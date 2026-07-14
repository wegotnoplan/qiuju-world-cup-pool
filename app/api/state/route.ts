import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  bets,
  fixtureEntries,
  fixtures,
  oddsOffers,
  participants,
  resultAudits,
  settlements,
} from "@/db/schema";
import {
  APP_RULES,
  APP_STATE_VERSION,
  DEFAULT_RULES_TEXT,
  deriveFixtureStates,
  FIXTURES,
  gradeSelection,
  isFixtureBettingWindowOpen,
  matchScoreValidationError,
  MAX_BETS_PER_PARTICIPANT,
  PARTICIPANTS,
  RESULT_BASIS,
  STAKE_CENTS,
  type AppState,
  type Bet,
  type BetSelectionInput,
  type Fixture,
  type FixtureEntry,
  type FixtureRecordStatus,
  type ManualResultRequest,
  type KnockoutWinnerSide,
  type OddsOffer,
  type ParticipantId,
  type SetEntryEditUnlockedRequest,
  type Settlement,
  type StateMutationRequest,
  type UploadOddsRequest,
  winnerSideFromRegulationScore,
} from "@/lib/app-data";
import {
  fixtureTeamsAreResolved,
  FixtureProgressionError,
  planKnockoutProgression,
} from "@/lib/fixture-progression";
import { ALL_SEED_ODDS } from "@/lib/seed-odds";
import { settlePool } from "@/lib/settlement";
import { hasValidAdminSession } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

type Database = ReturnType<typeof getDb>;

function routeError(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  const detail =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;
  if (combined.includes("no such table")) {
    return {
      status: 503,
      message:
        "Database tables are not ready. Apply the Drizzle migrations before using the app.",
    };
  }
  return { status: 500, message };
}

function errorChainIncludes(error: unknown, fragment: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes(fragment)) return true;
    current = current.cause;
  }
  return false;
}

function badRequest(message: string, status = 400): never {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  throw error;
}

function statusForError(error: unknown): number {
  return error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : routeError(error).status;
}

