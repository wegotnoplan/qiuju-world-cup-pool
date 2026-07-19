import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_DISTRIBUTION_RULE_VERSION,
  calculateFinalDistribution,
} from "../lib/final-distribution.ts";

const FIXTURE_IDS = ["m101", "m102", "m103", "m104"];
const CLOSED_AT = "2026-07-19T08:00:00+08:00";

function participant(participantId, displayOrder) {
  return { participantId, displayOrder };
}

function ticket(ticketId, fixtureId, participantId, payoutCents = 0, stakeCents = 1_000) {
  return { ticketId, fixtureId, participantId, stakeCents, payoutCents };
}

function resultById(snapshot, participantId) {
  return snapshot.results.find((result) => result.participantId === participantId);
}

test("allocates 70/15/15 from actual M104 returns and preserves the complete ledger", () => {
  const participants = [
    participant("idle", 0),
    participant("bob", 1),
    participant("alice", 2),
    participant("carol", 3),
  ];
  const ledgerTickets = [
    ticket("a-101", "m101", "alice"),
    ticket("a-102", "m102", "alice"),
    ticket("a-103", "m103", "alice"),
    ticket("a-104", "m104", "alice"),
    ticket("b-101", "m101", "bob"),
    ticket("b-102", "m102", "bob"),
    ticket("b-104", "m104", "bob"),
    ticket("c-101", "m101", "carol"),
    ticket("c-103", "m103", "carol"),
    ticket("c-104", "m104", "carol"),
  ];
  const snapshot = calculateFinalDistribution({
    closedAt: CLOSED_AT,
    fixtureIds: FIXTURE_IDS,
    participants,
    ledgerTickets,
    m104Projection: {
      fixtureId: "m104",
      eligiblePoolCents: 10_000,
      paidCents: 9_000,
      tickets: [
        { ticketId: "a-104", participantId: "alice", outcome: "won", payoutCents: 2_400 },
        { ticketId: "b-104", participantId: "bob", outcome: "won", payoutCents: 6_600 },
        { ticketId: "c-104", participantId: "carol", outcome: "lost", payoutCents: 0 },
      ],
    },
  });

  assert.deepEqual(snapshot.closure, {
    fixtureId: "m104",
    ruleVersion: FINAL_DISTRIBUTION_RULE_VERSION,
    participantCount: 4,
    remainingPoolCents: 1_000,
    performancePoolCents: 700,
    rankingPoolCents: 150,
    participationPoolCents: 150,
    distributedCents: 1_000,
    undistributedCents: 0,
    winnersExist: true,
    closedAt: "2026-07-19T00:00:00.000Z",
  });

  assert.deepEqual(resultById(snapshot, "alice"), {
    participantId: "alice",
    displayOrder: 2,
    betCount: 4,
    stakeCents: 4_000,
    normalPayoutCents: 2_400,
    baseNetCents: -1_600,
    baseRank: 2,
    m104WinningWeightCents: 2_400,
    performanceBonusCents: 187,
    rankingBonusCents: 45,
    participationBonusCents: 60,
    bonusCents: 292,
    totalPayoutCents: 2_692,
    finalNetCents: -1_308,
    finalRank: 2,
  });
  assert.deepEqual(resultById(snapshot, "bob"), {
    participantId: "bob",
    displayOrder: 1,
    betCount: 3,
    stakeCents: 3_000,
    normalPayoutCents: 6_600,
    baseNetCents: 3_600,
    baseRank: 1,
    m104WinningWeightCents: 6_600,
    performanceBonusCents: 513,
    rankingBonusCents: 90,
    participationBonusCents: 45,
    bonusCents: 648,
    totalPayoutCents: 7_248,
    finalNetCents: 4_248,
    finalRank: 1,
  });
  assert.equal(resultById(snapshot, "carol").bonusCents, 60);
  assert.deepEqual(resultById(snapshot, "idle"), {
    participantId: "idle",
    displayOrder: 0,
    betCount: 0,
    stakeCents: 0,
    normalPayoutCents: 0,
    baseNetCents: 0,
    baseRank: 4,
    m104WinningWeightCents: 0,
    performanceBonusCents: 0,
    rankingBonusCents: 0,
    participationBonusCents: 0,
    bonusCents: 0,
    totalPayoutCents: 0,
    finalNetCents: 0,
    finalRank: 4,
  });
  assert.equal(
    snapshot.results.reduce((sum, result) => sum + result.bonusCents, 0),
    snapshot.closure.remainingPoolCents,
  );
});

