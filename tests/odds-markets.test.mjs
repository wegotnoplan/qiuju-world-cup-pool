import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeedState,
  deriveFixtureStates,
  gradeSelection,
  isGradeableOddsSelection,
  isFixtureBettingWindowOpen,
  isManualReviewOpen,
  knockoutResultValidationError,
  MANUAL_REVIEW_DELAY_MS,
  manualReviewOpensAt,
  matchScoreValidationError,
  normalizeApiFootballFixture,
  winnerSideFromKnockoutScores,
} from "../lib/app-data.ts";
import { ALL_SEED_ODDS, SEED_ODDS_BY_FIXTURE } from "../lib/seed-odds.ts";
import { settlePool } from "../lib/settlement.ts";

test("seeds all screenshot options for the first two fixtures", () => {
  assert.equal(SEED_ODDS_BY_FIXTURE["wc2026-m101"].length, 54);
  assert.equal(SEED_ODDS_BY_FIXTURE["wc2026-m102"].length, 54);
  assert.equal(ALL_SEED_ODDS.length, 108);
  assert.equal(new Set(ALL_SEED_ODDS.map((offer) => offer.id)).size, 108);
  for (const offer of ALL_SEED_ODDS) {
    assert.equal(
      isGradeableOddsSelection(offer.marketType, offer.selectionCode),
      true,
      `${offer.marketType}/${offer.selectionCode} must be auto-gradable`,
    );
  }
  assert.equal(isGradeableOddsSelection("UNKNOWN_MARKET", "HOME"), false);
  assert.equal(isGradeableOddsSelection("ASIAN_HANDICAP", "HOME:+0.25"), false);
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

test("validates and derives regulation, extra-time, and shoot-out winners", () => {
  const cases = [
    {
      name: "90-minute home win",
      regulation: { home: 2, away: 1 },
      extraTime: null,
      penalty: null,
      winnerSide: "home",
    },
    {
      name: "extra-time home win after a regulation draw",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 1 },
      penalty: null,
      winnerSide: "home",
    },
    {
      name: "away shoot-out win after regulation and extra-time draws",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 2 },
      penalty: { home: 4, away: 5 },
      winnerSide: "away",
    },
  ];

  for (const fixtureCase of cases) {
    assert.equal(
      knockoutResultValidationError(
        fixtureCase.regulation,
        fixtureCase.extraTime,
        fixtureCase.penalty,
      ),
      null,
      fixtureCase.name,
    );
    assert.equal(
      winnerSideFromKnockoutScores(
        fixtureCase.regulation,
        fixtureCase.extraTime,
        fixtureCase.penalty,
      ),
      fixtureCase.winnerSide,
      fixtureCase.name,
    );
  }
});

test("rejects incomplete or contradictory knockout score branches", () => {
  const invalidCases = [
    {
      name: "extra time after a regulation winner",
      regulation: { home: 2, away: 1 },
      extraTime: { home: 3, away: 1 },
      penalty: null,
      message: /90分钟已有胜方/,
    },
    {
      name: "missing extra time after a regulation draw",
      regulation: { home: 1, away: 1 },
      extraTime: null,
      penalty: null,
      message: /必须填写加时赛结束后的累计比分/,
    },
    {
      name: "incomplete extra-time score",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2 },
      penalty: null,
      message: /加时赛比分必须同时填写/,
    },
    {
      name: "extra-time cumulative score below regulation",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 0, away: 1 },
      penalty: null,
      message: /不能低于90分钟比分/,
    },
    {
      name: "shoot-out supplied after an extra-time winner",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 1 },
      penalty: { home: 4, away: 3 },
      message: /加时赛已有胜方/,
    },
    {
      name: "missing shoot-out after an extra-time draw",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 2 },
      penalty: null,
      message: /必须填写点球大战比分/,
    },
    {
      name: "incomplete shoot-out score",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 2 },
      penalty: { home: 4 },
      message: /点球比分必须同时填写/,
    },
    {
      name: "drawn shoot-out",
      regulation: { home: 1, away: 1 },
      extraTime: { home: 2, away: 2 },
      penalty: { home: 4, away: 4 },
      message: /点球大战比分不能为平局/,
    },
  ];

  for (const fixtureCase of invalidCases) {
    assert.match(
      knockoutResultValidationError(
        fixtureCase.regulation,
        fixtureCase.extraTime,
        fixtureCase.penalty,
      ) ?? "",
      fixtureCase.message,
      fixtureCase.name,
    );
  }
});

