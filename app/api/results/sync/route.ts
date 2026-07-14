import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
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
  gradeSelection,
  PARTICIPANTS,
  RESULT_BASIS,
  type RegulationScore,
} from "@/lib/app-data";
import { settlePool } from "@/lib/settlement";

export const dynamic = "force-dynamic";

type Database = ReturnType<typeof getDb>;

interface ProviderResult {
  providerStatus: string;
  regularTime: RegulationScore | null;
  outcome: "ready" | "waiting" | "manual_review";
  message: string;
}

interface ResultProvider {
  readonly name: "football-data.org";
  getMatch(providerMatchId: string): Promise<ProviderResult>;
}

interface FootballDataPayload {
  status?: unknown;
  score?: {
    regularTime?: {
      home?: unknown;
      away?: unknown;
    } | null;
  } | null;
}

class FootballDataProvider implements ResultProvider {
  readonly name = "football-data.org" as const;

  constructor(private readonly token: string) {}

  async getMatch(providerMatchId: string): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await fetch(
        `https://api.football-data.org/v4/matches/${encodeURIComponent(providerMatchId)}`,
        {
          headers: { "X-Auth-Token": this.token, Accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
          cache: "no-store",
        }
      );
    } catch {
      return {
        providerStatus: "NETWORK_ERROR",
        regularTime: null,
        outcome: "manual_review",
        message: "赛果服务暂时不可用，需要稍后重试或人工复核。",
      };
    }

    if (!response.ok) {
      return {
        providerStatus: `HTTP_${response.status}`,
        regularTime: null,
        outcome: "manual_review",
        message: "赛果服务未返回可用结果，需要人工复核。",
      };
    }

    let payload: FootballDataPayload;
    try {
      payload = (await response.json()) as FootballDataPayload;
    } catch {
      return {
        providerStatus: "INVALID_JSON",
        regularTime: null,
        outcome: "manual_review",
        message: "赛果服务响应格式无效，需要人工复核。",
      };
    }

    const providerStatus = typeof payload.status === "string" ? payload.status : "UNKNOWN";
    if (providerStatus !== "FINISHED") {
      return {
        providerStatus,
        regularTime: null,
        outcome: "waiting",
        message: "数据源尚未明确标记比赛为FINISHED，暂不结算。",
      };
    }

    // Deliberately do not fall back to score.fullTime: it may include extra time.
    const regularTime = payload.score?.regularTime;
    const home = regularTime?.home;
    const away = regularTime?.away;
    if (
      !Number.isInteger(home) ||
      !Number.isInteger(away) ||
      (home as number) < 0 ||
      (away as number) < 0
    ) {
      return {
        providerStatus,
        regularTime: null,
        outcome: "manual_review",
        message:
          "比赛虽已结束，但数据源没有明确的90分钟常规时间比分；禁止使用全场、加时或点球比分代替。",
      };
    }

    return {
      providerStatus,
      regularTime: { home: home as number, away: away as number },
      outcome: "ready",
      message: "已取得90分钟常规时间及伤停补时比分。",
    };
  }
}

function getProviderToken(): string | null {
  const workerToken = (env as unknown as { FOOTBALL_DATA_API_TOKEN?: string })
    .FOOTBALL_DATA_API_TOKEN;
  const token = workerToken || process.env.FOOTBALL_DATA_API_TOKEN;
  return token?.trim() || null;
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
}

async function audit(
  db: Database,
  fixtureId: string,
  source: string,
  outcome: string,
  message: string,
  now: string,
  providerStatus?: string,
  score?: RegulationScore
) {
  await db.insert(resultAudits).values({
    id: crypto.randomUUID(),
    fixtureId,
    source,
    outcome,
    message,
    providerStatus: providerStatus ?? null,
    regularHome: score?.home ?? null,
    regularAway: score?.away ?? null,
    createdAt: now,
  });
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
  await db
    .update(fixtures)
    .set({
      status: "review_required",
      reviewNote: message,
      regularHome: score?.home,
      regularAway: score?.away,
      resultSource: score ? "football-data.org" : null,
      resultBasis: score ? RESULT_BASIS : null,
      updatedAt: now,
    })
    .where(eq(fixtures.id, fixtureId));
  await audit(
    db,
    fixtureId,
    "football-data.org",
    "review_required",
    message,
    now,
    providerStatus,
    score
  );
}

interface SyncSettlementResult {
  outcome: "settled" | "manual_review" | "blocked";
  message: string;
  score?: RegulationScore;
  paidCents?: number;
  theoreticalPayoutCents?: number;
}