test("moves an empty performance bucket to 0/50/50 and shares crossed podium slots", () => {
  const active = [
    participant("d", 4),
    participant("b", 2),
    participant("a", 1),
    participant("c", 3),
  ];
  const ledgerTickets = active.flatMap(({ participantId }) => [
    ticket(`${participantId}-prior`, "m101", participantId),
    ticket(`${participantId}-final`, "m104", participantId),
  ]);
  const snapshot = calculateFinalDistribution({
    closedAt: CLOSED_AT,
    fixtureIds: FIXTURE_IDS,
    participants: [...active, participant("idle", 0)],
    ledgerTickets,
    m104Projection: {
      fixtureId: "m104",
      eligiblePoolCents: 8_000,
      paidCents: 0,
      tickets: active.map(({ participantId }) => ({
        ticketId: `${participantId}-final`,
        participantId,
        outcome: "lost",
        payoutCents: 0,
      })),
    },
  });

  assert.equal(snapshot.closure.winnersExist, false);
  assert.equal(snapshot.closure.performancePoolCents, 0);
  assert.equal(snapshot.closure.rankingPoolCents, 4_000);
  assert.equal(snapshot.closure.participationPoolCents, 4_000);
  for (const participantId of ["a", "b", "c", "d"]) {
    const result = resultById(snapshot, participantId);
    assert.equal(result.baseRank, 1);
    assert.equal(result.rankingBonusCents, 1_000);
    assert.equal(result.participationBonusCents, 1_000);
    assert.equal(result.finalRank, 1);
  }
  assert.equal(resultById(snapshot, "idle").baseRank, 5);
  assert.equal(resultById(snapshot, "idle").finalRank, 5);
});

test("uses largest remainders and displayOrder for every one-cent tie", () => {
  const participants = [
    participant("a", 2),
    participant("b", 1),
    participant("c", 3),
  ];
  const ledgerTickets = participants.flatMap(({ participantId }) => [
    ticket(`${participantId}-prior`, "m101", participantId, 0, 1_001),
    ticket(`${participantId}-final`, "m104", participantId),
  ]);
  const snapshot = calculateFinalDistribution({
    closedAt: CLOSED_AT,
    fixtureIds: FIXTURE_IDS,
    participants,
    ledgerTickets,
    m104Projection: {
      fixtureId: "m104",
      eligiblePoolCents: 6_003,
      paidCents: 3_000,
      tickets: participants.map(({ participantId }) => ({
        ticketId: `${participantId}-final`,
        participantId,
        outcome: "won",
        payoutCents: 1_000,
      })),
    },
  });

  assert.deepEqual(
    [
      snapshot.closure.performancePoolCents,
      snapshot.closure.rankingPoolCents,
      snapshot.closure.participationPoolCents,
    ],
    [2_102, 451, 450],
  );
  assert.deepEqual(
    ["b", "a", "c"].map((id) => resultById(snapshot, id).performanceBonusCents),
    [701, 701, 700],
  );
  assert.deepEqual(
    ["b", "a", "c"].map((id) => resultById(snapshot, id).rankingBonusCents),
    [151, 150, 150],
  );
  assert.deepEqual(
    ["b", "a", "c"].map((id) => resultById(snapshot, id).participationBonusCents),
    [150, 150, 150],
  );
  assert.deepEqual(
    ["b", "a", "c"].map((id) => resultById(snapshot, id).finalRank),
    [1, 2, 3],
  );
});

