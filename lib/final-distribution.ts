/**
 * Immutable rule identifier persisted with every terminal-pool closure.
 * Changing any allocation or ranking rule requires a new version.
 */
export const FINAL_DISTRIBUTION_RULE_VERSION = "final-pool-v1" as const;

export interface FinalDistributionParticipantInput {
  participantId: string;
  displayOrder: number;
}

/**
 * One formally locked ticket retained in the four-match ledger. M104's
 * payoutCents is deliberately ignored and replaced by m104Projection so this
 * calculation can run in the same transaction as ordinary M104 settlement.
 */
export interface FinalDistributionLedgerTicketInput {
  ticketId: string;
  fixtureId: string;
  participantId: string;
  stakeCents: number;
  payoutCents: number;
}

export interface M104SettlementTicketProjection {
  ticketId: string;
  participantId: string;
  outcome: "won" | "lost";
  /** The ordinary settlement's actual (not theoretical) return. */
  payoutCents: number;
}

export interface M104SettlementProjection {
  fixtureId: string;
  eligiblePoolCents: number;
  paidCents: number;
  tickets: readonly M104SettlementTicketProjection[];
}

export interface CalculateFinalDistributionInput {
  closedAt: string;
  /** Exactly four unique fixture ids, including m104Projection.fixtureId. */
  fixtureIds: readonly string[];
  /** All registered participants, including people with no tickets. */
  participants: readonly FinalDistributionParticipantInput[];
  /** Only formally locked tickets that remain in the authoritative ledger. */
  ledgerTickets: readonly FinalDistributionLedgerTicketInput[];
  m104Projection: M104SettlementProjection;
}

export interface FinalDistributionClosure {
  fixtureId: string;
  ruleVersion: typeof FINAL_DISTRIBUTION_RULE_VERSION;
  participantCount: number;
  remainingPoolCents: number;
  performancePoolCents: number;
  rankingPoolCents: number;
  participationPoolCents: number;
  distributedCents: number;
  undistributedCents: number;
  winnersExist: boolean;
  closedAt: string;
}

export interface FinalDistributionResult {
  participantId: string;
  displayOrder: number;
  betCount: number;
  stakeCents: number;
  normalPayoutCents: number;
  baseNetCents: number;
  baseRank: number;
  m104WinningWeightCents: number;
  performanceBonusCents: number;
  rankingBonusCents: number;
  participationBonusCents: number;
  bonusCents: number;
  totalPayoutCents: number;
  finalNetCents: number;
  finalRank: number;
}

export interface FinalDistributionSnapshot {
  closure: FinalDistributionClosure;
  results: FinalDistributionResult[];
}

interface ParticipantAccumulator extends FinalDistributionResult {
  isParticipant: boolean;
}

interface WeightedClaim {
  key: string;
  weight: bigint;
  displayOrder: number;
}

const ZERO = BigInt(0);

function assertNonNegativeMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer number of cents`);
  }
}

function assertPositiveMoney(value: number, name: string): void {
  assertNonNegativeMoney(value, name);
  if (value === 0) throw new RangeError(`${name} must be greater than zero`);
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStable(
  left: Pick<WeightedClaim, "displayOrder" | "key">,
  right: Pick<WeightedClaim, "displayOrder" | "key">,
): number {
  return left.displayOrder - right.displayOrder || compareIds(left.key, right.key);
}

function toSafeNumber(value: bigint, name: string): number {
  if (value < ZERO || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds JavaScript's safe integer money range`);
  }
  return Number(value);
}

function sumSafe(values: readonly number[], name: string): number {
  return toSafeNumber(
    values.reduce((sum, value) => sum + BigInt(value), ZERO),
    name,
  );
}