async function settleFromProvider(
  db: Database,
  fixtureId: string,
  score: RegulationScore,
  now: string
): Promise<SyncSettlementResult> {
  const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
  const fixture = fixtureRows.find((row) => row.id === fixtureId);
  if (!fixture) return { outcome: "blocked", message: "比赛不存在。" };
  if (fixture.status === "settled") {
    return { outcome: "settled", message: "本场此前已经结算。", score };
  }
  const blockingPrior = fixtureRows.find(
    (row) => row.sequence < fixture.sequence && row.status !== "settled"
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
    grade: gradeSelection(bet.marketType, bet.selectionCode, score),
  }));
  const unsupported = graded.filter((item) => item.grade === "unsupported");
  if (unsupported.length > 0) {
    const message = `有${unsupported.length}注不能仅凭常规时间比分自动判定，需要人工复核。`;
    for (const item of unsupported) {
      await db
        .update(bets)
        .set({ status: "review_required" })
        .where(eq(bets.id, item.bet.id));
    }
    await markReviewRequired(db, fixture.id, message, now, "FINISHED", score);
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

  for (const item of graded) {
    const settledTicket = settledTicketById.get(item.bet.id);
    await db
      .update(bets)
      .set({
        status: item.grade,
        theoreticalPayoutCents: settledTicket?.amountDueFen ?? 0,
        payoutCents: settledTicket?.payoutFen ?? 0,
        settledAt: now,
      })
      .where(eq(bets.id, item.bet.id));
  }

  const note = "football-data.org明确返回FINISHED及score.regularTime；未读取fullTime、加时或点球比分。";
  await db
    .insert(settlements)
    .values({
      fixtureId: fixture.id,
      regularHome: score.home,
      regularAway: score.away,
      resultBasis: RESULT_BASIS,
      resultSource: "football-data.org",
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
    })
    .onConflictDoNothing();
  await db
    .update(fixtures)
    .set({
      status: "settled",
      regularHome: score.home,
      regularAway: score.away,
      resultSource: "football-data.org",
      resultBasis: RESULT_BASIS,
      reviewNote: null,
      settledAt: now,
      updatedAt: now,
    })
    .where(eq(fixtures.id, fixture.id));
  await audit(
    db,
    fixture.id,
    "football-data.org",
    "settled",
    note,
    now,
    "FINISHED",
    score
  );

  return {
    outcome: "settled",
    message: "已按90分钟常规时间及伤停补时结算。",
    score,
    paidCents: poolSettlement.totalPayoutFen,
    theoreticalPayoutCents: poolSettlement.totalDueFen,
  };
}

async function runSync() {
  const db = getDb();
  await ensureSeedData(db);
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const dueFixtures = (await db.select().from(fixtures).orderBy(asc(fixtures.sequence))).filter(
    (fixture) => fixture.status !== "settled" && Date.parse(fixture.resultSyncDueAt) <= nowMs
  );
  const token = getProviderToken();
  const provider = token ? new FootballDataProvider(token) : null;
  const results: Array<Record<string, unknown>> = [];

  for (const fixture of dueFixtures) {
    if (!provider) {
      const message = "未配置服务器端赛果服务凭据，需要人工复核。";
      await markReviewRequired(db, fixture.id, message, now, "NOT_CONFIGURED");
      results.push({ fixtureId: fixture.id, matchCode: fixture.matchCode, outcome: "manual_review", message });
      continue;
    }
    if (!fixture.providerMatchId) {
      const message = "本场尚未绑定赛果服务比赛ID，需要人工复核。";
      await markReviewRequired(db, fixture.id, message, now, "MATCH_ID_MISSING");
      results.push({ fixtureId: fixture.id, matchCode: fixture.matchCode, outcome: "manual_review", message });
      continue;
    }

    const providerResult = await provider.getMatch(fixture.providerMatchId);
    if (providerResult.outcome === "waiting") {
      await audit(
        db,
        fixture.id,
        provider.name,
        "waiting",
        providerResult.message,
        now,
        providerResult.providerStatus
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
      await markReviewRequired(
        db,
        fixture.id,
        providerResult.message,
        now,
        providerResult.providerStatus
      );
      results.push({
        fixtureId: fixture.id,
        matchCode: fixture.matchCode,
        outcome: "manual_review",
        message: providerResult.message,
      });
      continue;
    }

    const settlement = await settleFromProvider(db, fixture.id, providerResult.regularTime, now);
    results.push({ fixtureId: fixture.id, matchCode: fixture.matchCode, ...settlement });
  }

  return {
    syncedAt: now,
    resultBasis: RESULT_BASIS,
    resultBasisLabel: "90分钟常规时间＋伤停补时；不含加时赛与点球大战",
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
        ? "D1 tables are not ready. Generate and apply the Drizzle migration first."
        : message,
    },
    { status: noTable ? 503 : 500 }
  );
}

/** GET is intentionally catch-up capable so reopening a closed browser can resume sync. */
export async function GET() {
  try {
    return Response.json(await runSync());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST() {
  try {
    return Response.json(await runSync());
  } catch (error) {
    return errorResponse(error);
  }
}