function messageForError(error: unknown): string {
  if (error instanceof Error && "status" in error) return error.message;
  return routeError(error).message;
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

  // Preserve IDs entered by an administrator, but backfill provider IDs that
  // became known after an existing database had already been seeded.
  for (const fixture of FIXTURES) {
    if (fixture.providerMatchId) {
      await db
        .update(fixtures)
        .set({ providerMatchId: fixture.providerMatchId })
        .where(and(eq(fixtures.id, fixture.id), isNull(fixtures.providerMatchId)));
    }

    // A later seed may resolve a knockout placeholder. Only replace a side
    // that is still explicitly marked as a placeholder, so an administrator's
    // already-real team data is never overwritten by seed synchronization.
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

  // Keep inserts in small batches for conservative SQLite parameter limits.
  // insert only missing seed rows in small batches instead of sending all 108
  // screenshot options in one statement.
  const existingOfferIds = new Set(
    (await db.select({ id: oddsOffers.id }).from(oddsOffers)).map((row) => row.id),
  );
  const missingSeedOffers = ALL_SEED_ODDS.filter(
    (offer) => offer.id && !existingOfferIds.has(offer.id),
  ).map((offer) => ({
    id: offer.id!,
    fixtureId: offer.id!.startsWith("wc2026-m101-")
      ? "wc2026-m101"
      : "wc2026-m102",
    marketType: offer.marketType,
    selectionCode: offer.selectionCode,
    label: offer.label,
    odds: offer.odds,
    rulesText: offer.rulesText ?? DEFAULT_RULES_TEXT,
    source: offer.source ?? "用户提供的竞彩模拟页截图",
    active: true,
  }));
  for (let offset = 0; offset < missingSeedOffers.length; offset += 10) {
    await db
      .insert(oddsOffers)
      .values(missingSeedOffers.slice(offset, offset + 10))
      .onConflictDoNothing();
  }
}

function asRecordStatus(value: string): FixtureRecordStatus {
  if (value === "review_required" || value === "settled") return value;
  return "scheduled";
}

function asParticipantId(value: string): ParticipantId {
  return value as ParticipantId;
}

async function loadState(db: Database, now = new Date().toISOString()): Promise<AppState> {
  await ensureSeedData(db);
  const [participantRows, fixtureRows, offerRows, entryRows, betRows, settlementRows] =
    await Promise.all([
      db.select().from(participants).orderBy(asc(participants.displayOrder)),
      db.select().from(fixtures).orderBy(asc(fixtures.sequence)),
      db
        .select()
        .from(oddsOffers)
        .where(eq(oddsOffers.active, true))
        .orderBy(asc(oddsOffers.marketType), asc(oddsOffers.label)),
      db.select().from(fixtureEntries).orderBy(asc(fixtureEntries.lockedAt)),
      db.select().from(bets).orderBy(asc(bets.placedAt), asc(bets.id)),
      db.select().from(settlements),
    ]);

  const offersByFixture = new Map<string, OddsOffer[]>();
  for (const row of offerRows) {
    const list = offersByFixture.get(row.fixtureId) ?? [];
    list.push({
      id: row.id,
      fixtureId: row.fixtureId,
      marketType: row.marketType,
      selectionCode: row.selectionCode,
      label: row.label,
      odds: row.odds,
      rulesText: row.rulesText,
      source: row.source,
      active: row.active,
      uploadedAt: row.uploadedAt,
    });
    offersByFixture.set(row.fixtureId, list);
  }

  const mappedSettlements: Settlement[] = settlementRows.map((row) => ({
    fixtureId: row.fixtureId,
    halfTimeScore:
      row.halfHome === null || row.halfAway === null
        ? null
        : { home: row.halfHome, away: row.halfAway },
    regularTimeScore: { home: row.regularHome, away: row.regularAway },
    resultBasis: RESULT_BASIS,
    resultSource:
      row.resultSource === "external-provider" ||
      row.resultSource === "api-football" ||
      row.resultSource === "football-data.org"
        ? row.resultSource
        : "manual",
    poolBeforeCents: row.poolBeforeCents,
    currentFixtureStakeCents: row.currentFixtureStakeCents,
    eligiblePoolCents: row.eligiblePoolCents,
    theoreticalPayoutCents: row.theoreticalPayoutCents,
    paidCents: row.paidCents,
    scaleBps: row.scaleBps,
    settledAt: row.settledAt,
    note: row.note,
  }));
  const settlementByFixture = new Map(
    mappedSettlements.map((settlement) => [settlement.fixtureId, settlement])
  );

  const mappedFixtures: Fixture[] = fixtureRows.map((row) => ({
    id: row.id,
    matchCode: row.matchCode as Fixture["matchCode"],
    sequence: row.sequence,
    stage: row.stage as Fixture["stage"],
    homeTeam: {
      code: row.homeTeamCode,
      name: row.homeTeamName,
      englishName: row.homeTeamEnglishName,
      placeholder: row.homeTeamPlaceholder || undefined,
    },
    awayTeam: {
      code: row.awayTeamCode,
      name: row.awayTeamName,
      englishName: row.awayTeamEnglishName,
      placeholder: row.awayTeamPlaceholder || undefined,
    },
    kickoffAt: row.kickoffAt,
    lockAt: row.lockAt,
    resultSyncDueAt: row.resultSyncDueAt,
    providerMatchId: row.providerMatchId,
    winnerSide:
      row.winnerSide === "home" || row.winnerSide === "away"
        ? row.winnerSide
        : null,
    recordStatus: asRecordStatus(row.status),
    status: "locked",
    isBettingOpen: false,
    halfTimeScore:
      row.halfHome === null || row.halfAway === null
        ? null
        : { home: row.halfHome, away: row.halfAway },
    regularTimeScore:
      row.regularHome === null || row.regularAway === null
        ? null
        : { home: row.regularHome, away: row.regularAway },
    resultSource:
      row.resultSource === "manual" ||
      row.resultSource === "api-football" ||
      row.resultSource === "football-data.org" ||
      row.resultSource === "external-provider"
        ? row.resultSource
        : null,
    resultBasis: row.resultBasis === RESULT_BASIS ? RESULT_BASIS : null,
    reviewNote: row.reviewNote,
    offers: offersByFixture.get(row.id) ?? [],
    settlement: settlementByFixture.get(row.id) ?? null,
  }));
  const derived = deriveFixtureStates(mappedFixtures, now);

  const mappedBets: Bet[] = betRows.map((row) => ({
    id: row.id,
    fixtureId: row.fixtureId,
    participantId: asParticipantId(row.participantId),
    offerId: row.offerId,
    marketType: row.marketType,
    selectionCode: row.selectionCode,
    label: row.label,
    odds: row.odds,
    stakeCents: row.stakeCents,
    placedAt: row.placedAt,
    status: row.status as Bet["status"],
    theoreticalPayoutCents: row.theoreticalPayoutCents,
    payoutCents: row.payoutCents,
    settledAt: row.settledAt,
  }));
  const mappedEntries: FixtureEntry[] = entryRows.map((row) => ({
    id: row.id,
    fixtureId: row.fixtureId,
    participantId: asParticipantId(row.participantId),
    betCount: row.betCount,
    stakeCents: row.stakeCents,
    lockedAt: row.lockedAt,
    editUnlockedAt: row.editUnlockedAt,
    revision: row.revision,
    canEdit: row.editUnlockedAt !== null && derived.activeFixtureId === row.fixtureId,
  }));
  const contributedCents = mappedBets.reduce((sum, bet) => sum + bet.stakeCents, 0);
  const paidCents = mappedBets.reduce((sum, bet) => sum + bet.payoutCents, 0);

  return {
    version: APP_STATE_VERSION,
    serverTime: now,
    activeFixtureId: derived.activeFixtureId,
    nextFixtureId: derived.nextFixtureId,
    participants: participantRows
      .filter((row) => PARTICIPANTS.some((participant) => participant.id === row.id))
      .map((row) => ({
        id: asParticipantId(row.id),
        name: row.name,
        displayOrder: row.displayOrder,
        active: row.active,
      })),
    fixtures: derived.fixtures,
    entries: mappedEntries,
    bets: mappedBets,
    settlements: mappedSettlements,
    pool: {
      contributedCents,
      paidCents,
      balanceCents: Math.max(0, contributedCents - paidCents),
    },
    rules: { ...APP_RULES },
  };
}

function activeFixtureForRows<
  T extends {
    id: string;
    kickoffAt: string;
    lockAt: string;
    sequence: number;
    status: string;
    winnerSide: string | null;
    homeTeamPlaceholder: boolean;
    awayTeamPlaceholder: boolean;
  }
>(fixtureRows: T[], now: string): T | null {
  const next = [...fixtureRows]
    .filter(
      (fixture) =>
        fixture.status !== "settled" || fixture.winnerSide === null,
    )
    .sort((a, b) => a.sequence - b.sequence)[0];
  return next &&
    next.status === "scheduled" &&
    !next.homeTeamPlaceholder &&
    !next.awayTeamPlaceholder &&
    isFixtureBettingWindowOpen(next, now)
    ? next
    : null;
}

function validateParticipantId(value: unknown): ParticipantId {
  if (
    typeof value !== "string" ||
    !PARTICIPANTS.some((participant) => participant.id === value)
  ) {
    badRequest("参与者无效。", 400);
  }
  return value as ParticipantId;
}

function resolveOffers(
  selections: BetSelectionInput[],
  availableOffers: (typeof oddsOffers.$inferSelect)[]
) {
  const resolved = selections.map((selection) => {
    const requestedId = selection.offerId ?? selection.id;
    let offer = requestedId
      ? availableOffers.find((candidate) => candidate.id === requestedId)
      : undefined;
    if (!offer && selection.marketType && selection.selectionCode) {
      offer = availableOffers.find(
        (candidate) =>
          candidate.marketType === selection.marketType &&
          candidate.selectionCode === selection.selectionCode
      );
    }
    if (!offer) badRequest("所选赔率不存在、已停用或不属于本场比赛。", 409);
    if (
      selection.odds !== undefined &&
      (!Number.isFinite(selection.odds) || Math.abs(selection.odds - offer.odds) > 1e-9)
    ) {
      badRequest("赔率已经变化，请刷新后重新确认。", 409);
    }
    return offer;
  });
  if (new Set(resolved.map((offer) => offer.id)).size !== resolved.length) {
    badRequest("同一个赔率选项不能重复下注。", 400);
  }
  return resolved;
}

function resolveEditableSelections(
  selections: BetSelectionInput[],
  availableOffers: (typeof oddsOffers.$inferSelect)[],
  lockedBets: (typeof bets.$inferSelect)[],
) {
  const resolved = selections.map((selection) => {
    const requestedId = selection.offerId ?? selection.id;
    const lockedBet = requestedId
      ? lockedBets.find((candidate) => candidate.offerId === requestedId)
      : selection.marketType && selection.selectionCode
        ? lockedBets.find(
            (candidate) =>
              normalizeMarketValue(candidate.marketType) ===
                normalizeMarketValue(selection.marketType!) &&
              normalizeMarketValue(candidate.selectionCode) ===
                normalizeMarketValue(selection.selectionCode!),
          )
        : undefined;
    const lockedOddsMatch =
      lockedBet &&
      (selection.odds === undefined ||
        (Number.isFinite(selection.odds) &&
          Math.abs(selection.odds - lockedBet.odds) <= 1e-9));
    if (lockedBet && lockedOddsMatch) {
      return {
        offerId: lockedBet.offerId,
        marketType: lockedBet.marketType,
        selectionCode: lockedBet.selectionCode,
        label: lockedBet.label,
        odds: lockedBet.odds,
      };
    }

    const [offer] = resolveOffers([selection], availableOffers);
    return {
      offerId: offer.id,
      marketType: offer.marketType,
      selectionCode: offer.selectionCode,
      label: offer.label,
      odds: offer.odds,
    };
  });
  if (new Set(resolved.map((selection) => selection.offerId)).size !== resolved.length) {
    badRequest("同一个赔率选项不能重复下注。", 400);
  }
  return resolved;
}

function normalizeMarketValue(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function selectionsMatchLockedBets(
  selections: BetSelectionInput[],
  lockedBets: (typeof bets.$inferSelect)[],
): boolean {
  if (selections.length !== lockedBets.length) return false;
  const matchedBetIds = new Set<string>();

  for (const selection of selections) {
    const requestedId = selection.offerId ?? selection.id;
    let matched = requestedId
      ? lockedBets.find((bet) => bet.offerId === requestedId)
      : undefined;
    if (!matched && selection.marketType && selection.selectionCode) {
      const marketType = normalizeMarketValue(selection.marketType);
      const selectionCode = normalizeMarketValue(selection.selectionCode);
      matched = lockedBets.find(
        (bet) =>
          normalizeMarketValue(bet.marketType) === marketType &&
          normalizeMarketValue(bet.selectionCode) === selectionCode,
      );
    }
    if (!matched || matchedBetIds.has(matched.id)) return false;
    if (
      selection.odds !== undefined &&
      (!Number.isFinite(selection.odds) || Math.abs(selection.odds - matched.odds) > 1e-9)
    ) {
      return false;
    }
    matchedBetIds.add(matched.id);
  }

  return matchedBetIds.size === lockedBets.length;
}

async function lockedBetsForParticipant(
  db: Database,
  fixtureId: string,
  participantId: ParticipantId,
) {
  return db
    .select()
    .from(bets)
    .where(
      and(eq(bets.fixtureId, fixtureId), eq(bets.participantId, participantId)),
    );
}

async function lockEntry(
  db: Database,
  payload:
    | Extract<StateMutationRequest, { action: "place-bets" }>
    | Extract<StateMutationRequest, { action: "lock-entry" }>,
  now: string
) {
  const participantId = validateParticipantId(payload.participantId);
  if (!Array.isArray(payload.selections)) badRequest("selections 必须是数组。", 400);
  if (payload.selections.length === 0) {
    badRequest("锁定加入奖池前至少要选择1注。", 400);
  }
  if (payload.selections.length > MAX_BETS_PER_PARTICIPANT) {
    badRequest(`每人每场最多${MAX_BETS_PER_PARTICIPANT}注。`, 400);
  }

  const [existingEntry] = await db
    .select({
      id: fixtureEntries.id,
      editUnlockedAt: fixtureEntries.editUnlockedAt,
      revision: fixtureEntries.revision,
    })
    .from(fixtureEntries)
    .where(
      and(
        eq(fixtureEntries.fixtureId, payload.fixtureId),
        eq(fixtureEntries.participantId, participantId)
      )
    )
    .limit(1);
  // Retry-safe even if the first successful response was lost or the global
  // lock time passed between attempts. An administrator can separately grant
  // this participant a time-limited edit permission for the active fixture.
  if (existingEntry) {
    const lockedBets = await lockedBetsForParticipant(
      db,
      payload.fixtureId,
      participantId,
    );
    if (existingEntry.editUnlockedAt === null) {
      if (selectionsMatchLockedBets(payload.selections, lockedBets)) return;
      badRequest("该参与者已经锁定，本场下注不能修改。", 409);
    }

    const entryRevision =
      "entryRevision" in payload ? payload.entryRevision : undefined;
    if (
      !Number.isSafeInteger(entryRevision) ||
      entryRevision !== existingEntry.revision
    ) {
      badRequest("下注状态已经变化，请刷新页面后再确认。", 409);
    }

    const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
    const activeFixture = activeFixtureForRows(fixtureRows, now);
    if (!activeFixture || activeFixture.id !== payload.fixtureId) {
      badRequest("本场已到锁定时间，原注单保持有效，不能再修改。", 423);
    }
    if (lockedBets.some((bet) => bet.status !== "pending")) {
      badRequest("本场注单已进入结算流程，不能再修改。", 409);
    }

    const availableOffers = await db
      .select()
      .from(oddsOffers)
      .where(and(eq(oddsOffers.fixtureId, payload.fixtureId), eq(oddsOffers.active, true)));
    const selectedOffers = resolveEditableSelections(
      payload.selections,
      availableOffers,
      lockedBets,
    );

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(fixtureEntries)
        .set({
          betCount: selectedOffers.length,
          stakeCents: selectedOffers.length * STAKE_CENTS,
          lockedAt: now,
          editUnlockedAt: null,
          revision: existingEntry.revision + 1,
        })
        .where(
          and(
            eq(fixtureEntries.id, existingEntry.id),
            eq(fixtureEntries.revision, existingEntry.revision),
          ),
        )
        .returning({ id: fixtureEntries.id });
      if (updated.length !== 1) {
        badRequest("下注状态已经变化，请刷新页面后再确认。", 409);
      }
      await tx
        .delete(bets)
        .where(
          and(
            eq(bets.fixtureId, payload.fixtureId),
            eq(bets.participantId, participantId),
          ),
        );
      await tx.insert(bets).values(
        selectedOffers.map((offer) => ({
          id: crypto.randomUUID(),
          fixtureId: payload.fixtureId,
          participantId,
          offerId: offer.offerId,
          marketType: offer.marketType,
          selectionCode: offer.selectionCode,
          label: offer.label,
          odds: offer.odds,
          stakeCents: STAKE_CENTS,
          placedAt: now,
          status: "pending",
        })),
      );
    });
    return;
  }

  const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
  const requestedFixture = fixtureRows.find((fixture) => fixture.id === payload.fixtureId);
  if (
    requestedFixture &&
    (requestedFixture.homeTeamPlaceholder || requestedFixture.awayTeamPlaceholder)
  ) {
    badRequest("本场对阵尚未确认，暂不能下注。", 423);
  }
  const activeFixture = activeFixtureForRows(fixtureRows, now);
  if (!activeFixture || activeFixture.id !== payload.fixtureId) {
    badRequest("本场当前不可下注：只有下一场未开赛比赛可操作，且开赛前2小时锁定。", 423);
  }

  const availableOffers = await db
    .select()
    .from(oddsOffers)
    .where(and(eq(oddsOffers.fixtureId, payload.fixtureId), eq(oddsOffers.active, true)));
  if (availableOffers.length === 0) {
    badRequest("本场赔率尚未配置，暂不能下注。", 423);
  }
  const selectedOffers = resolveOffers(payload.selections, availableOffers);
  const participantExists = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.active, true)))
    .limit(1);
  if (!participantExists[0]) badRequest("参与者无效或已停用。", 400);

  const entryId = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(fixtureEntries).values({
        id: entryId,
        fixtureId: payload.fixtureId,
        participantId,
        betCount: selectedOffers.length,
        stakeCents: selectedOffers.length * STAKE_CENTS,
        lockedAt: now,
      }),
      db.insert(bets).values(
        selectedOffers.map((offer) => ({
          id: crypto.randomUUID(),
          fixtureId: payload.fixtureId,
          participantId,
          offerId: offer.id,
          marketType: offer.marketType,
          selectionCode: offer.selectionCode,
          label: offer.label,
          odds: offer.odds,
          stakeCents: STAKE_CENTS,
          placedAt: now,
          status: "pending",
        })),
      ),
    ]);
  } catch (error) {
    // Two first-time requests can race past the initial read. The libSQL batch is
    // atomic, so a unique-entry conflict leaves exactly one complete entry.
    if (!errorChainIncludes(error, "UNIQUE constraint failed")) throw error;
    const [racedEntry] = await db
      .select({ id: fixtureEntries.id })
      .from(fixtureEntries)
      .where(
        and(
          eq(fixtureEntries.fixtureId, payload.fixtureId),
          eq(fixtureEntries.participantId, participantId),
        ),
      )
      .limit(1);
    if (!racedEntry) throw error;
    const lockedBets = await lockedBetsForParticipant(
      db,
      payload.fixtureId,
      participantId,
    );
    if (!selectionsMatchLockedBets(payload.selections, lockedBets)) {
      badRequest("该参与者已经锁定，本场下注不能修改。", 409);
    }
  }
}

