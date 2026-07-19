"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, FinalPoolResult } from "@/lib/app-data";
import { ParticipantAvatar } from "./ParticipantAvatar";

function unwrapState(payload: unknown): AppState {
  return (payload as { state?: AppState }).state ?? (payload as AppState);
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function signedMoney(cents: number): string {
  return `${cents > 0 ? "+" : ""}${money(cents)}`;
}

function formatWeight(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
}

function shanghaiDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

async function responseError(response: Response): Promise<string> {
  return response
    .json()
    .then((body: { error?: string; message?: string }) =>
      body.error ?? body.message ?? `请求失败（${response.status}）`,
    )
    .catch(() => `请求失败（${response.status}）`);
}

async function fetchAppState(signal?: AbortSignal): Promise<AppState> {
  const response = await fetch("/api/state", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  return unwrapState(await response.json());
}

export function FinalPoolLedger() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  const loadState = useCallback(async (signal?: AbortSignal) => {
    try {
      setState(await fetchAppState(signal));
      setError(null);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "最终总账读取失败");
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppState(controller.signal)
      .then((nextState) => {
        setState(nextState);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "最终总账读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, []);

  function refreshState(): void {
    setRefreshing(true);
    void loadState();
  }

  const distribution = state?.finalDistribution ?? null;
  const closure = distribution?.closure ?? null;
  const status = distribution?.status ?? "waiting_for_m104";
  const m104 = state?.fixtures.find((fixture) => fixture.matchCode === "M104") ?? null;
  const legacyRemainingCents = m104?.settlement
    ? Math.max(0, m104.settlement.eligiblePoolCents - m104.settlement.paidCents)
    : state?.pool.balanceCents ?? 0;

  const rankedResults = useMemo(
    () =>
      [...(distribution?.results ?? [])].sort(
        (a, b) =>
          a.finalRank - b.finalRank ||
          b.finalNetCents - a.finalNetCents ||
          a.displayOrder - b.displayOrder,
      ),
    [distribution?.results],
  );

  const participantNames = useMemo(
    () => new Map(state?.participants.map((person) => [person.id, person.name]) ?? []),
    [state?.participants],
  );

  const statusCopy = status === "closed"
    ? {
        badge: "已封账",
        title: "全部奖池已经完成最终分配",
        detail: "四场比赛的常规结算保持不变；这里单独汇总终局加奖与最终到账。",
      }
    : status === "ready_to_close"
      ? {
          badge: "待封账",
          title: "M104 已完成常规结算，等待封账快照",
          detail: "比赛账已经冻结，终局三桶派彩尚未写入；刷新后可查看最终结果。",
        }
      : {
          badge: "等待 M104",
          title: "最终派彩将在决赛结算后生成",
          detail: "当前只展示规则预览；M104 比赛卡与现有天梯仍按纯比赛账运行。",
        };

  const bucketCards = closure
    ? [
        {
          key: "performance",
          eyebrow: closure.winnersExist ? "末轮奖励 · 70%" : "末轮奖励 · 已转出",
          title: "M104 命中奖励",
          amount: closure.performancePoolCents,
          detail: closure.winnersExist
            ? "按每个人 M104 中奖彩票的命中权重瓜分。"
            : "M104 无人命中，本桶一半转入排名桶、一半转入参与桶。",
          rows: rankedResults.filter((row) => row.performanceBonusCents > 0),
          rowMeta: (row: FinalPoolResult) => `命中权重 ${formatWeight(row.m104WinningWeight)}`,
          rowAmount: (row: FinalPoolResult) => row.performanceBonusCents,
        },
        {
          key: "ranking",
          eyebrow: closure.winnersExist ? "排名奖励 · 15%" : "排名奖励 · 实际 50%",
          title: "常规天梯前三",
          amount: closure.rankingPoolCents,
          detail: "按四场纯比赛账名次派发：第一名 60%、第二名 30%、第三名 10%。",
          rows: rankedResults.filter((row) => row.rankingBonusCents > 0),
          rowMeta: (row: FinalPoolResult) => `常规榜第 ${row.baseRank} 名`,
          rowAmount: (row: FinalPoolResult) => row.rankingBonusCents,
        },
        {
          key: "participation",
          eyebrow: closure.winnersExist ? "参与奖励 · 15%" : "参与奖励 · 实际 50%",
          title: "四场参与加权",
          amount: closure.participationPoolCents,
          detail: "按四场正式锁定并保留在账本中的注单数量加权；零注者不参与。",
          rows: rankedResults.filter((row) => row.participationBonusCents > 0),
          rowMeta: (row: FinalPoolResult) => `${row.betCount} 注`,
          rowAmount: (row: FinalPoolResult) => row.participationBonusCents,
        },
      ]
    : [];

  const previewBuckets = [
    { percentage: "70%", title: "M104 命中奖励", detail: "按 M104 中奖彩票的命中权重加权派发。" },
    { percentage: "15%", title: "常规排名奖励", detail: "纯比赛账前三名按 60% / 30% / 10% 派发。" },
    { percentage: "15%", title: "参与奖励", detail: "按四场正式锁定注单总数加权派发。" },
  ];

  const finalTotalPayoutCents = rankedResults.reduce(
    (sum, row) => sum + row.totalPayoutCents,
    0,
  );
  const totalStakeCents = rankedResults.reduce((sum, row) => sum + row.stakeCents, 0);
  const normalPayoutCents = rankedResults.reduce(
    (sum, row) => sum + row.normalPayoutCents,
    0,
  );
  const distributedParticipantCount = rankedResults.filter((row) => row.betCount > 0).length;
  const m104Score = m104?.regularTimeScore
    ? `${m104.regularTimeScore.home} : ${m104.regularTimeScore.away}`
    : "未记录";

  return (
    <div className="wb-app wb-final-app">
      <header className="wb-topbar">
        <Link className="wb-brand" href="/" aria-label="返回球局比赛页">
          <span>球局</span><small>世界杯奖池</small>
        </Link>
        <span className="wb-final-ledger-link is-current" aria-current="page">最终总账</span>
        <nav className="wb-final-top-actions" aria-label="最终总账导航">
          <Link href="/">返回比赛</Link>
        </nav>
      </header>

      <main className="wb-final-main">
        {!state ? (
          <section className="wb-final-state-card" aria-busy={refreshing}>
            <span className="wb-ledger-loading-mark" aria-hidden="true">账</span>
            <h1>{error ? "最终总账暂时无法读取" : "正在读取最终总账"}</h1>
            <p>{error ?? "正在核对 M104 状态、封账快照和逐人派彩。"}</p>
            {error && (
              <button type="button" onClick={refreshState} disabled={refreshing}>
                {refreshing ? "重新读取中…" : "重新读取"}
              </button>
            )}
          </section>
        ) : (
          <>
            <section className="wb-final-hero" data-status={status}>
              <div className="wb-final-hero-copy">
                <span>FINAL POOL LEDGER</span>
                <h1>最终总账</h1>
                <p>{statusCopy.title}</p>
                <small>{statusCopy.detail}</small>
              </div>
              <div className="wb-final-status-cluster">
                <strong>{statusCopy.badge}</strong>
                {closure && <small>{shanghaiDateTime(closure.closedAt)} 封账</small>}
                <button type="button" onClick={refreshState} disabled={refreshing}>
                  {refreshing ? "刷新中…" : "刷新账本"}
                </button>
              </div>
            </section>

            {error && (
              <div className="wb-final-inline-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)}>关闭</button>
              </div>
            )}

            <section className="wb-final-section" aria-labelledby="final-summary-title">
              <div className="wb-final-section-head">
                <div><span>01</span><h2 id="final-summary-title">封账摘要</h2></div>
                <p>终局分配独立记账，不改写任何比赛注单与常规派彩。</p>
              </div>
              {closure ? (
                <>
                  <div className="wb-final-summary-grid">
                    <div><span>四场总投入</span><strong>{money(totalStakeCents)}</strong></div>
                    <div><span>四场常规派彩</span><strong>{money(normalPayoutCents)}</strong></div>
                    <div><span>M104 常规结算余款</span><strong>{money(closure.remainingPoolCents)}</strong></div>
                    <div><span>终局派彩</span><strong>{money(closure.distributedCents)}</strong></div>
                    <div><span>未分配</span><strong>{money(closure.undistributedCents)}</strong></div>
                  </div>
                  <p className="wb-final-conservation">
                    <b>金额守恒</b>
                    <span>
                      四场总投入 {money(totalStakeCents)} = 四场常规派彩 {money(normalPayoutCents)} + 终局派彩 {money(closure.distributedCents)} + 未分配 {money(closure.undistributedCents)}
                    </span>
                  </p>
                </>
              ) : (
                <div className="wb-final-pending-summary" data-status={status}>
                  <span aria-hidden="true">{status === "ready_to_close" ? "⌛" : "M104"}</span>
                  <div>
                    <b>{status === "ready_to_close" ? "常规比赛账已结算，终局账待封存" : "M104 尚未完成常规结算"}</b>
                    <p>
                      {status === "ready_to_close"
                        ? `当前可封账余款为 ${money(legacyRemainingCents)}；生成不可变快照后会展示逐人最终到账。`
                        : "决赛正常派彩完成后，才会以常规结算余款作为终局三桶的分配本金。"}
                    </p>
                  </div>
                </div>
              )}
            </section>

            {closure && (
              <section className="wb-final-section" aria-labelledby="final-ranking-title">
                <div className="wb-final-section-head">
                  <div><span>02</span><h2 id="final-ranking-title">最终排行榜</h2></div>
                  <p>最终净收益 = 四场常规派彩 + 终局加奖 - 四场总投入。</p>
                </div>
                <div className="wb-final-ranking" role="list">
                  {rankedResults.map((row) => {
                    const name = participantNames.get(row.participantId) ?? row.participantId;
                    const netStatus = row.finalNetCents > 0 ? "pos" : row.finalNetCents < 0 ? "neg" : "zero";
                    return (
                      <article
                        className="wb-final-rank-row"
                        data-highlight={row.betCount > 0 && row.finalRank <= 3 ? `top-${row.finalRank}` : "none"}
                        data-idle={row.betCount === 0 ? "true" : undefined}
                        key={row.participantId}
                        role="listitem"
                      >
                        <span className="wb-final-rank-number" aria-label={row.betCount === 0 ? "未参与" : `最终第 ${row.finalRank} 名`}>
                          {row.betCount === 0 ? "×" : row.finalRank}
                        </span>
                        <ParticipantAvatar participantId={row.participantId} className="wb-avatar-history" />
                        <span className="wb-final-rank-person">
                          <b>{name}</b>
                          <small>{row.betCount === 0 ? "未下注 · 不参与底池派发" : `${row.betCount}注 · 常规榜第${row.baseRank}名`}</small>
                        </span>
                        <span className="wb-final-rank-breakdown">
                          <small>常规 {money(row.normalPayoutCents)} · 加奖 {money(row.bonusCents)}</small>
                          <b>最终到账 {money(row.totalPayoutCents)}</b>
                        </span>
                        <strong data-net={netStatus}>{signedMoney(row.finalNetCents)}</strong>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="wb-final-section" aria-labelledby="final-buckets-title">
              <div className="wb-final-section-head">
                <div><span>{closure ? "03" : "02"}</span><h2 id="final-buckets-title">三桶审计</h2></div>
                <p>{closure ? "每一分钱都可回溯到分桶、权重和个人实收。" : "预览比例将在 M104 常规结算完成后固化。"}</p>
              </div>
              {closure ? (
                <div className="wb-final-bucket-grid">
                  {bucketCards.map((bucket) => (
                    <article className="wb-final-bucket" data-bucket={bucket.key} key={bucket.key}>
                      <header>
                        <span>{bucket.eyebrow}</span>
                        <h3>{bucket.title}</h3>
                        <strong>{money(bucket.amount)}</strong>
                        <p>{bucket.detail}</p>
                      </header>
                      <div className="wb-final-bucket-rows">
                        {bucket.rows.length > 0 ? bucket.rows.map((row) => (
                          <div key={row.participantId}>
                            <span>
                              <ParticipantAvatar participantId={row.participantId} className="wb-avatar-draft" />
                              <span><b>{participantNames.get(row.participantId) ?? row.participantId}</b><small>{bucket.rowMeta(row)}</small></span>
                            </span>
                            <strong>{money(bucket.rowAmount(row))}</strong>
                          </div>
                        )) : (
                          <p className="wb-final-bucket-empty">本桶没有直接派彩对象</p>
                        )}
                      </div>
                      <footer className="wb-final-bucket-check">
                        <span>桶预算 = 逐人实收合计</span>
                        <strong>
                          {money(bucket.amount)} = {money(bucket.rows.reduce((sum, row) => sum + bucket.rowAmount(row), 0))}
                        </strong>
                        <small>
                          未分配 {money(Math.max(0, bucket.amount - bucket.rows.reduce((sum, row) => sum + bucket.rowAmount(row), 0)))}
                        </small>
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="wb-final-preview-grid">
                  {previewBuckets.map((bucket) => (
                    <article key={bucket.title}>
                      <strong>{bucket.percentage}</strong>
                      <div><h3>{bucket.title}</h3><p>{bucket.detail}</p></div>
                    </article>
                  ))}
                  <p className="wb-final-fallback-note">
                    <b>M104 无人命中时</b>
                    <span>70% 桶不闲置：一半转入排名桶，一半转入参与桶，最终按实际 0% / 50% / 50% 派发。</span>
                  </p>
                </div>
              )}
            </section>

            <section className="wb-final-section wb-final-basis" aria-labelledby="final-basis-title">
              <div className="wb-final-section-head">
                <div><span>{closure ? "04" : "03"}</span><h2 id="final-basis-title">封账依据</h2></div>
                <p>规则固定、快照固定，重复读取不会重复派彩。</p>
              </div>
              <ol>
                <li><b>先结比赛账</b><span>M104 仍按原规则完成常规派彩，剩余金额才进入最终总账。</span></li>
                <li><b>再做三桶派彩</b><span>末轮命中奖励、常规排名奖励、参与奖励分别计算，零注者不参与终局奖金。</span></li>
                <li><b>金额按分结算</b><span>除法尾差使用最大余数法补齐；同余数时按固定顺序决定，确保派发总额可核对。</span></li>
                <li><b>封账快照幂等</b><span>封账结果独立于比赛账保存，重复执行或刷新不会改变已封存金额。</span></li>
              </ol>
              {closure && (
                <dl className="wb-final-audit-meta">
                  <div><dt>规则版本</dt><dd>{closure.ruleVersion}</dd></div>
                  <div><dt>M104 90分钟比分</dt><dd>{m104Score}</dd></div>
                  <div><dt>普通结算时间</dt><dd>{m104?.settlement ? shanghaiDateTime(m104.settlement.settledAt) : "未记录"}</dd></div>
                  <div><dt>封账时间</dt><dd>{shanghaiDateTime(closure.closedAt)}</dd></div>
                  <div><dt>有效分配人数</dt><dd>{distributedParticipantCount} 人</dd></div>
                  <div><dt>最终总派彩</dt><dd>{money(finalTotalPayoutCents)}</dd></div>
                  <div><dt>余款核对</dt><dd>{money(closure.remainingPoolCents)}</dd></div>
                  <div><dt>未分配</dt><dd>{money(closure.undistributedCents)}</dd></div>
                </dl>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
