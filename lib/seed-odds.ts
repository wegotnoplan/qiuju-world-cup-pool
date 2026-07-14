import type { OddsOfferInput } from "./app-data";

export const SCREENSHOT_ODDS_SOURCE = "用户提供的竞彩模拟页截图";
export const SCREENSHOT_ODDS_RULES_TEXT =
  "仅按90分钟常规时间及伤停补时结算，不含加时赛与点球大战。";

export type SeedOddsFixtureId = "wc2026-m101" | "wc2026-m102";

type OfferSpec = readonly [
  marketType: string,
  selectionCode: string,
  label: string,
  odds: number,
];

function idPart(value: string): string {
  return value.toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9+-]+/g, "-");
}

function buildOffers(
  fixtureId: SeedOddsFixtureId,
  specs: readonly OfferSpec[],
): OddsOfferInput[] {
  return specs.map(([marketType, selectionCode, label, odds]) => ({
    id: `${fixtureId}-${idPart(marketType)}-${idPart(selectionCode)}`,
    marketType,
    selectionCode,
    label,
    odds,
    rulesText: SCREENSHOT_ODDS_RULES_TEXT,
    source: SCREENSHOT_ODDS_SOURCE,
  }));
}

const M101_SPECS = [
  ["MATCH_RESULT", "HOME", "法国胜", 2.03],
  ["MATCH_RESULT", "DRAW", "平局", 3.13],
  ["MATCH_RESULT", "AWAY", "西班牙胜", 3.15],

  ["HANDICAP_1X2_HOME_MINUS_1", "HOME", "法国(-1)胜", 4.33],
  ["HANDICAP_1X2_HOME_MINUS_1", "DRAW", "法国(-1)平", 3.6],
  ["HANDICAP_1X2_HOME_MINUS_1", "AWAY", "法国(-1)负", 1.61],

  ["EXACT_SCORE", "1-0", "1:0", 9.7],
  ["EXACT_SCORE", "2-0", "2:0", 13.0],
  ["EXACT_SCORE", "2-1", "2:1", 6.25],
  ["EXACT_SCORE", "3-0", "3:0", 27.0],
  ["EXACT_SCORE", "3-1", "3:1", 12.0],
  ["EXACT_SCORE", "3-2", "3:2", 16.0],
  ["EXACT_SCORE", "4-0", "4:0", 80.0],
  ["EXACT_SCORE", "4-1", "4:1", 55.0],
  ["EXACT_SCORE", "4-2", "4:2", 45.0],
  ["EXACT_SCORE", "5-0", "5:0", 250.0],
  ["EXACT_SCORE", "5-1", "5:1", 200.0],
  ["EXACT_SCORE", "5-2", "5:2", 125.0],
  ["EXACT_SCORE", "HOME_OTHER", "胜其它", 60.0],
  ["EXACT_SCORE", "0-0", "0:0", 12.5],
  ["EXACT_SCORE", "1-1", "1:1", 5.7],
  ["EXACT_SCORE", "2-2", "2:2", 9.5],
  ["EXACT_SCORE", "3-3", "3:3", 30.0],
  ["EXACT_SCORE", "DRAW_OTHER", "平其它", 150.0],
  ["EXACT_SCORE", "0-1", "0:1", 11.0],
  ["EXACT_SCORE", "0-2", "0:2", 20.0],
  ["EXACT_SCORE", "1-2", "1:2", 9.3],
  ["EXACT_SCORE", "0-3", "0:3", 45.0],
  ["EXACT_SCORE", "1-3", "1:3", 27.0],
  ["EXACT_SCORE", "2-3", "2:3", 25.0],
  ["EXACT_SCORE", "0-4", "0:4", 125.0],
  ["EXACT_SCORE", "1-4", "1:4", 100.0],
  ["EXACT_SCORE", "2-4", "2:4", 90.0],
  ["EXACT_SCORE", "0-5", "0:5", 350.0],
  ["EXACT_SCORE", "1-5", "1:5", 300.0],
  ["EXACT_SCORE", "2-5", "2:5", 300.0],
  ["EXACT_SCORE", "AWAY_OTHER", "负其它", 80.0],

  ["TOTAL_GOALS_EXACT", "0", "0球", 12.5],
  ["TOTAL_GOALS_EXACT", "1", "1球", 5.2],
  ["TOTAL_GOALS_EXACT", "2", "2球", 3.5],
  ["TOTAL_GOALS_EXACT", "3", "3球", 3.4],
  ["TOTAL_GOALS_EXACT", "4", "4球", 5.1],
  ["TOTAL_GOALS_EXACT", "5", "5球", 9.5],
  ["TOTAL_GOALS_EXACT", "6", "6球", 17.0],
  ["TOTAL_GOALS_EXACT", "7_PLUS", "7+球", 24.0],

  ["HALF_FULL_TIME", "HOME_HOME", "胜胜", 3.8],
  ["HALF_FULL_TIME", "HOME_DRAW", "胜平", 12.0],
  ["HALF_FULL_TIME", "HOME_AWAY", "胜负", 20.0],
  ["HALF_FULL_TIME", "DRAW_HOME", "平胜", 4.65],
  ["HALF_FULL_TIME", "DRAW_DRAW", "平平", 5.65],
  ["HALF_FULL_TIME", "DRAW_AWAY", "平负", 7.45],
  ["HALF_FULL_TIME", "AWAY_HOME", "负胜", 15.0],
  ["HALF_FULL_TIME", "AWAY_DRAW", "负平", 12.0],
  ["HALF_FULL_TIME", "AWAY_AWAY", "负负", 5.5],
] as const satisfies readonly OfferSpec[];

