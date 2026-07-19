import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const fixtures = sqliteTable(
  "fixtures",
  {
    id: text("id").primaryKey(),
    matchCode: text("match_code").notNull(),
    sequence: integer("sequence").notNull(),
    stage: text("stage").notNull(),
    homeTeamCode: text("home_team_code").notNull(),
    homeTeamName: text("home_team_name").notNull(),
    homeTeamEnglishName: text("home_team_english_name").notNull(),
    homeTeamPlaceholder: integer("home_team_placeholder", { mode: "boolean" })
      .notNull()
      .default(false),
    awayTeamCode: text("away_team_code").notNull(),
    awayTeamName: text("away_team_name").notNull(),
    awayTeamEnglishName: text("away_team_english_name").notNull(),
    awayTeamPlaceholder: integer("away_team_placeholder", { mode: "boolean" })
      .notNull()
      .default(false),
    kickoffAt: text("kickoff_at").notNull(),
    lockAt: text("lock_at").notNull(),
    resultSyncDueAt: text("result_sync_due_at").notNull(),
    providerMatchId: text("provider_match_id"),
    status: text("status").notNull().default("scheduled"),
    winnerSide: text("winner_side"),
    halfHome: integer("half_home"),
    halfAway: integer("half_away"),
    regularHome: integer("regular_home"),
    regularAway: integer("regular_away"),
    afterExtraHome: integer("after_extra_home"),
    afterExtraAway: integer("after_extra_away"),
    penaltyHome: integer("penalty_home"),
    penaltyAway: integer("penalty_away"),
    resultSource: text("result_source"),
    resolutionSource: text("resolution_source"),
    resolvedAt: text("resolved_at"),
    resultBasis: text("result_basis"),
    reviewNote: text("review_note"),
    settledAt: text("settled_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("fixtures_match_code_unique").on(table.matchCode),
    uniqueIndex("fixtures_sequence_unique").on(table.sequence),
    index("fixtures_status_sequence_idx").on(table.status, table.sequence),
  ]
);

export const fixtureEntries = sqliteTable(
  "fixture_entries",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => fixtures.id),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id),
    betCount: integer("bet_count").notNull(),
    stakeCents: integer("stake_cents").notNull(),
    lockedAt: text("locked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    editUnlockedAt: text("edit_unlocked_at"),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    uniqueIndex("fixture_entries_fixture_participant_unique").on(
      table.fixtureId,
      table.participantId
    ),
    index("fixture_entries_fixture_locked_idx").on(table.fixtureId, table.lockedAt),
  ]
);

export const oddsOffers = sqliteTable(
  "odds_offers",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => fixtures.id),
    marketType: text("market_type").notNull(),
    selectionCode: text("selection_code").notNull(),
    label: text("label").notNull(),
    odds: real("odds").notNull(),
    rulesText: text("rules_text").notNull(),
    source: text("source").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    uploadedAt: text("uploaded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("odds_offers_fixture_active_idx").on(table.fixtureId, table.active),
    index("odds_offers_fixture_market_idx").on(table.fixtureId, table.marketType),
  ]
);

export const bets = sqliteTable(
  "bets",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => fixtures.id),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id),
    offerId: text("offer_id")
      .notNull()
      .references(() => oddsOffers.id),
    marketType: text("market_type").notNull(),
    selectionCode: text("selection_code").notNull(),
    label: text("label").notNull(),
    odds: real("odds").notNull(),
    stakeCents: integer("stake_cents").notNull(),
    placedAt: text("placed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    status: text("status").notNull().default("pending"),
    theoreticalPayoutCents: integer("theoretical_payout_cents").notNull().default(0),
    payoutCents: integer("payout_cents").notNull().default(0),
    settledAt: text("settled_at"),
  },
  (table) => [
    uniqueIndex("bets_fixture_participant_offer_unique").on(
      table.fixtureId,
      table.participantId,
      table.offerId
    ),
    index("bets_fixture_idx").on(table.fixtureId),
    index("bets_participant_fixture_idx").on(table.participantId, table.fixtureId),
  ]
);