test("returns a complete frozen snapshot when the ordinary remainder is zero", () => {
  const participants = [
    participant("a", 1),
    participant("b", 2),
    participant("c", 3),
  ];
  const ledgerTickets = participants.map(({ participantId }) =>
    // These stale values prove that the same-transaction M104 projection wins.
    ticket(`${participantId}-final`, "m104", participantId, 777),
  );
  const snapshot = calculateFinalDistribution({
    closedAt: CLOSED_AT,
    fixtureIds: FIXTURE_IDS,
    participants,
    ledgerTickets,
    m104Projection: {
      fixtureId: "m104",
      eligiblePoolCents: 3_000,
      paidCents: 3_000,
      tickets: [
        { ticketId: "a-final", participantId: "a", outcome: "won", payoutCents: 3_000 },
        { ticketId: "b-final", participantId: "b", outcome: "lost", payoutCents: 0 },
        { ticketId: "c-final", participantId: "c", outcome: "lost", payoutCents: 0 },
      ],
    },
  });

  assert.equal(snapshot.closure.remainingPoolCents, 0);
  assert.equal(snapshot.closure.distributedCents, 0);
  assert.equal(snapshot.closure.undistributedCents, 0);
  assert.equal(snapshot.results.length, 3);
  assert.equal(resultById(snapshot, "a").normalPayoutCents, 3_000);
  assert.equal(resultById(snapshot, "a").m104WinningWeightCents, 3_000);
  assert.ok(snapshot.results.every((result) => result.bonusCents === 0));
});

test("rejects fewer than three bettors and inconsistent terminal ledgers", () => {
  const participants = [
    participant("a", 1),
    participant("b", 2),
    participant("idle", 3),
  ];
  const ledgerTickets = [
    ticket("a-final", "m104", "a"),
    ticket("b-final", "m104", "b"),
  ];
  const projection = {
    fixtureId: "m104",
    eligiblePoolCents: 2_000,
    paidCents: 0,
    tickets: [
      { ticketId: "a-final", participantId: "a", outcome: "lost", payoutCents: 0 },
      { ticketId: "b-final", participantId: "b", outcome: "lost", payoutCents: 0 },
    ],
  };
  assert.throws(
    () =>
      calculateFinalDistribution({
        closedAt: CLOSED_AT,
        fixtureIds: FIXTURE_IDS,
        participants,
        ledgerTickets,
        m104Projection: projection,
      }),
    /at least three participants with bets/,
  );

  assert.throws(
    () =>
      calculateFinalDistribution({
        closedAt: CLOSED_AT,
        fixtureIds: FIXTURE_IDS,
        participants: [participant("a", 1), participant("b", 2), participant("c", 3)],
        ledgerTickets: [
          ticket("a-final", "m104", "a"),
          ticket("b-final", "m104", "b"),
          ticket("c-final", "m104", "c"),
        ],
        m104Projection: {
          ...projection,
          eligiblePoolCents: 2_999,
          tickets: [
            ...projection.tickets,
            { ticketId: "c-final", participantId: "c", outcome: "lost", payoutCents: 0 },
          ],
        },
      }),
    /ledger balance must equal/,
  );
});

test("requires the M104 projection to exactly cover the authoritative ledger", () => {
  assert.throws(
    () =>
      calculateFinalDistribution({
        closedAt: CLOSED_AT,
        fixtureIds: FIXTURE_IDS,
        participants: [participant("a", 1), participant("b", 2), participant("c", 3)],
        ledgerTickets: [
          ticket("a-final", "m104", "a"),
          ticket("b-final", "m104", "b"),
          ticket("c-final", "m104", "c"),
        ],
        m104Projection: {
          fixtureId: "m104",
          eligiblePoolCents: 3_000,
          paidCents: 0,
          tickets: [
            { ticketId: "a-final", participantId: "a", outcome: "lost", payoutCents: 0 },
            { ticketId: "b-final", participantId: "b", outcome: "lost", payoutCents: 0 },
          ],
        },
      }),
    /missing ledger ticket c-final/,
  );
});
