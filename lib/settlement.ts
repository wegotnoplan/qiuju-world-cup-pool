/** The fixed stake for every ticket: CNY 10.00, expressed in fen. */
export const STAKE_FEN = 1_000 as const;

/** Decimal odds may be supplied as a number or a decimal string. */
export type DecimalOdds = number | string;

export type TicketOutcome = "won" | "lost" | "void";

export interface SettlementTicket {
  /** Stable application-level identifier for this ticket. */
  ticketId: string;
  /**
   * Stable submission order. A lower sequence wins an otherwise equal
   * largest-remainder tie.
   */
  ticketSequence: number;
  odds: DecimalOdds;
  outcome: TicketOutcome;
}

export interface SettlePoolInput {
  /** Total cash currently available, including this round's stakes and rollover. */
  poolFen: number;
  tickets: readonly SettlementTicket[];
  /** Optional settlement cap. Odds above it are recorded and paid at the cap. */
  oddsCap?: DecimalOdds;
}

export interface SettledTicket extends SettlementTicket {
  /** Canonical decimal odds after applying the optional cap. */
  effectiveOdds: string;
  oddsCapApplied: boolean;
  /** 10 yuan times effective odds for a winning ticket; zero otherwise. */
  theoreticalReturnFen: number;
  /** Fixed 10 yuan refund due for a void ticket; zero otherwise. */
  refundDueFen: number;
  /** The claim before any pool-shortage proration. */
  amountDueFen: number;
  /** The actual amount paid from the pool. */
  payoutFen: number;
  shortfallFen: number;
}

export interface PoolSettlement {
  poolFen: number;
  stakeFen: typeof STAKE_FEN;
  ticketCount: number;
  contributedFen: number;
  theoreticalWinningReturnsFen: number;
  voidRefundsDueFen: number;
  totalDueFen: number;
  winnerPayoutFen: number;
  voidRefundFen: number;
  totalPayoutFen: number;
  rolloverFen: number;
  poolSufficient: boolean;
  winnerPayoutsProrated: boolean;
  voidRefundsProrated: boolean;
  tickets: SettledTicket[];
}

export interface RegulationScore {
  /** Home goals after 90 minutes plus stoppage time only. */
  homeGoals: number;
  /** Away goals after 90 minutes plus stoppage time only. */
  awayGoals: number;
}

export type OneXTwoSelection = {
  market: "1x2";
  pick: "home" | "draw" | "away";
};

export type ExactScoreSelection = {
  market: "exact-score";
  homeGoals: number;
  awayGoals: number;
};

export type TotalsSelection = {
  market: "totals";
  pick: "over" | "under";
  line: number | string;
};

export type BothTeamsToScoreSelection = {
  market: "btts";
  pick: "yes" | "no";
};

/** These are the only market types this settlement module grades. */
export type RegulationSelection =
  | OneXTwoSelection
  | ExactScoreSelection
  | TotalsSelection
  | BothTeamsToScoreSelection;

export type GradedOutcome = "won" | "lost" | "void";

interface ParsedDecimal {
  numerator: bigint;
  denominator: bigint;
}

interface Claim {
  ticketIndex: number;
  ticketSequence: number;
  amountFen: number;
}

const MAX_DECIMAL_EXPONENT = 100;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const BIGINT_FIVE = BigInt(5);
const BIGINT_TEN = BigInt(10);

function assertMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer number of fen`);
  }
}

function assertGoalCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < BIGINT_ZERO ? -left : left;
  let b = right < BIGINT_ZERO ? -right : right;

  while (b !== BIGINT_ZERO) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

function powerOfTen(exponent: number): bigint {
  return BIGINT_TEN ** BigInt(exponent);
}

function parseNonNegativeDecimal(value: number | string, name: string): ParsedDecimal {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }

  const source = String(value).trim();
  const match = /^(\+?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) {
    throw new TypeError(`${name} must be a non-negative decimal number`);
  }

  const integerDigits = match[2];
  const fractionalDigits = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");

  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) {
    throw new RangeError(
      `${name} exponent must be between -${MAX_DECIMAL_EXPONENT} and ${MAX_DECIMAL_EXPONENT}`,
    );
  }

  let numerator = BigInt(`${integerDigits}${fractionalDigits}`);
  const scale = fractionalDigits.length - exponent;
  let denominator = BIGINT_ONE;

  if (scale > 0) {
    denominator = powerOfTen(scale);
  } else if (scale < 0) {
    numerator *= powerOfTen(-scale);
  }

  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function parseDecimalOdds(value: DecimalOdds, name: string): ParsedDecimal {
  const parsed = parseNonNegativeDecimal(value, name);
  if (parsed.numerator < parsed.denominator) {
    throw new RangeError(`${name} must be at least 1.0`);
  }
  return parsed;
}

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < BIGINT_ZERO ? -1 : difference > BIGINT_ZERO ? 1 : 0;
}

function decimalToCanonicalString(value: ParsedDecimal): string {
  let denominator = value.denominator;
  let powersOfTwo = 0;
  let powersOfFive = 0;

  while (denominator % BIGINT_TWO === BIGINT_ZERO) {
    denominator /= BIGINT_TWO;
    powersOfTwo += 1;
  }
  while (denominator % BIGINT_FIVE === BIGINT_ZERO) {
    denominator /= BIGINT_FIVE;
    powersOfFive += 1;
  }

  if (denominator !== BIGINT_ONE) {
    throw new RangeError("decimal value cannot be represented as a finite decimal");
  }

  const scale = Math.max(powersOfTwo, powersOfFive);
  const scaledNumerator =
    value.numerator *
    BIGINT_TWO ** BigInt(scale - powersOfTwo) *
    BIGINT_FIVE ** BigInt(scale - powersOfFive);
  const digits = scaledNumerator.toString();

  if (scale === 0) {
    return digits;
  }

  const padded = digits.padStart(scale + 1, "0");
  const integerPart = padded.slice(0, -scale);
  const fractionalPart = padded.slice(-scale).replace(/0+$/, "");
  return fractionalPart.length > 0 ? `${integerPart}.${fractionalPart}` : integerPart;
}

function bigintToSafeMoney(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

/**
 * Returns 10 yuan times the effective decimal odds, rounded half up to one fen.
 * Arithmetic is performed as an exact decimal rational, not binary floating point.
 */
export function calculateTheoreticalReturnFen(
  odds: DecimalOdds,
  oddsCap?: DecimalOdds,
): number {
  const parsedOdds = parseDecimalOdds(odds, "odds");
  const parsedCap = oddsCap === undefined ? undefined : parseDecimalOdds(oddsCap, "oddsCap");
  const effectiveOdds =
    parsedCap !== undefined && compareDecimals(parsedOdds, parsedCap) > 0
      ? parsedCap
      : parsedOdds;
  const unroundedNumerator = BigInt(STAKE_FEN) * effectiveOdds.numerator;
  const rounded =
    (BIGINT_TWO * unroundedNumerator + effectiveOdds.denominator) /
    (BIGINT_TWO * effectiveOdds.denominator);
  return bigintToSafeMoney(rounded, "theoretical return");
}

function sumMoney(values: readonly number[], name: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), BIGINT_ZERO);
  return bigintToSafeMoney(total, name);
}

/**
 * Hamilton/largest-remainder allocation. Result positions match claim positions.
 * Equal fractional remainders are resolved by ascending ticketSequence.
 */
function prorateClaims(claims: readonly Claim[], budgetFen: number): number[] {
  assertMoney(budgetFen, "budgetFen");
  const payouts = new Array<number>(claims.length).fill(0);
  const totalClaim = claims.reduce(
    (sum, claim) => sum + BigInt(claim.amountFen),
    BIGINT_ZERO,
  );

  if (totalClaim === BIGINT_ZERO || budgetFen === 0) {
    return payouts;
  }

  if (BigInt(budgetFen) >= totalClaim) {
    return claims.map((claim) => claim.amountFen);
  }

  const ranking = claims.map((claim, claimIndex) => {
    const numerator = BigInt(budgetFen) * BigInt(claim.amountFen);
    const base = numerator / totalClaim;
    payouts[claimIndex] = Number(base);
    return {
      claimIndex,
      ticketSequence: claim.ticketSequence,
      remainder: numerator % totalClaim,
    };
  });

  const baseTotal = payouts.reduce((sum, payout) => sum + payout, 0);
  const remainingFen = budgetFen - baseTotal;
  ranking.sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    if (left.ticketSequence !== right.ticketSequence) {
      return left.ticketSequence - right.ticketSequence;
    }
    return left.claimIndex - right.claimIndex;
  });

  for (let index = 0; index < remainingFen; index += 1) {
    payouts[ranking[index].claimIndex] += 1;
  }

  return payouts;
}

function validateTickets(tickets: readonly SettlementTicket[]): void {
  const ids = new Set<string>();
  const sequences = new Set<number>();

  for (const ticket of tickets) {
    if (typeof ticket.ticketId !== "string" || ticket.ticketId.length === 0) {
      throw new TypeError("ticketId must be a non-empty string");
    }
    if (ids.has(ticket.ticketId)) {
      throw new RangeError(`duplicate ticketId: ${ticket.ticketId}`);
    }
    ids.add(ticket.ticketId);

    if (!Number.isSafeInteger(ticket.ticketSequence) || ticket.ticketSequence < 0) {
      throw new RangeError("ticketSequence must be a non-negative safe integer");
    }
    if (sequences.has(ticket.ticketSequence)) {
      throw new RangeError(`duplicate ticketSequence: ${ticket.ticketSequence}`);
    }
    sequences.add(ticket.ticketSequence);

    if (ticket.outcome !== "won" && ticket.outcome !== "lost" && ticket.outcome !== "void") {
      throw new TypeError(`unsupported ticket outcome: ${String(ticket.outcome)}`);
    }
  }
}

/**
 * Settles a fixed-stake pool in integer fen.
 *
 * Void stakes are refunded first. Remaining money pays winning theoretical
 * returns in full when possible, or by deterministic largest-remainder
 * proration when the pool is short. Unspent money rolls into the next round.
 */
export function settlePool(input: SettlePoolInput): PoolSettlement {
  assertMoney(input.poolFen, "poolFen");
  validateTickets(input.tickets);

  const parsedCap =
    input.oddsCap === undefined ? undefined : parseDecimalOdds(input.oddsCap, "oddsCap");
  const initialTickets = input.tickets.map((ticket) => {
    const parsedOdds = parseDecimalOdds(ticket.odds, `odds for ticket ${ticket.ticketId}`);
    const oddsCapApplied =
      parsedCap !== undefined && compareDecimals(parsedOdds, parsedCap) > 0;
    const effectiveOdds = oddsCapApplied ? parsedCap : parsedOdds;
    const theoreticalReturnFen =
      ticket.outcome === "won"
        ? calculateTheoreticalReturnFen(ticket.odds, input.oddsCap)
        : 0;
    const refundDueFen = ticket.outcome === "void" ? STAKE_FEN : 0;

    return {
      ...ticket,
      effectiveOdds: decimalToCanonicalString(effectiveOdds),
      oddsCapApplied,
      theoreticalReturnFen,
      refundDueFen,
      amountDueFen: theoreticalReturnFen + refundDueFen,
      payoutFen: 0,
      shortfallFen: theoreticalReturnFen + refundDueFen,
    } satisfies SettledTicket;
  });

  const voidClaims: Claim[] = [];
  const winnerClaims: Claim[] = [];
  initialTickets.forEach((ticket, ticketIndex) => {
    if (ticket.refundDueFen > 0) {
      voidClaims.push({
        ticketIndex,
        ticketSequence: ticket.ticketSequence,
        amountFen: ticket.refundDueFen,
      });
    } else if (ticket.theoreticalReturnFen > 0) {
      winnerClaims.push({
        ticketIndex,
        ticketSequence: ticket.ticketSequence,
        amountFen: ticket.theoreticalReturnFen,
      });
    }
  });

  const voidRefundsDueFen = sumMoney(
    voidClaims.map((claim) => claim.amountFen),
    "void refunds due",
  );
  const theoreticalWinningReturnsFen = sumMoney(
    winnerClaims.map((claim) => claim.amountFen),
    "theoretical winning returns",
  );
  const totalDueFen = sumMoney(
    [voidRefundsDueFen, theoreticalWinningReturnsFen],
    "total amount due",
  );

  const voidBudgetFen = Math.min(input.poolFen, voidRefundsDueFen);
  const voidPayouts = prorateClaims(voidClaims, voidBudgetFen);
  const voidRefundFen = sumMoney(voidPayouts, "void refunds paid");
  const poolAfterRefundsFen = input.poolFen - voidRefundFen;

  const winnerBudgetFen = Math.min(poolAfterRefundsFen, theoreticalWinningReturnsFen);
  const winnerPayouts = prorateClaims(winnerClaims, winnerBudgetFen);
  const winnerPayoutFen = sumMoney(winnerPayouts, "winner payouts");

  const payoutsByTicketIndex = new Array<number>(initialTickets.length).fill(0);
  voidClaims.forEach((claim, index) => {
    payoutsByTicketIndex[claim.ticketIndex] = voidPayouts[index];
  });
  winnerClaims.forEach((claim, index) => {
    payoutsByTicketIndex[claim.ticketIndex] = winnerPayouts[index];
  });

  const tickets = initialTickets.map((ticket, ticketIndex) => {
    const payoutFen = payoutsByTicketIndex[ticketIndex];
    return {
      ...ticket,
      payoutFen,
      shortfallFen: ticket.amountDueFen - payoutFen,
    };
  });
  const totalPayoutFen = voidRefundFen + winnerPayoutFen;
  const contributedFen = bigintToSafeMoney(
    BigInt(input.tickets.length) * BigInt(STAKE_FEN),
    "ticket contributions",
  );

  return {
    poolFen: input.poolFen,
    stakeFen: STAKE_FEN,
    ticketCount: input.tickets.length,
    contributedFen,
    theoreticalWinningReturnsFen,
    voidRefundsDueFen,
    totalDueFen,
    winnerPayoutFen,
    voidRefundFen,
    totalPayoutFen,
    rolloverFen: input.poolFen - totalPayoutFen,
    poolSufficient: input.poolFen >= totalDueFen,
    winnerPayoutsProrated: winnerPayoutFen < theoreticalWinningReturnsFen,
    voidRefundsProrated: voidRefundFen < voidRefundsDueFen,
    tickets,
  };
}

function validateRegulationScore(score: RegulationScore): void {
  assertGoalCount(score.homeGoals, "regulationScore.homeGoals");
  assertGoalCount(score.awayGoals, "regulationScore.awayGoals");
}

export function gradeOneXTwo(
  selection: OneXTwoSelection,
  regulationScore: RegulationScore,
): GradedOutcome {
  validateRegulationScore(regulationScore);
  const actual =
    regulationScore.homeGoals > regulationScore.awayGoals
      ? "home"
      : regulationScore.homeGoals < regulationScore.awayGoals
        ? "away"
        : "draw";
  return selection.pick === actual ? "won" : "lost";
}

export function gradeExactScore(
  selection: ExactScoreSelection,
  regulationScore: RegulationScore,
): GradedOutcome {
  validateRegulationScore(regulationScore);
  assertGoalCount(selection.homeGoals, "selection.homeGoals");
  assertGoalCount(selection.awayGoals, "selection.awayGoals");
  return selection.homeGoals === regulationScore.homeGoals &&
    selection.awayGoals === regulationScore.awayGoals
    ? "won"
    : "lost";
}

export function gradeTotals(
  selection: TotalsSelection,
  regulationScore: RegulationScore,
): GradedOutcome {
  validateRegulationScore(regulationScore);
  if (selection.pick !== "over" && selection.pick !== "under") {
    throw new TypeError(`unsupported totals pick: ${String(selection.pick)}`);
  }

  const line = parseNonNegativeDecimal(selection.line, "selection.line");
  const regulationGoals = BigInt(regulationScore.homeGoals + regulationScore.awayGoals);
  const comparison = regulationGoals * line.denominator - line.numerator;

  if (comparison === BIGINT_ZERO) {
    return "void";
  }

  const actual = comparison > BIGINT_ZERO ? "over" : "under";
  return selection.pick === actual ? "won" : "lost";
}

export function gradeBothTeamsToScore(
  selection: BothTeamsToScoreSelection,
  regulationScore: RegulationScore,
): GradedOutcome {
  validateRegulationScore(regulationScore);
  if (selection.pick !== "yes" && selection.pick !== "no") {
    throw new TypeError(`unsupported BTTS pick: ${String(selection.pick)}`);
  }
  const actual =
    regulationScore.homeGoals > 0 && regulationScore.awayGoals > 0 ? "yes" : "no";
  return selection.pick === actual ? "won" : "lost";
}

/**
 * Grades only the score at the end of regulation (90 minutes plus stoppage).
 * Extra-time goals and penalty shoot-out scores must never be supplied here.
 */
export function gradeSelection(
  selection: RegulationSelection,
  regulationScore: RegulationScore,
): GradedOutcome {
  switch (selection.market) {
    case "1x2":
      return gradeOneXTwo(selection, regulationScore);
    case "exact-score":
      return gradeExactScore(selection, regulationScore);
    case "totals":
      return gradeTotals(selection, regulationScore);
    case "btts":
      return gradeBothTeamsToScore(selection, regulationScore);
    default: {
      const unsupported = selection as { market?: unknown };
      throw new TypeError(`unsupported regulation market: ${String(unsupported.market)}`);
    }
  }
}
