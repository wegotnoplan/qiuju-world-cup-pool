export const APP_STATE_VERSION = 4 as const;
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

export type KnockoutWinnerSide = "home" | "away";

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

type MatchScoreInput = {
  home?: unknown;
  away?: unknown;
};

/**
 * Validates a normalized result before it reaches any market grader. A
 * missing half-time score is allowed, but a supplied score must be complete
 * and cannot exceed the 90-minute score for either team.
 */
export function matchScoreValidationError(
  regularTime: MatchScoreInput,
  halfTime: MatchScoreInput | null,
): string | null {
  if (
    !Number.isSafeInteger(regularTime.home) ||
    !Number.isSafeInteger(regularTime.away) ||
    (regularTime.home as number) < 0 ||
    (regularTime.away as number) < 0 ||
    (regularTime.home as number) > 99 ||
    (regularTime.away as number) > 99
  ) {
    return "90分钟比分必须是0到99之间的整数。";
  }

  if (halfTime === null) return null;
  if (
    !Number.isSafeInteger(halfTime.home) ||
    !Number.isSafeInteger(halfTime.away) ||
    (halfTime.home as number) < 0 ||
    (halfTime.away as number) < 0 ||
    (halfTime.home as number) > 99 ||
    (halfTime.away as number) > 99
  ) {
    return "半场比分必须同时填写0到99之间的整数。";
  }
  if (
    (halfTime.home as number) > (regularTime.home as number) ||
    (halfTime.away as number) > (regularTime.away as number)
  ) {
    return "半场比分不能大于90分钟比分。";
  }
  return null;
}

export interface ApiFootballFixturePayload {
  fixture?: {
    id?: unknown;
    date?: unknown;
    status?: {
      long?: unknown;
      short?: unknown;
      elapsed?: unknown;
    } | null;
  } | null;
  league?: {
    id?: unknown;
    season?: unknown;
    round?: unknown;
  } | null;
  teams?: {
    home?: { id?: unknown; name?: unknown; winner?: unknown } | null;
    away?: { id?: unknown; name?: unknown; winner?: unknown } | null;
  } | null;
  goals?: { home?: unknown; away?: unknown } | null;
  score?: {
    halftime?: { home?: unknown; away?: unknown } | null;
    fulltime?: { home?: unknown; away?: unknown } | null;
    extratime?: { home?: unknown; away?: unknown } | null;
    penalty?: { home?: unknown; away?: unknown } | null;
  } | null;
}

export interface NormalizedApiFootballResult {
  providerStatus: string;
  halfTime: RegulationScore | null;
  regularTime: RegulationScore | null;
  winnerSide: KnockoutWinnerSide | null;
  outcome: "ready" | "waiting" | "manual_review";
  message: string;
}

export function winnerSideFromRegulationScore(
  score: RegulationScore,
): KnockoutWinnerSide | null {
  if (score.home > score.away) return "home";
  if (score.away > score.home) return "away";
  return null;
}

function apiFootballWinnerSide(
  match: ApiFootballFixturePayload,
): KnockoutWinnerSide | null {
  const homeWon = match.teams?.home?.winner === true;
  const awayWon = match.teams?.away?.winner === true;
  if (homeWon === awayWon) return null;
  return homeWon ? "home" : "away";
}

// ET/BT/P mean regulation time is already complete even though extra time or
// penalties are still running. score.fulltime is therefore safe to freeze for
// this pool as soon as one of these statuses is reported.
const REGULATION_COMPLETE_API_FOOTBALL_STATUSES = new Set([
  "FT",
  "ET",
  "BT",
  "P",
  "AET",
  "PEN",
]);

// ET/BT/P are live phases: the 90-minute score is frozen, but an extra-time
// lead or an in-progress shootout must never become the persisted knockout
// winner. Only terminal provider states may advance the bracket.
const KNOCKOUT_WINNER_COMPLETE_API_FOOTBALL_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
]);

