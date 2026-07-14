import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeedState,
  deriveFixtureStates,
  gradeSelection,
  matchScoreValidationError,
  normalizeApiFootballFixture,
} from "../lib/app-data.ts";
import { ALL_SEED_ODDS, SEED_ODDS_BY_FIXTURE } from "../lib/seed-odds.ts";

test("seeds all screenshot options for the first two fixtures", () => {
  assert.equal(SEED_ODDS_BY_FIXTURE["wc2026-m101"].length, 54);
  assert.equal(SEED_ODDS_BY_FIXTURE["wc2026-m102"].length, 54);
  assert.equal(ALL_SEED_ODDS.length, 108);
  assert.equal(new Set(ALL_SEED_ODDS.map((offer) => offer.id)).size, 108);
  for (const offer of ALL_SEED_ODDS) {
    assert.notEqual(
      gradeSelection(
        offer.marketType,
        offer.selectionCode,
        { home: 2, away: 1 },
        { home: 1, away: 0 },
      ),
      "unsupported",
      `${offer.marketType}/${offer.selectionCode} must be auto-gradable`,
    );
  }
});

test("grades screenshot-only markets from half-time and regulation scores", () => {
  const halfTime = { home: 0, away: 0 };
  const regulation = { home: 2, away: 1 };

  assert.equal(
    gradeSelection("HANDICAP_1X2_HOME_MINUS_1", "DRAW", regulation, halfTime),
    "won",
  );
  assert.equal(gradeSelection("TOTAL_GOALS_EXACT", "3", regulation, halfTime), "won");
  assert.equal(gradeSelection("HALF_FULL_TIME", "DRAW_HOME", regulation, halfTime), "won");
  assert.equal(gradeSelection("EXACT_SCORE", "2-1", regulation, halfTime), "won");
  assert.equal(gradeSelection("EXACT_SCORE", "HOME_OTHER", regulation, halfTime), "lost");
});

test("grades the three exact-score other buckets without overlap", () => {
  assert.equal(gradeSelection("EXACT_SCORE", "HOME_OTHER", { home: 6, away: 1 }), "won");
  assert.equal(gradeSelection("EXACT_SCORE", "DRAW_OTHER", { home: 4, away: 4 }), "won");
  assert.equal(gradeSelection("EXACT_SCORE", "AWAY_OTHER", { home: 3, away: 6 }), "won");
  assert.equal(gradeSelection("EXACT_SCORE", "AWAY_OTHER", { home: 0, away: 5 }), "lost");
});

test("half-full-time requires an explicit half-time score", () => {
  assert.equal(
    gradeSelection("HALF_FULL_TIME", "DRAW_HOME", { home: 2, away: 1 }),
    "unsupported",
  );
});

test("rejects impossible half-time and 90-minute score combinations", () => {
  assert.equal(
    matchScoreValidationError(
      { home: 2, away: 1 },
      { home: 3, away: 0 },
    ),
    "半场比分不能大于90分钟比分。",
  );
  assert.equal(
    matchScoreValidationError(
      { home: 2, away: 1 },
      { home: 1, away: 0 },
    ),
    null,
  );
  assert.match(
    matchScoreValidationError(
      { home: -1, away: 1 },
      null,
    ),
    /90分钟比分/,
  );
});

test("API-Football ET, AET and PEN results settle strictly from score.fulltime", () => {
  const enteringExtraTime = normalizeApiFootballFixture({
    fixture: { status: { short: "ET" } },
    goals: { home: 1, away: 1 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 1, away: 1 },
      extratime: { home: 0, away: 0 },
      penalty: { home: null, away: null },
    },
  });
  assert.equal(enteringExtraTime.outcome, "ready");
  assert.deepEqual(enteringExtraTime.regularTime, { home: 1, away: 1 });

  const afterExtraTime = normalizeApiFootballFixture({
    fixture: { status: { short: "AET" } },
    goals: { home: 3, away: 2 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 1, away: 1 },
      extratime: { home: 3, away: 2 },
      penalty: { home: null, away: null },
    },
  });
  assert.equal(afterExtraTime.outcome, "ready");
  assert.deepEqual(afterExtraTime.regularTime, { home: 1, away: 1 });

  const afterPenalties = normalizeApiFootballFixture({
    fixture: { status: { short: "PEN" } },
    goals: { home: 6, away: 5 },
    score: {
      halftime: { home: 0, away: 0 },
      fulltime: { home: 0, away: 0 },
      extratime: { home: 1, away: 1 },
      penalty: { home: 5, away: 4 },
    },
  });
  assert.equal(afterPenalties.outcome, "ready");
  assert.deepEqual(afterPenalties.regularTime, { home: 0, away: 0 });
});

test("API-Football stores halftime but does not settle during regulation play", () => {
  const live = normalizeApiFootballFixture({
    fixture: { status: { short: "2H" } },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 1 },
    },
  });
  assert.equal(live.outcome, "waiting");
  assert.deepEqual(live.halfTime, { home: 1, away: 0 });
  assert.equal(live.regularTime, null);
});

test("API-Football waits instead of requesting review while fulltime data is publishing", () => {
  const enteringExtraTime = normalizeApiFootballFixture({
    fixture: { status: { short: "ET" } },
    score: {
      halftime: { home: 0, away: 1 },
      fulltime: { home: null, away: null },
    },
  });
  assert.equal(enteringExtraTime.outcome, "waiting");
  assert.deepEqual(enteringExtraTime.halfTime, { home: 0, away: 1 });
  assert.equal(enteringExtraTime.regularTime, null);
});

test("keeps later fixtures locked until the prior fixture settles", () => {
  const now = "2026-07-14T12:00:00+08:00";
  const seed = createSeedState(now);
  assert.equal(seed.activeFixtureId, null, "fixtures without active odds stay locked");
  const configuredFixtures = seed.fixtures.map((fixture, index) =>
    index < 2
      ? {
          ...fixture,
          offers: [
            {
              id: `${fixture.id}-test-home`,
              fixtureId: fixture.id,
              marketType: "MATCH_RESULT",
              selectionCode: "HOME",
              label: `${fixture.homeTeam.name}胜`,
              odds: 2,
              rulesText: "90分钟",
              source: "test",
              active: true,
              uploadedAt: now,
            },
          ],
        }
      : fixture,
  );
  const ready = deriveFixtureStates(configuredFixtures, now);
  assert.equal(ready.activeFixtureId, "wc2026-m101");

  const waiting = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, recordStatus: "review_required" } : fixture,
    ),
    now,
  );
  assert.equal(waiting.activeFixtureId, null);

  const advanced = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, recordStatus: "settled" } : fixture,
    ),
    now,
  );
  assert.equal(advanced.activeFixtureId, "wc2026-m102");

  const placeholdersRemainLocked = deriveFixtureStates(
    configuredFixtures.map((fixture, index) => ({
      ...fixture,
      recordStatus: index < 2 ? "settled" : fixture.recordStatus,
      offers:
        index === 2
          ? [{ ...configuredFixtures[0].offers[0], id: "m103-test", fixtureId: fixture.id }]
          : fixture.offers,
    })),
    now,
  );
  assert.equal(
    placeholdersRemainLocked.activeFixtureId,
    null,
    "active odds must not unlock a fixture whose teams are placeholders",
  );
});
