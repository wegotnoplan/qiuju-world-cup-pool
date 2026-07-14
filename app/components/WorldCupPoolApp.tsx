"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  createSeedState,
  type AppState,
  type Bet,
  type Fixture,
  type OddsOffer,
  type ParticipantId,
} from "@/lib/app-data";

type ViewKey = "next" | "pool" | "history" | "rules";
type AdminTab = "odds" | "result" | "sync";

type DraftSelection = Pick<
  OddsOffer,
  "id" | "marketType" | "selectionCode" | "label" | "odds" | "rulesText"
>;

type DraftMap = Record<ParticipantId, Array<DraftSelection | null>>;

interface PickerState {
  participantId: ParticipantId;
  slotIndex: number;
}

interface ApiErrorPayload {
  error?: string;
  message?: string;
}

const PARTICIPANT_IDS: ParticipantId[] = [
  "gao",
  "ye",
  "dong",
  "qiu",
  "kang",
  "bo",
  "zhao",
];

const NAV_ITEMS: Array<{ key: ViewKey; label: string; glyph: string }> = [
  { key: "next", label: "下一场", glyph: "◉" },
  { key: "pool", label: "奖池", glyph: "¥" },
  { key: "history", label: "记录", glyph: "≡" },
  { key: "rules", label: "规则", glyph: "?" },
];

const FLAG_BY_CODE: Record<string, string> = {
  FRA: "FR",
  ESP: "ES",
  ENG: "EN",
  ARG: "AR",
};

const STAGE_LABELS: Record<Fixture["stage"], string> = {
  semi_final: "半决赛",
  third_place: "季军赛",
  final: "决赛",
};

const MARKET_LABELS: Record<string, string> = {
  MATCH_RESULT: "90分钟胜平负",
  MONEYLINE_90: "90分钟胜平负",
  "1X2": "90分钟胜平负",
  DOUBLE_CHANCE: "双重机会",
  DOUBLE_CHANCE_90: "双重机会",
  TOTAL_GOALS: "总进球",
  TOTAL: "总进球",
  OVER_UNDER: "大小球",
  BOTH_TEAMS_TO_SCORE: "双方进球",
  BTTS: "双方进球",
  EXACT_SCORE: "精确比分",
  CORRECT_SCORE: "精确比分",
  DRAW_NO_BET: "平局退款",
  DNB: "平局退款",
  HANDICAP: "让球",
  SPREAD: "让球",
  ASIAN_HANDICAP: "亚洲让球",
  HOME_TEAM_TOTAL: "主队进球",
  AWAY_TEAM_TOTAL: "客队进球",
};

const DEFAULT_IMPORT = JSON.stringify(
  {
    providerMatchId: null,
    source: "手动导入",
    offers: [
      {
        marketType: "MATCH_RESULT",
        selectionCode: "HOME",
        label: "主胜",
        odds: 2.4,
        rulesText: "只按90分钟常规时间及伤停补时结算",
      },
      {
        marketType: "MATCH_RESULT",
        selectionCode: "DRAW",
        label: "平局",
        odds: 3.2,
        rulesText: "只按90分钟常规时间及伤停补时结算",
      },
      {
        marketType: "MATCH_RESULT",
        selectionCode: "AWAY",
        label: "客胜",
        odds: 2.9,
        rulesText: "只按90分钟常规时间及伤停补时结算",
      },
    ],
  },
  null,
  2
);

function emptyDrafts(): DraftMap {
  return {
    gao: [],
    ye: [],
    dong: [],
    qiu: [],
    kang: [],
    bo: [],
    zhao: [],
  };
}

function draftFromBet(bet: Bet, fixture: Fixture): DraftSelection {
  const offer = fixture.offers.find((candidate) => candidate.id === bet.offerId);
  return {
    id: bet.offerId,
    marketType: bet.marketType,
    selectionCode: bet.selectionCode,
    label: bet.label,
    odds: bet.odds,
    rulesText:
      offer?.rulesText ?? "只按90分钟常规时间及伤停补时结算，不含加时赛与点球大战。",
  };
}