async function setEntryEditUnlocked(
  db: Database,
  payload: SetEntryEditUnlockedRequest,
  now: string,
) {
  const participantId = validateParticipantId(payload.participantId);
  if (typeof payload.unlocked !== "boolean") {
    badRequest("unlocked 必须是布尔值。", 400);
  }

  const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
  const activeFixture = activeFixtureForRows(fixtureRows, now);
  if (!activeFixture || activeFixture.id !== payload.fixtureId) {
    badRequest("只能调整当前开放投注比赛，且必须早于固定锁定时间。", 423);
  }

  const [entry] = await db
    .select()
    .from(fixtureEntries)
    .where(
      and(
        eq(fixtureEntries.fixtureId, payload.fixtureId),
        eq(fixtureEntries.participantId, participantId),
      ),
    )
    .limit(1);
  if (!entry) badRequest("该参与者本场还没有锁定注单。", 404);

  const alreadyUnlocked = entry.editUnlockedAt !== null;
  if (alreadyUnlocked === payload.unlocked) return;

  await db
    .update(fixtureEntries)
    .set({
      editUnlockedAt: payload.unlocked ? now : null,
      revision: entry.revision + 1,
    })
    .where(
      and(
        eq(fixtureEntries.id, entry.id),
        eq(fixtureEntries.revision, entry.revision),
      ),
    );
}

