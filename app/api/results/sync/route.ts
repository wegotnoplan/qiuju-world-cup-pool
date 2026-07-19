import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  bets,
  fixtures,
  participants,
  resultAudits,
  settlements,
} from "@/db/schema";
import {
  FIXTURES,
  FINAL_FIXTURE_ID,
  gradeSelection,
  PARTICIPANTS,
  RESULT_BASIS,
  type KnockoutWinnerSide,
  type RegulationScore,
} from "@/lib/app-data";
import {
  ApiFootballRequestError,
  fetchApiFootball,
  findApiFootballFixture,
  normalizeApiFootballFixture,
  type ApiFootballFixturePayload,
} from "@/lib/api-football";
import { settlePool } from "@/lib/settlement";
import { hasValidAdminSession } from "@/lib/admin-auth";
import {
  fixtureTeamsAreResolved,
  FixtureProgressionError,
  planKnockoutProgression,
} from "@/lib/fixture-progression";
import {
  asFinalDistributionOutcome,
  ensureFinalDistributionForPersistedM104,
  planFinalDistributionClosure,
} from "@/lib/final-distribution-storage";

export const dynamic = "force-dynamic";

type Database = ReturnType<typeof getDb>;
// Match polling and the shared API cache use the same cadence. Keeping this a
// few seconds below the browser's 180-second timer avoids duplicate upstream
// requests while still allowing one fresh snapshot every three minutes.
const AUTO_RETRY_COOLDOWN_MS = 175 * 1_000;
const RETRYABLE_PROVIDER_STATUSES = new Set([
  "NOT_CONFIGURED",
  "PLAN_RESTRICTED",
  "QUOTA_EXCEEDED",
  "NETWORK_ERROR",
  "UPSTREAM_ERROR",
  "INVALID_RESPONSE",
  "DISCOVERY_ERROR",
  "MATCH_NOT_FOUND",
]);

function errorChainIncludes(error: unknown, fragment: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes(fragment)) return true;
    current = current.cause;
  }
  return false;
}

interface ProviderResult {
  providerStatus: string;
  halfTime: RegulationScore | null;
  regularTime: RegulationScore | null;
  winnerSide: KnockoutWinnerSide | null;
  outcome: "ready" | "waiting" | "manual_review";
  message: string;
}

interface ResultProvider {
  readonly name: "api-football";
  getMatch(providerMatchId: string): Promise<ProviderResult>;
}

class ApiFootballProvider implements ResultProvider {
  readonly name = "api-football" as const;

  async getMatch(providerMatchId: string): Promise<ProviderResult> {
    try {
      const result = await fetchApiFootball<ApiFootballFixturePayload[]>({
        endpoint: "fixtures",
        params: { id: providerMatchId },
      });
      const matches = Array.isArray(result.envelope.response)
        ? result.envelope.response
        : [];
      if (matches.length === 0) {
        return {
          providerStatus: "MATCH_NOT_FOUND",
          halfTime: null,
          regularTime: null,
          winnerSide: null,
          outcome: "waiting",
          message: "API-Football 暂未返回已绑定比赛，保持直播同步并稍后重试。",
        };
      }
      if (matches.length !== 1) {
        return {
          providerStatus: "MATCH_NOT_FOUND",
          halfTime: null,
          regularTime: null,
          winnerSide: null,
          outcome: "manual_review",
          message: "API-Football 没有返回唯一的已绑定比赛，需要人工复核比赛 ID。",
        };
      }
      return normalizeApiFootballFixture(matches[0]!);
    } catch (error) {
      if (error instanceof ApiFootballRequestError) {
        return {
          providerStatus: error.code,
          halfTime: null,
          regularTime: null,
          winnerSide: null,
          outcome: "waiting",
          message: `${error.message} 本场保持待同步状态，可稍后重试。`,
        };
      }
      return {
        providerStatus: "NETWORK_ERROR",
        halfTime: null,
        regularTime: null,
        winnerSide: null,
        outcome: "waiting",
        message: "API-Football 暂时不可用，本场保持待同步状态。",
      };
    }
  }
}

