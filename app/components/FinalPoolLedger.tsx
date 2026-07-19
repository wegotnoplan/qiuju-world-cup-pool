"use client";

import type { AppState, FinalPoolResult } from "@/lib/app-data";
import { ParticipantAvatar } from "./ParticipantAvatar";

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function signedMoney(cents: number): string {
  return `${cents > 0 ? "+" : ""}${money(cents)}`;
}

function netStatus(cents: number): "pos" | "neg" | "zero" {
  return cents > 0 ? "pos" : cents < 0 ? "neg" : "zero";
}

function scoreLabel(state: AppState): string {
  const fixture = state.fixtures.find((item) => item.matchCode === "M104");
  if (!fixture?.regularTimeScore) return "M104";
  return `${fixture.homeTeam.name} ${fixture.regularTimeScore.home} : ${fixture.regularTimeScore.away} ${fixture.awayTeam.name}`;
}

function total(results: FinalPoolResult[], pick: (row: FinalPoolResult) => number): number {
  return results.reduce((sum, row) => sum + pick(row), 0);
}

export function FinalPoolLedger({ state }: { state: AppState }) {
  const distribution = state.finalDistribution;
  const rows = distribution.results
    .filter((row) => row.betCount > 0)
    .sort(
      (left, right) =>
        left.finalRank - right.finalRank ||
        right.finalNetCents - left.finalNetCents ||
        left.displayOrder - right.displayOrder,
    );
  const names = new Map(state.participants.map((person) => [person.id, person.name]));

  if (distribution.status !== "closed" || !distribution.closure) {
    const ready = distribution.status === "ready_to_close";
    return (
      <div className="wb-sheet-body wb-final-ledger-body">
        <div className="wb-final-ledger-empty" data-status={distribution.status}>
          <span aria-hidden="true">账</span>
          <b>{ready ? "M104 已结算，正在生成总账" : "等待 M104 结算"}</b>
          <p>
            {ready
              ? "封账完成后，这里会直接显示每个人的最终金额。"
              : "比赛结算完成后，这里会区分下注命中派彩与剩余池分配。"}
          </p>
        </div>
      </div>
    );
  }

  const stakeCents = total(rows, (row) => row.stakeCents);
  const normalPayoutCents = total(rows, (row) => row.normalPayoutCents);
  const bonusCents = total(rows, (row) => row.bonusCents);
  const payoutCents = total(rows, (row) => row.totalPayoutCents);

  return (
    <div className="wb-sheet-body wb-final-ledger-body">
      <div className="wb-final-score-strip">
        <span>{scoreLabel(state)}</span>
        <strong>已封账 · {rows.length}人</strong>
      </div>

      <section className="wb-final-totals" aria-label="最终总账汇总">
        <div><span>总投入</span><strong>{money(stakeCents)}</strong></div>
        <div data-source="bet"><span>下注命中派彩</span><strong>{money(normalPayoutCents)}</strong></div>
        <div data-source="pool"><span>剩余池分配</span><strong>{money(bonusCents)}</strong></div>
        <div data-source="total"><span>总到账</span><strong>{money(payoutCents)}</strong></div>
      </section>

      <div className="wb-final-ledger-list" role="list" aria-label="最终到账排名">
        {rows.map((row) => (
          <article
            className="wb-final-ledger-row"
            data-highlight={row.finalRank <= 3 ? `top-${row.finalRank}` : "none"}
            key={row.participantId}
            role="listitem"
          >
            <span className="wb-final-ledger-rank" aria-label={`最终第 ${row.finalRank} 名`}>
              {row.finalRank}
            </span>
            <ParticipantAvatar participantId={row.participantId} className="wb-avatar-history" />
            <span className="wb-final-ledger-person">
              <b>{names.get(row.participantId) ?? row.participantId}</b>
              <small>{row.betCount}注 · 投入 {money(row.stakeCents)}</small>
            </span>
            <span className="wb-final-source-split">
              <span data-source="bet"><small>下注命中</small><b>{money(row.normalPayoutCents)}</b></span>
              <span data-source="pool"><small>剩余池</small><b>{money(row.bonusCents)}</b></span>
            </span>
            <span className="wb-final-ledger-total">
              <small>总到账 {money(row.totalPayoutCents)}</small>
              <strong data-net={netStatus(row.finalNetCents)}>净 {signedMoney(row.finalNetCents)}</strong>
            </span>
          </article>
        ))}
      </div>
    </div>
  );
}