function draftsForFixture(state: AppState, fixture: Fixture): DraftMap {
  const drafts = emptyDrafts();
  for (const participantId of PARTICIPANT_IDS) {
    drafts[participantId] = state.bets
      .filter(
        (bet) => bet.fixtureId === fixture.id && bet.participantId === participantId
      )
      .map((bet) => draftFromBet(bet, fixture));
  }
  return drafts;
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function theoreticalReturn(odds: number): string {
  return money(Math.round(1_000 * odds));
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

function shanghaiDate(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
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

function countdown(target: string, now: number): string {
  const difference = Date.parse(target) - now;
  if (difference <= 0) return "已到锁定时间";
  const minutes = Math.floor(difference / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}天 ${hours}小时后锁定`;
  if (hours > 0) return `${hours}小时 ${remainingMinutes}分后锁定`;
  return `${Math.max(1, remainingMinutes)}分钟后锁定`;
}

function flagFor(code: string, placeholder?: boolean): string {
  if (placeholder) return "◌";
  return FLAG_BY_CODE[code] ?? "⚑";
}

function fixtureBets(state: AppState, fixtureId: string): Bet[] {
  return state.bets.filter((bet) => bet.fixtureId === fixtureId);
}

function statusPresentation(
  fixture: Fixture,
  activeFixtureId: string | null,
  nextFixtureId: string | null,
  now: number
): { label: string; short: string; tone: "open" | "locked" | "neutral" | "review" | "danger" } {
  if (fixture.recordStatus === "settled") {
    return { label: "已按90分钟赛果结算", short: "已结算", tone: "neutral" };
  }
  if (fixture.recordStatus === "review_required") {
    return { label: "赛果或玩法需要人工复核", short: "待复核", tone: "review" };
  }
  if (fixture.id === activeFixtureId) {
    return { label: "当前唯一可操作比赛", short: "开放下注", tone: "open" };
  }
  if (fixture.id === nextFixtureId && now >= Date.parse(fixture.lockAt)) {
    return { label: "已进入开赛前2小时锁定期", short: "已锁定", tone: "locked" };
  }
  if (now < Date.parse(fixture.kickoffAt)) {
    return { label: "仅供预览，轮到本场前不可操作", short: "预览锁定", tone: "locked" };
  }
  if (now < Date.parse(fixture.resultSyncDueAt)) {
    return { label: "比赛中或等待赛后数据窗口", short: "进行中", tone: "danger" };
  }
  return { label: "已到赛果同步时间，等待拉取", short: "待赛果", tone: "review" };
}

function unwrapState(payload: unknown): AppState {
  const wrapped = payload as { state?: AppState };
  return wrapped.state ?? (payload as AppState);
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    return payload.error ?? payload.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function PageHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {aside}
    </div>
  );
}

export function WorldCupPoolApp() {
  const [view, setView] = useState<ViewKey>("next");
  const [state, setState] = useState<AppState>(() => createSeedState());
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>(() => emptyDrafts());
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [pickerOfferId, setPickerOfferId] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>("odds");
  const [adminFixtureId, setAdminFixtureId] = useState("wc2026-m101");
  const [importText, setImportText] = useState(DEFAULT_IMPORT);
  const [manualHome, setManualHome] = useState("0");
  const [manualAway, setManualAway] = useState("0");
  const [manualReason, setManualReason] = useState("人工核对90分钟常规时间比分");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const orderedFixtures = useMemo(
    () => [...state.fixtures].sort((a, b) => a.sequence - b.sequence),
    [state.fixtures]
  );
  const nextFixture = useMemo(
    () => orderedFixtures.find((fixture) => Date.parse(fixture.kickoffAt) > now) ?? null,
    [orderedFixtures, now]
  );
  const activeFixtureId =
    nextFixture && now < Date.parse(nextFixture.lockAt) ? nextFixture.id : null;
  const selectedFixture =
    orderedFixtures.find((fixture) => fixture.id === selectedFixtureId) ??
    orderedFixtures.find((fixture) => fixture.id === activeFixtureId) ??
    nextFixture ??
    orderedFixtures.at(-1) ??
    null;
  const canEdit = Boolean(
    selectedFixture && selectedFixture.id === activeFixtureId && selectedFixture.isBettingOpen
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        await fetch("/api/results/sync", { cache: "no-store" }).catch(() => null);
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) throw new Error(await responseMessage(response));
        const nextState = unwrapState(await response.json());
        if (cancelled) return;
        setState(nextState);
        const preferred =
          nextState.activeFixtureId ??
          nextState.fixtures.find(
            (fixture) => Date.parse(fixture.kickoffAt) > Date.parse(nextState.serverTime)
          )?.id ??
          nextState.fixtures.at(-1)?.id ??
          null;
        setSelectedFixtureId(preferred);
        const preferredFixture = nextState.fixtures.find((fixture) => fixture.id === preferred);
        if (preferredFixture) setDrafts(draftsForFixture(nextState, preferredFixture));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "本地账本暂时无法读取";
        const seed = createSeedState();
        setState(seed);
        setSelectedFixtureId(seed.activeFixtureId ?? seed.fixtures[0]?.id ?? null);
        setToast(`${message}。界面已进入只读预览。`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!picker && !adminOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPicker(null);
        setAdminOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picker, adminOpen]);

  function selectFixture(fixture: Fixture) {
    setSelectedFixtureId(fixture.id);
    setAdminFixtureId(fixture.id);
    setDrafts(draftsForFixture(state, fixture));
  }

  function toggleParticipant(participantId: ParticipantId) {
    if (!canEdit) return;
    setDrafts((current) => ({
      ...current,
      [participantId]: current[participantId].length > 0 ? [] : [null],
    }));
    setInlineError(null);
  }

  function changeBetCount(participantId: ParticipantId, delta: number) {
    if (!canEdit) return;
    setDrafts((current) => {
      const existing = current[participantId];
      const target = Math.max(1, Math.min(3, existing.length + delta));
      if (target === existing.length) return current;
      const next =
        target > existing.length
          ? [...existing, ...Array<null>(target - existing.length).fill(null)]
          : existing.slice(0, target);
      return { ...current, [participantId]: next };
    });
    setInlineError(null);
  }

  function openPicker(participantId: ParticipantId, slotIndex: number) {
    if (!canEdit) return;
    setPicker({ participantId, slotIndex });
    setPickerOfferId(drafts[participantId][slotIndex]?.id ?? null);
  }

  function confirmPicker() {
    if (!picker || !selectedFixture || !pickerOfferId) return;
    const offer = selectedFixture.offers.find((candidate) => candidate.id === pickerOfferId);
    if (!offer) return;
    setDrafts((current) => {
      const participantDrafts = [...current[picker.participantId]];
      participantDrafts[picker.slotIndex] = {
        id: offer.id,
        marketType: offer.marketType,
        selectionCode: offer.selectionCode,
        label: offer.label,
        odds: offer.odds,
        rulesText: offer.rulesText,
      };
      return { ...current, [picker.participantId]: participantDrafts };
    });
    setPicker(null);
    setPickerOfferId(null);
  }

  async function saveBets() {
    if (!selectedFixture || !canEdit) return;
    const selectedPeople = PARTICIPANT_IDS.filter((id) => drafts[id].length > 0);
    if (selectedPeople.length === 0) {
      setInlineError("请至少勾选一位参与者。未参加的人保持未勾选即可。");
      return;
    }
    const incomplete = selectedPeople.find((id) => drafts[id].some((selection) => !selection));
    if (incomplete) {
      const name = state.participants.find((participant) => participant.id === incomplete)?.name;
      setInlineError(`${name ?? "参与者"}还有空注，请先选择规则与赔率。`);
      return;
    }
    setSaving(true);
    setInlineError(null);
    try {
      let nextState = state;
      const changedParticipants = PARTICIPANT_IDS.filter((participantId) => {
        const existingOfferIds = state.bets
          .filter(
            (bet) =>
              bet.fixtureId === selectedFixture.id && bet.participantId === participantId
          )
          .map((bet) => bet.offerId)
          .sort();
        const draftOfferIds = drafts[participantId]
          .filter((selection): selection is DraftSelection => selection !== null)
          .map((selection) => selection.id)
          .sort();
        return JSON.stringify(existingOfferIds) !== JSON.stringify(draftOfferIds);
      });
      if (changedParticipants.length === 0) {
        setToast("本场下注没有变化，无需重复保存。");
        return;
      }
      for (const participantId of changedParticipants) {
        const selections = drafts[participantId]
          .filter((selection): selection is DraftSelection => selection !== null)
          .map((selection) => ({
            offerId: selection.id,
            marketType: selection.marketType,
            selectionCode: selection.selectionCode,
            label: selection.label,
            odds: selection.odds,
          }));
        const response = await fetch("/api/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "place-bets",
            fixtureId: selectedFixture.id,
            participantId,
            selections,
          }),
        });
        if (!response.ok) throw new Error(await responseMessage(response));
        nextState = unwrapState(await response.json());
      }
      setState(nextState);
      setToast(`已保存${selectedPeople.length}人，共${draftCount}注，入池${money(draftCount * 1_000)}。`);
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "保存失败，请稍后再试。");
    } finally {
      setSaving(false);
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then(setImportText);
  }

  async function uploadOdds() {
    setSaving(true);
    setInlineError(null);
    try {
      const parsed = JSON.parse(importText) as {
        offers?: unknown[];
        providerMatchId?: string | number | null;
        source?: string;
      } | unknown[];
      const offers = Array.isArray(parsed) ? parsed : parsed.offers;
      if (!Array.isArray(offers)) throw new Error("JSON 中需要 offers 数组，或直接使用数组格式。");
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "upload-odds",
          fixtureId: adminFixtureId,
          providerMatchId: Array.isArray(parsed) ? null : parsed.providerMatchId,
          source: Array.isArray(parsed) ? "手动导入" : parsed.source,
          offers,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const nextState = unwrapState(await response.json());
      setState(nextState);
      const fixture = nextState.fixtures.find((candidate) => candidate.id === adminFixtureId);
      setToast(`已导入${fixture?.offers.length ?? offers.length}个赔率选项。`);
      setAdminOpen(false);
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "赔率导入失败。");
    } finally {
      setSaving(false);
    }
  }

  async function syncResults() {
    setSaving(true);
    setInlineError(null);
    try {
      const response = await fetch("/api/results/sync", { method: "POST" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const syncPayload = (await response.json()) as { dueCount?: number; results?: unknown[] };
      const stateResponse = await fetch("/api/state", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error(await responseMessage(stateResponse));
      setState(unwrapState(await stateResponse.json()));
      setToast(
        syncPayload.dueCount
          ? `已检查${syncPayload.dueCount}场到期比赛，结果已写入账本。`
          : "当前没有到达赛果同步时间的比赛。"
      );
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "赛果同步失败。");
    } finally {
      setSaving(false);
    }
  }

  async function saveManualResult() {
    const home = Number(manualHome);
    const away = Number(manualAway);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
      setInlineError("请输入两个非负整数，且必须是90分钟加伤停补时结束时的比分。");
      return;
    }
    if (manualReason.trim().length < 4) {
      setInlineError("请写明人工赛果的核对来源或原因。");
      return;
    }
    setSaving(true);
    setInlineError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "manual-result",
          fixtureId: adminFixtureId,
          regulationHome: home,
          regulationAway: away,
          reason: manualReason.trim(),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setState(unwrapState(await response.json()));
      setToast(`已用90分钟比分 ${home}:${away} 完成人工复核。`);
      setAdminOpen(false);
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "人工赛果保存失败。");
    } finally {
      setSaving(false);
    }
  }

  const draftCount = PARTICIPANT_IDS.reduce((sum, id) => sum + drafts[id].length, 0);
  const draftPeople = PARTICIPANT_IDS.filter((id) => drafts[id].length > 0).length;
  const currentFixtureBetCount = selectedFixture
    ? fixtureBets(state, selectedFixture.id).length
    : 0;
  const currentRollover = Math.max(
    0,
    state.pool.balanceCents - currentFixtureBetCount * state.rules.stakeCents
  );

  if (loading) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <div className="header-inner">
            <div className="brand-lockup">
              <div className="brand-mark">26</div>
              <div className="brand-copy">
                <p className="brand-title">球局</p>
                <p className="brand-subtitle">世界杯朋友群奖池</p>
              </div>
            </div>
          </div>
        </header>
        <main className="loading-shell" aria-busy="true" aria-label="正在读取本地奖池账本">
          <div className="loading-pulse">
            <div className="loading-line" />
            <div className="loading-line" />
            <div className="loading-line" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">26</div>
            <div className="brand-copy">
              <p className="brand-title">球局</p>
              <p className="brand-subtitle">7人 · 每注¥10 · 无庄家奖池</p>
            </div>
          </div>
          <nav className="desktop-nav" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`nav-button ${view === item.key ? "is-active" : ""}`}
                aria-current={view === item.key ? "page" : undefined}
                onClick={() => setView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="manage-button"
            onClick={() => {
              setAdminFixtureId(selectedFixture?.id ?? orderedFixtures[0]?.id ?? "");
              setInlineError(null);
              setAdminOpen(true);
            }}
          >
            <span aria-hidden="true">＋</span>
            <span>管理</span>
          </button>
        </div>
      </header>

      <main className="main-content">
        {view === "next" && selectedFixture && (
          <>
            <PageHeader
              eyebrow="Match center"
              title="四场决胜，逐场滚动"
              description="向左回看已结束场次，向右预览未开赛场次。只有时间顺序中的下一场可操作，其余比赛保持锁定。"
              aside={<span className="quiet-badge">上海时间</span>}
            />

            <div className="match-rail-wrap">
              <div className="rail-label">
                <span>已结束 ← 横向滑动 → 未开赛</span>
                <span>{orderedFixtures.length} 场</span>
              </div>
              <div className="match-rail" aria-label="四场比赛时间轴">
                {orderedFixtures.map((fixture) => {
                  const status = statusPresentation(
                    fixture,
                    activeFixtureId,
                    nextFixture?.id ?? null,
                    now
                  );
                  return (
                    <button
                      type="button"
                      key={fixture.id}
                      className={`match-tab ${
                        selectedFixture.id === fixture.id ? "is-selected" : ""
                      } ${fixture.id === activeFixtureId ? "is-active" : ""}`}
                      aria-pressed={selectedFixture.id === fixture.id}
                      onClick={() => selectFixture(fixture)}
                    >
                      <div className="match-tab-top">
                        <span className="match-sequence">
                          {fixture.matchCode} · {STAGE_LABELS[fixture.stage]}
                        </span>
                        <span className="status-badge" data-tone={status.tone}>
                          {status.short}
                        </span>
                      </div>
                      <div className="match-tab-teams">
                        <div className="mini-team">
                          <span className="team-flag">
                            {flagFor(fixture.homeTeam.code, fixture.homeTeam.placeholder)}
                          </span>
                          <span className="mini-team-name">{fixture.homeTeam.name}</span>
                        </div>
                        <span className="versus">VS</span>
                        <div className="mini-team">
                          <span className="team-flag">
                            {flagFor(fixture.awayTeam.code, fixture.awayTeam.placeholder)}
                          </span>
                          <span className="mini-team-name">{fixture.awayTeam.name}</span>
                        </div>
                      </div>
                      <div className="match-tab-time">{shanghaiDateTime(fixture.kickoffAt)} 开赛</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="next-layout">
              <div className="next-sidebar">
                <MatchScoreboard
                  fixture={selectedFixture}
                  status={statusPresentation(
                    selectedFixture,
                    activeFixtureId,
                    nextFixture?.id ?? null,
                    now
                  )}
                  now={now}
                />
                <div
                  className="state-banner"
                  data-tone={canEdit ? "open" : selectedFixture.id === nextFixture?.id ? "locked" : "neutral"}
                >
                  <span className="state-icon" aria-hidden="true">
                    {canEdit ? "✓" : "⌁"}
                  </span>
                  <div>
                    <strong>
                      {canEdit
                        ? "本场已激活，可以选择参与者和赔率"
                        : statusPresentation(
                            selectedFixture,
                            activeFixtureId,
                            nextFixture?.id ?? null,
                            now
                          ).label}
                    </strong>
                    <div>
                      {canEdit
                        ? selectedFixture.offers.length > 0
                          ? `已导入${selectedFixture.offers.length}个赔率选项，保存后锁定每注赔率。`
                          : "本场还没有赔率，请先从右上角“管理”导入。"
                        : "可查看已保存下注，但不能新增、替换或删除。"}
                    </div>
                  </div>
                </div>
                <div className="pool-equation" aria-label="当前奖池构成">
                  <span>上轮结转</span>
                  <span className="equation-value">{money(currentRollover)}</span>
                  <span className="equation-operator">＋</span>
                  <span>{canEdit ? "本场草稿" : "本场注金"}</span>
                  <span className="equation-value">
                    {money((canEdit ? draftCount : currentFixtureBetCount) * 1_000)}
                  </span>
                  <span className="equation-operator">＝</span>
                  <span>本场可见奖池</span>
                  <span className="equation-value">
                    {money(currentRollover + (canEdit ? draftCount : currentFixtureBetCount) * 1_000)}
                  </span>
                </div>
              </div>

              <section aria-labelledby="participants-title">
                <div className="section-bar">
                  <h2 id="participants-title" className="section-title">谁参加这场</h2>
                  <span className="section-note">每人 1–3 注 · 每注 ¥10</span>
                </div>
                <div className="participant-list">
                  {state.participants.map((participant) => {
                    const participantDrafts = drafts[participant.id];
                    const checked = participantDrafts.length > 0;
                    return (
                      <div className="participant-block" key={participant.id}>
                        <div className="participant-row">
                          <label className="participant-label">
                            <input
                              type="checkbox"
                              className="participant-check"
                              checked={checked}
                              disabled={!canEdit}
                              onChange={() => toggleParticipant(participant.id)}
                            />
                            <span className="avatar" aria-hidden="true">
                              {participant.name.slice(0, 1)}
                            </span>
                            <span>
                              <span className="participant-name">{participant.name}</span>
                              <span className="participant-meta">
                                {checked ? `${participantDrafts.length}注 · ¥${participantDrafts.length * 10}` : "本场不参加"}
                              </span>
                            </span>
                          </label>
                          {checked && (
                            <div className="stepper" aria-label={`${participant.name}注数`}>
                              <button
                                type="button"
                                aria-label="减少一注"
                                disabled={!canEdit || participantDrafts.length <= 1}
                                onClick={() => changeBetCount(participant.id, -1)}
                              >
                                −
                              </button>
                              <span className="stepper-value">{participantDrafts.length}</span>
                              <button
                                type="button"
                                aria-label="增加一注"
                                disabled={!canEdit || participantDrafts.length >= 3}
                                onClick={() => changeBetCount(participant.id, 1)}
                              >
                                ＋
                              </button>
                            </div>
                          )}
                        </div>
                        {checked && (
                          <div className="bet-slots">
                            {participantDrafts.map((selection, slotIndex) => (
                              <button
                                type="button"
                                key={`${participant.id}-${slotIndex}`}
                                className={`bet-slot ${selection ? "has-selection" : ""}`}
                                disabled={!canEdit}
                                onClick={() => openPicker(participant.id, slotIndex)}
                              >
                                <span>
                                  <span className="bet-slot-title">
                                    {selection ? selection.label : `第${slotIndex + 1}注 · 选择规则与赔率`}
                                  </span>
                                  <span className="bet-slot-rule">
                                    {selection
                                      ? `${MARKET_LABELS[selection.marketType] ?? selection.marketType} · 90分钟口径`
                                      : selectedFixture.offers.length > 0
                                        ? "点击打开赔率选框"
                                        : "等待管理员导入本场赔率"}
                                  </span>
                                </span>
                                <span className="odds-stack">
                                  {selection ? (
                                    <>
                                      <span className="odds-pill">{selection.odds.toFixed(2)}</span>
                                      <span className="return-copy">理论 {theoreticalReturn(selection.odds)}</span>
                                    </>
                                  ) : (
                                    <span aria-hidden="true">›</span>
                                  )}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {inlineError && <p className="error-text" role="alert">{inlineError}</p>}
              </section>
            </div>

            {(draftCount > 0 || (!canEdit && currentFixtureBetCount > 0)) && (
              <div className="save-dock" aria-live="polite">
                <div className="save-summary">
                  <strong>{draftPeople}人 · {draftCount}注 · 入池{money(draftCount * 1_000)}</strong>
                  <span>{canEdit ? "保存后赔率固定，锁盘前仍可修改" : "当前场次只读"}</span>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canEdit || saving || selectedFixture.offers.length === 0}
                  onClick={() => void saveBets()}
                >
                  {saving ? "保存中…" : canEdit ? "保存本场下注" : "已锁定"}
                </button>
              </div>
            )}
          </>
        )}

        {view === "pool" && (
          <PoolView
            state={state}
            fixtures={orderedFixtures}
            now={now}
            onSync={() => {
              setAdminTab("sync");
              setAdminOpen(true);
            }}
          />
        )}

        {view === "history" && <HistoryView state={state} fixtures={orderedFixtures} now={now} />}

        {view === "rules" && <RulesView />}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button
            type="button"
            key={item.key}
            className={`bottom-nav-button ${view === item.key ? "is-active" : ""}`}
            aria-current={view === item.key ? "page" : undefined}
            onClick={() => setView(item.key)}
          >
            <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {picker && selectedFixture && (
        <MarketPicker
          fixture={selectedFixture}
          participantName={
            state.participants.find((participant) => participant.id === picker.participantId)?.name ?? "参与者"
          }
          slotIndex={picker.slotIndex}
          selectedOfferId={pickerOfferId}
          onSelect={setPickerOfferId}
          onConfirm={confirmPicker}
          onClose={() => setPicker(null)}
          onManage={() => {
            setPicker(null);
            setAdminFixtureId(selectedFixture.id);
            setAdminTab("odds");
            setAdminOpen(true);
          }}
          closeButtonRef={closeButtonRef}
        />
      )}

      {adminOpen && (
        <AdminSheet
          tab={adminTab}
          setTab={setAdminTab}
          fixtures={orderedFixtures}
          fixtureId={adminFixtureId}
          setFixtureId={setAdminFixtureId}
          importText={importText}
          setImportText={setImportText}
          onFile={handleFile}
          onUpload={() => void uploadOdds()}
          onSync={() => void syncResults()}
          manualHome={manualHome}
          setManualHome={setManualHome}
          manualAway={manualAway}
          setManualAway={setManualAway}
          manualReason={manualReason}
          setManualReason={setManualReason}
          onManual={() => void saveManualResult()}
          saving={saving}
          error={inlineError}
          onClose={() => {
            setAdminOpen(false);
            setInlineError(null);
          }}
          closeButtonRef={closeButtonRef}
        />
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </div>
  );
}

function MatchScoreboard({
  fixture,
  status,
  now,
}: {
  fixture: Fixture;
  status: ReturnType<typeof statusPresentation>;
  now: number;
}) {
  return (
    <section className="scoreboard" aria-label={`${fixture.homeTeam.name}对${fixture.awayTeam.name}`}>
      <div className="scoreboard-head">
        <span className="scoreboard-stage">
          {fixture.matchCode} · {STAGE_LABELS[fixture.stage]}
        </span>
        <span className="status-badge" data-tone={status.tone}>{status.short}</span>
      </div>
      <div className="scoreboard-teams">
        <div className="hero-team">
          <span className="team-flag">{flagFor(fixture.homeTeam.code, fixture.homeTeam.placeholder)}</span>
          <span className="hero-team-name">{fixture.homeTeam.name}</span>
          <span className="hero-team-code">{fixture.homeTeam.code}</span>
        </div>
        <div className="kickoff-stack">
          {fixture.regularTimeScore ? (
            <>
              <span className="kickoff-time">
                {fixture.regularTimeScore.home}:{fixture.regularTimeScore.away}
              </span>
              <span className="kickoff-date">90分钟</span>
            </>
          ) : (
            <>
              <span className="kickoff-time">{shanghaiTime(fixture.kickoffAt)}</span>
              <span className="kickoff-date">{shanghaiDate(fixture.kickoffAt)}</span>
            </>
          )}
        </div>
        <div className="hero-team">
          <span className="team-flag">{flagFor(fixture.awayTeam.code, fixture.awayTeam.placeholder)}</span>
          <span className="hero-team-name">{fixture.awayTeam.name}</span>
          <span className="hero-team-code">{fixture.awayTeam.code}</span>
        </div>
      </div>
      <div className="scoreboard-footer">
        <div className="scoreboard-detail">
          <span className="detail-label">锁定时间</span>
          <span className="detail-value">{shanghaiDateTime(fixture.lockAt)}</span>
        </div>
        <div className="scoreboard-detail">
          <span className="detail-label">状态提醒</span>
          <span className="detail-value">
            {now < Date.parse(fixture.lockAt) ? countdown(fixture.lockAt, now) : status.short}
          </span>
        </div>
      </div>
    </section>
  );
}

function MarketPicker({
  fixture,
  participantName,
  slotIndex,
  selectedOfferId,
  onSelect,
  onConfirm,
  onClose,
  onManage,
  closeButtonRef,
}: {
  fixture: Fixture;
  participantName: string;
  slotIndex: number;
  selectedOfferId: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  onManage: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, OddsOffer[]>();
    for (const offer of fixture.offers.filter((candidate) => candidate.active)) {
      const list = grouped.get(offer.marketType) ?? [];
      list.push(offer);
      grouped.set(offer.marketType, list);
    }
    return [...grouped.entries()];
  }, [fixture.offers]);
  const selected = fixture.offers.find((offer) => offer.id === selectedOfferId) ?? null;

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="market-sheet-title">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <h2 id="market-sheet-title">{participantName} · 第{slotIndex + 1}注</h2>
            <p>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭赔率选择" onClick={onClose}>×</button>
        </header>
        <div className="scope-notice">
          <span aria-hidden="true">90′</span>
          <span>仅按90分钟常规时间 + 伤停补时结算；不含加时赛和点球大战。</span>
        </div>
        <div className="sheet-body">
          {groups.length > 0 ? (
            groups.map(([marketType, offers], groupIndex) => (
              <details className="market-group" key={marketType} open={groupIndex === 0}>
                <summary>
                  <span>{MARKET_LABELS[marketType] ?? marketType}</span>
                  <span className="market-count">{offers.length}个选项</span>
                </summary>
                {offers.map((offer) => (
                  <label className="market-option" key={offer.id}>
                    <input
                      type="radio"
                      name="market-offer"
                      value={offer.id}
                      checked={selectedOfferId === offer.id}
                      onChange={() => onSelect(offer.id)}
                    />
                    <span>
                      <span className="market-option-label">{offer.label}</span>
                      <span className="market-option-rule">{offer.rulesText}</span>
                    </span>
                    <span className="market-odds">{offer.odds.toFixed(2)}</span>
                  </label>
                ))}
              </details>
            ))
          ) : (
            <div className="empty-state">
              <div className="empty-state-mark" aria-hidden="true">＋</div>
              <h3>尚未导入本场赔率</h3>
              <p>先上传这场比赛的规则与十进制赔率，所有人再从同一份锁定选项中下注。</p>
              <button type="button" className="secondary-button" onClick={onManage}>去导入赔率</button>
            </div>
          )}
        </div>
        <footer className="sheet-footer">
          <div className="selection-preview">
            <span>{selected ? `${MARKET_LABELS[selected.marketType] ?? selected.marketType} · ${selected.label}` : "请选择一个赔率选项"}</span>
            <strong>{selected ? `¥10 × ${selected.odds.toFixed(2)} = ${theoreticalReturn(selected.odds)}` : "—"}</strong>
          </div>
          <button type="button" className="primary-button" disabled={!selected} onClick={onConfirm}>确认此注</button>
        </footer>
      </section>
    </div>
  );
}

function PoolView({
  state,
  fixtures,
  now,
  onSync,
}: {
  state: AppState;
  fixtures: Fixture[];
  now: number;
  onSync: () => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Pool ledger"
        title="每一块钱都有去向"
        description="注金按比赛顺序进入奖池，中奖按锁定赔率形成理论应返。前一场结算完成后，剩余金额才转入下一场。"
        aside={<button type="button" className="secondary-button" onClick={onSync}>同步赛果</button>}
      />
      <section className="ledger-equation" aria-label="奖池总账">
        <div className="ledger-equation-main">
          <div className="ledger-number"><span>期初</span><strong>{money(0)}</strong></div>
          <span className="ledger-operator">＋</span>
          <div className="ledger-number"><span>全部注金</span><strong>{money(state.pool.contributedCents)}</strong></div>
          <span className="ledger-operator">−</span>
          <div className="ledger-number"><span>实际返还</span><strong>{money(state.pool.paidCents)}</strong></div>
          <span className="ledger-operator">＝</span>
          <div className="ledger-number"><span>当前结余</span><strong>{money(state.pool.balanceCents)}</strong></div>
        </div>
        <div className="ledger-caption">此处只记录和计算，不代表已经完成真实转账。金额统一以“分”保存并对账。</div>
      </section>

      <div className="section-bar">
        <h2 className="section-title">四场结算进度</h2>
        <span className="section-note">仅认90分钟＋伤停</span>
      </div>
      <div className="timeline">
        {fixtures.map((fixture) => {
          const bets = fixtureBets(state, fixture.id);
          const presentation = statusPresentation(fixture, state.activeFixtureId, null, now);
          const settlement = fixture.settlement;
          return (
            <div className="timeline-item" key={fixture.id}>
              <div className="timeline-dot" data-tone={presentation.tone}>{fixture.matchCode.slice(1)}</div>
              <div className="timeline-content">
                <div className="timeline-head">
                  <div>
                    <h3 className="timeline-title">{fixture.homeTeam.name} vs {fixture.awayTeam.name}</h3>
                    <p className="timeline-meta">
                      {fixture.recordStatus === "settled" && fixture.regularTimeScore
                        ? `90分钟赛果 ${fixture.regularTimeScore.home}:${fixture.regularTimeScore.away}`
                        : `预计 ${shanghaiDateTime(fixture.resultSyncDueAt)} 同步赛果`}
                    </p>
                  </div>
                  <span className="status-badge" data-tone={presentation.tone}>{presentation.short}</span>
                </div>
                <div className="timeline-flow">
                  <div className="timeline-stat"><span>本场注数</span><strong>{bets.length}注</strong></div>
                  <div className="timeline-stat"><span>理论应返</span><strong>{money(settlement?.theoreticalPayoutCents ?? 0)}</strong></div>
                  <div className="timeline-stat"><span>实际返还</span><strong>{money(settlement?.paidCents ?? 0)}</strong></div>
                </div>
                {fixture.reviewNote && <p className="error-text">{fixture.reviewNote}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function HistoryView({ state, fixtures, now }: { state: AppState; fixtures: Fixture[]; now: number }) {
  return (
    <>
      <PageHeader
        eyebrow="Match history"
        title="比赛记录与计算明细"
        description="按比赛倒序查看参与注数、90分钟赛果、理论应返和实际返还。展开任意场次即可核对个人下注。"
        aside={<span className="quiet-badge">规则 v1.0</span>}
      />
      <div className="history-list">
        {[...fixtures].reverse().map((fixture) => {
          const bets = fixtureBets(state, fixture.id);
          const status = statusPresentation(fixture, state.activeFixtureId, null, now);
          return (
            <details className="history-row" key={fixture.id}>
              <summary>
                <span>
                  <span className="history-match">
                    {flagFor(fixture.homeTeam.code, fixture.homeTeam.placeholder)} {fixture.homeTeam.name} · {fixture.awayTeam.name} {flagFor(fixture.awayTeam.code, fixture.awayTeam.placeholder)}
                  </span>
                  <span className="history-time">{shanghaiDateTime(fixture.kickoffAt)} · {bets.length}注</span>
                </span>
                <span className="status-badge" data-tone={status.tone}>{status.short}</span>
              </summary>
              <div className="history-detail">
                {fixture.regularTimeScore ? (
                  <p><strong>90分钟赛果：</strong>{fixture.regularTimeScore.home}:{fixture.regularTimeScore.away}。加时赛和点球大战不参与结算。</p>
                ) : (
                  <p>本场尚未形成可结算的90分钟赛果。</p>
                )}
                {bets.length > 0 ? (
                  bets.map((bet) => {
                    const person = state.participants.find((participant) => participant.id === bet.participantId);
                    return (
                      <p key={bet.id}>
                        <strong>{person?.name ?? bet.participantId}</strong>：{bet.label} @ {bet.odds.toFixed(2)}，状态 {betStatusLabel(bet.status)}，理论 {money(bet.theoreticalPayoutCents)}，实返 {money(bet.payoutCents)}。
                      </p>
                    );
                  })
                ) : (
                  <p>暂无下注记录。</p>
                )}
                {fixture.settlement && (
                  <p>
                    结算池 {money(fixture.settlement.eligiblePoolCents)}，理论总应返 {money(fixture.settlement.theoreticalPayoutCents)}，实际返还 {money(fixture.settlement.paidCents)}。
                  </p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}

function RulesView() {
  return (
    <>
      <PageHeader
        eyebrow="Rules v1.0"
        title="先把口径说清楚，再开球"
        description="本规则服务于朋友群内部的记录与计算。任何自动赛果不够明确时，宁可进入人工复核，也不使用加时后的最终比分猜测。"
        aside={<span className="quiet-badge">更新于 2026.07.14</span>}
      />
      <section className="rules-hero">
        <span className="rules-hero-number">90′</span>
        <h2>常规时间 = 90分钟 + 伤停补时</h2>
        <p>不包含30分钟加时赛，也不包含点球大战。比如90分钟为2:2、加时后3:2，本群胜平负仍按“平”结算，精确比分按2:2结算。</p>
      </section>
      <div className="rule-list">
        <article className="rule-item">
          <h3>参与和注金</h3>
          <p>固定七位成员，每场可不参加；参加时选1–3注。每注固定10元，每一注都是独立彩票。</p>
        </article>
        <article className="rule-item">
          <h3>只有下一场可操作</h3>
          <p>四场比赛横向滚动展示。已结束和后续比赛均为只读，始终只有按时间排序的下一场可编辑。</p>
        </article>
        <article className="rule-item">
          <h3>开赛前2小时锁定</h3>
          <p>锁定时刻起拒绝新增、替换和删除下注。服务端时间是最终依据，手机时间只用于倒计时显示。</p>
        </article>
        <article className="rule-item">
          <h3>赔率不设最低或最高限制</h3>
          <p>系统只接受大于1.00的有效十进制赔率。下注保存时复制赔率快照，后续重新导入不会改变已锁定票。</p>
        </article>
        <article className="rule-item">
          <h3>中奖彩票的理论应返</h3>
          <p>赔率包含本金。1.30倍中奖应返13元，5.00倍中奖应返50元。</p>
          <div className="formula">理论应返 = ¥10 × 锁定赔率</div>
        </article>
        <article className="rule-item">
          <h3>奖池足额</h3>
          <p>按每张中奖彩票的理论应返全额支付，付完后的余额进入下一场。</p>
          <div className="formula">¥100结转 + ¥30注金 − ¥20 − ¥35 = ¥75滚存</div>
        </article>
        <article className="rule-item">
          <h3>奖池不足</h3>
          <p>所有中奖彩票按理论应返占比同比例缩减。分币采用最大余数法，确保总账一分不差。</p>
          <table className="example-table">
            <thead><tr><th>中奖彩票</th><th>理论</th><th>实返</th></tr></thead>
            <tbody>
              <tr><td>2.00倍</td><td>¥20</td><td>¥6</td></tr>
              <tr><td>3.00倍</td><td>¥30</td><td>¥9</td></tr>
              <tr><td>5.00倍</td><td>¥50</td><td>¥15</td></tr>
            </tbody>
          </table>
        </article>
        <article className="rule-item">
          <h3>赛果同步与人工复核</h3>
          <p>本地版在打开页面时补做已到期同步；上线后可接定时任务。只有数据源明确给出90分钟比分时才能自动结算，缺失或含义模糊就进入人工复核。</p>
        </article>
      </div>
    </>
  );
}

function AdminSheet({
  tab,
  setTab,
  fixtures,
  fixtureId,
  setFixtureId,
  importText,
  setImportText,
  onFile,
  onUpload,
  onSync,
  manualHome,
  setManualHome,
  manualAway,
  setManualAway,
  manualReason,
  setManualReason,
  onManual,
  saving,
  error,
  onClose,
  closeButtonRef,
}: {
  tab: AdminTab;
  setTab: (tab: AdminTab) => void;
  fixtures: Fixture[];
  fixtureId: string;
  setFixtureId: (id: string) => void;
  importText: string;
  setImportText: (value: string) => void;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
  onSync: () => void;
  manualHome: string;
  setManualHome: (value: string) => void;
  manualAway: string;
  setManualAway: (value: string) => void;
  manualReason: string;
  setManualReason: (value: string) => void;
  onManual: () => void;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="admin-sheet-title">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <h2 id="admin-sheet-title">比赛管理</h2>
            <p>赔率导入、90分钟赛果与同步</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭比赛管理" onClick={onClose}>×</button>
        </header>
        <div className="scope-notice"><span aria-hidden="true">!</span><span>赛果输入必须是90分钟常规时间＋伤停补时结束比分，不得填写加时或点球后的结果。</span></div>
        <div className="sheet-body">
          <div className="admin-tabs" role="tablist" aria-label="管理类型">
            {([
              ["odds", "导入赔率"],
              ["result", "人工赛果"],
              ["sync", "自动同步"],
            ] as Array<[AdminTab, string]>).map(([key, label]) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === key}
                key={key}
                className={`admin-tab ${tab === key ? "is-active" : ""}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="field-label">
            选择比赛
            <select value={fixtureId} onChange={(event) => setFixtureId(event.target.value)}>
              {fixtures.map((fixture) => (
                <option key={fixture.id} value={fixture.id}>
                  {fixture.matchCode} · {fixture.homeTeam.name} vs {fixture.awayTeam.name}
                </option>
              ))}
            </select>
          </label>

          {tab === "odds" && (
            <div className="form-stack" style={{ marginTop: 12 }}>
              <label className="field-label">
                读取 JSON 文件
                <input type="file" accept="application/json,.json" onChange={onFile} />
              </label>
              <label className="field-label">
                或粘贴赔率 JSON
                <textarea value={importText} onChange={(event) => setImportText(event.target.value)} spellCheck={false} />
              </label>
              <p className="form-help">支持胜平负、大小球、双方进球、精确比分等结构化玩法。重新导入会替换本场尚未锁定的赔率列表，但不会修改已经保存的下注快照。</p>
              <div className="form-actions">
                <button type="button" className="primary-button" disabled={saving} onClick={onUpload}>{saving ? "导入中…" : "校验并导入"}</button>
                <button type="button" className="secondary-button" onClick={() => setImportText(DEFAULT_IMPORT)}>恢复模板</button>
              </div>
            </div>
          )}

          {tab === "result" && (
            <div className="form-stack" style={{ marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="field-label">主队90分钟进球<input type="number" min="0" step="1" inputMode="numeric" value={manualHome} onChange={(event) => setManualHome(event.target.value)} /></label>
                <label className="field-label">客队90分钟进球<input type="number" min="0" step="1" inputMode="numeric" value={manualAway} onChange={(event) => setManualAway(event.target.value)} /></label>
              </div>
              <label className="field-label">核对来源或原因<input value={manualReason} onChange={(event) => setManualReason(event.target.value)} /></label>
              <p className="form-help">人工赛果会保存来源说明，并按当前奖池预览后执行结算。若前一场尚未结算，系统会阻止后一场先结算。</p>
              <button type="button" className="danger-button" disabled={saving} onClick={onManual}>{saving ? "结算中…" : "确认90分钟比分并结算"}</button>
            </div>
          )}

          {tab === "sync" && (
            <div className="sync-panel" style={{ marginTop: 12 }}>
              <h3>检查已到赛果时间的比赛</h3>
              <p>本地版会在每次打开页面时补做检查。配置服务器端 football-data.org 凭据和比赛ID后，只接受明确的 FINISHED 与 regularTime 字段。否则转为人工复核。</p>
              <button type="button" className="primary-button" disabled={saving} onClick={onSync}>{saving ? "同步中…" : "立即检查"}</button>
            </div>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function betStatusLabel(status: Bet["status"]): string {
  switch (status) {
    case "won":
      return "中奖";
    case "lost":
      return "未中";
    case "void":
      return "作废退款";
    case "review_required":
      return "待复核";
    default:
      return "待赛果";
  }
}
