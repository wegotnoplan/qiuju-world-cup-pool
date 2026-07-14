import type { KnockoutWinnerSide, Team } from "./app-data";

export interface ProgressionFixture {
  id: string;
  matchCode: string;
  winnerSide: string | null;
  homeTeamCode: string;
  homeTeamName: string;
  homeTeamEnglishName: string;
  homeTeamPlaceholder: boolean;
  awayTeamCode: string;
  awayTeamName: string;
  awayTeamEnglishName: string;
  awayTeamPlaceholder: boolean;
}

export interface BracketTeamPatch {
  fixtureId: string;
  side: KnockoutWinnerSide;
  team: Team;
}

export interface KnockoutProgressionPlan {
  sourceFixtureId: string;
  winnerSide: KnockoutWinnerSide;
  teamPatches: BracketTeamPatch[];
}

export class FixtureProgressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureProgressionError";
  }
}

export function fixtureTeamsAreResolved(
  fixture: Pick<
    ProgressionFixture,
    "homeTeamPlaceholder" | "awayTeamPlaceholder"
  >,
): boolean {
  return !fixture.homeTeamPlaceholder && !fixture.awayTeamPlaceholder;
}

function teamAtSide(
  fixture: ProgressionFixture,
  side: KnockoutWinnerSide,
): Team {
  return side === "home"
    ? {
        code: fixture.homeTeamCode,
        name: fixture.homeTeamName,
        englishName: fixture.homeTeamEnglishName,
      }
    : {
        code: fixture.awayTeamCode,
        name: fixture.awayTeamName,
        englishName: fixture.awayTeamEnglishName,
      };
}

function targetSide(
  fixture: ProgressionFixture,
  side: KnockoutWinnerSide,
) {
  return side === "home"
    ? {
        team: {
          code: fixture.homeTeamCode,
          name: fixture.homeTeamName,
          englishName: fixture.homeTeamEnglishName,
        },
        placeholder: fixture.homeTeamPlaceholder,
      }
    : {
        team: {
          code: fixture.awayTeamCode,
          name: fixture.awayTeamName,
          englishName: fixture.awayTeamEnglishName,
        },
        placeholder: fixture.awayTeamPlaceholder,
      };
}

function sameTeam(left: Team, right: Team): boolean {
  return (
    left.code === right.code &&
    left.name === right.name &&
    left.englishName === right.englishName
  );
}

/**
 * Plans the fixed 2026 World Cup final-four bracket without using the pool's
 * 90-minute score. `winnerSide` is the actual advancing side after any extra
 * time or penalties; the opposite side is sent to the third-place fixture.
 */
export function planKnockoutProgression(
  fixtureRows: ProgressionFixture[],
  sourceFixtureId: string,
  winnerSide: KnockoutWinnerSide,
): KnockoutProgressionPlan {
  const source = fixtureRows.find((fixture) => fixture.id === sourceFixtureId);
  if (!source) throw new FixtureProgressionError("比赛不存在，无法推进淘汰赛对阵。");
  if (source.winnerSide && source.winnerSide !== winnerSide) {
    throw new FixtureProgressionError("本场晋级方已按另一支球队锁定，不能覆盖。");
  }

  if (source.matchCode !== "M101" && source.matchCode !== "M102") {
    return { sourceFixtureId, winnerSide, teamPatches: [] };
  }

  const destinationSide: KnockoutWinnerSide =
    source.matchCode === "M101" ? "home" : "away";
  const thirdPlace = fixtureRows.find((fixture) => fixture.matchCode === "M103");
  const final = fixtureRows.find((fixture) => fixture.matchCode === "M104");
  if (!thirdPlace || !final) {
    throw new FixtureProgressionError("后续淘汰赛场次不完整，暂不能写入晋级对阵。");
  }

  const loserSide: KnockoutWinnerSide = winnerSide === "home" ? "away" : "home";
  const requested = [
    { fixture: thirdPlace, side: destinationSide, team: teamAtSide(source, loserSide) },
    { fixture: final, side: destinationSide, team: teamAtSide(source, winnerSide) },
  ];
  const teamPatches: BracketTeamPatch[] = [];

  for (const destination of requested) {
    const current = targetSide(destination.fixture, destination.side);
    if (!current.placeholder && !sameTeam(current.team, destination.team)) {
      throw new FixtureProgressionError(
        `${destination.fixture.matchCode}对阵已经写入另一支球队，不能静默覆盖。`,
      );
    }
    if (current.placeholder) {
      teamPatches.push({
        fixtureId: destination.fixture.id,
        side: destination.side,
        team: destination.team,
      });
    }
  }

  return { sourceFixtureId, winnerSide, teamPatches };
}