/** Exact Hamilton allocation with a stable displayOrder/identifier tie-break. */
function allocateLargestRemainder(
  totalCents: number,
  claims: readonly WeightedClaim[],
  name: string,
): Map<string, number> {
  assertNonNegativeMoney(totalCents, name);
  const allocation = new Map(claims.map((claim) => [claim.key, 0]));
  if (totalCents === 0) return allocation;

  const totalWeight = claims.reduce((sum, claim) => sum + claim.weight, ZERO);
  if (totalWeight === ZERO) {
    throw new Error(`${name} has money to distribute but no positive allocation weight`);
  }

  const ranked = claims.map((claim) => {
    if (claim.weight < ZERO) {
      throw new RangeError(`${name} weights must be non-negative`);
    }
    const numerator = BigInt(totalCents) * claim.weight;
    const base = numerator / totalWeight;
    allocation.set(claim.key, toSafeNumber(base, `${name} allocation`));
    return { ...claim, remainder: numerator % totalWeight };
  });

  const baseTotal = sumSafe([...allocation.values()], `${name} base allocation`);
  const remainingCents = totalCents - baseTotal;
  ranked.sort(
    (left, right) =>
      (left.remainder === right.remainder
        ? 0
        : left.remainder > right.remainder
          ? -1
          : 1) || compareStable(left, right),
  );
  for (let index = 0; index < remainingCents; index += 1) {
    const claim = ranked[index];
    if (!claim) throw new Error(`${name} largest-remainder allocation failed`);
    allocation.set(claim.key, (allocation.get(claim.key) ?? 0) + 1);
  }
  return allocation;
}

function allocateFixedWeights(
  totalCents: number,
  weights: readonly number[],
  name: string,
): number[] {
  const allocation = allocateLargestRemainder(
    totalCents,
    weights.map((weight, index) => ({
      key: String(index),
      weight: BigInt(weight),
      displayOrder: index,
    })),
    name,
  );
  return weights.map((_, index) => allocation.get(String(index)) ?? 0);
}

function assignCompetitionRanks(
  rows: readonly ParticipantAccumulator[],
  value: (row: ParticipantAccumulator) => number,
): Map<string, number> {
  const bettors = rows
    .filter((row) => row.isParticipant)
    .slice()
    .sort(
      (left, right) =>
        value(right) - value(left) ||
        left.displayOrder - right.displayOrder ||
        compareIds(left.participantId, right.participantId),
    );
  const ranks = new Map<string, number>();
  let previousValue: number | undefined;
  let previousRank = 0;
  bettors.forEach((row, index) => {
    const currentValue = value(row);
    if (index === 0 || currentValue !== previousValue) previousRank = index + 1;
    ranks.set(row.participantId, previousRank);
    previousValue = currentValue;
  });
  const idleRank = bettors.length + 1;
  for (const row of rows) {
    if (!row.isParticipant) ranks.set(row.participantId, idleRank);
  }
  return ranks;
}