function validateOfferPayload(payload: UploadOddsRequest) {
  if (!Array.isArray(payload.offers) || payload.offers.length === 0) {
    badRequest("赔率文件至少需要一个 offer。", 400);
  }
  if (payload.offers.length > 250) badRequest("单场最多上传250个赔率选项。", 400);
  const keys = new Set<string>();
  for (const [index, offer] of payload.offers.entries()) {
    if (!offer || typeof offer !== "object") badRequest(`第${index + 1}个赔率格式无效。`);
    if (!offer.marketType?.trim() || !offer.selectionCode?.trim() || !offer.label?.trim()) {
      badRequest(`第${index + 1}个赔率缺少 marketType、selectionCode 或 label。`);
    }
    if (!Number.isFinite(offer.odds) || offer.odds <= 1 || offer.odds > 100_000) {
      badRequest(`第${index + 1}个赔率必须是大于1的有效十进制赔率。`);
    }
    const key = `${offer.marketType.trim().toUpperCase()}::${offer.selectionCode
      .trim()
      .toUpperCase()}`;
    if (keys.has(key)) badRequest(`第${index + 1}个赔率与前面的选项重复。`);
    keys.add(key);
  }
}

async function uploadOdds(db: Database, payload: UploadOddsRequest, now: string) {
  validateOfferPayload(payload);
  const [fixture] = await db
    .select()
    .from(fixtures)
    .where(eq(fixtures.id, payload.fixtureId))
    .limit(1);
  if (!fixture) badRequest("比赛不存在。", 404);
  if (Date.parse(now) >= Date.parse(fixture.lockAt)) {
    badRequest("比赛已锁定，不能再上传或替换赔率。", 423);
  }

  const existingIds = new Set(
    (await db.select({ id: oddsOffers.id }).from(oddsOffers)).map((row) => row.id)
  );
  const inputIds = new Set<string>();
  const source = payload.source?.trim() || "manual-upload";
  const values = payload.offers.map((offer) => {
    let id = offer.id?.trim();
    if (!id || existingIds.has(id) || inputIds.has(id)) {
      id = `${payload.fixtureId}-${crypto.randomUUID()}`;
    }
    inputIds.add(id);
    return {
      id,
      fixtureId: payload.fixtureId,
      marketType: offer.marketType.trim().toUpperCase().replace(/[\s-]+/g, "_"),
      selectionCode: offer.selectionCode.trim().toUpperCase().replace(/\s+/g, "_"),
      label: offer.label.trim(),
      odds: offer.odds,
      rulesText: offer.rulesText?.trim() || DEFAULT_RULES_TEXT,
      source: offer.source?.trim() || source,
      active: true,
      uploadedAt: now,
    };
  });

  await db
    .update(oddsOffers)
    .set({ active: false })
    .where(and(eq(oddsOffers.fixtureId, payload.fixtureId), eq(oddsOffers.active, true)));
  await db.insert(oddsOffers).values(values);
  if (payload.providerMatchId !== undefined) {
    await db
      .update(fixtures)
      .set({
        providerMatchId:
          payload.providerMatchId === null ? null : String(payload.providerMatchId).trim() || null,
        updatedAt: now,
      })
      .where(eq(fixtures.id, payload.fixtureId));
  }
}

