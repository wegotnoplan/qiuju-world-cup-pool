export const APP_STATE_VERSION = 1 as const;
export const STAKE_CENTS = 1_000;
export const MAX_BETS_PER_PARTICIPANT = 3;
export const LOCK_MINUTES_BEFORE_KICKOFF = 120;
export const RESULT_BASIS = "REGULATION_PLUS_STOPPAGE" as const;
export const DEFAULT_RULES_TEXT =
  "只按90分钟常规时间及伤停补时结算，不包含加时赛与点球大战。";

export type ParticipantId =
  | "gao"
  | "ye"
  | "dong"
  | "qiu"
  | "kang"
  | "bo"
  | "zhao";

export interface Participant {
  id: ParticipantId;
  name: string;
  displayOrder: number;
  active: boolean;
}

export interface Team {
  code: string;
  name: string;
  englishName: string;
  placeholder?: boolean;
}

export type FixtureRecordStatus =
  | "scheduled"
  | "review_required"
  | "settled";

export type FixtureStatus =
  | "active"
  | "locked"
  | "in_progress"
  | "awaiting_result"
  | "review_required"
  | "settled";

export interface RegulationScore {
  home: number;
  away: number;
}

export interface OddsOffer {
  id: string;
  fixtureId: string;
  marketType: string;
  selectionCode: string;
  label: string;
  odds: number;
  rulesText: string;
  source: string;
  active: boolean;
  uploadedAt: string;
}

export type BetStatus =
  | "pending"
  | "won"
  | "lost"
  | "void"
  | "review_required";

export interface Bet {
  id: string;
  fixtureId: string;
  participantId: ParticipantId;
  offerId: string;
  marketType: string;
  selectionCode: string;
  label: string;
  odds: number;
  stakeCents: number;
  placedAt: string;
  status: BetStatus;
  theoreticalPayoutCents: number;
  payoutCents: number;
  settledAt: string | null;
}

export interface Settlement {
  fixtureId: string;
  regularTimeScore: RegulationScore;
  resultBasis: typeof RESULT_BASIS;
  resultSource: "football-data.org" | "manual";
  poolBeforeCents: number;
  currentFixtureStakeCents: number;
  eligiblePoolCents: number;
  theoreticalPayoutCents: number;
  paidCents: number;
  scaleBps: number;
  settledAt: string;
  note: string | null;
}

export interface Fixture {
  id: string;
  matchCode: "M101" | "M102" | "M103" | "M104";
  sequence: number;
  stage: "semi_final" | "third_place" | "final";
  homeTeam: Team;
  awayTeam: Team;
  kickoffAt: string;
  lockAt: string;
  resultSyncDueAt: string;
  providerMatchId: string | null;
  recordStatus: FixtureRecordStatus;
  status: FixtureStatus;
  isBettingOpen: boolean;
  regularTimeScore: RegulationScore | null;
  resultSource: "football-data.org" | "manual" | null;
  resultBasis: typeof RESULT_BASIS | null;
  reviewNote: string | null;
  offers: OddsOffer[];
  settlement: Settlement | null;
}

