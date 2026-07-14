import assert from "node:assert/strict";
import test from "node:test";

import {
  STAKE_FEN,
  calculateTheoreticalReturnFen,
  gradeSelection,
  settlePool,
} from "../lib/settlement.ts";

test("calculates returns in fen with exact round-half-up and an optional cap", () => {
  assert.equal(STAKE_FEN, 1_000);
  assert.equal(calculateTheoreticalReturnFen("2.3454"), 2_345);
  assert.equal(calculateTheoreticalReturnFen("2.3455"), 2_346);
  assert.equal(calculateTheoreticalReturnFen(250, 100), 100_000);
  assert.equal(calculateTheoreticalReturnFen("2.5e1", "7.25"), 7_250);
});

test("pays winners and void refunds in full, then rolls the balance forward", () => {
  const settlement = settlePool({
    poolFen: 10_000,
    tickets: [
      { ticketId: "winner", ticketSequence: 2, odds: "2.3455", outcome: "won" },
      { ticketId: "void", ticketSequence: 1, odds: 8, outcome: "void" },
      { ticketId: "loser", ticketSequence: 3, odds: 3, outcome: "lost" },
    ],
  });

  assert.equal(settlement.theoreticalWinningReturnsFen, 2_346);
  assert.equal(settlement.voidRefundsDueFen, 1_000);
  assert.equal(settlement.winnerPayoutFen, 2_346);
  assert.equal(settlement.voidRefundFen, 1_000);
  assert.equal(settlement.totalPayoutFen, 3_346);
  assert.equal(settlement.rolloverFen, 6_654);
  assert.equal(settlement.poolSufficient, true);
  assert.equal(settlement.winnerPayoutsProrated, false);
  assert.equal(settlement.voidRefundsProrated, false);
  assert.deepEqual(
    settlement.tickets.map(({ ticketId, payoutFen, shortfallFen }) => ({
      ticketId,
      payoutFen,
      shortfallFen,
    })),
    [
      { ticketId: "winner", payoutFen: 2_346, shortfallFen: 0 },
      { ticketId: "void", payoutFen: 1_000, shortfallFen: 0 },
      { ticketId: "loser", payoutFen: 0, shortfallFen: 0 },
    ],
  );
});

test("uses largest remainders and ticketSequence as the stable one-fen tie-break", () => {
  const settlement = settlePool({
    poolFen: 1_001,
    tickets: [
      { ticketId: "submitted-later", ticketSequence: 20, odds: 2, outcome: "won" },
      { ticketId: "submitted-first", ticketSequence: 10, odds: 2, outcome: "won" },
    ],
  });

  assert.equal(settlement.totalPayoutFen, 1_001);
  assert.equal(settlement.rolloverFen, 0);
  assert.equal(settlement.poolSufficient, false);
  assert.equal(settlement.winnerPayoutsProrated, true);
  assert.equal(settlement.tickets[0].payoutFen, 500);
  assert.equal(settlement.tickets[1].payoutFen, 501);
});

test("awards a non-tied largest remainder before ticket order", () => {
  const settlement = settlePool({
    poolFen: 1_001,
    tickets: [
      { ticketId: "small", ticketSequence: 1, odds: 1, outcome: "won" },
      { ticketId: "large", ticketSequence: 2, odds: 3, outcome: "won" },
    ],
  });

  assert.equal(settlement.tickets[0].payoutFen, 250);
  assert.equal(settlement.tickets[1].payoutFen, 751);
});

test("refunds void stakes first and deterministically prorates even an impossible short pool", () => {
  const settlement = settlePool({
    poolFen: 501,
    tickets: [
      { ticketId: "void-later", ticketSequence: 8, odds: 4, outcome: "void" },
      { ticketId: "winner", ticketSequence: 1, odds: 2, outcome: "won" },
      { ticketId: "void-first", ticketSequence: 3, odds: 9, outcome: "void" },
    ],
  });

  assert.equal(settlement.tickets[0].payoutFen, 250);
  assert.equal(settlement.tickets[1].payoutFen, 0);
  assert.equal(settlement.tickets[2].payoutFen, 251);
  assert.equal(settlement.voidRefundsProrated, true);
  assert.equal(settlement.winnerPayoutsProrated, true);
  assert.equal(settlement.rolloverFen, 0);
});

test("applies the odds cap to winning returns without altering the entered odds", () => {
  const settlement = settlePool({
    poolFen: 200_000,
    oddsCap: 100,
    tickets: [
      { ticketId: "longshot", ticketSequence: 1, odds: 250, outcome: "won" },
    ],
  });

  assert.equal(settlement.tickets[0].odds, 250);
  assert.equal(settlement.tickets[0].effectiveOdds, "100");
  assert.equal(settlement.tickets[0].oddsCapApplied, true);
  assert.equal(settlement.tickets[0].theoreticalReturnFen, 100_000);
  assert.equal(settlement.rolloverFen, 100_000);
});

test("grades only 90 minutes plus stoppage time for all supported markets", () => {
  const regulationScore = {
    homeGoals: 1,
    awayGoals: 1,
    // Deliberately ignored: the helper only reads regulation goals.
    extraTimeHomeGoals: 2,
    extraTimeAwayGoals: 0,
    homePenalties: 5,
    awayPenalties: 4,
  };

  assert.equal(gradeSelection({ market: "1x2", pick: "draw" }, regulationScore), "won");
  assert.equal(gradeSelection({ market: "1x2", pick: "home" }, regulationScore), "lost");
  assert.equal(
    gradeSelection(
      { market: "exact-score", homeGoals: 1, awayGoals: 1 },
      regulationScore,
    ),
    "won",
  );
  assert.equal(
    gradeSelection({ market: "totals", pick: "under", line: "2.5" }, regulationScore),
    "won",
  );
  assert.equal(
    gradeSelection({ market: "totals", pick: "over", line: 2 }, regulationScore),
    "void",
  );
  assert.equal(gradeSelection({ market: "btts", pick: "yes" }, regulationScore), "won");
});

test("rejects unsafe money, invalid odds, and unstable duplicate sequences", () => {
  assert.throws(
    () => settlePool({ poolFen: 10.5, tickets: [] }),
    /non-negative safe integer/,
  );
  assert.throws(() => calculateTheoreticalReturnFen("0.99"), /at least 1\.0/);
  assert.throws(
    () =>
      settlePool({
        poolFen: 2_000,
        tickets: [
          { ticketId: "one", ticketSequence: 4, odds: 2, outcome: "won" },
          { ticketId: "two", ticketSequence: 4, odds: 2, outcome: "won" },
        ],
      }),
    /duplicate ticketSequence/,
  );
});