async function persistProgression(
  db: Database,
  sourceFixtureId: string,
  winnerSide: KnockoutWinnerSide,
  now: string,
) {
  try {
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
  } catch (error) {
    if (error instanceof FixtureProgressionError) badRequest(error.message, 409);
    throw error;
  }
}

interface SettleInput {
  fixtureId: string;
  halfHome: number | null;
  halfAway: number | null;
  regularHome: number;
  regularAway: number;
  winnerSide: KnockoutWinnerSide;
  source: "external-provider" | "api-football" | "football-data.org" | "manual";
  note: string;
  now: string;
}

function settlementMatchesInput(
  settlement: typeof settlements.$inferSelect,
  input: SettleInput,
): boolean {
  return (
    settlement.regularHome === input.regularHome &&
    settlement.regularAway === input.regularAway &&
    settlement.halfHome === input.halfHome &&
    settlement.halfAway === input.halfAway
  );
}

function settlementRegulationMatchesInput(
  settlement: typeof settlements.$inferSelect,
  input: SettleInput,
): boolean {
  return (
    settlement.regularHome === input.regularHome &&
    settlement.regularAway === input.regularAway
  );
}

async function settleFixture(db: Database, input: SettleInput) {
  const fixtureRows = await db.select().from(fixtures).orderBy(asc(fixtures.sequence));
  const fixture = fixtureRows.find((row) => row.id === input.fixtureId);
  if (!fixture) badRequest("比赛不存在。", 404);
  if (fixture.status === "settled") {
    const [existingSettlement] = await db
      .select()
      .from(settlements)
      .where(eq(settlements.fixtureId, fixture.id))
      .limit(1);
    if (
      existingSettlement &&
      settlementRegulationMatchesInput(existingSettlement, input)
    ) {
      await persistProgression(
        db,
        fixture.id,
        input.winnerSide,
        input.now,
      );
      return;
    }
    badRequest("本场已经按另一份赛果结算，不能覆盖。", 409);
  }

  if (!fixtureTeamsAreResolved(fixture)) {
    badRequest("本场对阵尚未确认，不能录入或结算赛果。", 409);
  }

  const blockingPrior = fixtureRows.find(
    (row) =>
      row.sequence < fixture.sequence &&
      (row.status !== "settled" || row.winnerSide === null),
  );
  if (blockingPrior) {
    badRequest(`请先完成${blockingPrior.matchCode}的结算，避免后续注金倒灌前场奖池。`, 409);
  }

  const fixtureBets = await db
    .select()
    .from(bets)
    .where(eq(bets.fixtureId, fixture.id))
    .orderBy(asc(bets.placedAt), asc(bets.id));
  const score = { home: input.regularHome, away: input.regularAway };
  const halfTimeScore =
    input.halfHome === null || input.halfAway === null
      ? null
      : { home: input.halfHome, away: input.halfAway };
  const graded = fixtureBets.map((bet) => ({
    bet,
    grade: gradeSelection(bet.marketType, bet.selectionCode, score, halfTimeScore),
  }));
  const unsupported = graded.filter((item) => item.grade === "unsupported");
  if (unsupported.length > 0) {
    const message = `有${unsupported.length}注无法仅凭常规时间比分自动判定，需要人工复核。`;
    const [firstUnsupported, ...remainingUnsupported] = unsupported;
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
          halfHome: halfTimeScore?.home ?? null,
          halfAway: halfTimeScore?.away ?? null,
          regularHome: score.home,
          regularAway: score.away,
          resultSource: input.source,
          resultBasis: RESULT_BASIS,
          reviewNote: `${message} ${input.note}`.trim(),
          updatedAt: input.now,
        })
        .where(eq(fixtures.id, fixture.id)),
      db.insert(resultAudits).values({
        id: crypto.randomUUID(),
        fixtureId: fixture.id,
        source: input.source,
        outcome: "review_required",
        message,
        providerStatus:
          input.source === "api-football"
            ? "FT"
            : input.source === "football-data.org"
              ? "FINISHED"
              : "MANUAL",
        halfHome: halfTimeScore?.home ?? null,
        halfAway: halfTimeScore?.away ?? null,
        regularHome: score.home,
        regularAway: score.away,
        createdAt: input.now,
      }),
    ] as const);
    return;
  }

  const eligibleFixtureIds = fixtureRows
    .filter((row) => row.sequence <= fixture.sequence)
    .map((row) => row.id);
  const allBets = await db.select().from(bets);
  const eligibleBets = allBets.filter((bet) => eligibleFixtureIds.includes(bet.fixtureId));
  const priorFixtureIds = new Set(
    fixtureRows.filter((row) => row.sequence < fixture.sequence).map((row) => row.id)
  );
  const priorStakeCents = eligibleBets
    .filter((bet) => priorFixtureIds.has(bet.fixtureId))
    .reduce((sum, bet) => sum + bet.stakeCents, 0);
  const priorPaidCents = eligibleBets
    .filter((bet) => priorFixtureIds.has(bet.fixtureId))
    .reduce((sum, bet) => sum + bet.payoutCents, 0);
  const poolBeforeCents = Math.max(0, priorStakeCents - priorPaidCents);
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

  const settlementValue = {
    fixtureId: fixture.id,
    halfHome: halfTimeScore?.home ?? null,
    halfAway: halfTimeScore?.away ?? null,
    regularHome: score.home,
    regularAway: score.away,
    resultBasis: RESULT_BASIS,
    resultSource: input.source,
    poolBeforeCents,
    currentFixtureStakeCents,
    eligiblePoolCents,
    theoreticalPayoutCents: poolSettlement.totalDueFen,
    paidCents: poolSettlement.totalPayoutFen,
    scaleBps:
      poolSettlement.totalDueFen === 0
        ? 10_000
        : Math.round((poolSettlement.totalPayoutFen / poolSettlement.totalDueFen) * 10_000),
    note: input.note,
    settledAt: input.now,
  };
  try {
    // The settlement PK is the concurrency guard. It intentionally has no
    // conflict-ignore clause: if another request wins, this entire libSQL batch
    // rolls back instead of overwriting bets/fixture with a second result.
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
            settledAt: input.now,
          })
          .where(eq(bets.id, item.bet.id));
      }),
      db
        .update(fixtures)
        .set({
          status: "settled",
          halfHome: halfTimeScore?.home ?? null,
          halfAway: halfTimeScore?.away ?? null,
          regularHome: score.home,
          regularAway: score.away,
          resultSource: input.source,
          resultBasis: RESULT_BASIS,
          reviewNote: null,
          settledAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(fixtures.id, fixture.id)),
      db.insert(resultAudits).values({
        id: crypto.randomUUID(),
        fixtureId: fixture.id,
        source: input.source,
        outcome: "settled",
        message: input.note,
        providerStatus:
          input.source === "api-football"
            ? "FT"
            : input.source === "football-data.org"
              ? "FINISHED"
              : "MANUAL",
        halfHome: halfTimeScore?.home ?? null,
        halfAway: halfTimeScore?.away ?? null,
        regularHome: score.home,
        regularAway: score.away,
        createdAt: input.now,
      }),
    ] as const);
  } catch (error) {
    if (!errorChainIncludes(error, "UNIQUE constraint failed")) throw error;
    const [existingSettlement] = await db
      .select()
      .from(settlements)
      .where(eq(settlements.fixtureId, fixture.id))
      .limit(1);
    if (!existingSettlement) throw error;
    if (!settlementMatchesInput(existingSettlement, input)) {
      badRequest("本场已经按另一份赛果结算，不能覆盖。", 409);
    }
  }
  // Settlement and bracket advancement are deliberately separate. If the
  // process stops between them, the settled fixture remains winner-less and is
  // picked up by the next sync; this verified transaction is therefore safely
  // retryable without ever rolling back a valid 90-minute pool settlement.
  await persistProgression(db, fixture.id, input.winnerSide, input.now);
}