function completeProviderScore(
  value: { home?: unknown; away?: unknown } | null | undefined,
): RegulationScore | null {
  if (
    !Number.isInteger(value?.home) ||
    !Number.isInteger(value?.away) ||
    (value?.home as number) < 0 ||
    (value?.away as number) < 0
  ) {
    return null;
  }
  return { home: value!.home as number, away: value!.away as number };
}

/**
 * API-Football's score.fulltime is the regulation score used by this pool.
 * goals, score.extratime and score.penalty are intentionally never read.
 */
export function normalizeApiFootballFixture(
  match: ApiFootballFixturePayload,
): NormalizedApiFootballResult {
  const rawStatus = match.fixture?.status?.short;
  const providerStatus =
    typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : "UNKNOWN";
  const halfTime = completeProviderScore(match.score?.halftime);
  if (!REGULATION_COMPLETE_API_FOOTBALL_STATUSES.has(providerStatus)) {
    return {
      providerStatus,
      halfTime,
      regularTime: null,
      winnerSide: null,
      outcome: "waiting",
      message: halfTime
        ? "已记录半场比分；API-Football 尚未明确标记比赛结束，暂不结算。"
        : "API-Football 尚未明确标记比赛结束，暂不结算。",
    };
  }

  const fulltime = match.score?.fulltime;
  const halftime = match.score?.halftime ?? null;
  if (fulltime?.home == null || fulltime?.away == null) {
    return {
      providerStatus,
      halfTime,
      regularTime: null,
      winnerSide: null,
      outcome: "waiting",
      message: "常规时间已经结束，正在等待 API-Football 发布90分钟比分。",
    };
  }
  const scoreError = matchScoreValidationError(
    { home: fulltime?.home, away: fulltime?.away },
    halftime,
  );
  if (scoreError) {
    return {
      providerStatus,
      halfTime: null,
      regularTime: null,
      winnerSide: null,
      outcome: "manual_review",
      message: `API-Football 的90分钟比分未通过校验：${scoreError} 禁止用 goals、加时或点球比分替代。`,
    };
  }

  const regularTime = {
    home: fulltime!.home as number,
    away: fulltime!.away as number,
  };
  const scoreWinnerSide = winnerSideFromRegulationScore(regularTime);
  const providerWinnerSide = KNOCKOUT_WINNER_COMPLETE_API_FOOTBALL_STATUSES.has(
    providerStatus,
  )
    ? apiFootballWinnerSide(match)
    : null;
  if (
    providerWinnerSide &&
    scoreWinnerSide &&
    providerWinnerSide !== scoreWinnerSide
  ) {
    return {
      providerStatus,
      halfTime,
      regularTime,
      winnerSide: null,
      outcome: "manual_review",
      message: "API-Football 的实际胜方与90分钟非平局比分冲突，需要人工复核。",
    };
  }
  return {
    providerStatus,
    halfTime,
    regularTime,
    winnerSide: KNOCKOUT_WINNER_COMPLETE_API_FOOTBALL_STATUSES.has(providerStatus)
      ? providerWinnerSide ?? scoreWinnerSide
      : null,
    outcome: "ready",
    message: "已取得90分钟常规时间及伤停补时比分。",
  };
}

function normalizedApiFootballTeamName(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]/g, "")
    : "";
}

export interface ApiFootballFixtureDiscoveryInput {
  kickoffAt: string;
  homeTeamEnglishName: string;
  awayTeamEnglishName: string;
  teamsArePlaceholders?: boolean;
}

export function findApiFootballFixture(
  matches: ApiFootballFixturePayload[],
  input: ApiFootballFixtureDiscoveryInput,
): ApiFootballFixturePayload | null {
  const kickoffMs = Date.parse(input.kickoffAt);
  const timeMatches = matches.filter((match) => {
    const fixtureId = match.fixture?.id;
    const date = match.fixture?.date;
    return (
      Number.isSafeInteger(fixtureId) &&
      typeof date === "string" &&
      Math.abs(Date.parse(date) - kickoffMs) <= 90 * 60 * 1_000
    );
  });
  if (timeMatches.length === 0) return null;

  if (!input.teamsArePlaceholders) {
    const home = normalizedApiFootballTeamName(input.homeTeamEnglishName);
    const away = normalizedApiFootballTeamName(input.awayTeamEnglishName);
    const exact = timeMatches.find(
      (match) =>
        normalizedApiFootballTeamName(match.teams?.home?.name) === home &&
        normalizedApiFootballTeamName(match.teams?.away?.name) === away,
    );
    if (exact) return exact;
  }
  return timeMatches.length === 1 ? timeMatches[0]! : null;
}