const M102_SPECS = [
  ["MATCH_RESULT", "HOME", "英格兰胜", 2.35],
  ["MATCH_RESULT", "DRAW", "平局", 2.75],
  ["MATCH_RESULT", "AWAY", "阿根廷胜", 2.94],

  ["HANDICAP_1X2_HOME_MINUS_1", "HOME", "英格兰(-1)胜", 5.65],
  ["HANDICAP_1X2_HOME_MINUS_1", "DRAW", "英格兰(-1)平", 3.75],
  ["HANDICAP_1X2_HOME_MINUS_1", "AWAY", "英格兰(-1)负", 1.46],

  ["EXACT_SCORE", "1-0", "1:0", 8.0],
  ["EXACT_SCORE", "2-0", "2:0", 12.5],
  ["EXACT_SCORE", "2-1", "2:1", 6.5],
  ["EXACT_SCORE", "3-0", "3:0", 30.0],
  ["EXACT_SCORE", "3-1", "3:1", 21.0],
  ["EXACT_SCORE", "3-2", "3:2", 28.0],
  ["EXACT_SCORE", "4-0", "4:0", 85.0],
  ["EXACT_SCORE", "4-1", "4:1", 75.0],
  ["EXACT_SCORE", "4-2", "4:2", 80.0],
  ["EXACT_SCORE", "5-0", "5:0", 350.0],
  ["EXACT_SCORE", "5-1", "5:1", 300.0],
  ["EXACT_SCORE", "5-2", "5:2", 250.0],
  ["EXACT_SCORE", "HOME_OTHER", "胜其它", 100.0],
  ["EXACT_SCORE", "0-0", "0:0", 8.0],
  ["EXACT_SCORE", "1-1", "1:1", 5.0],
  ["EXACT_SCORE", "2-2", "2:2", 10.5],
  ["EXACT_SCORE", "3-3", "3:3", 42.0],
  ["EXACT_SCORE", "DRAW_OTHER", "平其它", 175.0],
  ["EXACT_SCORE", "0-1", "0:1", 8.5],
  ["EXACT_SCORE", "0-2", "0:2", 16.0],
  ["EXACT_SCORE", "1-2", "1:2", 8.5],
  ["EXACT_SCORE", "0-3", "0:3", 40.0],
  ["EXACT_SCORE", "1-3", "1:3", 28.0],
  ["EXACT_SCORE", "2-3", "2:3", 38.0],
  ["EXACT_SCORE", "0-4", "0:4", 110.0],
  ["EXACT_SCORE", "1-4", "1:4", 110.0],
  ["EXACT_SCORE", "2-4", "2:4", 100.0],
  ["EXACT_SCORE", "0-5", "0:5", 500.0],
  ["EXACT_SCORE", "1-5", "1:5", 350.0],
  ["EXACT_SCORE", "2-5", "2:5", 400.0],
  ["EXACT_SCORE", "AWAY_OTHER", "负其它", 175.0],

  ["TOTAL_GOALS_EXACT", "0", "0球", 8.0],
  ["TOTAL_GOALS_EXACT", "1", "1球", 4.2],
  ["TOTAL_GOALS_EXACT", "2", "2球", 2.95],
  ["TOTAL_GOALS_EXACT", "3", "3球", 3.8],
  ["TOTAL_GOALS_EXACT", "4", "4球", 6.5],
  ["TOTAL_GOALS_EXACT", "5", "5球", 14.0],
  ["TOTAL_GOALS_EXACT", "6", "6球", 26.0],
  ["TOTAL_GOALS_EXACT", "7_PLUS", "7+球", 40.0],

  ["HALF_FULL_TIME", "HOME_HOME", "胜胜", 4.3],
  ["HALF_FULL_TIME", "HOME_DRAW", "胜平", 11.0],
  ["HALF_FULL_TIME", "HOME_AWAY", "胜负", 21.0],
  ["HALF_FULL_TIME", "DRAW_HOME", "平胜", 5.6],
  ["HALF_FULL_TIME", "DRAW_DRAW", "平平", 4.6],
  ["HALF_FULL_TIME", "DRAW_AWAY", "平负", 6.75],
  ["HALF_FULL_TIME", "AWAY_HOME", "负胜", 19.0],
  ["HALF_FULL_TIME", "AWAY_DRAW", "负平", 11.0],
  ["HALF_FULL_TIME", "AWAY_AWAY", "负负", 5.1],
] as const satisfies readonly OfferSpec[];

export const M101_SEED_ODDS: OddsOfferInput[] = buildOffers(
  "wc2026-m101",
  M101_SPECS,
);

export const M102_SEED_ODDS: OddsOfferInput[] = buildOffers(
  "wc2026-m102",
  M102_SPECS,
);

export const SEED_ODDS_BY_FIXTURE: Record<SeedOddsFixtureId, OddsOfferInput[]> = {
  "wc2026-m101": M101_SEED_ODDS,
  "wc2026-m102": M102_SEED_ODDS,
};

export const ALL_SEED_ODDS: OddsOfferInput[] = [
  ...M101_SEED_ODDS,
  ...M102_SEED_ODDS,
];