async function ensureSeedData(db: Database) {
  await db
    .insert(participants)
    .values(PARTICIPANTS.map((participant) => ({ ...participant })))
    .onConflictDoNothing();
  await db
    .insert(fixtures)
    .values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        matchCode: fixture.matchCode,
        sequence: fixture.sequence,
        stage: fixture.stage,
        homeTeamCode: fixture.homeTeam.code,
        homeTeamName: fixture.homeTeam.name,
        homeTeamEnglishName: fixture.homeTeam.englishName,
        homeTeamPlaceholder: fixture.homeTeam.placeholder ?? false,
        awayTeamCode: fixture.awayTeam.code,
        awayTeamName: fixture.awayTeam.name,
        awayTeamEnglishName: fixture.awayTeam.englishName,
        awayTeamPlaceholder: fixture.awayTeam.placeholder ?? false,
        kickoffAt: fixture.kickoffAt,
        lockAt: fixture.lockAt,
        resultSyncDueAt: fixture.resultSyncDueAt,
        providerMatchId: fixture.providerMatchId,
        status: fixture.recordStatus,
      }))
    )
    .onConflictDoNothing();

  for (const fixture of FIXTURES) {
    if (fixture.providerMatchId) {
      await db
        .update(fixtures)
        .set({ providerMatchId: fixture.providerMatchId })
        .where(and(eq(fixtures.id, fixture.id), isNull(fixtures.providerMatchId)));
    }

    if (!fixture.homeTeam.placeholder) {
      await db
        .update(fixtures)
        .set({
          homeTeamCode: fixture.homeTeam.code,
          homeTeamName: fixture.homeTeam.name,
          homeTeamEnglishName: fixture.homeTeam.englishName,
          homeTeamPlaceholder: false,
        })
        .where(
          and(eq(fixtures.id, fixture.id), eq(fixtures.homeTeamPlaceholder, true)),
        );
    }
    if (!fixture.awayTeam.placeholder) {
      await db
        .update(fixtures)
        .set({
          awayTeamCode: fixture.awayTeam.code,
          awayTeamName: fixture.awayTeam.name,
          awayTeamEnglishName: fixture.awayTeam.englishName,
          awayTeamPlaceholder: false,
        })
        .where(
          and(eq(fixtures.id, fixture.id), eq(fixtures.awayTeamPlaceholder, true)),
        );
    }
  }
}

async function audit(
  db: Database,
  fixtureId: string,
  source: string,
  outcome: string,
  message: string,
  now: string,
  providerStatus?: string,
  score?: RegulationScore,
  halfTime?: RegulationScore | null
) {
  await db.insert(resultAudits).values({
    id: crypto.randomUUID(),
    fixtureId,
    source,
    outcome,
    message,
    providerStatus: providerStatus ?? null,
    halfHome: halfTime?.home ?? null,
    halfAway: halfTime?.away ?? null,
    regularHome: score?.home ?? null,
    regularAway: score?.away ?? null,
    createdAt: now,
  });
}

async function isInAutoRetryCooldown(
  db: Database,
  fixtureId: string,
  nowMs: number,
  cooldownMs = AUTO_RETRY_COOLDOWN_MS,
): Promise<boolean> {
  const [latestWaiting] = await db
    .select({ createdAt: resultAudits.createdAt })
    .from(resultAudits)
    .where(
      and(
        eq(resultAudits.fixtureId, fixtureId),
        eq(resultAudits.outcome, "waiting"),
      ),
    )
    .orderBy(desc(resultAudits.createdAt))
    .limit(1);
  return Boolean(
    latestWaiting &&
      nowMs - Date.parse(latestWaiting.createdAt) < cooldownMs,
  );
}

