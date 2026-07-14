"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createSeedState,
  type AppState,
  type Fixture,
  type OddsOffer,
  type ParticipantId,
} from "@/lib/app-data";
import { ApiSportsGameWidget } from "./ApiSportsGameWidget";
import { ParticipantAvatar } from "./ParticipantAvatar";
import { PoolPodium, type PoolRankingRow } from "./PoolPodium";

type DraftSlots = Partial<Record<ParticipantId, Array<OddsOffer | null>>>;
type SheetName = "people" | "odds" | "confirm" | "manage" | "rules" | null;

const STAGE_LABEL: Record<Fixture["stage"], string> = {
  semi_final: "半决赛",
  third_place: "三四名决赛",
  final: "决赛",
};

const MARKET_ORDER = [
  "MATCH_RESULT",
  "HANDICAP_1X2_HOME_MINUS_1",
  "EXACT_SCORE",
  "TOTAL_GOALS_EXACT",
  "HALF_FULL_TIME",
] as const;

const MARKET_LABEL: Record<string, string> = {
  MATCH_RESULT: "胜平负",
  MONEYLINE_90: "胜平负",
  "1X2": "胜平负",
  HANDICAP_1X2_HOME_MINUS_1: "让球胜平负",
  HANDICAP_3WAY_HOME_MINUS_1: "让球胜平负",
  EXACT_SCORE: "比分",
  CORRECT_SCORE: "比分",
  TOTAL_GOALS_EXACT: "总进球",
  EXACT_TOTAL_GOALS: "总进球",
  HALF_FULL_TIME: "半全场",
  HALF_FULL: "半全场",
};

const SCORE_ORDER = [
  "1-0", "2-0", "2-1", "3-0", "3-1", "3-2", "4-0", "4-1", "4-2", "5-0", "5-1", "5-2", "HOME_OTHER",
  "0-0", "1-1", "2-2", "3-3", "DRAW_OTHER",
  "0-1", "0-2", "1-2", "0-3", "1-3", "2-3", "0-4", "1-4", "2-4", "0-5", "1-5", "2-5", "AWAY_OTHER",
];
const HALF_FULL_ORDER = [
  "HOME_HOME", "HOME_DRAW", "HOME_AWAY",
  "DRAW_HOME", "DRAW_DRAW", "DRAW_AWAY",
  "AWAY_HOME", "AWAY_DRAW", "AWAY_AWAY",
];
const LIVE_SYNC_INTERVAL_MS = 180_000;
const LIVE_SYNC_CLOCK_MS = 30_000;

function unwrapState(payload: unknown): AppState {
  return (payload as { state?: AppState }).state ?? (payload as AppState);
}

