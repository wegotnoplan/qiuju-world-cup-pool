import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  bets,
  finalPoolClosures,
  finalPoolResults,
  fixtures,
  participants,
  settlements,
} from "@/db/schema";
import { FINAL_FIXTURE_ID, PARTICIPANTS } from "@/lib/app-data";
import {
  calculateFinalDistribution,
  FINAL_DISTRIBUTION_RULE_VERSION,
} from "@/lib/final-distribution";

type Database = ReturnType<typeof getDb>;

export interface FinalSettlementProjection {
  fixtureId: typeof FINAL_FIXTURE_ID;
  eligiblePoolCents: number;
  paidCents: number;
  tickets: Array<{
    ticketId: string;
    participantId: string;
    outcome: "won" | "lost";
    payoutCents: number;
  }>;
}

export function asFinalDistributionOutcome(value: string): "won" | "lost" {
  if (value === "won" || value === "lost") return value;
  throw new Error(
    "终局派彩只接受明确的赢/输结果；当前玩法不应产生走盘或待复核注单。",
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes("UNIQUE constraint failed")) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Builds, but does not execute, the terminal-ledger inserts. Callers append
 * these statements to the same atomic batch that persists M104's ordinary
 * settlement. The projection therefore replaces M104's still-pending rows
 * without requiring a write/read gap.
 */
export async function planFinalDistributionClosure(
  db: Database,
  projection: FinalSettlementProjection,
  closedAt: string,
) {
  const [existingClosure] = await db
    .select({
      fixtureId: finalPoolClosures.fixtureId,
      ruleVersion: finalPoolClosures.ruleVersion,
    })
    .from(finalPoolClosures)
    .where(eq(finalPoolClosures.fixtureId, FINAL_FIXTURE_ID))
    .limit(1);
  if (existingClosure) {
    if (existingClosure.ruleVersion !== FINAL_DISTRIBUTION_RULE_VERSION) {
      throw new Error(
        `终局奖池已按规则 ${existingClosure.ruleVersion} 封账，不能改用 ${FINAL_DISTRIBUTION_RULE_VERSION} 重算。`,
      );
    }
    return { alreadyClosed: true as const, queries: [] as const };
  }

  if (projection.fixtureId !== FINAL_FIXTURE_ID) {
    throw new Error("终局派彩只能由 M104 的普通比赛结算触发。");
  }

  const fixtureRows = await db
    .select({ id: fixtures.id, sequence: fixtures.sequence })
    .from(fixtures)
    .orderBy(asc(fixtures.sequence));
  const fixtureIds = fixtureRows.map((fixture) => fixture.id);
  if (
    fixtureIds.length !== 4 ||
    new Set(fixtureIds).size !== 4 ||
    fixtureIds[fixtureIds.length - 1] !== FINAL_FIXTURE_ID
  ) {
    throw new Error("终局派彩要求四场比赛账本完整且 M104 为最后一场。");
  }

  const [participantRows, ledgerBetRows] = await Promise.all([
    db
      .select({ participantId: participants.id, displayOrder: participants.displayOrder })
      .from(participants)
      .where(inArray(participants.id, PARTICIPANTS.map((participant) => participant.id)))
      .orderBy(asc(participants.displayOrder)),
    db
      .select({
        ticketId: bets.id,
        fixtureId: bets.fixtureId,
        participantId: bets.participantId,
        stakeCents: bets.stakeCents,
        payoutCents: bets.payoutCents,
      })
      .from(bets)
      .where(inArray(bets.fixtureId, fixtureIds))
      .orderBy(asc(bets.placedAt), asc(bets.id)),
  ]);
  if (participantRows.length !== PARTICIPANTS.length) {
    throw new Error("终局派彩要求当前参与者名册完整。");
  }
  const participantIds = new Set(participantRows.map((row) => row.participantId));
  const unknownParticipantBet = ledgerBetRows.find(
    (ticket) => !participantIds.has(ticket.participantId),
  );
  if (unknownParticipantBet) {
    throw new Error(
      `终局账本中的参与者 ${unknownParticipantBet.participantId} 不在当前名册，不能静默忽略其注金。`,
    );
  }

  const distribution = calculateFinalDistribution({
    closedAt,
    fixtureIds,
    participants: participantRows,
    ledgerTickets: ledgerBetRows,
    m104Projection: projection,
  });
  const closureValue = {
    fixtureId: FINAL_FIXTURE_ID,
    ruleVersion: distribution.closure.ruleVersion,
    participantCount: distribution.closure.participantCount,
    remainingPoolCents: distribution.closure.remainingPoolCents,
    performancePoolCents: distribution.closure.performancePoolCents,
    rankingPoolCents: distribution.closure.rankingPoolCents,
    participationPoolCents: distribution.closure.participationPoolCents,
    distributedCents: distribution.closure.distributedCents,
    undistributedCents: distribution.closure.undistributedCents,
    winnersExist: distribution.closure.winnersExist,
    closedAt: distribution.closure.closedAt,
  };
  const resultValues = distribution.results.map((result) => ({
    fixtureId: FINAL_FIXTURE_ID,
    participantId: result.participantId,
    displayOrder: result.displayOrder,
    betCount: result.betCount,
    stakeCents: result.stakeCents,
    normalPayoutCents: result.normalPayoutCents,
    baseNetCents: result.baseNetCents,
    baseRank: result.baseRank,
    m104WinningWeight: result.m104WinningWeightCents,
    performanceBonusCents: result.performanceBonusCents,
    rankingBonusCents: result.rankingBonusCents,
    participationBonusCents: result.participationBonusCents,
    bonusCents: result.bonusCents,
    totalPayoutCents: result.totalPayoutCents,
    finalNetCents: result.finalNetCents,
    finalRank: result.finalRank,
  }));
  if (resultValues.length !== participantRows.length || resultValues.length === 0) {
    throw new Error("终局派彩结果必须完整覆盖全部参与者。");
  }

  return {
    alreadyClosed: false as const,
    queries: [
      db.insert(finalPoolClosures).values(closureValue),
      db.insert(finalPoolResults).values(resultValues),
    ] as const,
  };
}

/**
 * Backfills a terminal ledger if M104 was already settled before this schema
 * existed or a previous response was interrupted after an identical commit.
 */
export async function ensureFinalDistributionForPersistedM104(
  db: Database,
): Promise<void> {
  const [settlement] = await db
    .select()
    .from(settlements)
    .where(eq(settlements.fixtureId, FINAL_FIXTURE_ID))
    .limit(1);
  if (!settlement) return;

  const ticketRows = await db
    .select({
      ticketId: bets.id,
      participantId: bets.participantId,
      status: bets.status,
      payoutCents: bets.payoutCents,
    })
    .from(bets)
    .where(eq(bets.fixtureId, FINAL_FIXTURE_ID))
    .orderBy(asc(bets.placedAt), asc(bets.id));
  const tickets = ticketRows.map((ticket) => {
    if (ticket.status !== "won" && ticket.status !== "lost") {
      throw new Error("M104 已结算注单状态不完整，不能封闭终局奖池。");
    }
    return {
      ticketId: ticket.ticketId,
      participantId: ticket.participantId,
      outcome: asFinalDistributionOutcome(ticket.status),
      payoutCents: ticket.payoutCents,
    };
  });
  const plan = await planFinalDistributionClosure(
    db,
    {
      fixtureId: FINAL_FIXTURE_ID,
      eligiblePoolCents: settlement.eligiblePoolCents,
      paidCents: settlement.paidCents,
      tickets,
    },
    settlement.settledAt,
  );
  if (plan.alreadyClosed) return;

  try {
    await db.batch(plan.queries);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const [concurrentClosure] = await db
      .select({
        fixtureId: finalPoolClosures.fixtureId,
        ruleVersion: finalPoolClosures.ruleVersion,
      })
      .from(finalPoolClosures)
      .where(eq(finalPoolClosures.fixtureId, FINAL_FIXTURE_ID))
      .limit(1);
    if (!concurrentClosure) throw error;
    if (concurrentClosure.ruleVersion !== FINAL_DISTRIBUTION_RULE_VERSION) {
      throw new Error(
        `终局奖池已按规则 ${concurrentClosure.ruleVersion} 封账，不能改用 ${FINAL_DISTRIBUTION_RULE_VERSION} 重算。`,
      );
    }
  }
}
