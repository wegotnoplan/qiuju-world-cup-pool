import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURES, winnerSideFromRegulationScore } from "../lib/app-data.ts";
import {
  fixtureTeamsAreResolved,
  FixtureProgressionError,
  planKnockoutProgression,
} from "../lib/fixture-progression.ts";

function progressionRows() {
  return FIXTURES.map((fixture) => ({
    id: fixture.id,
    matchCode: fixture.matchCode,
    winnerSide: null,
    homeTeamCode: fixture.homeTeam.code,
    homeTeamName: fixture.homeTeam.name,
    homeTeamEnglishName: fixture.homeTeam.englishName,
    homeTeamPlaceholder: fixture.homeTeam.placeholder ?? false,
    awayTeamCode: fixture.awayTeam.code,
    awayTeamName: fixture.awayTeam.name,
    awayTeamEnglishName: fixture.awayTeam.englishName,
    awayTeamPlaceholder: fixture.awayTeam.placeholder ?? false,
  }));
}

function applyPlan(rows, plan) {
  return rows.map((row) => {
    let next =
      row.id === plan.sourceFixtureId
        ? { ...row, winnerSide: plan.winnerSide }
        : { ...row };
    for (const patch of plan.teamPatches) {
      if (patch.fixtureId !== row.id) continue;
      next =
        patch.side === "home"
          ? {
              ...next,
              homeTeamCode: patch.team.code,
              homeTeamName: patch.team.name,
              homeTeamEnglishName: patch.team.englishName,
              homeTeamPlaceholder: false,
            }
          : {
              ...next,
              awayTeamCode: patch.team.code,
              awayTeamName: patch.team.name,
              awayTeamEnglishName: patch.team.englishName,
              awayTeamPlaceholder: false,
            };
    }
    return next;
  });
}

const CASES = [
  {
    name: "M101 home advances",
    fixtureId: "wc2026-m101",
    winnerSide: "home",
    destinationSide: "home",
    thirdPlaceTeam: { code: "ESP", name: "西班牙", englishName: "Spain" },
    finalTeam: { code: "FRA", name: "法国", englishName: "France" },
  },
  {
    name: "M101 away advances",
    fixtureId: "wc2026-m101",
    winnerSide: "away",
    destinationSide: "home",
    thirdPlaceTeam: { code: "FRA", name: "法国", englishName: "France" },
    finalTeam: { code: "ESP", name: "西班牙", englishName: "Spain" },
  },
  {
    name: "M102 home advances",
    fixtureId: "wc2026-m102",
    winnerSide: "home",
    destinationSide: "away",
    thirdPlaceTeam: { code: "ARG", name: "阿根廷", englishName: "Argentina" },
    finalTeam: { code: "ENG", name: "英格兰", englishName: "England" },
  },
  {
    name: "M102 away advances",
    fixtureId: "wc2026-m102",
    winnerSide: "away",
    destinationSide: "away",
    thirdPlaceTeam: { code: "ENG", name: "英格兰", englishName: "England" },
    finalTeam: { code: "ARG", name: "阿根廷", englishName: "Argentina" },
  },
];

for (const fixtureCase of CASES) {
  test(`${fixtureCase.name} fills the fixed third-place and final slots`, () => {
    const plan = planKnockoutProgression(
      progressionRows(),
      fixtureCase.fixtureId,
      fixtureCase.winnerSide,
    );

    assert.equal(plan.sourceFixtureId, fixtureCase.fixtureId);
    assert.equal(plan.winnerSide, fixtureCase.winnerSide);
    assert.deepEqual(plan.teamPatches, [
      {
        fixtureId: "wc2026-m103",
        side: fixtureCase.destinationSide,
        team: fixtureCase.thirdPlaceTeam,
      },
      {
        fixtureId: "wc2026-m104",
        side: fixtureCase.destinationSide,
        team: fixtureCase.finalTeam,
      },
    ]);
  });
}

test("a regulation draw still follows the separately recorded away winner", () => {
  const regulationScore = { home: 1, away: 1 };
  assert.equal(winnerSideFromRegulationScore(regulationScore), null);

  const plan = planKnockoutProgression(
    progressionRows(),
    "wc2026-m101",
    "away",
  );

  assert.deepEqual(
    plan.teamPatches.map(({ fixtureId, team }) => ({ fixtureId, team: team.name })),
    [
      { fixtureId: "wc2026-m103", team: "法国" },
      { fixtureId: "wc2026-m104", team: "西班牙" },
    ],
  );
});

test("a fixture is settlement-ready only after both teams are resolved", () => {
  const rows = progressionRows();
  const semiFinal = rows.find((fixture) => fixture.matchCode === "M101");
  const thirdPlace = rows.find((fixture) => fixture.matchCode === "M103");

  assert.equal(fixtureTeamsAreResolved(semiFinal), true);
  assert.equal(fixtureTeamsAreResolved(thirdPlace), false);
  assert.equal(
    fixtureTeamsAreResolved({
      ...thirdPlace,
      homeTeamPlaceholder: false,
      awayTeamPlaceholder: true,
    }),
    false,
  );
});

test("replaying the same progression is idempotent", () => {
  const rows = progressionRows();
  const first = planKnockoutProgression(rows, "wc2026-m101", "home");
  const applied = applyPlan(rows, first);
  const replay = planKnockoutProgression(applied, "wc2026-m101", "home");

  assert.equal(replay.winnerSide, "home");
  assert.deepEqual(replay.teamPatches, []);
});

test("a conflicting winner cannot overwrite a locked progression", () => {
  const rows = progressionRows().map((fixture) =>
    fixture.id === "wc2026-m101"
      ? { ...fixture, winnerSide: "home" }
      : fixture,
  );

  assert.throws(
    () => planKnockoutProgression(rows, "wc2026-m101", "away"),
    (error) =>
      error instanceof FixtureProgressionError &&
      /晋级方已按另一支球队锁定/.test(error.message),
  );
});

test("a conflicting non-placeholder destination cannot be silently replaced", () => {
  const rows = progressionRows().map((fixture) =>
    fixture.id === "wc2026-m104"
      ? {
          ...fixture,
          homeTeamCode: "BRA",
          homeTeamName: "巴西",
          homeTeamEnglishName: "Brazil",
          homeTeamPlaceholder: false,
        }
      : fixture,
  );

  assert.throws(
    () => planKnockoutProgression(rows, "wc2026-m101", "home"),
    (error) =>
      error instanceof FixtureProgressionError &&
      /M104对阵已经写入另一支球队/.test(error.message),
  );
});

test("non-semifinal fixtures do not produce downstream bracket patches", () => {
  const plan = planKnockoutProgression(
    progressionRows(),
    "wc2026-m103",
    "home",
  );

  assert.deepEqual(plan, {
    sourceFixtureId: "wc2026-m103",
    winnerSide: "home",
    teamPatches: [],
  });
});