async function markReviewRequired(
  db: Database,
  fixtureId: string,
  message: string,
  now: string,
  providerStatus?: string,
  score?: RegulationScore
) {
  const [current] = await db
    .select({
      status: fixtures.status,
      reviewNote: fixtures.reviewNote,
      regularHome: fixtures.regularHome,
      regularAway: fixtures.regularAway,
    })
    .from(fixtures)
    .where(eq(fixtures.id, fixtureId))
    .limit(1);
  if (
    current?.status === "review_required" &&
    current.reviewNote === message &&
    current.regularHome === (score?.home ?? null) &&
    current.regularAway === (score?.away ?? null)
  ) {
    return;
  }
  await db.batch([
    db
      .update(fixtures)
      .set({
        status: "review_required",
        reviewNote: message,
        regularHome: score?.home,
        regularAway: score?.away,
        resultSource: score ? "api-football" : null,
        resultBasis: score ? RESULT_BASIS : null,
        updatedAt: now,
      })
      .where(eq(fixtures.id, fixtureId)),
    db.insert(resultAudits).values({
      id: crypto.randomUUID(),
      fixtureId,
      source: "api-football",
      outcome: "review_required",
      message,
      providerStatus: providerStatus ?? null,
      regularHome: score?.home ?? null,
      regularAway: score?.away ?? null,
      createdAt: now,
    }),
  ]);
}

interface SyncSettlementResult {
  outcome: "settled" | "manual_review" | "blocked";
  message: string;
  score?: RegulationScore;
  paidCents?: number;
  theoreticalPayoutCents?: number;
}

function providerSettlementRegulationMatches(
  settlement: typeof settlements.$inferSelect,
  score: RegulationScore,
): boolean {
  return (
    settlement.regularHome === score.home &&
    settlement.regularAway === score.away
  );
}

async function persistProgression(
  db: Database,
  sourceFixtureId: string,
  winnerSide: KnockoutWinnerSide,
  now: string,
) {
  await db.transaction(async (tx) => {
    const fixtureRows = await tx
      .select()
      .from(fixtures)
      .orderBy(asc(fixtures.sequence));
    const currentPlan = planKnockoutProgression(
      fixtureRows,
      sourceFixtureId,
      winnerSide,
    );
    const sourceUpdated = await tx
      .update(fixtures)
      .set({ winnerSide: currentPlan.winnerSide, updatedAt: now })
      .where(eq(fixtures.id, currentPlan.sourceFixtureId))
      .returning({ id: fixtures.id });
    if (sourceUpdated.length !== 1) {
      throw new FixtureProgressionError("比赛状态刚刚发生变化，请刷新后重试。");
    }
    for (const patch of currentPlan.teamPatches) {
      const updated = patch.side === "home"
        ? await tx
            .update(fixtures)
            .set({
              homeTeamCode: patch.team.code,
              homeTeamName: patch.team.name,
              homeTeamEnglishName: patch.team.englishName,
              homeTeamPlaceholder: false,
              updatedAt: now,
            })
            .where(
              and(
                eq(fixtures.id, patch.fixtureId),
                eq(fixtures.homeTeamPlaceholder, true),
              ),
            )
            .returning({ id: fixtures.id })
        : await tx
            .update(fixtures)
            .set({
              awayTeamCode: patch.team.code,
              awayTeamName: patch.team.name,
              awayTeamEnglishName: patch.team.englishName,
              awayTeamPlaceholder: false,
              updatedAt: now,
            })
            .where(
              and(
                eq(fixtures.id, patch.fixtureId),
                eq(fixtures.awayTeamPlaceholder, true),
              ),
            )
            .returning({ id: fixtures.id });
      if (updated.length !== 1) {
        throw new FixtureProgressionError("淘汰赛对阵刚刚发生变化，请刷新后重试。");
      }
    }
  });
}