export interface PoolSummary {
  contributedCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface AppRules {
  stakeCents: number;
  maxBetsPerParticipant: number;
  minimumOdds: number | null;
  settlementOddsCap: number | null;
  lockMinutesBeforeKickoff: number;
  resultBasis: typeof RESULT_BASIS;
  resultBasisLabel: string;
  payoutFormula: string;
  insufficientPoolRule: string;
}

export interface AppState {
  version: typeof APP_STATE_VERSION;
  serverTime: string;
  activeFixtureId: string | null;
  participants: Participant[];
  fixtures: Fixture[];
  bets: Bet[];
  settlements: Settlement[];
  pool: PoolSummary;
  rules: AppRules;
}

export interface BetSelectionInput {
  offerId?: string;
  id?: string;
  marketType?: string;
  selectionCode?: string;
  label?: string;
  odds?: number;
}

export interface PlaceBetsRequest {
  action: "place-bets";
  fixtureId: string;
  participantId: ParticipantId;
  selections: BetSelectionInput[];
}

export interface OddsOfferInput {
  id?: string;
  marketType: string;
  selectionCode: string;
  label: string;
  odds: number;
  rulesText?: string;
  source?: string;
}

export interface UploadOddsRequest {
  action: "upload-odds";
  fixtureId: string;
  providerMatchId?: string | number | null;
  source?: string;
  offers: OddsOfferInput[];
}

export interface ManualResultRequest {
  action: "manual-result";
  fixtureId: string;
  regulationHome: number;
  regulationAway: number;
  reason: string;
}

export type StateMutationRequest =
  | PlaceBetsRequest
  | UploadOddsRequest
  | ManualResultRequest;

export const PARTICIPANTS: readonly Participant[] = [
  { id: "gao", name: "高哥", displayOrder: 1, active: true },
  { id: "ye", name: "叶哥", displayOrder: 2, active: true },
  { id: "dong", name: "东哥", displayOrder: 3, active: true },
  { id: "qiu", name: "丘哥", displayOrder: 4, active: true },
  { id: "kang", name: "康哥", displayOrder: 5, active: true },
  { id: "bo", name: "波哥", displayOrder: 6, active: true },
  { id: "zhao", name: "兆", displayOrder: 7, active: true },
] as const;

type SeedFixture = Omit<
  Fixture,
  | "status"
  | "isBettingOpen"
  | "offers"
  | "settlement"
  | "regularTimeScore"
  | "resultSource"
  | "resultBasis"
  | "reviewNote"
>;

export const FIXTURES: readonly SeedFixture[] = [
  {
    id: "wc2026-m101",
    matchCode: "M101",
    sequence: 101,
    stage: "semi_final",
    homeTeam: { code: "FRA", name: "法国", englishName: "France" },
    awayTeam: { code: "ESP", name: "西班牙", englishName: "Spain" },
    kickoffAt: "2026-07-15T03:00:00+08:00",
    lockAt: "2026-07-15T01:00:00+08:00",
    resultSyncDueAt: "2026-07-15T08:00:00+08:00",
    providerMatchId: null,
    recordStatus: "scheduled",
  },
  {
    id: "wc2026-m102",
    matchCode: "M102",
    sequence: 102,
    stage: "semi_final",
    homeTeam: { code: "ENG", name: "英格兰", englishName: "England" },
    awayTeam: { code: "ARG", name: "阿根廷", englishName: "Argentina" },
    kickoffAt: "2026-07-16T03:00:00+08:00",
    lockAt: "2026-07-16T01:00:00+08:00",
    resultSyncDueAt: "2026-07-16T08:00:00+08:00",
    providerMatchId: null,
    recordStatus: "scheduled",
  },
  {
    id: "wc2026-m103",
    matchCode: "M103",
    sequence: 103,
    stage: "third_place",
    homeTeam: {
      code: "L101",
      name: "M101负者",
      englishName: "Loser M101",
      placeholder: true,
    },
    awayTeam: {
      code: "L102",
      name: "M102负者",
      englishName: "Loser M102",
      placeholder: true,
    },
    kickoffAt: "2026-07-19T05:00:00+08:00",
    lockAt: "2026-07-19T03:00:00+08:00",
    resultSyncDueAt: "2026-07-19T10:00:00+08:00",
    providerMatchId: null,
    recordStatus: "scheduled",
  },
  {
    id: "wc2026-m104",
    matchCode: "M104",
    sequence: 104,
    stage: "final",
    homeTeam: {
      code: "W101",
      name: "M101胜者",
      englishName: "Winner M101",
      placeholder: true,
    },
    awayTeam: {
      code: "W102",
      name: "M102胜者",
      englishName: "Winner M102",
      placeholder: true,
    },
    kickoffAt: "2026-07-20T03:00:00+08:00",
    lockAt: "2026-07-20T01:00:00+08:00",
    resultSyncDueAt: "2026-07-20T08:00:00+08:00",
    providerMatchId: null,
    recordStatus: "scheduled",
  },
] as const;

export const APP_RULES: AppRules = {
  stakeCents: STAKE_CENTS,
  maxBetsPerParticipant: MAX_BETS_PER_PARTICIPANT,
  minimumOdds: null,
  settlementOddsCap: null,
  lockMinutesBeforeKickoff: LOCK_MINUTES_BEFORE_KICKOFF,
  resultBasis: RESULT_BASIS,
  resultBasisLabel: "90分钟常规时间＋伤停补时（不含加时赛和点球）",
  payoutFormula: "中奖彩票理论奖金 = 每注10元 × 锁定赔率",
  insufficientPoolRule: "奖池不足时，全部中奖彩票按理论奖金占比同比例折算",
};

function validTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Adds time-sensitive UI state without trusting the browser for write checks.
 * API mutations repeat the lock validation using their own server clock.
 */
export function deriveFixtureStates(
  fixtures: Fixture[],
  now = new Date().toISOString()
): { fixtures: Fixture[]; activeFixtureId: string | null } {
  const nowMs = validTime(now);
  const nextNotStarted = [...fixtures]
    .filter((fixture) => validTime(fixture.kickoffAt) > nowMs)
    .sort((a, b) => a.sequence - b.sequence)[0];
  const activeFixtureId =
    nextNotStarted && nowMs < validTime(nextNotStarted.lockAt)
      ? nextNotStarted.id
      : null;

  return {
    activeFixtureId,
    fixtures: fixtures.map((fixture): Fixture => {
      let status: FixtureStatus;
      if (fixture.recordStatus === "settled") {
        status = "settled";
      } else if (fixture.recordStatus === "review_required") {
        status = "review_required";
      } else if (fixture.id === activeFixtureId) {
        status = "active";
      } else if (nowMs < validTime(fixture.kickoffAt)) {
        status = "locked";
      } else if (nowMs < validTime(fixture.resultSyncDueAt)) {
        status = "in_progress";
      } else {
        status = "awaiting_result";
      }

      return {
        ...fixture,
        status,
        isBettingOpen: fixture.id === activeFixtureId,
      };
    }),
  };
}

export function createSeedState(now = new Date().toISOString()): AppState {
  const baseFixtures: Fixture[] = FIXTURES.map((fixture) => ({
    ...fixture,
    homeTeam: { ...fixture.homeTeam },
    awayTeam: { ...fixture.awayTeam },
    status: "locked",
    isBettingOpen: false,
    regularTimeScore: null,
    resultSource: null,
    resultBasis: null,
    reviewNote: null,
    offers: [],
    settlement: null,
  }));
  const derived = deriveFixtureStates(baseFixtures, now);

  return {
    version: APP_STATE_VERSION,
    serverTime: now,
    activeFixtureId: derived.activeFixtureId,
    participants: PARTICIPANTS.map((participant) => ({ ...participant })),
    fixtures: derived.fixtures,
    bets: [],
    settlements: [],
    pool: { contributedCents: 0, paidCents: 0, balanceCents: 0 },
    rules: { ...APP_RULES },
  };
}

export type BetGrade = "won" | "lost" | "void" | "unsupported";

function parseNumberCode(value: string): number | null {
  const normalized = value.replace(/_/g, ".");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

/** Grades score-based offers using regulation plus stoppage time only. */
export function gradeSelection(
  marketType: string,
  selectionCode: string,
  score: RegulationScore
): BetGrade {
  const market = marketType.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const code = selectionCode.trim().toUpperCase().replace(/\s+/g, "_");
  const { home, away } = score;
  const total = home + away;

  if (["MATCH_RESULT", "1X2", "MONEYLINE_90"].includes(market)) {
    if (["HOME", "HOME_WIN", "1"].includes(code)) return home > away ? "won" : "lost";
    if (["DRAW", "X"].includes(code)) return home === away ? "won" : "lost";
    if (["AWAY", "AWAY_WIN", "2"].includes(code)) return away > home ? "won" : "lost";
    return "unsupported";
  }

  if (["DOUBLE_CHANCE", "DOUBLE_CHANCE_90"].includes(market)) {
    if (["HOME_OR_DRAW", "1X"].includes(code)) return home >= away ? "won" : "lost";
    if (["AWAY_OR_DRAW", "X2"].includes(code)) return away >= home ? "won" : "lost";
    if (["HOME_OR_AWAY", "12"].includes(code)) return home !== away ? "won" : "lost";
    return "unsupported";
  }

  if (["BOTH_TEAMS_TO_SCORE", "BTTS"].includes(market)) {
    const yes = home > 0 && away > 0;
    if (["YES", "Y"].includes(code)) return yes ? "won" : "lost";
    if (["NO", "N"].includes(code)) return yes ? "lost" : "won";
    return "unsupported";
  }

  if (["TOTAL_GOALS", "TOTAL", "OVER_UNDER"].includes(market)) {
    const match = code.match(/^(OVER|UNDER)[_:]?([0-9]+(?:[._][0-9]+)?)$/);
    if (!match) return "unsupported";
    const threshold = parseNumberCode(match[2]);
    if (threshold === null) return "unsupported";
    if (total === threshold) return "void";
    return match[1] === "OVER"
      ? total > threshold
        ? "won"
        : "lost"
      : total < threshold
        ? "won"
        : "lost";
  }

  if (["EXACT_SCORE", "CORRECT_SCORE"].includes(market)) {
    const match = code.match(/^(?:HOME_)?([0-9]+)(?:_AWAY_|-|:)([0-9]+)$/);
    if (!match) return "unsupported";
    return home === Number(match[1]) && away === Number(match[2]) ? "won" : "lost";
  }

  if (["DRAW_NO_BET", "DNB"].includes(market)) {
    if (home === away) return "void";
    if (["HOME", "1"].includes(code)) return home > away ? "won" : "lost";
    if (["AWAY", "2"].includes(code)) return away > home ? "won" : "lost";
    return "unsupported";
  }

  if (["HANDICAP", "SPREAD", "ASIAN_HANDICAP"].includes(market)) {
    const match = code.match(/^(HOME|AWAY)[:_]?([+-]?[0-9]+(?:[._][0-9]+)?)$/);
    if (!match) return "unsupported";
    const handicap = parseNumberCode(match[2]);
    if (handicap === null || Math.abs(handicap * 4 - Math.round(handicap * 4)) > 1e-8) {
      return "unsupported";
    }
    // Quarter-goal Asian handicaps require split-stake grading and are sent to review.
    if (Math.abs(handicap * 2 - Math.round(handicap * 2)) > 1e-8) return "unsupported";
    const margin = match[1] === "HOME" ? home + handicap - away : away + handicap - home;
    return margin === 0 ? "void" : margin > 0 ? "won" : "lost";
  }

  if (["HOME_TEAM_TOTAL", "AWAY_TEAM_TOTAL"].includes(market)) {
    const match = code.match(/^(OVER|UNDER)[_:]?([0-9]+(?:[._][0-9]+)?)$/);
    if (!match) return "unsupported";
    const threshold = parseNumberCode(match[2]);
    if (threshold === null) return "unsupported";
    const goals = market === "HOME_TEAM_TOTAL" ? home : away;
    if (goals === threshold) return "void";
    return match[1] === "OVER"
      ? goals > threshold
        ? "won"
        : "lost"
      : goals < threshold
        ? "won"
        : "lost";
  }

  return "unsupported";
}