test("the eventual knockout winner cannot change grading or money for the same 90-minute score", () => {
  const regulation = { home: 1, away: 1 };
  const halfTime = { home: 0, away: 0 };
  const selections = [
    { id: "draw", market: "MATCH_RESULT", pick: "DRAW", odds: 2 },
    { id: "home", market: "MATCH_RESULT", pick: "HOME", odds: 3 },
    { id: "score", market: "EXACT_SCORE", pick: "1-1", odds: 4 },
    { id: "half-full", market: "HALF_FULL_TIME", pick: "DRAW_DRAW", odds: 5 },
  ];

  function resolveAndSettle(extraTime, penalty) {
    const grades = selections.map((selection) =>
      gradeSelection(
        selection.market,
        selection.pick,
        regulation,
        halfTime,
      ),
    );
    return {
      winnerSide: winnerSideFromKnockoutScores(regulation, extraTime, penalty),
      grades,
      settlement: settlePool({
        poolFen: 4_000,
        tickets: selections.map((selection, index) => ({
          ticketId: selection.id,
          ticketSequence: index,
          odds: selection.odds,
          outcome: grades[index],
        })),
      }),
    };
  }

  const homeAfterExtraTime = resolveAndSettle({ home: 2, away: 1 }, null);
  const awayAfterPenalties = resolveAndSettle(
    { home: 2, away: 2 },
    { home: 4, away: 5 },
  );

  assert.equal(homeAfterExtraTime.winnerSide, "home");
  assert.equal(awayAfterPenalties.winnerSide, "away");
  assert.deepEqual(homeAfterExtraTime.grades, ["won", "lost", "won", "won"]);
  assert.deepEqual(awayAfterPenalties.grades, homeAfterExtraTime.grades);
  assert.deepEqual(awayAfterPenalties.settlement, homeAfterExtraTime.settlement);
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

test("API-Football keeps the regulation draw separate from its knockout winner", () => {
  const afterPenalties = normalizeApiFootballFixture({
    fixture: { status: { short: "PEN" } },
    teams: {
      home: { name: "France", winner: false },
      away: { name: "Spain", winner: true },
    },
    goals: { home: 5, away: 6 },
    score: {
      halftime: { home: 0, away: 0 },
      fulltime: { home: 1, away: 1 },
      extratime: { home: 1, away: 1 },
      penalty: { home: 4, away: 5 },
    },
  });

  assert.equal(afterPenalties.outcome, "ready");
  assert.deepEqual(afterPenalties.regularTime, { home: 1, away: 1 });
  assert.equal(afterPenalties.winnerSide, "away");
});

test("API-Football never confirms a knockout winner during ET, BT, or P", () => {
  for (const providerStatus of ["ET", "BT", "P"]) {
    const liveKnockout = normalizeApiFootballFixture({
      fixture: { status: { short: providerStatus } },
      teams: {
        home: { name: "France", winner: true },
        away: { name: "Spain", winner: false },
      },
      score: {
        halftime: { home: 0, away: 0 },
        fulltime: { home: 1, away: 1 },
      },
    });

    assert.equal(liveKnockout.outcome, "ready", providerStatus);
    assert.equal(liveKnockout.winnerSide, null, providerStatus);
  }
});

test("API-Football sends a terminal winner conflicting with a non-draw score to review", () => {
  const conflict = normalizeApiFootballFixture({
    fixture: { status: { short: "FT" } },
    teams: {
      home: { name: "France", winner: false },
      away: { name: "Spain", winner: true },
    },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 1 },
    },
  });

  assert.equal(conflict.outcome, "manual_review");
  assert.equal(conflict.winnerSide, null);
  assert.match(conflict.message, /实际胜方.*冲突/);
});