async function settleFromProvider(
  db: Database,
  fixtureId: string,
  score: RegulationScore,
  halfTime: RegulationScore | null,
  winnerSide: KnockoutWinnerSide | null,
  providerStatus: string,
  now: string
): Promise<SyncSettlementResult> {
  const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
  const fixture = fixtureRows.find((row) => row.id === fixtureId);
  if (!fixture) return { outcome: "blocked", message: "比赛不存在。" };
  const effectiveHalfTime =
    halfTime ??
    (fixture.halfHome !== null && fixture.halfAway !== null
      ? { home: fixture.halfHome, away: fixture.halfAway }
      : null);
  if (fixture.status === "settled") {
    const [existingSettlement] = await db
      .select()
      .from(settlements)
      .where(eq(settlements.fixtureId, fixture.id))
      .limit(1);
    if (
      existingSettlement &&
      providerSettlementRegulationMatches(existingSettlement, score)
    ) {
      if (fixture.id === FINAL_FIXTURE_ID) {
        await ensureFinalDistributionForPersistedM104(db);
      }
      if (winnerSide) {
        try {
          await persistProgression(db, fixture.id, winnerSide, now);
        } catch (error) {
          if (!(error instanceof FixtureProgressionError)) throw error;
          return { outcome: "manual_review", message: error.message, score };
        }
      }
      const bracketPending =
        !fixture.winnerSide &&
        !winnerSide;
      return {
        outcome: "settled",
        message: bracketPending
          ? "90分钟奖池已结算，继续等待加时或点球后的实际晋级方。"
          : "本场此前已经按相同赛果结算。",
        score,
        paidCents: existingSettlement.paidCents,
        theoreticalPayoutCents: existingSettlement.theoreticalPayoutCents,
      };
    }
    return {
      outcome: "manual_review",
      message: "本场已按另一份赛果结算，自动同步不会覆盖。",
      score,
    };
  }

  if (!fixtureTeamsAreResolved(fixture)) {
    return {
      outcome: "blocked",
      message: "本场对阵尚未确认，不能自动结算赛果。",
    };
  }
  const blockingPrior = fixtureRows.find(
    (row) =>
      row.sequence < fixture.sequence &&
      (row.status !== "settled" || row.winnerSide === null),
  );
  if (blockingPrior) {
    return {
      outcome: "blocked",
      message: `等待${blockingPrior.matchCode}先结算，后场注金不会用于前场赔付。`,
    };
  }

  const fixtureBets = await db
    .select()
    .from(bets)
    .where(eq(bets.fixtureId, fixture.id))
    .orderBy(asc(bets.placedAt), asc(bets.id));
  const graded = fixtureBets.map((bet) => ({
    bet,
    grade: gradeSelection(
      bet.marketType,
      bet.selectionCode,
      score,
      effectiveHalfTime,
    ),
  }));
  const unsupported = graded.filter((item) => item.grade === "unsupported");
  if (unsupported.length > 0) {
    const message = `有${unsupported.length}注不能仅凭常规时间比分自动判定，需要人工复核。`;
    const firstUnsupported = unsupported[0]!;
    const remainingUnsupported = unsupported.slice(1);
    await db.batch([
      db
        .update(bets)
        .set({ status: "review_required" })
        .where(eq(bets.id, firstUnsupported.bet.id)),
      ...remainingUnsupported.map((item) =>
        db
          .update(bets)
          .set({ status: "review_required" })
          .where(eq(bets.id, item.bet.id)),
      ),
      db
        .update(fixtures)
        .set({
          status: "review_required",
          halfHome: effectiveHalfTime?.home ?? null,
          halfAway: effectiveHalfTime?.away ?? null,
          regularHome: score.home,
          regularAway: score.away,
          resultSource: "api-football",
          resultBasis: RESULT_BASIS,
          reviewNote: message,
          updatedAt: now,
        })
        .where(eq(fixtures.id, fixture.id)),
      db.insert(resultAudits).values({
        id: crypto.randomUUID(),
        fixtureId: fixture.id,
        source: "api-football",
        outcome: "review_required",
        message,
        providerStatus,
        halfHome: effectiveHalfTime?.home ?? null,
        halfAway: effectiveHalfTime?.away ?? null,
        regularHome: score.home,
        regularAway: score.away,
        createdAt: now,
      }),
    ] as const);
    return { outcome: "manual_review", message, score };
  }

  const priorFixtureIds = new Set(
    fixtureRows.filter((row) => row.sequence < fixture.sequence).map((row) => row.id)
  );
  const allBets = await db.select().from(bets);
  const priorBets = allBets.filter((bet) => priorFixtureIds.has(bet.fixtureId));
  const poolBeforeCents = Math.max(
    0,
    priorBets.reduce((sum, bet) => sum + bet.stakeCents, 0) -
      priorBets.reduce((sum, bet) => sum + bet.payoutCents, 0)
  );
  const currentFixtureStakeCents = fixtureBets.reduce((sum, bet) => sum + bet.stakeCents, 0);
  const eligiblePoolCents = poolBeforeCents + currentFixtureStakeCents;
  const poolSettlement = settlePool({
    poolFen: eligiblePoolCents,
    tickets: graded.map((item, ticketSequence) => ({
      ticketId: item.bet.id,
      ticketSequence,
      odds: String(item.bet.odds),
      outcome: item.grade as "won" | "lost" | "void",
    })),
  });
  const settledTicketById = new Map(
    poolSettlement.tickets.map((ticket) => [ticket.ticketId, ticket])
  );

  const finalDistributionPlan =
    fixture.id === FINAL_FIXTURE_ID
      ? await planFinalDistributionClosure(
          db,
          {
            fixtureId: FINAL_FIXTURE_ID,
            eligiblePoolCents,
            paidCents: poolSettlement.totalPayoutFen,
            tickets: graded.map((item) => ({
              ticketId: item.bet.id,
              participantId: item.bet.participantId,
              outcome: asFinalDistributionOutcome(item.grade),
              payoutCents:
                settledTicketById.get(item.bet.id)?.payoutFen ?? 0,
            })),
          },
          now,
        )
      : null;

  const note =
    "API-Football明确返回常规时间结束；只读取score.fulltime作为90分钟比分，未读取goals、加时或点球比分。";
  const settlementValue = {
    fixtureId: fixture.id,
    halfHome: effectiveHalfTime?.home ?? null,
    halfAway: effectiveHalfTime?.away ?? null,
    regularHome: score.home,
    regularAway: score.away,
    resultBasis: RESULT_BASIS,
    resultSource: "api-football",
    poolBeforeCents,
    currentFixtureStakeCents,
    eligiblePoolCents,
    theoreticalPayoutCents: poolSettlement.totalDueFen,
    paidCents: poolSettlement.totalPayoutFen,
    scaleBps:
      poolSettlement.totalDueFen === 0
        ? 10_000
        : Math.round((poolSettlement.totalPayoutFen / poolSettlement.totalDueFen) * 10_000),
    note,
    settledAt: now,
  };
  let concurrentSettlement: typeof settlements.$inferSelect | null = null;
  try {
    // The settlement PK is the concurrency guard. A conflict aborts the whole
    // libSQL batch, so a second result can never overwrite tickets or the fixture.
    await db.batch([
      db.insert(settlements).values(settlementValue),
      ...graded.map((item) => {
        const settledTicket = settledTicketById.get(item.bet.id);
        return db
          .update(bets)
          .set({
            status: item.grade,
            theoreticalPayoutCents: settledTicket?.amountDueFen ?? 0,
            payoutCents: settledTicket?.payoutFen ?? 0,
            settledAt: now,
          })
          .where(eq(bets.id, item.bet.id));
      }),
      db
        .update(fixtures)
        .set({
          status: "settled",
          halfHome: effectiveHalfTime?.home ?? null,
          halfAway: effectiveHalfTime?.away ?? null,
          regularHome: score.home,
          regularAway: score.away,
          resultSource: "api-football",
          resultBasis: RESULT_BASIS,
          reviewNote: null,
          settledAt: now,
          updatedAt: now,
        })
        .where(eq(fixtures.id, fixture.id)),
      db.insert(resultAudits).values({
        id: crypto.randomUUID(),
        fixtureId: fixture.id,
        source: "api-football",
        outcome: "settled",
        message: note,
        providerStatus,
        halfHome: effectiveHalfTime?.home ?? null,
        halfAway: effectiveHalfTime?.away ?? null,
        regularHome: score.home,
        regularAway: score.away,
        createdAt: now,
      }),
      ...(finalDistributionPlan?.queries ?? []),
    ] as const);
  } catch (error) {
    if (!errorChainIncludes(error, "UNIQUE constraint failed")) throw error;
    const [existingSettlement] = await db
      .select()
      .from(settlements)
      .where(eq(settlements.fixtureId, fixture.id))
      .limit(1);
    if (!existingSettlement) throw error;
    if (!providerSettlementRegulationMatches(existingSettlement, score)) {
      return {
        outcome: "manual_review",
        message: "本场已按另一份赛果结算，自动同步不会覆盖。",
        score,
      };
    }
    if (fixture.id === FINAL_FIXTURE_ID) {
      await ensureFinalDistributionForPersistedM104(db);
    }
    concurrentSettlement = existingSettlement;
  }

  if (winnerSide) {
    try {
      // The 90-minute pool settlement is already durable. Bracket advancement
      // is a separate verified transaction and remains retryable while
      // winnerSide is null if this process stops between the two operations.
      await persistProgression(db, fixture.id, winnerSide, now);
    } catch (progressionError) {
      if (!(progressionError instanceof FixtureProgressionError)) {
        throw progressionError;
      }
      return {
        outcome: "manual_review",
        message: progressionError.message,
        score,
      };
    }
  }

  return {
    outcome: "settled",
    message: concurrentSettlement
      ? "并发同步已按相同赛果完成结算。"
      : !winnerSide
        ? "已按90分钟比分结算奖池；继续等待加时或点球后的实际胜者。"
        : "已按90分钟常规时间及伤停补时结算。",
    score,
    paidCents: concurrentSettlement?.paidCents ?? poolSettlement.totalPayoutFen,
    theoreticalPayoutCents:
      concurrentSettlement?.theoreticalPayoutCents ?? poolSettlement.totalDueFen,
  };
}

