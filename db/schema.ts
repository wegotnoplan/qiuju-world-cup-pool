import { sql } from "drizzle-orm";
import {
  index,
  integer,
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
    halfHome: integer("half_home"),
    halfAway: integer("half_away"),
    regularHome: integer("regular_home"),
    regularAway: integer("regular_away"),
    resultSource: text("result_source"),
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("result_audits_fixture_created_idx").on(table.fixtureId, table.createdAt)]
);

/**
 * A small persistent cache shared by the widget proxy and result sync.
 * Keeping successful upstream payloads in D1 prevents every browser tab from
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