async function manualResult(db: Database, payload: ManualResultRequest, now: string) {
  const hasHalf = payload.halfHome !== undefined || payload.halfAway !== undefined;
  const regularTimeScore = {
    home: payload.regulationHome,
    away: payload.regulationAway,
  };
  const scoreError = matchScoreValidationError(
    regularTimeScore,
    hasHalf ? { home: payload.halfHome, away: payload.halfAway } : null,
  );
  if (scoreError) badRequest(scoreError, 400);
  if (
    payload.winnerSide !== undefined &&
    payload.winnerSide !== "home" &&
    payload.winnerSide !== "away"
  ) {
    badRequest("实际晋级方必须选择主队或客队。", 400);
  }
  const scoreWinnerSide = winnerSideFromRegulationScore(regularTimeScore);
  if (
    scoreWinnerSide &&
    payload.winnerSide &&
    payload.winnerSide !== scoreWinnerSide
  ) {
    badRequest("90分钟比分已有胜方，实际晋级方不能与比分冲突。", 400);
  }
  const winnerSide = scoreWinnerSide ?? payload.winnerSide;
  if (!winnerSide) {
    badRequest("90分钟战平时，请选择加时或点球后的实际晋级方。", 400);
  }
  if (typeof payload.reason !== "string" || payload.reason.trim().length < 3) {
    badRequest("人工录入必须填写复核原因。", 400);
  }
  const [fixture] = await db
    .select()
    .from(fixtures)
    .where(eq(fixtures.id, payload.fixtureId))
    .limit(1);
  if (!fixture) badRequest("比赛不存在。", 404);
  if (Date.parse(now) < Date.parse(fixture.kickoffAt)) {
    badRequest("比赛尚未开赛，不能录入赛果。", 409);
  }
  await settleFixture(db, {
    fixtureId: payload.fixtureId,
    halfHome: hasHalf ? (payload.halfHome as number) : null,
    halfAway: hasHalf ? (payload.halfAway as number) : null,
    regularHome: payload.regulationHome,
    regularAway: payload.regulationAway,
    winnerSide,
    source: "manual",
    note: `人工复核：${payload.reason.trim()}；仅按90分钟及伤停补时。`,
    now,
  });
}