interface ProviderDiscoveryResult {
  providerMatchId: string | null;
  providerStatus: string;
  message: string;
}

async function discoverProviderMatchId(
  fixture: typeof fixtures.$inferSelect,
): Promise<ProviderDiscoveryResult> {
  try {
    const kickoffDistanceMs = Date.parse(fixture.kickoffAt) - Date.now();
    const result = await fetchApiFootball<ApiFootballFixturePayload[]>({
      endpoint: "fixtures",
      // A date lookup is intentionally server-only. The browser proxy remains
      // restricted to league=1/season=2026 or an already-bound fixture ID.
      params: {
        date: fixture.kickoffAt.slice(0, 10),
        timezone: "Asia/Shanghai",
      },
      ttlSeconds:
        kickoffDistanceMs > 6 * 60 * 60 * 1_000 ? 6 * 60 * 60 : 175,
    });
    const candidates = (
      Array.isArray(result.envelope.response) ? result.envelope.response : []
    ).filter(
      (match) =>
        Number(match.league?.id) === 1 &&
        Number(match.league?.season) === 2026,
    );
    const match = findApiFootballFixture(candidates, {
      kickoffAt: fixture.kickoffAt,
      homeTeamEnglishName: fixture.homeTeamEnglishName,
      awayTeamEnglishName: fixture.awayTeamEnglishName,
      teamsArePlaceholders:
        fixture.homeTeamPlaceholder || fixture.awayTeamPlaceholder,
    });
    const id = match?.fixture?.id;
    if (!Number.isSafeInteger(id)) {
      return {
        providerMatchId: null,
        providerStatus: "MATCH_NOT_FOUND",
        message:
          "API-Football 的比赛日数据中没有唯一匹配本场的 2026 世界杯比赛，需要人工绑定比赛 ID。",
      };
    }
    return {
      providerMatchId: String(id),
      providerStatus: "MATCH_ID_DISCOVERED",
      message: `已按开球时间与对阵自动绑定 API-Football 比赛 ID ${id}。`,
    };
  } catch (error) {
    if (error instanceof ApiFootballRequestError) {
      return {
        providerMatchId: null,
        providerStatus: error.code,
        message: error.message,
      };
    }
    return {
      providerMatchId: null,
      providerStatus: "DISCOVERY_ERROR",
      message: "无法自动识别 API-Football 比赛 ID，需要人工绑定。",
    };
  }
}