test("API-Football falls back to the regulation winner when teams.winner is absent", () => {
  const regulationWin = normalizeApiFootballFixture({
    fixture: { status: { short: "FT" } },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 1 },
    },
  });

  assert.equal(regulationWin.outcome, "ready");
  assert.equal(regulationWin.winnerSide, "home");
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
  assert.equal(seed.nextFixtureId, "wc2026-m101");
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
  assert.equal(ready.nextFixtureId, "wc2026-m101");

  const waiting = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, recordStatus: "review_required" } : fixture,
    ),
    now,
  );
  assert.equal(waiting.activeFixtureId, null);
  assert.equal(waiting.nextFixtureId, "wc2026-m101");

  const awaitingKnockoutWinner = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0
        ? { ...fixture, recordStatus: "settled", winnerSide: null }
        : fixture,
    ),
    now,
  );
  assert.equal(awaitingKnockoutWinner.activeFixtureId, null);
  assert.equal(
    awaitingKnockoutWinner.nextFixtureId,
    "wc2026-m101",
    "a settled 90-minute draw remains next until its actual winner is stored",
  );

  const advanced = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0
        ? { ...fixture, recordStatus: "settled", winnerSide: "home" }
        : fixture,
    ),
    now,
  );
  assert.equal(advanced.activeFixtureId, "wc2026-m102");
  assert.equal(advanced.nextFixtureId, "wc2026-m102");

  const afterM102Lock = deriveFixtureStates(
    configuredFixtures.map((fixture, index) =>
      index === 0
        ? { ...fixture, recordStatus: "settled", winnerSide: "home" }
        : fixture,
    ),
    "2026-07-16T01:00:00+08:00",
  );
  assert.equal(afterM102Lock.activeFixtureId, null);
  assert.equal(
    afterM102Lock.nextFixtureId,
    "wc2026-m102",
    "the next fixture remains identifiable after betting locks",
  );

  const placeholdersRemainLocked = deriveFixtureStates(
    configuredFixtures.map((fixture, index) => ({
      ...fixture,
      recordStatus: index < 2 ? "settled" : fixture.recordStatus,
      winnerSide: index < 2 ? "home" : fixture.winnerSide,
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
  assert.equal(placeholdersRemainLocked.nextFixtureId, "wc2026-m103");

  const completed = deriveFixtureStates(
    configuredFixtures.map((fixture) => ({
      ...fixture,
      recordStatus: "settled",
      winnerSide: "home",
    })),
    now,
  );
  assert.equal(completed.activeFixtureId, null);
  assert.equal(completed.nextFixtureId, null);
});

test("keeps all four fixtures selectable while the next fixture advances", () => {
  const now = "2026-07-15T12:00:00+08:00";
  const seed = createSeedState(now);
  const withOffers = seed.fixtures.map((fixture) => ({
    ...fixture,
    offers: [
      {
        id: `${fixture.id}-home`,
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
  }));

  const afterM101 = deriveFixtureStates(
    withOffers.map((fixture) =>
      fixture.matchCode === "M101"
        ? { ...fixture, recordStatus: "settled", winnerSide: "away" }
        : fixture,
    ),
    now,
  );

  assert.deepEqual(
    afterM101.fixtures.map(({ matchCode, status }) => ({ matchCode, status })),
    [
      { matchCode: "M101", status: "settled" },
      { matchCode: "M102", status: "active" },
      { matchCode: "M103", status: "locked" },
      { matchCode: "M104", status: "locked" },
    ],
  );
  assert.equal(afterM101.nextFixtureId, "wc2026-m102");
  assert.equal(afterM101.fixtures.length, 4, "completed fixtures must remain in history");

  const resolvedTeams = afterM101.fixtures.map((fixture) => {
    if (fixture.matchCode === "M102") {
      return { ...fixture, recordStatus: "settled", winnerSide: "home" };
    }
    if (fixture.matchCode === "M103") {
      return {
        ...fixture,
        homeTeam: { code: "FRA", name: "法国", englishName: "France" },
        awayTeam: { code: "ARG", name: "阿根廷", englishName: "Argentina" },
      };
    }
    if (fixture.matchCode === "M104") {
      return {
        ...fixture,
        homeTeam: { code: "ESP", name: "西班牙", englishName: "Spain" },
        awayTeam: { code: "ENG", name: "英格兰", englishName: "England" },
      };
    }
    return fixture;
  });
  const afterM102 = deriveFixtureStates(
    resolvedTeams,
    "2026-07-16T12:00:00+08:00",
  );

  assert.deepEqual(
    afterM102.fixtures.map(({ matchCode, status }) => ({ matchCode, status })),
    [
      { matchCode: "M101", status: "settled" },
      { matchCode: "M102", status: "settled" },
      { matchCode: "M103", status: "active" },
      { matchCode: "M104", status: "locked" },
    ],
  );
  assert.equal(afterM102.nextFixtureId, "wc2026-m103");
  assert.deepEqual(
    afterM102.fixtures.map((fixture) => fixture.matchCode),
    ["M101", "M102", "M103", "M104"],
  );
});

test("manual review opens at the exact kickoff plus three-hour boundary", () => {
  const kickoffAt = "2026-07-15T03:00:00+08:00";
  const kickoffMs = Date.parse(kickoffAt);
  const reviewAt = manualReviewOpensAt(kickoffAt);

  assert.equal(reviewAt, kickoffMs + MANUAL_REVIEW_DELAY_MS);
  assert.equal(isManualReviewOpen(kickoffAt, reviewAt - 1), false, "T+3h-1ms");
  assert.equal(isManualReviewOpen(kickoffAt, reviewAt), true, "T+3h");
  assert.equal(isManualReviewOpen(kickoffAt, reviewAt + 1), true, "T+3h+1ms");
  assert.equal(isManualReviewOpen("not-a-date", reviewAt), false);
  assert.equal(isManualReviewOpen(kickoffAt, "not-a-date"), false);
});

test("the betting window closes exactly at the fixed lock time", () => {
  const seed = createSeedState("2026-07-14T12:00:00+08:00");
  const fixture = seed.fixtures[0];

  assert.equal(
    isFixtureBettingWindowOpen(fixture, "2026-07-15T00:59:59.999+08:00"),
    true,
  );
  assert.equal(
    isFixtureBettingWindowOpen(fixture, "2026-07-15T01:00:00+08:00"),
    false,
  );
});