function fixtureInLiveSyncWindow(state: AppState, nowMs: number): Fixture | null {
  return (
    [...state.fixtures]
      .sort((a, b) => a.sequence - b.sequence)
      .find(
        (fixture) =>
          fixture.recordStatus === "scheduled" &&
          nowMs >= Date.parse(fixture.kickoffAt) &&
          nowMs <= Date.parse(fixture.resultSyncDueAt),
      ) ?? null
  );
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function shanghaiDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function shanghaiTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function responseError(response: Response): Promise<string> {
  return response
    .json()
    .then((body: { error?: string; message?: string }) => {
      const message = body.error ?? body.message ?? `请求失败（${response.status}）`;
      if (message.length > 220 || /failed query:/i.test(message)) {
        return `请求失败（${response.status}），请在管理页检查本地账本配置。`;
      }
      return message;
    })
    .catch(() => `请求失败（${response.status}）`);
}

function statusLabel(fixture: Fixture, activeFixtureId: string | null): string {
  if (fixture.recordStatus === "settled") return "已结算";
  if (fixture.recordStatus === "review_required") return "待复核";
  if (fixture.homeTeam.placeholder || fixture.awayTeam.placeholder) return "等待对阵与赔率";
  if (fixture.offers.length === 0 && fixture.status === "locked") return "等待赔率";
  if (fixture.id === activeFixtureId) return "开放下注";
  if (fixture.status === "in_progress") return "比赛进行中";
  if (fixture.status === "awaiting_result") return "等待赛果";
  return "只读锁定";
}

function lockedCardCopy(fixture: Fixture): { title: string; body: string } {
  if (fixture.recordStatus === "settled") {
    return { title: "本场无人参与", body: "本场没有锁定注单。" };
  }
  if (fixture.homeTeam.placeholder || fixture.awayTeam.placeholder) {
    return {
      title: "等待对阵与赔率",
      body: "前两场结束后更新球队；收到赔率图后开放。",
    };
  }
  if (fixture.offers.length === 0) {
    return { title: "等待赔率", body: "对阵已确认，收到本场赔率图后开放。" };
  }
  return { title: "本场暂不可操作", body: "只有顺序中的下一场比赛开放下注。" };
}

function Flag({ code, label }: { code: string; label: string }) {
  const supported = ["FRA", "ESP", "ENG", "ARG"].includes(code);
  return (
    <span
      className={`wb-flag${supported ? "" : " wb-flag-placeholder"}`}
      data-code={supported ? code : undefined}
      role="img"
      aria-label={`${label}国旗`}
    />
  );
}

function DialogShell({
  title,
  eyebrow,
  onClose,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="wb-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`wb-sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby="wb-dialog-title">
        <div className="wb-sheet-handle" aria-hidden="true" />
        <header className="wb-sheet-header">
          <div>
            {eyebrow && <p>{eyebrow}</p>}
            <h2 id="wb-dialog-title">{title}</h2>
          </div>
          <button className="wb-icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function offerGroup(marketType: string): string {
  const market = marketType.toUpperCase();
  if (["MATCH_RESULT", "MONEYLINE_90", "1X2"].includes(market)) return "MATCH_RESULT";
  if (["HANDICAP_1X2_HOME_MINUS_1", "HANDICAP_3WAY_HOME_MINUS_1"].includes(market)) return "HANDICAP_1X2_HOME_MINUS_1";
  if (["EXACT_SCORE", "CORRECT_SCORE"].includes(market)) return "EXACT_SCORE";
  if (["TOTAL_GOALS_EXACT", "EXACT_TOTAL_GOALS"].includes(market)) return "TOTAL_GOALS_EXACT";
  if (["HALF_FULL_TIME", "HALF_FULL"].includes(market)) return "HALF_FULL_TIME";
  return market;
}

function orderIndex(group: string, selectionCode: string): number {
  const code = selectionCode.toUpperCase();
  if (group === "MATCH_RESULT" || group === "HANDICAP_1X2_HOME_MINUS_1") {
    return ["HOME", "DRAW", "AWAY"].indexOf(code);
  }
  if (group === "EXACT_SCORE") return SCORE_ORDER.indexOf(code);
  if (group === "TOTAL_GOALS_EXACT") {
    if (code === "7_PLUS") return 7;
    const value = Number(code);
    return Number.isFinite(value) ? value : 999;
  }
  if (group === "HALF_FULL_TIME") return HALF_FULL_ORDER.indexOf(code);
  return 999;
}

function groupedOffers(offers: OddsOffer[]): Array<{ key: string; label: string; offers: OddsOffer[] }> {
  const groups = new Map<string, OddsOffer[]>();
  for (const offer of offers.filter((candidate) => candidate.active)) {
    const key = offerGroup(offer.marketType);
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  const known = MARKET_ORDER.filter((key) => groups.has(key));
  const unknown = [...groups.keys()].filter((key) => !known.includes(key as (typeof MARKET_ORDER)[number])).sort();
  return [...known, ...unknown].map((key) => ({
    key,
    label: MARKET_LABEL[key] ?? key,
    offers: (groups.get(key) ?? []).sort((a, b) => {
      const aIndex = orderIndex(key, a.selectionCode);
      const bIndex = orderIndex(key, b.selectionCode);
      return (aIndex < 0 ? 998 : aIndex) - (bIndex < 0 ? 998 : bIndex) || a.label.localeCompare(b.label, "zh-CN");
    }),
  }));
}

export function PoolWorkbench() {
  const [state, setState] = useState<AppState>(() => createSeedState());
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftSlots>({});
  const [sheet, setSheet] = useState<SheetName>(null);
  const [picker, setPicker] = useState<{ participantId: ParticipantId; slot: number } | null>(null);
  const [pickedOfferId, setPickedOfferId] = useState<string | null>(null);
  const [pendingParticipant, setPendingParticipant] = useState<ParticipantId | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oddsJson, setOddsJson] = useState('{\n  "source": "手动导入",\n  "offers": []\n}');
  const [halfHome, setHalfHome] = useState("");
  const [halfAway, setHalfAway] = useState("");
  const [fullHome, setFullHome] = useState("");
  const [fullAway, setFullAway] = useState("");
  const trackRef = useRef<HTMLDivElement | null>(null);
  const didInitialScroll = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const stateRef = useRef(state);
  const syncInFlightRef = useRef(false);
  const lastResultSyncAtRef = useRef(0);
  const liveSyncFixtureIdRef = useRef<string | null>(null);

  const fixtures = useMemo(() => [...state.fixtures].sort((a, b) => a.sequence - b.sequence), [state.fixtures]);
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? fixtures[0] ?? null;
  const isActive = Boolean(selectedFixture && selectedFixture.id === state.activeFixtureId && selectedFixture.isBettingOpen);
  const selectedEntries = useMemo(
    () => selectedFixture ? state.entries.filter((entry) => entry.fixtureId === selectedFixture.id) : [],
    [selectedFixture, state.entries],
  );
  const fixtureStake = selectedEntries.reduce((sum, entry) => sum + entry.stakeCents, 0);

  const carryBefore = useMemo(() => {
    if (!selectedFixture) return 0;
    let carry = 0;
    for (const fixture of fixtures) {
      if (fixture.sequence >= selectedFixture.sequence) break;
      if (fixture.settlement) carry = Math.max(0, fixture.settlement.eligiblePoolCents - fixture.settlement.paidCents);
    }
    return carry;
  }, [fixtures, selectedFixture]);

  const fixturePool = selectedFixture?.settlement?.eligiblePoolCents ?? carryBefore + fixtureStake;
  const rollover = selectedFixture?.settlement
    ? Math.max(0, selectedFixture.settlement.eligiblePoolCents - selectedFixture.settlement.paidCents)
    : carryBefore;

  const leaderboard = useMemo(() => {
    if (!selectedFixture) return [];
    return selectedEntries
      .map((entry) => {
        const participant = state.participants.find((person) => person.id === entry.participantId);
        const participantBets = state.bets.filter(
          (bet) => bet.fixtureId === selectedFixture.id && bet.participantId === entry.participantId,
        );
        const payout = participantBets.reduce((sum, bet) => sum + bet.payoutCents, 0);
        const wonCount = participantBets.filter((bet) => bet.status === "won").length;
        return {
          id: entry.participantId,
          name: participant?.name ?? entry.participantId,
          invested: entry.stakeCents,
          payout,
          roi: entry.stakeCents > 0 ? ((payout - entry.stakeCents) / entry.stakeCents) * 100 : 0,
          hasWin: wonCount > 0,
          wonCount,
          displayOrder: participant?.displayOrder ?? 99,
        } satisfies PoolRankingRow;
      })
      .sort(
        (a, b) =>
          Number(b.hasWin) - Number(a.hasWin) ||
          b.payout - a.payout ||
          b.roi - a.roi ||
          b.wonCount - a.wonCount ||
          a.displayOrder - b.displayOrder,
      );
  }, [selectedEntries, selectedFixture, state.bets, state.participants]);

  const activeDraftPeople = state.participants.filter((person) => (drafts[person.id]?.length ?? 0) > 0);
  const pickerFixture = selectedFixture;
  const pickerGroups = useMemo(() => groupedOffers(pickerFixture?.offers ?? []), [pickerFixture]);

  const refreshState = useCallback(async (): Promise<AppState> => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const next = unwrapState(await response.json());
    stateRef.current = next;
    setState(next);
    setSelectedFixtureId((current) => current ?? next.activeFixtureId ?? next.fixtures[0]?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    const nowMs = Date.now();
    lastResultSyncAtRef.current = nowMs;
    liveSyncFixtureIdRef.current = fixtureInLiveSyncWindow(stateRef.current, nowMs)?.id ?? null;
    // Local mode cannot run while the browser is closed, so opening the app
    // first performs a provider-neutral catch-up for any due fixtures.
    void fetch("/api/results/sync", { cache: "no-store" })
      .catch(() => null)
      .then(() => fetch("/api/state", { cache: "no-store" }))
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return unwrapState(await response.json());
      })
      .then((next) => {
        if (cancelled) return;
        stateRef.current = next;
        setState(next);
        setSelectedFixtureId(next.activeFixtureId ?? next.fixtures[0]?.id ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "本地账本暂时无法读取");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function pollLiveFixture() {
      const nowMs = Date.now();
      const liveFixture = fixtureInLiveSyncWindow(stateRef.current, nowMs);
      if (!liveFixture) {
        liveSyncFixtureIdRef.current = null;
        return;
      }

      if (liveSyncFixtureIdRef.current !== liveFixture.id) {
        liveSyncFixtureIdRef.current = liveFixture.id;
        lastResultSyncAtRef.current = 0;
      }
      if (
        syncInFlightRef.current ||
        nowMs - lastResultSyncAtRef.current < LIVE_SYNC_INTERVAL_MS
      ) {
        return;
      }

      syncInFlightRef.current = true;
      lastResultSyncAtRef.current = nowMs;
      try {
        const response = await fetch("/api/results/sync", { method: "POST" });
        if (!response.ok) throw new Error(await responseError(response));
        if (!cancelled) await refreshState();
      } catch {
        // The widget keeps showing its last snapshot. The next cadence retries
        // without interrupting betting history or the rest of the page.
      } finally {
        syncInFlightRef.current = false;
      }
    }

    void pollLiveFixture();
    const timer = window.setInterval(
      () => void pollLiveFixture(),
      LIVE_SYNC_CLOCK_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!sheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSheet(null);
    document.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", close);
    };
  }, [sheet]);

  useEffect(() => {
    if (!selectedFixtureId || didInitialScroll.current) return;
    const element = trackRef.current?.querySelector<HTMLElement>(`[data-fixture-id="${selectedFixtureId}"]`);
    if (!element) return;
    didInitialScroll.current = true;
    element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "center" });
  }, [selectedFixtureId, fixtures.length]);

  function handleTrackScroll() {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = window.requestAnimationFrame(() => {
      const track = trackRef.current;
      if (!track) return;
      const center = track.getBoundingClientRect().left + track.clientWidth / 2;
      const cards = [...track.querySelectorAll<HTMLElement>("[data-fixture-id]")];
      const nearest = cards.sort(
        (a, b) => Math.abs(a.getBoundingClientRect().left + a.clientWidth / 2 - center) - Math.abs(b.getBoundingClientRect().left + b.clientWidth / 2 - center),
      )[0];
      if (nearest?.dataset.fixtureId) setSelectedFixtureId(nearest.dataset.fixtureId);
    });
  }

  function addDraftParticipant(participantId: ParticipantId) {
    setDrafts((current) => ({ ...current, [participantId]: [null] }));
    setSheet(null);
  }

  function openOdds(participantId: ParticipantId, slot: number) {
    if (!isActive) return;
    setPicker({ participantId, slot });
    setPickedOfferId(drafts[participantId]?.[slot]?.id ?? null);
    setSheet("odds");
  }

  function confirmOdds() {
    if (!picker || !pickedOfferId || !selectedFixture) return;
    const offer = selectedFixture.offers.find((candidate) => candidate.id === pickedOfferId);
    if (!offer) return;
    setDrafts((current) => {
      const slots = [...(current[picker.participantId] ?? [null])];
      slots[picker.slot] = offer;
      return { ...current, [picker.participantId]: slots };
    });
    setSheet(null);
    setPicker(null);
  }

  async function lockEntry() {
    if (!pendingParticipant || !selectedFixture) return;
    const selections = drafts[pendingParticipant] ?? [];
    if (selections.length < 1 || selections.some((selection) => !selection)) {
      setError("请先完成每一注的选择。");
      setSheet(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "lock-entry",
          fixtureId: selectedFixture.id,
          participantId: pendingParticipant,
          idempotencyKey: crypto.randomUUID(),
          selections: selections.map((selection) => ({ offerId: selection?.id, odds: selection?.odds })),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const next = unwrapState(await response.json());
      setState(next);
      setDrafts((current) => ({ ...current, [pendingParticipant]: [] }));
      const name = state.participants.find((person) => person.id === pendingParticipant)?.name;
      setToast(`${name ?? "参与者"}已锁定并加入奖池`);
      setSheet(null);
      setPendingParticipant(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "锁定失败，请稍后重试");
      setSheet(null);
    } finally {
      setBusy(false);
    }
  }

  async function syncResults() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/results/sync", { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      await refreshState();
      setToast("已检查到期比赛，账本已刷新");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      setBusy(false);
    }
  }

  async function importOdds() {
    if (!selectedFixture) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(oddsJson) as { source?: string; providerMatchId?: string | null; offers?: unknown[] } | unknown[];
      const offers = Array.isArray(parsed) ? parsed : parsed.offers;
      if (!Array.isArray(offers) || offers.length === 0) throw new Error("请粘贴包含 offers 数组的赔率 JSON。");
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "upload-odds",
          fixtureId: selectedFixture.id,
          source: Array.isArray(parsed) ? "手动导入" : parsed.source,
          providerMatchId: Array.isArray(parsed) ? null : parsed.providerMatchId,
          offers,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setState(unwrapState(await response.json()));
      setToast(`已导入${offers.length}个赔率选项`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "赔率导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveManualResult() {
    if (!selectedFixture) return;
    const regulationHome = Number(fullHome);
    const regulationAway = Number(fullAway);
    const hasHalf = halfHome !== "" || halfAway !== "";
    if (!Number.isInteger(regulationHome) || !Number.isInteger(regulationAway) || regulationHome < 0 || regulationAway < 0) {
      setError("请输入有效的90分钟非负整数比分。");
      return;
    }
    if (hasHalf && (!Number.isInteger(Number(halfHome)) || !Number.isInteger(Number(halfAway)))) {
      setError("半场比分需要同时填写两个整数。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "manual-result",
          fixtureId: selectedFixture.id,
          halfHome: hasHalf ? Number(halfHome) : undefined,
          halfAway: hasHalf ? Number(halfAway) : undefined,
          regulationHome,
          regulationAway,
          reason: "管理员核对数据源后录入",
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setState(unwrapState(await response.json()));
      setToast("90分钟赛果已锁定并完成结算");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "赛果保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (!selectedFixture) return <div className="wb-empty-page">暂无比赛</div>;

  const result = selectedFixture.regularTimeScore;
  const resultOutcome = result ? (result.home > result.away ? `${selectedFixture.homeTeam.name}胜` : result.home < result.away ? `${selectedFixture.awayTeam.name}胜` : "平局") : "";
  const tickerText = result
    ? `90分钟赛果 · ${result.home}:${result.away} · ${resultOutcome} · 总进球 ${result.home + result.away} · 不含加时与点球`
    : "";

  return (
    <div className="wb-app">
      <header className="wb-topbar">
        <div className="wb-brand"><span>球局</span><small>世界杯奖池</small></div>
        <div className="wb-top-actions">
          <button type="button" onClick={() => setSheet("rules")}>规则</button>
          <button type="button" onClick={() => setSheet("manage")} aria-label="打开管理面板">管理</button>
        </div>
      </header>

      <main className="wb-main">
        <section className="wb-scoreboard" aria-label="当前比赛、奖池与赛果">
          <div className="wb-match-meta">
            <span>{selectedFixture.matchCode} · {STAGE_LABEL[selectedFixture.stage]}</span>
            <strong>{shanghaiDateTime(selectedFixture.kickoffAt)} 北京时间</strong>
            <span className="wb-status" data-status={selectedFixture.id === state.activeFixtureId ? "active" : selectedFixture.status}>
              {statusLabel(selectedFixture, state.activeFixtureId)}
            </span>
          </div>
          <ApiSportsGameWidget
            fixtureId={selectedFixture.providerMatchId}
            kickoffAt={selectedFixture.kickoffAt}
            currentTime={state.serverTime}
            settled={selectedFixture.recordStatus === "settled"}
            fallback={(
              <div className="wb-matchup" id="wb-match-title">
                <div className="wb-team wb-team-home"><Flag code={selectedFixture.homeTeam.code} label={selectedFixture.homeTeam.name} /><b>{selectedFixture.homeTeam.name}</b></div>
                <div className="wb-score">
                  <strong>{result ? `${result.home} : ${result.away}` : "— : —"}</strong>
                  <span>{result ? "90分钟比分" : "比分待赛后锁定"}</span>
                </div>
                <div className="wb-team wb-team-away"><Flag code={selectedFixture.awayTeam.code} label={selectedFixture.awayTeam.name} /><b>{selectedFixture.awayTeam.name}</b></div>
              </div>
            )}
          />
          <div
            className="wb-frozen-score"
            data-frozen={Boolean(result)}
            aria-label={
              result
                ? "已冻结的半场和90分钟结算比分"
                : selectedFixture.halfTimeScore
                  ? "半场比分已记录，等待90分钟结算比分"
                  : "等待半场和90分钟结算比分"
            }
          >
            <div className="wb-frozen-score-title">
              <span>群内结算基准</span>
              <b>{result ? "已冻结" : selectedFixture.halfTimeScore ? "半场已记录" : "等待赛果"}</b>
            </div>
            <div className="wb-frozen-score-value">
              <span>半场</span>
              <strong>{selectedFixture.halfTimeScore ? `${selectedFixture.halfTimeScore.home} : ${selectedFixture.halfTimeScore.away}` : "— : —"}</strong>
            </div>
            <span className="wb-frozen-score-arrow" aria-hidden="true">›</span>
            <div className="wb-frozen-score-value is-regulation">
              <span>90分钟</span>
              <strong>{result ? `${result.home} : ${result.away}` : "— : —"}</strong>
            </div>
            <small>仅常规时间＋伤停补时<br />不含加时与点球</small>
          </div>
          <div className="wb-match-stats">
            <div><span>本场总奖池</span><strong>{money(fixturePool)}</strong></div>
            <div><span>参与人数</span><strong>{selectedEntries.length}<small> / 7</small></strong></div>
            <div><span>{selectedFixture.settlement ? "本场滚存" : "上场滚入"}</span><strong>{money(rollover)}</strong></div>
          </div>

          {result && (
            <div className="wb-result-ticker" aria-label={tickerText}>
              <div><span>{tickerText}</span><span aria-hidden="true">{tickerText}</span></div>
            </div>
          )}

          {selectedFixture.recordStatus === "settled" && (
            <div className="wb-ranking-wrap">
              <div className="wb-ranking-title"><strong>本场排行榜</strong><span>剩余 {money(rollover)} 滚入下一场</span></div>
              {leaderboard.length ? (
                <PoolPodium rows={leaderboard} />
              ) : <p className="wb-no-ranking">本场无人参与，奖池全额滚存。</p>}
            </div>
          )}
        </section>

        <section className="wb-carousel-section" aria-labelledby="wb-carousel-title">
          <div className="wb-carousel-heading">
            <div><h2 id="wb-carousel-title">参与卡片</h2><p>左右滑动切换比赛，上方信息同步更新</p></div>
            <div className="wb-dots" aria-label="比赛页码">{fixtures.map((fixture) => <span key={fixture.id} className={fixture.id === selectedFixture.id ? "is-current" : ""} />)}</div>
          </div>
          <div className="wb-fixture-track" ref={trackRef} onScroll={handleTrackScroll}>
            {fixtures.map((fixture) => {
              const entries = state.entries.filter((entry) => entry.fixtureId === fixture.id);
              const bets = state.bets.filter((bet) => bet.fixtureId === fixture.id);
              const active = fixture.id === state.activeFixtureId && fixture.isBettingOpen;
              const selected = fixture.id === selectedFixture.id;
              const emptyCopy = lockedCardCopy(fixture);
              return (
                <article
                  className={`wb-fixture-card${selected ? " is-selected" : ""}${active ? " is-active" : " is-readonly"}`}
                  key={fixture.id}
                  data-fixture-id={fixture.id}
                  onFocus={() => setSelectedFixtureId(fixture.id)}
                >
                  <header className="wb-card-head">
                    <div><b>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</b><span>{shanghaiDateTime(fixture.kickoffAt)} · {STAGE_LABEL[fixture.stage]}</span></div>
                    <span className="wb-card-lock">{active ? `${shanghaiTime(fixture.lockAt)} 锁定` : statusLabel(fixture, state.activeFixtureId)}</span>
                  </header>
                  <div className="wb-card-body">
                    {(entries.length > 0 || (active && activeDraftPeople.length > 0)) && (
                      <div className="wb-entry-table-head">
                        <span>下注人</span><span>项目</span><span>赔率</span>
                      </div>
                    )}
                    {entries.map((entry) => {
                      const participant = state.participants.find((person) => person.id === entry.participantId);
                      const entryBets = bets.filter((bet) => bet.participantId === entry.participantId);
                      return (
                        <div className="wb-locked-entry" key={entry.id}>
                          <div className="wb-entry-player">
                            <ParticipantAvatar
                              participantId={entry.participantId}
                              className="wb-avatar-card"
                            />
                            <span>
                              <b>{participant?.name ?? entry.participantId}</b>
                              <small>{entry.betCount}注 · 已锁定</small>
                            </span>
                          </div>
                          <div className="wb-entry-bets">
                            {entryBets.map((bet) => (
                              <div className="wb-entry-bet" key={bet.id}>
                                <span>
                                  <b>{bet.label}</b>
                                  <small>{MARKET_LABEL[offerGroup(bet.marketType)] ?? bet.marketType}</small>
                                </span>
                                <strong>{bet.odds.toFixed(2)}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {active && activeDraftPeople.map((person) => {
                      const slots = drafts[person.id] ?? [];
                      return (
                        <div className="wb-draft" key={person.id}>
                          <div className="wb-draft-head">
                            <div>
                              <ParticipantAvatar participantId={person.id} className="wb-avatar-draft" />
                              <strong>{person.name}<span>未锁定</span></strong>
                            </div>
                            <button type="button" onClick={() => setDrafts((current) => ({ ...current, [person.id]: [] }))}>移除</button>
                          </div>
                          <div className="wb-draft-slots">
                            {slots.map((offer, slot) => (
                              <button className={offer ? "has-offer" : ""} type="button" key={slot} onClick={() => openOdds(person.id, slot)}>
                                <i>{slot + 1}</i><span>{offer ? <><b>{offer.label}</b><small>{MARKET_LABEL[offerGroup(offer.marketType)] ?? offer.marketType}</small></> : <><b>选择第{slot + 1}注</b><small>点此打开本场全部玩法</small></>}</span>{offer ? <strong>{offer.odds.toFixed(2)}</strong> : <strong>＋</strong>}
                              </button>
                            ))}
                          </div>
                          <div className="wb-draft-actions">
                            <button type="button" disabled={slots.length >= 3} onClick={() => setDrafts((current) => ({ ...current, [person.id]: [...(current[person.id] ?? []), null] }))}>＋ 加一注</button>
                            <button type="button" className="wb-lock-button" disabled={slots.some((offer) => !offer)} onClick={() => { setPendingParticipant(person.id); setSheet("confirm"); }}>锁定并加入奖池</button>
                          </div>
                        </div>
                      );
                    })}

                    {active && (
                      <button className="wb-add-person" type="button" onClick={() => setSheet("people")}>
                        <span>＋</span><b>添加参与人</b><small>七人中选择，完成1–3注后单独锁定</small>
                      </button>
                    )}
                    {!active && entries.length === 0 && (
                      <div className="wb-card-empty"><span>锁</span><b>{emptyCopy.title}</b><p>{emptyCopy.body}</p></div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        {error && <button className="wb-error" type="button" onClick={() => setError(null)}>{error}<span>×</span></button>}
      </main>

      {sheet === "people" && (
        <DialogShell title="选择参与人" eyebrow={`${selectedFixture.homeTeam.name} vs ${selectedFixture.awayTeam.name}`} onClose={() => setSheet(null)}>
          <div className="wb-sheet-body">
            <p className="wb-sheet-note">每个人单独完成并锁定。锁定后不可修改，也不能重复加入。</p>
            <div className="wb-people-grid">
              {state.participants.map((person) => {
                const locked = selectedEntries.some((entry) => entry.participantId === person.id);
                const drafted = Boolean(drafts[person.id]?.length);
                return (
                  <button type="button" key={person.id} disabled={locked || drafted} onClick={() => addDraftParticipant(person.id)}>
                    <ParticipantAvatar participantId={person.id} className="wb-avatar-picker" />
                    <b>{person.name}</b>
                    <small>{locked ? "已锁定" : drafted ? "编辑中" : "可加入"}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </DialogShell>
      )}

      {sheet === "odds" && picker && (
        <DialogShell className="wb-odds-sheet" title={`选择第${picker.slot + 1}注`} eyebrow={`${selectedFixture.homeTeam.name} vs ${selectedFixture.awayTeam.name} · 90分钟`} onClose={() => setSheet(null)}>
          <div className="wb-odds-scope"><b>结算口径</b> 只看90分钟常规时间及伤停补时，不含加时赛和点球。</div>
          <div className="wb-sheet-body wb-odds-body">
            {pickerGroups.length ? pickerGroups.map((group, groupIndex) => (
              <section className="wb-market" key={group.key}>
                <header><span>{group.label}</span><small>{group.offers.length}项</small></header>
                <div className={`wb-offer-grid wb-grid-${group.key.toLowerCase().replaceAll("_", "-")}`}>
                  {group.offers.map((offer) => {
                    const duplicate = (drafts[picker.participantId] ?? []).some((candidate, index) => index !== picker.slot && candidate?.id === offer.id);
                    return (
                      <label className={pickedOfferId === offer.id ? "is-picked" : ""} key={offer.id}>
                        <input type="radio" name="wb-odds" value={offer.id} checked={pickedOfferId === offer.id} disabled={duplicate} onChange={() => setPickedOfferId(offer.id)} />
                        <span>{offer.label}</span><strong>{offer.odds.toFixed(2)}</strong>
                      </label>
                    );
                  })}
                </div>
                {groupIndex === 1 && <p className="wb-market-help">让球结果按主队 -1 后的90分钟比分计算。</p>}
              </section>
            )) : <div className="wb-no-offers"><b>本场赔率还未导入</b><p>请先在管理面板粘贴赔率 JSON。</p><button type="button" onClick={() => setSheet("manage")}>打开管理</button></div>}
          </div>
          <footer className="wb-sheet-footer">
            <div><span>理论应返</span><strong>{pickedOfferId ? money(Math.round(1000 * (selectedFixture.offers.find((offer) => offer.id === pickedOfferId)?.odds ?? 0))) : "—"}</strong></div>
            <button type="button" disabled={!pickedOfferId} onClick={confirmOdds}>确认这一注</button>
          </footer>
        </DialogShell>
      )}

      {sheet === "confirm" && pendingParticipant && (
        <DialogShell title="确认锁定" eyebrow="该操作不可撤回" onClose={() => setSheet(null)}>
          <div className="wb-sheet-body">
            <div className="wb-confirm-person">
              <span>
                <ParticipantAvatar
                  participantId={pendingParticipant}
                  className="wb-avatar-confirm"
                />
                <b>{state.participants.find((person) => person.id === pendingParticipant)?.name}</b>
              </span>
              <strong>{drafts[pendingParticipant]?.length ?? 0}注 · {money((drafts[pendingParticipant]?.length ?? 0) * 1000)}</strong>
            </div>
            <div className="wb-confirm-list">{(drafts[pendingParticipant] ?? []).map((offer, index) => <p key={offer?.id ?? index}><span>{index + 1}. {offer?.label}</span><strong>{offer?.odds.toFixed(2)}</strong></p>)}</div>
            <p className="wb-sheet-note">确认后，此人正式加入本场奖池。每注固定10元，赔率和选择将永久锁定。</p>
          </div>
          <footer className="wb-sheet-footer wb-confirm-footer"><button type="button" disabled={busy} onClick={() => void lockEntry()}>{busy ? "正在锁定…" : "确认锁定并加入奖池"}</button></footer>
        </DialogShell>
      )}

      {sheet === "manage" && (
        <DialogShell title="本场管理" eyebrow={`${selectedFixture.matchCode} · ${selectedFixture.homeTeam.name} vs ${selectedFixture.awayTeam.name}`} onClose={() => setSheet(null)}>
          <div className="wb-sheet-body wb-manage-body">
            <section className="wb-admin-section"><div><h3>赛果同步</h3><p>到达预设抓取时间后检查已配置数据源；数据源可随时替换。</p></div><button type="button" disabled={busy} onClick={() => void syncResults()}>立即检查</button></section>
            <section className="wb-admin-form"><h3>导入赔率 JSON</h3><textarea aria-label="赔率 JSON" value={oddsJson} onChange={(event) => setOddsJson(event.target.value)} spellCheck={false} /><button type="button" disabled={busy} onClick={() => void importOdds()}>导入到当前比赛</button></section>
            <section className="wb-admin-form"><h3>人工复核比分</h3><p>半场比分用于半全场玩法；结算比分始终只填90分钟＋伤停补时。</p><div className="wb-score-inputs"><label>半场主队<input inputMode="numeric" value={halfHome} onChange={(event) => setHalfHome(event.target.value)} placeholder="可空" /></label><label>半场客队<input inputMode="numeric" value={halfAway} onChange={(event) => setHalfAway(event.target.value)} placeholder="可空" /></label><label>90′主队<input inputMode="numeric" value={fullHome} onChange={(event) => setFullHome(event.target.value)} placeholder="0" /></label><label>90′客队<input inputMode="numeric" value={fullAway} onChange={(event) => setFullAway(event.target.value)} placeholder="0" /></label></div><button type="button" disabled={busy} onClick={() => void saveManualResult()}>复核并锁定赛果</button></section>
          </div>
        </DialogShell>
      )}

      {sheet === "rules" && (
        <DialogShell title="奖池规则" eyebrow="简单、透明、无庄家风险" onClose={() => setSheet(null)}>
          <div className="wb-sheet-body wb-rules">
            <ol><li><b>每注固定10元</b><span>每人每场1–3注；个人点击锁定后才正式加入奖池。</span></li><li><b>赔率不设上下限</b><span>中奖彩票理论奖金 = 10元 × 锁定赔率。</span></li><li><b>只看90分钟</b><span>常规时间与伤停补时有效，不含加时赛及点球大战。</span></li><li><b>奖池不足同比缩放</b><span>所有中奖者按理论奖金占比同比例折算，任何人都不用补钱。</span></li><li><b>剩余自动滚存</b><span>本场支付后仍有余额，则全额进入下一场奖池。</span></li><li><b>锁定不可修改</b><span>赔率、选项和注数以锁定时记录为准。</span></li></ol>
          </div>
        </DialogShell>
      )}

      {toast && <div className="wb-toast" role="status">{toast}</div>}
    </div>
  );
}