function validateAndInitialize(input: CalculateFinalDistributionInput): {
  closedAt: string;
  fixtureIds: Set<string>;
  participants: ParticipantAccumulator[];
  participantById: Map<string, ParticipantAccumulator>;
  ledgerByTicketId: Map<string, FinalDistributionLedgerTicketInput>;
  m104ProjectionByTicketId: Map<string, M104SettlementTicketProjection>;
} {
  const parsedClosedAt = Date.parse(input.closedAt);
  if (!Number.isFinite(parsedClosedAt)) {
    throw new TypeError("closedAt must be a valid date-time string");
  }

  if (input.fixtureIds.length !== 4) {
    throw new Error("final distribution requires exactly four fixture ids");
  }
  const fixtureIds = new Set<string>();
  for (const [index, fixtureId] of input.fixtureIds.entries()) {
    assertIdentifier(fixtureId, `fixtureIds[${index}]`);
    if (fixtureIds.has(fixtureId)) throw new Error(`duplicate fixtureId: ${fixtureId}`);
    fixtureIds.add(fixtureId);
  }
  assertIdentifier(input.m104Projection.fixtureId, "m104Projection.fixtureId");
  if (!fixtureIds.has(input.m104Projection.fixtureId)) {
    throw new Error("m104Projection.fixtureId must be one of the four fixture ids");
  }

  if (input.participants.length === 0) {
    throw new Error("final distribution requires registered participants");
  }
  const participantById = new Map<string, ParticipantAccumulator>();
  const participants = input.participants.map((participant, index) => {
    assertIdentifier(participant.participantId, `participants[${index}].participantId`);
    if (!Number.isSafeInteger(participant.displayOrder)) {
      throw new RangeError(`participants[${index}].displayOrder must be a safe integer`);
    }
    if (participantById.has(participant.participantId)) {
      throw new Error(`duplicate participantId: ${participant.participantId}`);
    }
    const result: ParticipantAccumulator = {
      participantId: participant.participantId,
      displayOrder: participant.displayOrder,
      betCount: 0,
      stakeCents: 0,
      normalPayoutCents: 0,
      baseNetCents: 0,
      baseRank: 0,
      m104WinningWeightCents: 0,
      performanceBonusCents: 0,
      rankingBonusCents: 0,
      participationBonusCents: 0,
      bonusCents: 0,
      totalPayoutCents: 0,
      finalNetCents: 0,
      finalRank: 0,
      isParticipant: false,
    };
    participantById.set(participant.participantId, result);
    return result;
  });

  const ledgerByTicketId = new Map<string, FinalDistributionLedgerTicketInput>();
  input.ledgerTickets.forEach((ticket, index) => {
    assertIdentifier(ticket.ticketId, `ledgerTickets[${index}].ticketId`);
    assertIdentifier(ticket.fixtureId, `ledgerTickets[${index}].fixtureId`);
    assertIdentifier(ticket.participantId, `ledgerTickets[${index}].participantId`);
    if (ledgerByTicketId.has(ticket.ticketId)) {
      throw new Error(`duplicate ledger ticketId: ${ticket.ticketId}`);
    }
    if (!fixtureIds.has(ticket.fixtureId)) {
      throw new Error(`ledger ticket ${ticket.ticketId} belongs to an unknown fixture`);
    }
    if (!participantById.has(ticket.participantId)) {
      throw new Error(`ledger ticket ${ticket.ticketId} belongs to an unknown participant`);
    }
    assertPositiveMoney(ticket.stakeCents, `ledgerTickets[${index}].stakeCents`);
    assertNonNegativeMoney(ticket.payoutCents, `ledgerTickets[${index}].payoutCents`);
    ledgerByTicketId.set(ticket.ticketId, ticket);
  });

  assertNonNegativeMoney(
    input.m104Projection.eligiblePoolCents,
    "m104Projection.eligiblePoolCents",
  );
  assertNonNegativeMoney(input.m104Projection.paidCents, "m104Projection.paidCents");
  if (input.m104Projection.paidCents > input.m104Projection.eligiblePoolCents) {
    throw new RangeError("m104Projection.paidCents cannot exceed eligiblePoolCents");
  }

  const m104ProjectionByTicketId = new Map<string, M104SettlementTicketProjection>();
  input.m104Projection.tickets.forEach((ticket, index) => {
    assertIdentifier(ticket.ticketId, `m104Projection.tickets[${index}].ticketId`);
    assertIdentifier(
      ticket.participantId,
      `m104Projection.tickets[${index}].participantId`,
    );
    if (m104ProjectionByTicketId.has(ticket.ticketId)) {
      throw new Error(`duplicate M104 projection ticketId: ${ticket.ticketId}`);
    }
    if (ticket.outcome !== "won" && ticket.outcome !== "lost") {
      throw new TypeError(`M104 ticket ${ticket.ticketId} must be won or lost`);
    }
    assertNonNegativeMoney(
      ticket.payoutCents,
      `m104Projection.tickets[${index}].payoutCents`,
    );
    if (ticket.outcome === "lost" && ticket.payoutCents !== 0) {
      throw new Error(`lost M104 ticket ${ticket.ticketId} cannot have a payout`);
    }
    const ledgerTicket = ledgerByTicketId.get(ticket.ticketId);
    if (!ledgerTicket || ledgerTicket.fixtureId !== input.m104Projection.fixtureId) {
      throw new Error(`M104 projection ticket ${ticket.ticketId} is not in the M104 ledger`);
    }
    if (ledgerTicket.participantId !== ticket.participantId) {
      throw new Error(`M104 projection participant mismatch for ticket ${ticket.ticketId}`);
    }
    m104ProjectionByTicketId.set(ticket.ticketId, ticket);
  });

  const m104LedgerTickets = input.ledgerTickets.filter(
    (ticket) => ticket.fixtureId === input.m104Projection.fixtureId,
  );
  for (const ticket of m104LedgerTickets) {
    if (!m104ProjectionByTicketId.has(ticket.ticketId)) {
      throw new Error(`M104 projection is missing ledger ticket ${ticket.ticketId}`);
    }
  }
  if (m104ProjectionByTicketId.size !== m104LedgerTickets.length) {
    throw new Error("M104 projection must exactly cover the M104 ledger");
  }
  const projectedPaidCents = sumSafe(
    input.m104Projection.tickets.map((ticket) => ticket.payoutCents),
    "M104 projected payouts",
  );
  if (projectedPaidCents !== input.m104Projection.paidCents) {
    throw new Error("m104Projection.paidCents must equal projected ticket payouts");
  }

  return {
    closedAt: new Date(parsedClosedAt).toISOString(),
    fixtureIds,
    participants,
    participantById,
    ledgerByTicketId,
    m104ProjectionByTicketId,
  };
}