export const settlements = sqliteTable("settlements", {
  fixtureId: text("fixture_id")
    .primaryKey()
    .references(() => fixtures.id),
  halfHome: integer("half_home"),
  halfAway: integer("half_away"),
  regularHome: integer("regular_home").notNull(),
  regularAway: integer("regular_away").notNull(),
  resultBasis: text("result_basis").notNull(),
  resultSource: text("result_source").notNull(),
  poolBeforeCents: integer("pool_before_cents").notNull(),
  currentFixtureStakeCents: integer("current_fixture_stake_cents").notNull(),
  eligiblePoolCents: integer("eligible_pool_cents").notNull(),
  theoreticalPayoutCents: integer("theoretical_payout_cents").notNull(),
  paidCents: integer("paid_cents").notNull(),
  scaleBps: integer("scale_bps").notNull(),
  note: text("note"),
  settledAt: text("settled_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Immutable terminal-pool ledger. This is intentionally separate from the
 * per-fixture settlement table: closing the pool must not make a terminal
 * bonus look like another match payout or alter the four-match leaderboard.
 */
export const finalPoolClosures = sqliteTable("final_pool_closures", {
  fixtureId: text("fixture_id")
    .primaryKey()
    .references(() => fixtures.id),
  ruleVersion: text("rule_version").notNull(),
  participantCount: integer("participant_count").notNull(),
  remainingPoolCents: integer("remaining_pool_cents").notNull(),
  performancePoolCents: integer("performance_pool_cents").notNull(),
  rankingPoolCents: integer("ranking_pool_cents").notNull(),
  participationPoolCents: integer("participation_pool_cents").notNull(),
  distributedCents: integer("distributed_cents").notNull(),
  undistributedCents: integer("undistributed_cents").notNull(),
  winnersExist: integer("winners_exist", { mode: "boolean" }).notNull(),
  closedAt: text("closed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** One immutable terminal-ledger row per participant. */
export const finalPoolResults = sqliteTable(
  "final_pool_results",
  {
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => finalPoolClosures.fixtureId),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id),
    displayOrder: integer("display_order").notNull(),
    betCount: integer("bet_count").notNull(),
    stakeCents: integer("stake_cents").notNull(),
    normalPayoutCents: integer("normal_payout_cents").notNull(),
    baseNetCents: integer("base_net_cents").notNull(),
    baseRank: integer("base_rank").notNull(),
    m104WinningWeight: integer("m104_winning_weight").notNull(),
    performanceBonusCents: integer("performance_bonus_cents").notNull(),
    rankingBonusCents: integer("ranking_bonus_cents").notNull(),
    participationBonusCents: integer("participation_bonus_cents").notNull(),
    bonusCents: integer("bonus_cents").notNull(),
    totalPayoutCents: integer("total_payout_cents").notNull(),
    finalNetCents: integer("final_net_cents").notNull(),
    finalRank: integer("final_rank").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fixtureId, table.participantId] }),
    index("final_pool_results_fixture_rank_idx").on(
      table.fixtureId,
      table.finalRank,
      table.displayOrder,
    ),
  ],
);

export const resultAudits = sqliteTable(
  "result_audits",
  {
    id: text("id").primaryKey(),
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => fixtures.id),
    source: text("source").notNull(),
    outcome: text("outcome").notNull(),
    message: text("message").notNull(),
    providerStatus: text("provider_status"),
    halfHome: integer("half_home"),
    halfAway: integer("half_away"),
    regularHome: integer("regular_home"),
    regularAway: integer("regular_away"),
    afterExtraHome: integer("after_extra_home"),
    afterExtraAway: integer("after_extra_away"),
    penaltyHome: integer("penalty_home"),
    penaltyAway: integer("penalty_away"),
    winnerSide: text("winner_side"),
    resolutionSource: text("resolution_source"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("result_audits_fixture_created_idx").on(table.fixtureId, table.createdAt)]
);

/**
 * A small persistent cache shared by the widget proxy and result sync.
 * Keeping successful upstream payloads in libSQL prevents every browser tab from
 * spending the API-Football free-plan allowance independently.
 */
export const apiFootballCache = sqliteTable(
  "api_football_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    endpoint: text("endpoint").notNull(),
    responseBody: text("response_body").notNull(),
    upstreamStatus: integer("upstream_status").notNull(),
    quotaLimit: integer("quota_limit"),
    quotaRemaining: integer("quota_remaining"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("api_football_cache_expires_idx").on(table.expiresAt)]
);