export async function GET() {
  try {
    const db = getDb();
    return Response.json(await loadState(db));
  } catch (error) {
    return Response.json(
      { error: messageForError(error) },
      { status: statusForError(error) }
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as StateMutationRequest;
    if (!payload || typeof payload !== "object" || !("action" in payload)) {
      badRequest("请求格式无效。", 400);
    }
    if (
      (payload.action === "set-entry-edit-unlocked" ||
        payload.action === "upload-odds" ||
        payload.action === "manual-result") &&
      !(await hasValidAdminSession(request))
    ) {
      badRequest("请先输入管理密码。", 401);
    }
    const db = getDb();
    await ensureSeedData(db);
    const now = new Date().toISOString();

    if (payload.action === "place-bets" || payload.action === "lock-entry") {
      await lockEntry(db, payload, now);
    } else if (payload.action === "set-entry-edit-unlocked") {
      await setEntryEditUnlocked(db, payload, now);
    } else if (payload.action === "upload-odds") {
      await uploadOdds(db, payload, now);
    } else if (payload.action === "manual-result") {
      await manualResult(db, payload, now);
    } else {
      badRequest("不支持的 action。", 400);
    }

    return Response.json(await loadState(db, now));
  } catch (error) {
    return Response.json(
      { error: messageForError(error) },
      { status: statusForError(error) }
    );
  }
}