/**
 * Calculates the immutable terminal-pool snapshot without database or clock
 * access. Ordinary four-match results remain separate from terminal bonuses.
 */
export function calculateFinalDistribution(
  input: CalculateFinalDistributionInput,
): FinalDistributionSnapshot {
  const validated = validateAndInitialize(input);
  const { participants, participantById, m104ProjectionByTicketId } = validated;

  for (const ticket of input.ledgerTickets) {
    const participant = participantById.get(ticket.participantId)!;
    const projectedM104 = m104ProjectionByTicketId.get(ticket.ticketId);
    participant.betCount += 1;
    participant.stakeCents = sumSafe(
      [participant.stakeCents, ticket.stakeCents],
      `${participant.participantId} stake`,
    );
    participant.normalPayoutCents = sumSafe(
      [participant.normalPayoutCents, projectedM104?.payoutCents ?? ticket.payoutCents],
      `${participant.participantId} ordinary payout`,
    );
    if (projectedM104?.outcome === "won") {
      participant.m104WinningWeightCents = sumSafe(
        [participant.m104WinningWeightCents, projectedM104.payoutCents],
        `${participant.participantId} M104 winning weight`,
      );
    }
  }

  const activeParticipants = participants.filter((participant) => participant.betCount > 0);
  if (activeParticipants.length < 3) {
    throw new Error("final distribution requires at least three participants with bets");
  }
  const remainingPoolCents =
    input.m104Projection.eligiblePoolCents - input.m104Projection.paidCents;
  const ledgerStakeCents = sumSafe(
    participants.map((participant) => participant.stakeCents),
    "four-match ledger stakes",
  );
  const ledgerNormalPayoutCents = sumSafe(
    participants.map((participant) => participant.normalPayoutCents),
    "four-match ordinary payouts",
  );
  if (ledgerNormalPayoutCents > ledgerStakeCents) {
    throw new Error("four-match ordinary payouts cannot exceed ledger stakes");
  }
  if (ledgerStakeCents - ledgerNormalPayoutCents !== remainingPoolCents) {
    throw new Error(
      "four-match ledger balance must equal the M104 ordinary settlement remainder",
    );
  }
  for (const participant of participants) {
    participant.isParticipant = participant.betCount > 0;
    participant.baseNetCents = participant.normalPayoutCents - participant.stakeCents;
  }
  const baseRanks = assignCompetitionRanks(participants, (participant) => participant.baseNetCents);
  for (const participant of participants) {
    participant.baseRank = baseRanks.get(participant.participantId)!;
  }

  const winnersExist = input.m104Projection.tickets.some(
    (ticket) => ticket.outcome === "won",
  );
  const [performancePoolCents, rankingPoolCents, participationPoolCents] =
    allocateFixedWeights(
      remainingPoolCents,
      winnersExist ? [70, 15, 15] : [0, 50, 50],
      "terminal pool buckets",
    );

  if (performancePoolCents > 0) {
    const performanceAllocation = allocateLargestRemainder(
      performancePoolCents,
      activeParticipants.map((participant) => ({
        key: participant.participantId,
        weight: BigInt(participant.m104WinningWeightCents),
        displayOrder: participant.displayOrder,
      })),
      "M104 performance pool",
    );
    for (const participant of activeParticipants) {
      participant.performanceBonusCents =
        performanceAllocation.get(participant.participantId) ?? 0;
    }
  }

  if (rankingPoolCents > 0) {
    const [firstSlotCents, secondSlotCents, thirdSlotCents] = allocateFixedWeights(
      rankingPoolCents,
      [60, 30, 10],
      "ranking prize slots",
    );
    const slotCents = [firstSlotCents, secondSlotCents, thirdSlotCents];
    const ranked = activeParticipants
      .slice()
      .sort(
        (left, right) =>
          left.baseRank - right.baseRank ||
          left.displayOrder - right.displayOrder ||
          compareIds(left.participantId, right.participantId),
      );
    for (let index = 0; index < ranked.length; ) {
      const rank = ranked[index].baseRank;
      let end = index + 1;
      while (end < ranked.length && ranked[end].baseRank === rank) end += 1;
      const tied = ranked.slice(index, end);
      const firstSlotIndex = rank - 1;
      const lastSlotExclusive = Math.min(firstSlotIndex + tied.length, 3);
      const tiedPoolCents =
        firstSlotIndex >= 3
          ? 0
          : sumSafe(
              slotCents.slice(firstSlotIndex, lastSlotExclusive),
              `rank ${rank} tied slots`,
            );
      if (tiedPoolCents > 0) {
        const tiedAllocation = allocateLargestRemainder(
          tiedPoolCents,
          tied.map((participant) => ({
            key: participant.participantId,
            weight: BigInt(1),
            displayOrder: participant.displayOrder,
          })),
          `rank ${rank} tied prize`,
        );
        for (const participant of tied) {
          participant.rankingBonusCents =
            tiedAllocation.get(participant.participantId) ?? 0;
        }
      }
      index = end;
    }
  }

  if (participationPoolCents > 0) {
    const participationAllocation = allocateLargestRemainder(
      participationPoolCents,
      activeParticipants.map((participant) => ({
        key: participant.participantId,
        weight: BigInt(participant.betCount),
        displayOrder: participant.displayOrder,
      })),
      "participation pool",
    );
    for (const participant of activeParticipants) {
      participant.participationBonusCents =
        participationAllocation.get(participant.participantId) ?? 0;
    }
  }

  for (const participant of participants) {
    participant.bonusCents = sumSafe(
      [
        participant.performanceBonusCents,
        participant.rankingBonusCents,
        participant.participationBonusCents,
      ],
      `${participant.participantId} terminal bonus`,
    );
    participant.totalPayoutCents = sumSafe(
      [participant.normalPayoutCents, participant.bonusCents],
      `${participant.participantId} final payout`,
    );
    participant.finalNetCents = participant.totalPayoutCents - participant.stakeCents;
  }
  const finalRanks = assignCompetitionRanks(participants, (participant) => participant.finalNetCents);
  for (const participant of participants) {
    participant.finalRank = finalRanks.get(participant.participantId)!;
  }

  const distributedCents = sumSafe(
    participants.map((participant) => participant.bonusCents),
    "terminal distributed total",
  );
  const expectedDistributedCents = sumSafe(
    [performancePoolCents, rankingPoolCents, participationPoolCents],
    "terminal bucket total",
  );
  if (distributedCents !== expectedDistributedCents) {
    throw new Error("terminal distribution does not conserve its bucket totals");
  }
  const undistributedCents = remainingPoolCents - distributedCents;
  if (undistributedCents !== 0) {
    throw new Error("terminal distribution left an unexpected undistributed balance");
  }

  return {
    closure: {
      fixtureId: input.m104Projection.fixtureId,
      ruleVersion: FINAL_DISTRIBUTION_RULE_VERSION,
      participantCount: participants.length,
      remainingPoolCents,
      performancePoolCents,
      rankingPoolCents,
      participationPoolCents,
      distributedCents,
      undistributedCents,
      winnersExist,
      closedAt: validated.closedAt,
    },
    results: participants
      .slice()
      .sort(
        (left, right) =>
          left.displayOrder - right.displayOrder ||
          compareIds(left.participantId, right.participantId),
      )
      .map(({ isParticipant, ...result }) => {
        void isParticipant;
        return result;
      }),
  };
}