async function runSync(force = false) {
  const db = getDb();
  await ensureSeedData(db);
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const provider = new ApiFootballProvider();
  const discoveryResults: Array<Record<string, unknown>> = [];

  // Bind the next match before kickoff so its game widget has an ID to render.
  // A failed pre-match lookup never changes the fixture to review_required;
  // it can be retried safely and successful date responses are cached for 6h.
  const upcomingUnbound = (
    await db.select().from(fixtures).orderBy(asc(fixtures.sequence))
  ).filter((fixture) => {
    const kickoffMs = Date.parse(fixture.kickoffAt);
    return (
      fixture.status === "scheduled" &&
      !fixture.providerMatchId &&
      kickoffMs > nowMs &&
      kickoffMs - nowMs <= 36 * 60 * 60 * 1_000
    );
  });
  for (const fixture of upcomingUnbound) {
    if (
      !force &&
      (await isInAutoRetryCooldown(db, fixture.id, nowMs, 6 * 60 * 60 * 1_000))
    ) {
      discoveryResults.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "cooldown",
        message: "赛前比赛 ID 刚检查过，6小时内不重复占用接口额度。",
      });
      continue;
    }
    const discovery = await discoverProviderMatchId(fixture);
    if (!discovery.providerMatchId) {
      await audit(
        db,
        fixture.id,
        provider.name,
        "waiting",
        discovery.message,
        now,
        discovery.providerStatus,
      );
      discoveryResults.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "waiting",
        message: discovery.message,
      });
      continue;
    }
    await db
      .update(fixtures)
      .set({ providerMatchId: discovery.providerMatchId, updatedAt: now })
      .where(eq(fixtures.id, fixture.id));
    await audit(
      db,
      fixture.id,
      provider.name,
      "match_id_discovered",
      discovery.message,
      now,
      discovery.providerStatus,
    );
    discoveryResults.push({
      fixtureId: fixture.id,
      matchCode: fixture.matchCode,
      outcome: "bound",
      providerMatchId: discovery.providerMatchId,
    });
  }

  const dueFixtures = (await db.select().from(fixtures).orderBy(asc(fixtures.sequence))).filter(
    (fixture) => {
      if (Date.parse(fixture.kickoffAt) > nowMs) return false;
      if (fixture.status === "scheduled") {
        return fixtureTeamsAreResolved(fixture);
      }
      return (
        fixture.status === "settled" &&
        fixture.winnerSide === null
      );
    },
  );
  const results: Array<Record<string, unknown>> = [];

  for (const fixture of dueFixtures) {
    const bracketResolutionOnly = fixture.status === "settled";
    if (!force && (await isInAutoRetryCooldown(db, fixture.id, nowMs))) {
      results.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "cooldown",
        message: "刚刚检查过赛况，3分钟内不重复占用接口额度。",
      });
      continue;
    }

    let providerMatchId = fixture.providerMatchId;
    if (!providerMatchId) {
      const discovery = await discoverProviderMatchId(fixture);
      providerMatchId = discovery.providerMatchId;
      if (!providerMatchId) {
        if (RETRYABLE_PROVIDER_STATUSES.has(discovery.providerStatus)) {
          await audit(
            db,
            fixture.id,
            provider.name,
            "waiting",
            discovery.message,
            now,
            discovery.providerStatus,
          );
          results.push({
            fixtureId: fixture.id,
            matchCode: fixture.matchCode,
            outcome: "waiting",
            message: discovery.message,
          });
          continue;
        }
        if (bracketResolutionOnly) {
          await audit(
            db,
            fixture.id,
            provider.name,
            "bracket_review_required",
            discovery.message,
            now,
            discovery.providerStatus,
          );
        } else {
          await markReviewRequired(
            db,
            fixture.id,
            discovery.message,
            now,
            discovery.providerStatus,
          );
        }
        results.push({
          fixtureId: fixture.id,
          matchCode: fixture.matchCode,
          outcome: "manual_review",
          message: discovery.message,
        });
        continue;
      }
      await db
        .update(fixtures)
        .set({ providerMatchId, updatedAt: now })
        .where(eq(fixtures.id, fixture.id));
      await audit(
        db,
        fixture.id,
        provider.name,
        "match_id_discovered",
        discovery.message,
        now,
        discovery.providerStatus,
      );
    }

    const providerResult = await provider.getMatch(providerMatchId);
    if (providerResult.outcome === "waiting") {
      if (providerResult.halfTime) {
        await db
          .update(fixtures)
          .set({
            halfHome: providerResult.halfTime.home,
            halfAway: providerResult.halfTime.away,
            resultSource: "api-football",
            updatedAt: now,
          })
          .where(
            and(
              eq(fixtures.id, fixture.id),
              isNull(fixtures.halfHome),
              isNull(fixtures.halfAway),
            ),
          );
      }
      await audit(
        db,
        fixture.id,
        provider.name,
        "waiting",
        providerResult.message,
        now,
        providerResult.providerStatus,
        undefined,
        providerResult.halfTime,
      );
      results.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "waiting",
        message: providerResult.message,
      });
      continue;
    }
    if (providerResult.outcome === "manual_review" || !providerResult.regularTime) {
      if (bracketResolutionOnly) {
        await audit(
          db,
          fixture.id,
          provider.name,
          "bracket_review_required",
          providerResult.message,
          now,
          providerResult.providerStatus,
        );
      } else {
        await markReviewRequired(
          db,
          fixture.id,
          providerResult.message,
          now,
          providerResult.providerStatus
        );
      }
      results.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "manual_review",
        message: providerResult.message,
      });
      continue;
    }

    const settlement = await settleFromProvider(
      db,
      fixture.id,
      providerResult.regularTime,
      providerResult.halfTime,
      providerResult.winnerSide,
      providerResult.providerStatus,
      now
    );
    results.push({ fixtureId: fixture.id, matchCode: fixture.matchCode, ...settlement });
  }

  return {
    syncedAt: now,
    resultBasis: RESULT_BASIS,
    resultBasisLabel: "90分钟常规时间＋伤停补时；不含加时赛与点球大战",
    discoveryResults,
    dueCount: dueFixtures.length,
    results,
  };
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  const noTable = message.includes("no such table");
  return Response.json(
    {
      error: noTable
        ? "Database tables are not ready. Apply the Drizzle migrations first."
        : message,
    },
    { status: noTable ? 503 : 500 }
  );
}

/** GET is intentionally catch-up capable so reopening a closed browser can resume sync. */
export async function GET() {
  try {
    return Response.json(await runSync(false));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!(await hasValidAdminSession(request))) {
      return Response.json(
        { error: "请先输入管理密码。" },
        { status: 401 },
      );
    }
    // Public deployments must never let a browser bypass the persistent
    // provider cooldown. The button remains useful as an immediate catch-up
    // check while repeated clicks reuse the same cached/audited result.
    return Response.json(await runSync(false));
  } catch (error) {
    return errorResponse(error);
  }
}
