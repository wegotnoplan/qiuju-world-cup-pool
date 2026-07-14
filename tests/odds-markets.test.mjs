import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeedState,
  deriveFixtureStates,
  gradeSelection,
  matchScoreValidationError,
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

test("keeps later fixtures locked until the prior fixture settles", () => {
  const now = "2026-07-14T12:00:00+08:00";
  const seed = createSeedState(now);
  assert.equal(seed.activeFixtureId, "wc2026-m101");

  const waiting = deriveFixtureStates(
    seed.fixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, recordStatus: "review_required" } : fixture,
    ),
    now,
  );
  assert.equal(waiting.activeFixtureId, null);

  const advanced = deriveFixtureStates(
    seed.fixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, recordStatus: "settled" } : fixture,
    ),
    now,
  );
  assert.equal(advanced.activeFixtureId, "wc2026-m102");
});