export type ResultSource =
  | "external-provider"
  | "api-football"
  | "football-data.org"
  | "manual";

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
  halfTimeScore: RegulationScore | null;
  regularTimeScore: RegulationScore;
  resultBasis: typeof RESULT_BASIS;
  resultSource: ResultSource;
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
  winnerSide: KnockoutWinnerSide | null;
  recordStatus: FixtureRecordStatus;
  status: FixtureStatus;
  isBettingOpen: boolean;
  halfTimeScore: RegulationScore | null;
  regularTimeScore: RegulationScore | null;
  resultSource: ResultSource | null;
  resultBasis: typeof RESULT_BASIS | null;
  reviewNote: string | null;
  offers: OddsOffer[];
  settlement: Settlement | null;
}

export interface FixtureEntry {
  id: string;
  fixtureId: string;
  participantId: ParticipantId;
  betCount: number;
  stakeCents: number;
  lockedAt: string;
  editUnlockedAt: string | null;
  revision: number;
  canEdit: boolean;
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
  nextFixtureId: string | null;
  participants: Participant[];
  fixtures: Fixture[];
  entries: FixtureEntry[];
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

export interface LockEntryRequest {
  action: "lock-entry";
  fixtureId: string;
  participantId: ParticipantId;
  selections: BetSelectionInput[];
  idempotencyKey?: string;
  entryRevision?: number;
}

export interface SetEntryEditUnlockedRequest {
  action: "set-entry-edit-unlocked";
  fixtureId: string;
  participantId: ParticipantId;
  unlocked: boolean;
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
  halfHome?: number;
  halfAway?: number;
  regulationHome: number;
  regulationAway: number;
  winnerSide?: KnockoutWinnerSide;
  reason: string;
}

export type StateMutationRequest =
  | PlaceBetsRequest
  | LockEntryRequest
  | SetEntryEditUnlockedRequest
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
  | "halfTimeScore"
  | "regularTimeScore"
  | "resultSource"
  | "resultBasis"
  | "reviewNote"
  | "winnerSide"
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
    resultSyncDueAt: "2026-07-15T07:00:00+08:00",
    providerMatchId: "1585131",
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
    resultSyncDueAt: "2026-07-16T07:00:00+08:00",
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
    resultSyncDueAt: "2026-07-19T09:00:00+08:00",
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
    resultSyncDueAt: "2026-07-20T07:00:00+08:00",
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

export function isFixtureBettingWindowOpen(
  fixture: Pick<Fixture, "kickoffAt" | "lockAt">,
  now: string,
): boolean {
  const nowMs = Date.parse(now);
  const kickoffMs = Date.parse(fixture.kickoffAt);
  const lockMs = Date.parse(fixture.lockAt);
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(kickoffMs) &&
    Number.isFinite(lockMs) &&
    kickoffMs > nowMs &&
    nowMs < lockMs
  );
}

/**
 * Adds time-sensitive UI state without trusting the browser for write checks.
 * API mutations repeat the lock validation using their own server clock.
 */
export function deriveFixtureStates(
  fixtures: Fixture[],
  now = new Date().toISOString()
): { fixtures: Fixture[]; activeFixtureId: string | null; nextFixtureId: string | null } {
  const nowMs = validTime(now);
  // The pool advances serially. A later fixture stays locked until every
  // earlier fixture is settled, even if its own kickoff is still in the future.
  const nextNotStarted = [...fixtures]
    .filter(
      (fixture) =>
        fixture.recordStatus !== "settled" || fixture.winnerSide === null,
    )
    .sort((a, b) => a.sequence - b.sequence)[0];
  const nextFixtureIsConfigured = Boolean(
    nextNotStarted &&
      !nextNotStarted.homeTeam.placeholder &&
      !nextNotStarted.awayTeam.placeholder &&
      nextNotStarted.offers.some((offer) => offer.active),
  );
  const activeFixtureId =
    nextNotStarted &&
    nextFixtureIsConfigured &&
    nextNotStarted.recordStatus === "scheduled" &&
    isFixtureBettingWindowOpen(nextNotStarted, now)
      ? nextNotStarted.id
      : null;

  return {
    activeFixtureId,
    nextFixtureId: nextNotStarted?.id ?? null,
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
    halfTimeScore: null,
    regularTimeScore: null,
    resultSource: null,
    resultBasis: null,
    reviewNote: null,
    winnerSide: null,
    offers: [],
    settlement: null,
  }));
  const derived = deriveFixtureStates(baseFixtures, now);

  return {
    version: APP_STATE_VERSION,
    serverTime: now,
    activeFixtureId: derived.activeFixtureId,
    nextFixtureId: derived.nextFixtureId,
    participants: PARTICIPANTS.map((participant) => ({ ...participant })),
    fixtures: derived.fixtures,
    entries: [],
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
  score: RegulationScore,
  halfTimeScore: RegulationScore | null = null
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

  if (["HANDICAP_1X2_HOME_MINUS_1", "HANDICAP_3WAY_HOME_MINUS_1"].includes(market)) {
    const adjustedMargin = home - 1 - away;
    if (["HOME", "1"].includes(code)) return adjustedMargin > 0 ? "won" : "lost";
    if (["DRAW", "X"].includes(code)) return adjustedMargin === 0 ? "won" : "lost";
    if (["AWAY", "2"].includes(code)) return adjustedMargin < 0 ? "won" : "lost";
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
    const listedHomeScores = new Set([
      "1-0", "2-0", "2-1", "3-0", "3-1", "3-2",
      "4-0", "4-1", "4-2", "5-0", "5-1", "5-2",
    ]);
    const listedDrawScores = new Set(["0-0", "1-1", "2-2", "3-3"]);
    const listedAwayScores = new Set([
      "0-1", "0-2", "1-2", "0-3", "1-3", "2-3",
      "0-4", "1-4", "2-4", "0-5", "1-5", "2-5",
    ]);
    const actualCode = `${home}-${away}`;
    if (code === "HOME_OTHER") {
      return home > away && !listedHomeScores.has(actualCode) ? "won" : "lost";
    }
    if (code === "DRAW_OTHER") {
      return home === away && !listedDrawScores.has(actualCode) ? "won" : "lost";
    }
    if (code === "AWAY_OTHER") {
      return away > home && !listedAwayScores.has(actualCode) ? "won" : "lost";
    }
    const match = code.match(/^(?:HOME_)?([0-9]+)(?:_AWAY_|-|:)([0-9]+)$/);
    if (!match) return "unsupported";
    return home === Number(match[1]) && away === Number(match[2]) ? "won" : "lost";
  }

  if (["TOTAL_GOALS_EXACT", "EXACT_TOTAL_GOALS"].includes(market)) {
    if (code === "7_PLUS") return total >= 7 ? "won" : "lost";
    const exact = Number(code);
    if (!Number.isInteger(exact) || exact < 0) return "unsupported";
    return total === exact ? "won" : "lost";
  }

  if (["HALF_FULL_TIME", "HALF_FULL"].includes(market)) {
    if (!halfTimeScore) return "unsupported";
    const outcome = (value: RegulationScore) =>
      value.home > value.away ? "HOME" : value.home < value.away ? "AWAY" : "DRAW";
    const [half, full, ...rest] = code.split("_");
    if (rest.length > 0 || !half || !full) return "unsupported";
    if (!["HOME", "DRAW", "AWAY"].includes(half)) return "unsupported";
    if (!["HOME", "DRAW", "AWAY"].includes(full)) return "unsupported";
    return half === outcome(halfTimeScore) && full === outcome(score) ? "won" : "lost";
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
