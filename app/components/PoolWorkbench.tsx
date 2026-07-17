"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  createSeedState,
  isManualReviewOpen,
  manualReviewOpensAt,
  type AppState,
  type Bet,
  type Fixture,
  type FixtureEntry,
  type OddsOffer,
  type ParticipantId,
} from "@/lib/app-data";
import { ApiSportsGameWidget } from "./ApiSportsGameWidget";
import { ParticipantAvatar } from "./ParticipantAvatar";
import { PoolPodium, type PoolRankingRow } from "./PoolPodium";

type DraftSlots = Partial<Record<ParticipantId, Array<OddsOffer | null>>>;
type SheetName =
  | "pool"
  | "history"
  | "people"
  | "odds"
  | "confirm"
  | "remove-confirm"
  | "admin-login"
  | "manage"
  | "unlock-confirm"
  | "rules"
  | "ladder"
  | null;

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
const CAROUSEL_SETTLE_MS = 140;

function unwrapState(payload: unknown): AppState {
  return (payload as { state?: AppState }).state ?? (payload as AppState);
}

function fixtureInLiveSyncWindow(state: AppState, nowMs: number): Fixture | null {
  return (
    [...state.fixtures]
      .sort((a, b) => a.sequence - b.sequence)
      .find(
        (fixture) =>
          nowMs >= Date.parse(fixture.kickoffAt) &&
          nowMs <= Date.parse(fixture.resultSyncDueAt) &&
          (fixture.recordStatus === "scheduled" ||
            (fixture.recordStatus === "settled" &&
              fixture.stage === "semi_final" &&
              fixture.winnerSide === null)),
      ) ?? null
  );
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function betSettlementLabel(bet: Bet): string {
  if (bet.status === "won") return `中 · ${money(bet.payoutCents)}`;
  if (bet.status === "lost") return "未中";
  if (bet.status === "void") return `退 ${money(bet.payoutCents)}`;
  if (bet.status === "review_required") return "待复核";
  return "待结算";
}

function betSettlementMark(status: Bet["status"]): string {
  if (status === "won") return "✓";
  if (status === "lost") return "×";
  if (status === "void") return "↩";
  if (status === "review_required") return "!";
  return "·";
}

function centerFixtureCard(track: HTMLDivElement, fixtureId: string): void {
  const element = [...track.querySelectorAll<HTMLElement>("[data-fixture-id]")]
    .find((candidate) => candidate.dataset.fixtureId === fixtureId);
  if (!element) return;

  const left = element.offsetLeft - track.offsetLeft - (track.clientWidth - element.offsetWidth) / 2;
  if (Math.abs(track.scrollLeft - left) < 1) return;
  track.scrollLeft = left;
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

function hasCompleteKnockoutOutcome(fixture: Fixture): boolean {
  const regulation = fixture.regularTimeScore;
  if (fixture.recordStatus !== "settled" || !fixture.winnerSide || !regulation) return false;
  if (regulation.home !== regulation.away) return true;

  const afterExtraTime = fixture.afterExtraTimeScore;
  if (!afterExtraTime) return false;
  if (afterExtraTime.home !== afterExtraTime.away) return true;

  const penalties = fixture.penaltyShootoutScore;
  return Boolean(penalties && penalties.home !== penalties.away);
}

type FixturePresentationMode =
  | "next"
  | "upcoming-confirmed"
  | "upcoming-tbd"
  | "completed";

function fixturePresentationMode(
  fixture: Fixture,
  nextFixtureId: string | null,
): FixturePresentationMode {
  if (fixture.recordStatus === "settled" && fixture.winnerSide) return "completed";
  if (fixture.id === nextFixtureId) return "next";
  return fixture.homeTeam.placeholder || fixture.awayTeam.placeholder
    ? "upcoming-tbd"
    : "upcoming-confirmed";
}

function statusLabel(
  fixture: Fixture,
  activeFixtureId: string | null,
  nextFixtureId: string | null,
): string {
  const mode = fixturePresentationMode(fixture, nextFixtureId);
  if (mode === "completed") return "完赛";
  if (fixture.recordStatus === "review_required") return "待复核";
  if (fixture.recordStatus === "settled" && !fixture.winnerSide) {
    return "等待最终赛果";
  }
  if (mode === "upcoming-tbd") return "未开赛 · 等待对阵";
  if (mode === "upcoming-confirmed") return "未开赛 · 对阵已定";
  if (fixture.homeTeam.placeholder || fixture.awayTeam.placeholder) return "下一场 · 等待对阵";
  if (fixture.offers.length === 0 && fixture.status === "locked") return "下一场 · 等待赔率";
  if (fixture.id === activeFixtureId) return "开放下注";
  if (fixture.status === "in_progress") return "比赛进行中";
  if (fixture.status === "awaiting_result") return "等待赛果";
  return "下一场 · 已锁定";
}

function lockedCardCopy(
  fixture: Fixture,
  mode: FixturePresentationMode,
): { title: string; body: string } {
  if (mode === "completed") {
    return { title: "本场无人参与", body: "本场没有锁定注单。" };
  }
  if (fixture.recordStatus === "settled" && !fixture.winnerSide) {
    return {
      title: "90分钟已结算",
      body: "等待加时或点球后的最终胜者；本场注单保持可见。",
    };
  }
  if (mode === "upcoming-tbd" || fixture.homeTeam.placeholder || fixture.awayTeam.placeholder) {
    return {
      title: "未开赛 · 等待对阵",
      body: "前场赛果确认后自动写入球队，轮到本场时再开放。",
    };
  }
  if (mode === "upcoming-confirmed") {
    return {
      title: "未开赛 · 对阵已确认",
      body: "当前只可查看；前一场结算后才轮到本场开放。",
    };
  }
  if (fixture.offers.length === 0) {
    return { title: "等待赔率", body: "对阵已确认，收到本场赔率图后开放。" };
  }
  return { title: "本场已经锁定", body: "下注历史保持可见，当前不能再修改。" };
}

type AdminReviewState = {
  kind: "settled" | "matchup-pending" | "too-early" | "prior-pending" | "reviewable";
  label: string;
  detail: string;
  canSubmit: boolean;
};

function adminReviewState(
  fixture: Fixture,
  fixtures: Fixture[],
  nowMs: number,
): AdminReviewState {
  if (hasCompleteKnockoutOutcome(fixture)) {
    return {
      kind: "settled",
      label: "已结算",
      detail: "本地赛果、金额和晋级方均已锁定。",
      canSubmit: false,
    };
  }
  if (fixture.homeTeam.placeholder || fixture.awayTeam.placeholder) {
    return {
      kind: "matchup-pending",
      label: "对阵待定",
      detail: "等待前场赛果写入双方球队后再复核。",
      canSubmit: false,
    };
  }

  const opensAt = manualReviewOpensAt(fixture.kickoffAt);
  if (!isManualReviewOpen(fixture.kickoffAt, nowMs)) {
    const opensAtLabel = Number.isFinite(opensAt)
      ? shanghaiDateTime(new Date(opensAt).toISOString())
      : "比赛时间确认后";
    return {
      kind: "too-early",
      label: "未到时间",
      detail: `${opensAtLabel}（开赛 T+3h）后可人工复核。`,
      canSubmit: false,
    };
  }

  const blockingPrior = fixtures.find(
    (candidate) =>
      candidate.sequence < fixture.sequence &&
      !hasCompleteKnockoutOutcome(candidate),
  );
  if (blockingPrior) {
    return {
      kind: "prior-pending",
      label: `等待 ${blockingPrior.matchCode}`,
      detail: `请先完成 ${blockingPrior.matchCode} 的结算和晋级方，避免滚存奖池顺序错误。`,
      canSubmit: false,
    };
  }

  return {
    kind: "reviewable",
    label: fixture.recordStatus === "settled" ? "可补完整赛果" : "可复核",
    detail:
      fixture.recordStatus === "settled"
        ? "90分钟奖池已结算，请补齐加时或点球比分以确定晋级方。"
        : "不依赖 API-SPORTS 或 Widget；保存后直接写入本地账本。",
    canSubmit: true,
  };
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

function fixtureWinnerText(fixture: Fixture, teamName: string) {
  if (fixture.stage === "semi_final") return `${teamName}晋级`;
  if (fixture.stage === "third_place") return `${teamName}获胜`;
  return `${teamName}夺冠`;
}

function MatchPlacementBadge({
  fixture,
  side,
}: {
  fixture: Fixture;
  side: Exclude<Fixture["winnerSide"], null>;
}) {
  if (!fixture.winnerSide) return null;

  const isWinner = fixture.winnerSide === side;
  const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;

  if (fixture.stage === "semi_final") {
    if (!isWinner) return null;
    return (
      <span
        className="wb-placement-badge"
        data-placement="win"
        aria-label={`${team.name}晋级`}
      >
        WIN
      </span>
    );
  }

  if (fixture.stage === "final" && isWinner) {
    return (
      <span
        className="wb-placement-badge wb-trophy-badge"
        data-placement="champion"
        aria-label={`${team.name}夺冠`}
      >
        <Image
          className="wb-trophy-icon"
          src="/pixel-world-cup-trophy.png"
          alt=""
          width={14}
          height={20}
          aria-hidden="true"
        />
      </span>
    );
  }

  const placement = fixture.stage === "final" ? "2nd" : isWinner ? "3rd" : "4th";
  const placementLabel =
    fixture.stage === "final"
      ? `${team.name}亚军`
      : `${team.name}${isWinner ? "第三名" : "第四名"}`;

  return (
    <span
      className="wb-placement-badge"
      data-placement={placement.toLowerCase()}
      aria-label={placementLabel}
    >
      {placement}
    </span>
  );
}

function LocalMatchCard({
  fixture,
  mode,
}: {
  fixture: Fixture;
  mode: FixturePresentationMode;
}) {
  const result = fixture.regularTimeScore;
  const afterExtraTime = fixture.afterExtraTimeScore;
  const penalties = fixture.penaltyShootoutScore;
  const displayScore = afterExtraTime ?? result;
  const winner = fixture.winnerSide
    ? fixture.winnerSide === "home"
      ? fixture.homeTeam
      : fixture.awayTeam
    : null;
  const winnerText = winner ? fixtureWinnerText(fixture, winner.name) : null;
  const scoreNote = displayScore
    ? penalties
      ? `点球 ${penalties.home}:${penalties.away}`
      : winnerText
        ? winnerText
        : result?.home === result?.away
          ? "90分钟已结算 · 等待最终胜者"
          : "90分钟比分 · 本地记录"
    : mode === "upcoming-tbd"
      ? "等待前场赛果确定对阵"
      : mode === "upcoming-confirmed"
        ? "对阵已确认 · 尚未开赛"
        : fixture.status === "in_progress"
          ? "比赛进行中 · 等待本地赛果"
          : "比分待赛后锁定";

  return (
    <div className="wb-matchup" data-local-result={mode === "completed" || undefined}>
      <div className="wb-team wb-team-home">
        <Flag code={fixture.homeTeam.code} label={fixture.homeTeam.name} />
        <MatchPlacementBadge fixture={fixture} side="home" />
        <b>{fixture.homeTeam.name}</b>
      </div>
      <div className="wb-score">
        <strong
          aria-label={displayScore
            ? `${afterExtraTime ? "最终比分" : "90分钟比分"}${displayScore.home}比${displayScore.away}`
            : "比分待定"}
        >
          {displayScore ? `${displayScore.home} : ${displayScore.away}` : "— : —"}
        </strong>
        <span className={penalties ? "wb-shootout-score" : undefined}>{scoreNote}</span>
      </div>
      <div className="wb-team wb-team-away">
        <Flag code={fixture.awayTeam.code} label={fixture.awayTeam.name} />
        <MatchPlacementBadge fixture={fixture} side="away" />
        <b>{fixture.awayTeam.name}</b>
      </div>
    </div>
  );
}

function DialogShell({
  title,
  eyebrow,
  onClose,
  children,
  className = "",
  initialFocusRef,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    const app = backdrop?.parentElement;
    const inertTargets = app
      ? [...app.children].filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child !== backdrop,
        )
      : [];
    const previousInert = inertTargets.map((target) => target.inert);
    inertTargets.forEach((target) => {
      target.inert = true;
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    if (initialFocusRef?.current) initialFocusRef.current.focus();
    else closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      inertTargets.forEach((target, index) => {
        target.inert = previousInert[index] ?? false;
      });
      returnFocus?.focus();
    };
  }, [initialFocusRef]);

  return (
    <div className="wb-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`wb-sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby="wb-dialog-title" tabIndex={-1}>
        <div className="wb-sheet-handle" aria-hidden="true" />
        <header className="wb-sheet-header">
          <div>
            {eyebrow && <p>{eyebrow}</p>}
            <h2 id="wb-dialog-title">{title}</h2>
          </div>
          <button ref={closeButtonRef} className="wb-icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function lockedBetAsOffer(bet: Bet, activeOffers: OddsOffer[]): OddsOffer {
  const unchangedActiveOffer = activeOffers.find(
    (offer) => offer.id === bet.offerId && Math.abs(offer.odds - bet.odds) <= 1e-9,
  );
  return unchangedActiveOffer ?? {
    id: bet.offerId,
    fixtureId: bet.fixtureId,
    marketType: bet.marketType,
    selectionCode: bet.selectionCode,
    label: bet.label,
    odds: bet.odds,
    rulesText: "原锁定注单可保留；如需替换，请选择当前有效赔率。",
    source: "原锁定注单",
    active: false,
    uploadedAt: bet.placedAt,
  };
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
  const [historyFixtureId, setHistoryFixtureId] = useState<string | null>(null);
  const [managedFixtureId, setManagedFixtureId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftSlots>({});
  const [sheet, setSheet] = useState<SheetName>(null);
  const [picker, setPicker] = useState<{ participantId: ParticipantId; slot: number } | null>(null);
  const [pickedOfferId, setPickedOfferId] = useState<string | null>(null);
  const [pendingParticipant, setPendingParticipant] = useState<ParticipantId | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<ParticipantId | null>(null);
  const [busy, setBusy] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [adminPinError, setAdminPinError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualResultError, setManualResultError] = useState<string | null>(null);
  const [ledgerReady, setLedgerReady] = useState(false);
  const [lockClock, setLockClock] = useState(() => Date.now());
  const [stateReceivedAt, setStateReceivedAt] = useState(() => Date.now());
  const [oddsJson, setOddsJson] = useState('{\n  "source": "手动导入",\n  "offers": []\n}');
  const [halfHome, setHalfHome] = useState("");
  const [halfAway, setHalfAway] = useState("");
  const [fullHome, setFullHome] = useState("");
  const [fullAway, setFullAway] = useState("");
  const [afterExtraHome, setAfterExtraHome] = useState("");
  const [afterExtraAway, setAfterExtraAway] = useState("");
  const [penaltyHome, setPenaltyHome] = useState("");
  const [penaltyAway, setPenaltyAway] = useState("");
  const trackRef = useRef<HTMLDivElement | null>(null);
  const didInitialScroll = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const scrollSettleTimer = useRef<number | null>(null);
  const requestedScrollFixtureId = useRef<string | null>(null);
  const hasExplicitFixtureSelection = useRef(false);
  const stateRef = useRef(state);
  const syncInFlightRef = useRef(false);
  const lastResultSyncAtRef = useRef(0);
  const liveSyncFixtureIdRef = useRef<string | null>(null);
  const adminPinInputRef = useRef<HTMLInputElement | null>(null);
  const editingRevisionsRef = useRef<Partial<Record<ParticipantId, number>>>({});
  const prevSelectedFixtureIdRef = useRef<string | null>(null);

  const fixtures = useMemo(() => [...state.fixtures].sort((a, b) => a.sequence - b.sequence), [state.fixtures]);
  const nextFixture = fixtures.find((fixture) => fixture.id === state.nextFixtureId) ?? null;
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? nextFixture ?? fixtures[0] ?? null;
  const historyFixture = fixtures.find((fixture) => fixture.id === historyFixtureId) ?? null;
  const managedFixture = fixtures.find((fixture) => fixture.id === managedFixtureId) ?? selectedFixture;
  const estimatedServerNowMs = Date.parse(state.serverTime) + Math.max(
    0,
    lockClock - stateReceivedAt,
  );
  const activeStateFixture = fixtures.find(
    (fixture) => fixture.id === state.activeFixtureId,
  );
  const locallyActiveFixtureId =
    activeStateFixture?.isBettingOpen &&
    estimatedServerNowMs < Date.parse(activeStateFixture.lockAt)
      ? activeStateFixture.id
      : null;
  const isActive = Boolean(
    selectedFixture &&
    selectedFixture.id === locallyActiveFixtureId,
  );
  const managedIsActive = Boolean(
    managedFixture &&
    managedFixture.id === locallyActiveFixtureId,
  );
  const managedReviewState = managedFixture
    ? adminReviewState(managedFixture, fixtures, estimatedServerNowMs)
    : null;
  const managedWinnerTeam = managedFixture?.winnerSide
    ? managedFixture.winnerSide === "home"
      ? managedFixture.homeTeam
      : managedFixture.awayTeam
    : null;
  const managedOddsLocked = Boolean(
    managedFixture && estimatedServerNowMs >= Date.parse(managedFixture.lockAt),
  );
  const fullScoreIsComplete =
    fullHome.trim() !== "" &&
    fullAway.trim() !== "" &&
    Number.isInteger(Number(fullHome)) &&
    Number.isInteger(Number(fullAway));
  const regulationIsDraw = Boolean(
    fullScoreIsComplete && Number(fullHome) === Number(fullAway),
  );
  const afterExtraScoreIsComplete =
    afterExtraHome.trim() !== "" &&
    afterExtraAway.trim() !== "" &&
    Number.isInteger(Number(afterExtraHome)) &&
    Number.isInteger(Number(afterExtraAway));
  const afterExtraIsDraw = Boolean(
    afterExtraScoreIsComplete && Number(afterExtraHome) === Number(afterExtraAway),
  );
  const selectedEntries = useMemo(
    () => selectedFixture ? state.entries.filter((entry) => entry.fixtureId === selectedFixture.id) : [],
    [selectedFixture, state.entries],
  );
  const fixtureStake = selectedEntries.reduce((sum, entry) => sum + entry.stakeCents, 0);
  const fixtureBetCount = selectedEntries.reduce((sum, entry) => sum + entry.betCount, 0);
  const participantBreakdown = useMemo(
    () => selectedEntries
      .map((entry) => {
        const participant = state.participants.find((person) => person.id === entry.participantId);
        return {
          ...entry,
          name: participant?.name ?? entry.participantId,
          displayOrder: participant?.displayOrder ?? 99,
        };
      })
      .sort((a, b) => a.displayOrder - b.displayOrder),
    [selectedEntries, state.participants],
  );
  const managedEntries = useMemo(
    () => managedFixture
      ? state.entries.filter((entry) => entry.fixtureId === managedFixture.id)
      : [],
    [managedFixture, state.entries],
  );
  const managedParticipantBreakdown = useMemo(
    () => managedEntries
      .map((entry) => {
        const participant = state.participants.find((person) => person.id === entry.participantId);
        return {
          ...entry,
          name: participant?.name ?? entry.participantId,
          displayOrder: participant?.displayOrder ?? 99,
        };
      })
      .sort((a, b) => a.displayOrder - b.displayOrder),
    [managedEntries, state.participants],
  );

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
  const carriedIn = selectedFixture?.settlement?.poolBeforeCents ?? carryBefore;
  const rollover = selectedFixture?.settlement
    ? Math.max(0, selectedFixture.settlement.eligiblePoolCents - selectedFixture.settlement.paidCents)
    : carryBefore;

  // 本场排行榜按每场 fixture 预计算，供已结算的参与卡片直接渲染。
  const leaderboardByFixture = useMemo(() => {
    const map = new Map<string, PoolRankingRow[]>();
    for (const fixture of fixtures) {
      const fEntries = state.entries.filter((entry) => entry.fixtureId === fixture.id);
      const fBets = state.bets.filter((bet) => bet.fixtureId === fixture.id);
      const rows = fEntries
        .map((entry) => {
          const participant = state.participants.find((person) => person.id === entry.participantId);
          const participantBets = fBets.filter((bet) => bet.participantId === entry.participantId);
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
      map.set(fixture.id, rows);
    }
    return map;
  }, [fixtures, state.entries, state.bets, state.participants]);

  // 仅统计完赛冻结（已结算）场次的金额，下注阶段的场次不计入天梯榜。
  const settledFixtureIds = useMemo(
    () =>
      new Set(
        state.fixtures
          .filter((fixture) => fixture.recordStatus === "settled")
          .map((fixture) => fixture.id),
      ),
    [state.fixtures],
  );

  // 天梯榜：聚合全体参与人跨场的投入 / 总收益 / 净收益。
  // 排序：净收益 desc → 总收益 desc → 总投入 asc → displayOrder asc
  // 并列名次以净收益为准（1224 排名法）。
  const ladderRows = useMemo(() => {
    const base = state.participants.map((person) => {
      const personEntries = state.entries.filter((entry) => entry.participantId === person.id && settledFixtureIds.has(entry.fixtureId));
      const personBets = state.bets.filter((bet) => bet.participantId === person.id && settledFixtureIds.has(bet.fixtureId));
      const invested = personEntries.reduce((sum, entry) => sum + entry.stakeCents, 0);
      const payout = personBets.reduce((sum, bet) => sum + bet.payoutCents, 0);
      return {
        id: person.id,
        name: person.name,
        displayOrder: person.displayOrder,
        fixtureCount: personEntries.length,
        betCount: personBets.length,
        wonCount: personBets.filter((bet) => bet.status === "won").length,
        invested,
        payout,
        net: payout - invested,
      };
    });
    base.sort(
      (a, b) =>
        b.net - a.net ||
        b.payout - a.payout ||
        a.invested - b.invested ||
        a.displayOrder - b.displayOrder,
    );
    // 1224 并列排名：净收益相等共享名次
    let lastNet = Number.NaN;
    let lastRank = 0;
    return base.map((row, index) => {
      if (row.net !== lastNet) {
        lastRank = index + 1;
        lastNet = row.net;
      }
      return { ...row, rank: lastRank };
    });
  }, [state.participants, state.entries, state.bets, settledFixtureIds]);

  const ladderTotals = useMemo(() => {
    const invested = ladderRows.reduce((s, r) => s + r.invested, 0);
    const payout = ladderRows.reduce((s, r) => s + r.payout, 0);
    const betCount = ladderRows.reduce((s, r) => s + r.betCount, 0);
    const settledFixtures = state.fixtures.filter((f) => f.recordStatus === "settled").length;
    return { invested, payout, betCount, settledFixtures };
  }, [ladderRows, state.fixtures]);

  const historyRows = useMemo(() => {
    if (!historyFixture) return [];
    return state.entries
      .filter((entry) => entry.fixtureId === historyFixture.id)
      .map((entry) => {
        const participant = state.participants.find((person) => person.id === entry.participantId);
        const bets = state.bets.filter(
          (bet) => bet.fixtureId === historyFixture.id && bet.participantId === entry.participantId,
        );
        return {
          ...entry,
          name: participant?.name ?? entry.participantId,
          displayOrder: participant?.displayOrder ?? 99,
          bets,
          payoutCents: bets.reduce((sum, bet) => sum + bet.payoutCents, 0),
        };
      })
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }, [historyFixture, state.bets, state.entries, state.participants]);
  const historyBetCount = historyRows.reduce((sum, entry) => sum + entry.bets.length, 0);
  const historyStakeCents = historyRows.reduce((sum, entry) => sum + entry.stakeCents, 0);
  const historyPayoutCents = historyRows.reduce((sum, entry) => sum + entry.payoutCents, 0);

  const activeDraftPeople = state.participants.filter((person) => (drafts[person.id]?.length ?? 0) > 0);
  const pendingEntry = pendingParticipant
    ? selectedEntries.find((entry) => entry.participantId === pendingParticipant) ?? null
    : null;
  const unlockTargetEntry = unlockTarget
    ? managedEntries.find((entry) => entry.participantId === unlockTarget) ?? null
    : null;
  const pickerFixture = selectedFixture;
  const pickerGroups = useMemo(() => groupedOffers(pickerFixture?.offers ?? []), [pickerFixture]);

  const applyState = useCallback((next: AppState) => {
    const previousNextFixtureId = stateRef.current.nextFixtureId;
    const editableEntries = next.entries.filter((entry) => entry.canEdit);
    const editableByParticipant = new Map(
      editableEntries.map((entry) => [entry.participantId, entry]),
    );
    const draftUpdates: Partial<Record<ParticipantId, Array<OddsOffer | null>>> = {};

    for (const participant of next.participants) {
      const entry = editableByParticipant.get(participant.id);
      const hydratedRevision = editingRevisionsRef.current[participant.id];
      if (!entry && hydratedRevision !== undefined) {
        delete editingRevisionsRef.current[participant.id];
        draftUpdates[participant.id] = [];
        continue;
      }
      if (!entry || hydratedRevision === entry.revision) continue;

      const fixture = next.fixtures.find((candidate) => candidate.id === entry.fixtureId);
      const entryBets = next.bets.filter(
        (bet) =>
          bet.fixtureId === entry.fixtureId &&
          bet.participantId === entry.participantId,
      );
      draftUpdates[participant.id] = entryBets.map((bet) =>
        lockedBetAsOffer(bet, fixture?.offers ?? []),
      );
      editingRevisionsRef.current[participant.id] = entry.revision;
    }

    const receivedAt = Date.now();
    setSelectedFixtureId((current) => {
      const orderedFixtures = [...next.fixtures].sort((a, b) => a.sequence - b.sequence);
      const fallback =
        next.nextFixtureId ??
        orderedFixtures.find((fixture) => fixture.recordStatus !== "settled")?.id ??
        orderedFixtures.at(-1)?.id ??
        null;
      const currentStillExists = current
        ? next.fixtures.some((fixture) => fixture.id === current)
        : false;
      const shouldFollowProgression =
        !hasExplicitFixtureSelection.current ||
        current === null ||
        !currentStillExists ||
        Boolean(
          previousNextFixtureId &&
          current === previousNextFixtureId &&
          previousNextFixtureId !== next.nextFixtureId &&
          next.nextFixtureId,
        );
      const target =
        shouldFollowProgression
          ? fallback
          : current;
      if (target && target !== current) requestedScrollFixtureId.current = target;
      return target;
    });
    stateRef.current = next;
    setState(next);
    setLedgerReady(true);
    setStateReceivedAt(receivedAt);
    if (Object.keys(draftUpdates).length > 0) {
      setDrafts((current) => ({ ...current, ...draftUpdates }));
    }
  }, []);

  const refreshState = useCallback(async (signal?: AbortSignal): Promise<AppState> => {
    const response = await fetch("/api/state", { cache: "no-store", signal });
    if (!response.ok) throw new Error(await responseError(response));
    const next = unwrapState(await response.json());
    if (signal?.aborted) return next;
    applyState(next);
    return next;
  }, [applyState]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 记录上一次选中的场次，用于判断记分牌过渡动画的滑入方向。
  useEffect(() => {
    prevSelectedFixtureIdRef.current = selectedFixture?.id ?? null;
  }, [selectedFixture?.id]);

  useEffect(() => {
    const activeFixture = state.fixtures.find(
      (fixture) => fixture.id === state.activeFixtureId,
    );
    if (!activeFixture) return;
    const serverNowMs = Date.parse(state.serverTime);
    const lockAtMs = Date.parse(activeFixture.lockAt);
    if (!Number.isFinite(serverNowMs) || !Number.isFinite(lockAtMs)) return;
    const elapsedSinceReceipt = Math.max(0, Date.now() - stateReceivedAt);
    const delay = Math.max(0, lockAtMs - (serverNowMs + elapsedSinceReceipt) + 25);
    const timer = window.setTimeout(() => {
      setLockClock(Date.now());
      void refreshState().catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [refreshState, state.activeFixtureId, state.fixtures, state.serverTime, stateReceivedAt]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const nowMs = Date.now();
    lastResultSyncAtRef.current = nowMs;
    liveSyncFixtureIdRef.current = fixtureInLiveSyncWindow(stateRef.current, nowMs)?.id ?? null;
    syncInFlightRef.current = true;

    async function loadLedgerThenSyncResults() {
      // Show the persisted ledger before waiting on the slower provider catch-up.
      try {
        const persistedState = await refreshState(signal);
        if (!signal.aborted) {
          liveSyncFixtureIdRef.current =
            fixtureInLiveSyncWindow(persistedState, Date.now())?.id ?? null;
        }
      } catch (reason: unknown) {
        if (!signal.aborted) {
          setError(reason instanceof Error ? reason.message : "本地账本暂时无法读取");
        }
      }
      if (signal.aborted) return;

      // Local mode cannot run while the browser is closed, so opening the app
      // still catches up due fixtures in the background and then refreshes once.
      try {
        const response = await fetch("/api/results/sync", {
          cache: "no-store",
          signal,
        });
        if (response.ok && !signal.aborted) {
          const refreshedState = await refreshState(signal);
          if (!signal.aborted) {
            liveSyncFixtureIdRef.current =
              fixtureInLiveSyncWindow(refreshedState, Date.now())?.id ?? null;
          }
        }
      } catch {
        // Keep the already loaded ledger usable. Live polling or a later open
        // will retry without turning provider latency into a page-load error.
      } finally {
        if (!signal.aborted) lastResultSyncAtRef.current = Date.now();
      }
    }

    void loadLedgerThenSyncResults().finally(() => {
      if (!signal.aborted) syncInFlightRef.current = false;
    });
    return () => {
      controller.abort();
      syncInFlightRef.current = false;
    };
  }, [refreshState]);

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
        const response = await fetch("/api/results/sync", { cache: "no-store" });
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
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheet]);

  useEffect(() => {
    if (sheet !== "manage") return;
    const timer = window.setInterval(() => setLockClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [sheet]);

  useLayoutEffect(() => {
    if (!selectedFixtureId) return;
    if (
      didInitialScroll.current &&
      requestedScrollFixtureId.current !== selectedFixtureId
    ) return;
    const track = trackRef.current;
    if (!track) return;
    didInitialScroll.current = true;
    requestedScrollFixtureId.current = null;
    centerFixtureCard(track, selectedFixtureId);
  }, [selectedFixtureId, fixtures.length]);

  useEffect(() => () => {
    if (scrollSettleTimer.current !== null) {
      window.clearTimeout(scrollSettleTimer.current);
    }
    if (scrollFrame.current !== null) {
      window.cancelAnimationFrame(scrollFrame.current);
    }
  }, []);

  function handleTrackScroll() {
    if (scrollFrame.current !== null) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
    if (scrollSettleTimer.current !== null) {
      window.clearTimeout(scrollSettleTimer.current);
    }
    scrollSettleTimer.current = window.setTimeout(() => {
      scrollFrame.current = window.requestAnimationFrame(() => {
        scrollFrame.current = null;
        const track = trackRef.current;
        if (!track) return;
        if (!hasExplicitFixtureSelection.current) {
          return;
        }
        const trackBox = track.getBoundingClientRect();
        const center = trackBox.left + trackBox.width / 2;
        const cards = [...track.querySelectorAll<HTMLElement>("[data-fixture-id]")];
        const nearest = cards.reduce<HTMLElement | null>((closest, card) => {
          if (!closest) return card;
          const cardBox = card.getBoundingClientRect();
          const closestBox = closest.getBoundingClientRect();
          const distance = Math.abs(cardBox.left + cardBox.width / 2 - center);
          const closestDistance = Math.abs(closestBox.left + closestBox.width / 2 - center);
          return distance < closestDistance ? card : closest;
        }, null);
        if (nearest?.dataset.fixtureId) {
          setSelectedFixtureId(nearest.dataset.fixtureId);
        }
      });
      scrollSettleTimer.current = null;
    }, CAROUSEL_SETTLE_MS);
  }

  function addDraftParticipant(participantId: ParticipantId) {
    setDrafts((current) => ({ ...current, [participantId]: [null] }));
    setSheet(null);
  }

  function markCarouselInteraction() {
    hasExplicitFixtureSelection.current = true;
  }

  function openBetHistory(fixtureId: string) {
    hasExplicitFixtureSelection.current = true;
    setSelectedFixtureId(fixtureId);
    setHistoryFixtureId(fixtureId);
    setSheet("history");
  }

  function openOdds(participantId: ParticipantId, slot: number) {
    if (!isActive) return;
    setPicker({ participantId, slot });
    const currentOffer = drafts[participantId]?.[slot];
    setPickedOfferId(currentOffer?.active ? currentOffer.id : null);
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

  async function assertAdminResponse(response: Response) {
    if (response.ok) return;
    const message = await responseError(response);
    if (response.status === 423) {
      await refreshState().catch(() => undefined);
    }
    if (response.status === 401) {
      setAdminAuthenticated(false);
      setAdminPin("");
      setAdminPinError("管理登录已失效，请重新输入密码。");
      setSheet("admin-login");
    }
    throw new Error(message);
  }

  function prepareManualResultFields(fixture: Fixture | null) {
    setHalfHome(fixture?.halfTimeScore?.home.toString() ?? "");
    setHalfAway(fixture?.halfTimeScore?.away.toString() ?? "");
    setFullHome(fixture?.regularTimeScore?.home.toString() ?? "");
    setFullAway(fixture?.regularTimeScore?.away.toString() ?? "");
    setAfterExtraHome(fixture?.afterExtraTimeScore?.home.toString() ?? "");
    setAfterExtraAway(fixture?.afterExtraTimeScore?.away.toString() ?? "");
    setPenaltyHome(fixture?.penaltyShootoutScore?.home.toString() ?? "");
    setPenaltyAway(fixture?.penaltyShootoutScore?.away.toString() ?? "");
    setManualResultError(null);
  }

  function selectManagedFixture(fixture: Fixture) {
    setManagedFixtureId(fixture.id);
    setUnlockTarget(null);
    setError(null);
    prepareManualResultFields(fixture);
  }

  function showManageSheet() {
    const target = selectedFixture ?? nextFixture ?? fixtures[0] ?? null;
    setError(null);
    setManagedFixtureId(target?.id ?? null);
    prepareManualResultFields(target);
    setLockClock(Date.now());
    setSheet("manage");
  }

  async function openManage() {
    setAdminPinError(null);
    if (adminAuthenticated) {
      showManageSheet();
      return;
    }
    setAdminBusy(true);
    try {
      const response = await fetch("/api/admin/session", { cache: "no-store" });
      const body = (await response.json()) as { authenticated?: boolean };
      if (response.ok && body.authenticated) {
        setAdminAuthenticated(true);
        showManageSheet();
      } else {
        setSheet("admin-login");
      }
    } catch {
      setAdminPinError("暂时无法验证管理登录，请重试。");
      setSheet("admin-login");
    } finally {
      setAdminBusy(false);
    }
  }

  async function authenticateAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4}$/.test(adminPin)) {
      setAdminPinError("请输入4位数字管理密码。");
      return;
    }
    setAdminBusy(true);
    setAdminPinError(null);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: adminPin }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setAdminAuthenticated(true);
      setAdminPin("");
      showManageSheet();
    } catch (reason) {
      setAdminPinError(reason instanceof Error ? reason.message : "管理密码验证失败。");
      window.requestAnimationFrame(() => adminPinInputRef.current?.focus());
    } finally {
      setAdminBusy(false);
    }
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
          entryRevision: pendingEntry?.revision,
          selections: selections.map((selection) => ({ offerId: selection?.id, odds: selection?.odds })),
        }),
      });
      if (!response.ok) {
        const message = await responseError(response);
        if (response.status === 423) {
          await refreshState().catch(() => undefined);
        }
        throw new Error(message);
      }
      const next = unwrapState(await response.json());
      applyState(next);
      setDrafts((current) => ({ ...current, [pendingParticipant]: [] }));
      const name = state.participants.find((person) => person.id === pendingParticipant)?.name;
      setToast(
        pendingEntry?.canEdit
          ? `${name ?? "参与者"}的注单已更新并重新锁定`
          : `${name ?? "参与者"}已锁定并加入奖池`,
      );
      setSheet(null);
      setPendingParticipant(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "锁定失败，请稍后重试");
      setSheet(null);
    } finally {
      setBusy(false);
    }
  }

  async function removeUnlockedEntry() {
    if (!pendingParticipant || !selectedFixture || !pendingEntry?.canEdit) return;
    const participantId = pendingParticipant;
    const entry = pendingEntry;
    const name = state.participants.find((person) => person.id === participantId)?.name;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove-entry",
          entryId: entry.id,
          fixtureId: selectedFixture.id,
          participantId,
          entryRevision: entry.revision,
        }),
      });
      await assertAdminResponse(response);
      applyState(unwrapState(await response.json()));
      setDrafts((current) => ({ ...current, [participantId]: [] }));
      setToast(`${name ?? "参与者"}的本场下注已全部移除`);
      setSheet(null);
      setPendingParticipant(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function syncResults() {
    if (syncInFlightRef.current) {
      setToast("正在检查赛果，请稍候");
      return;
    }
    syncInFlightRef.current = true;
    lastResultSyncAtRef.current = Date.now();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/results/sync", { method: "POST" });
      await assertAdminResponse(response);
      await refreshState();
      setToast("已检查到期比赛，账本已刷新");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      lastResultSyncAtRef.current = Date.now();
      syncInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function importOdds() {
    if (!managedFixture) return;
    const fixture = managedFixture;
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
          fixtureId: fixture.id,
          source: Array.isArray(parsed) ? "手动导入" : parsed.source,
          providerMatchId: Array.isArray(parsed) ? null : parsed.providerMatchId,
          offers,
        }),
      });
      await assertAdminResponse(response);
      applyState(unwrapState(await response.json()));
      setToast(`${fixture.matchCode} 已导入${offers.length}个赔率选项`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "赔率导入失败");
    } finally {
      setBusy(false);
    }
  }

  function normalizeScoreInput(value: string): string {
    return value.replace(/\D/g, "").slice(0, 2);
  }

  function updateRegulationScore(side: "home" | "away", rawValue: string) {
    const value = normalizeScoreInput(rawValue);
    const nextHome = side === "home" ? value : fullHome;
    const nextAway = side === "away" ? value : fullAway;
    if (side === "home") setFullHome(value);
    else setFullAway(value);
    setManualResultError(null);

    const remainsDraw =
      nextHome !== "" &&
      nextAway !== "" &&
      Number(nextHome) === Number(nextAway);
    if (!remainsDraw) {
      setAfterExtraHome("");
      setAfterExtraAway("");
      setPenaltyHome("");
      setPenaltyAway("");
    }
  }

  function updateAfterExtraScore(side: "home" | "away", rawValue: string) {
    const value = normalizeScoreInput(rawValue);
    const nextHome = side === "home" ? value : afterExtraHome;
    const nextAway = side === "away" ? value : afterExtraAway;
    if (side === "home") setAfterExtraHome(value);
    else setAfterExtraAway(value);
    setManualResultError(null);

    const remainsDraw =
      nextHome !== "" &&
      nextAway !== "" &&
      Number(nextHome) === Number(nextAway);
    if (!remainsDraw) {
      setPenaltyHome("");
      setPenaltyAway("");
    }
  }

  async function saveManualResult() {
    if (!managedFixture || !managedReviewState) return;
    const fixture = managedFixture;
    if (!managedReviewState.canSubmit) {
      setManualResultError(managedReviewState.detail);
      return;
    }

    const normalizedHalfHome = halfHome.trim();
    const normalizedHalfAway = halfAway.trim();
    const normalizedFullHome = fullHome.trim();
    const normalizedFullAway = fullAway.trim();
    const hasHalfHome = normalizedHalfHome !== "";
    const hasHalfAway = normalizedHalfAway !== "";
    if (hasHalfHome !== hasHalfAway) {
      setManualResultError("半场比分需要同时填写两个整数，或两项都留空。");
      return;
    }
    if (normalizedFullHome === "" || normalizedFullAway === "") {
      setManualResultError("90分钟比分需要同时填写主队和客队。");
      return;
    }
    const regulationHome = Number(normalizedFullHome);
    const regulationAway = Number(normalizedFullAway);
    const hasHalf = hasHalfHome && hasHalfAway;
    const validScore = (value: number) => Number.isInteger(value) && value >= 0 && value <= 99;
    if (!validScore(regulationHome) || !validScore(regulationAway)) {
      setManualResultError("请输入0到99之间的90分钟整数比分。");
      return;
    }
    const halfTimeHome = hasHalf ? Number(normalizedHalfHome) : undefined;
    const halfTimeAway = hasHalf ? Number(normalizedHalfAway) : undefined;
    if (hasHalf && (!validScore(halfTimeHome!) || !validScore(halfTimeAway!))) {
      setManualResultError("半场比分需要同时填写0到99之间的整数。");
      return;
    }
    if (
      hasHalf &&
      (halfTimeHome! > regulationHome || halfTimeAway! > regulationAway)
    ) {
      setManualResultError("半场比分不能大于90分钟比分。");
      return;
    }

    const needsExtraTime = regulationHome === regulationAway;
    let extraTimeHome: number | undefined;
    let extraTimeAway: number | undefined;
    let shootoutHome: number | undefined;
    let shootoutAway: number | undefined;
    if (needsExtraTime) {
      if (afterExtraHome.trim() === "" || afterExtraAway.trim() === "") {
        setManualResultError("90分钟战平时，请填写加时赛结束后的累计比分。");
        return;
      }
      extraTimeHome = Number(afterExtraHome);
      extraTimeAway = Number(afterExtraAway);
      if (!validScore(extraTimeHome) || !validScore(extraTimeAway)) {
        setManualResultError("加时赛累计比分需要同时填写0到99之间的整数。");
        return;
      }
      if (extraTimeHome < regulationHome || extraTimeAway < regulationAway) {
        setManualResultError("加时赛累计比分不能低于90分钟比分。");
        return;
      }
      if (extraTimeHome === extraTimeAway) {
        if (penaltyHome.trim() === "" || penaltyAway.trim() === "") {
          setManualResultError("加时后仍然战平，请填写点球大战比分。");
          return;
        }
        shootoutHome = Number(penaltyHome);
        shootoutAway = Number(penaltyAway);
        if (!validScore(shootoutHome) || !validScore(shootoutAway)) {
          setManualResultError("点球大战比分需要同时填写0到99之间的整数。");
          return;
        }
        if (shootoutHome === shootoutAway) {
          setManualResultError("点球大战必须决出胜负，比分不能相同。");
          return;
        }
      }
    }

    setBusy(true);
    setManualResultError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "manual-result",
          fixtureId: fixture.id,
          halfHome: halfTimeHome,
          halfAway: halfTimeAway,
          regulationHome,
          regulationAway,
          afterExtraTimeHome: extraTimeHome,
          afterExtraTimeAway: extraTimeAway,
          penaltyShootoutHome: shootoutHome,
          penaltyShootoutAway: shootoutAway,
          reason: "管理员核对数据源后录入",
        }),
      });
      await assertAdminResponse(response);
      const settledFixtureId = fixture.id;
      hasExplicitFixtureSelection.current = true;
      applyState(unwrapState(await response.json()));
      requestedScrollFixtureId.current = settledFixtureId;
      setSelectedFixtureId(settledFixtureId);
      setHalfHome("");
      setHalfAway("");
      setFullHome("");
      setFullAway("");
      setAfterExtraHome("");
      setAfterExtraAway("");
      setPenaltyHome("");
      setPenaltyAway("");
      setSheet(null);
      setToast(`${fixture.matchCode} 赛果已写入本地账本，金额与排行榜已完成结算`);
    } catch (reason) {
      setManualResultError(reason instanceof Error ? reason.message : "赛果保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function setSelectedEntryUnlocked(entry: FixtureEntry, unlocked: boolean) {
    if (!managedFixture || !managedIsActive) return;
    const fixture = managedFixture;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set-entry-edit-unlocked",
          fixtureId: fixture.id,
          participantId: entry.participantId,
          unlocked,
        }),
      });
      await assertAdminResponse(response);
      const next = unwrapState(await response.json());
      hasExplicitFixtureSelection.current = true;
      applyState(next);
      requestedScrollFixtureId.current = fixture.id;
      setSelectedFixtureId(fixture.id);
      const name = state.participants.find((person) => person.id === entry.participantId)?.name;
      setToast(
        unlocked
          ? `${name ?? "参与者"}的下注已单独解锁，可在卡片中修改或移除`
          : `${name ?? "参与者"}的下注已恢复锁定，原注单保持有效`,
      );
      setUnlockTarget(null);
      setSheet("manage");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解锁状态调整失败");
    } finally {
      setBusy(false);
    }
  }

  if (!ledgerReady) {
    return (
      <div className="wb-app wb-app-loading" aria-busy={!error}>
        <header className="wb-topbar">
          <div className="wb-brand"><span>球局</span><small>世界杯奖池</small></div>
          <span className="wb-loading-status">{error ? "读取失败" : "读取账本"}</span>
        </header>
        <main className="wb-ledger-loading-main">
          <div className="wb-ledger-loading-card" role="status" aria-live="polite">
            <span className="wb-ledger-loading-mark" aria-hidden="true">球</span>
            <b>{error ? "本地账本暂时无法读取" : "正在读取本地比赛账本"}</b>
            <p>{error ?? "赛果、下注历史和下一场状态会一起出现。"}</p>
            {error && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void refreshState().catch((reason: unknown) => {
                    setError(reason instanceof Error ? reason.message : "本地账本暂时无法读取");
                  });
                }}
              >
                重新读取
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (!selectedFixture) return <div className="wb-empty-page">暂无比赛</div>;

  const selectedMode = fixturePresentationMode(selectedFixture, state.nextFixtureId);
  const showNextWidget = Boolean(
    ledgerReady && nextFixture && selectedFixture.id === nextFixture.id,
  );
  const result = selectedFixture.regularTimeScore;
  const selectedIndex = fixtures.findIndex((fixture) => fixture.id === selectedFixture.id);
  const prevSelectedIndex = prevSelectedFixtureIdRef.current
    ? fixtures.findIndex((fixture) => fixture.id === prevSelectedFixtureIdRef.current)
    : -1;
  const slideFrom =
    selectedIndex >= 0 && prevSelectedIndex >= 0 && selectedIndex !== prevSelectedIndex
      ? selectedIndex > prevSelectedIndex
        ? "right"
        : "left"
      : null;

  return (
    <div className="wb-app">
      <header className="wb-topbar">
        <div className="wb-brand"><span>球局</span><small>世界杯奖池</small></div>
        <div className="wb-top-actions">
          <button type="button" onClick={() => setSheet("rules")}>规则</button>
          <button type="button" onClick={() => setSheet("ladder")} aria-label="查看全体历史投注与净收益天梯榜">天梯榜</button>
          <button
            type="button"
            disabled={adminBusy}
            onClick={() => void openManage()}
            aria-label="验证身份并打开管理面板"
          >
            {adminBusy ? "验证中" : "管理"}
          </button>
        </div>
      </header>

      <main className="wb-main" data-selected-presentation={selectedMode}>
        <section className="wb-scoreboard" aria-label="当前比赛、奖池与赛果">
          <div className="wb-scoreboard-anim" key={selectedFixture.id} data-slide-from={slideFrom ?? undefined}>
          <div className="wb-match-meta">
            <span>{selectedFixture.matchCode} · {STAGE_LABEL[selectedFixture.stage]}</span>
            <strong>{shanghaiDateTime(selectedFixture.kickoffAt)} 北京时间</strong>
            <span className="wb-status" data-status={selectedFixture.id === locallyActiveFixtureId ? "active" : selectedFixture.status === "active" ? "locked" : selectedFixture.status}>
              {statusLabel(selectedFixture, locallyActiveFixtureId, state.nextFixtureId)}
            </span>
          </div>
          {ledgerReady && nextFixture && (
            <div className="wb-next-widget-slot" hidden={!showNextWidget}>
              <ApiSportsGameWidget
                fixtureId={
                  nextFixture.homeTeam.placeholder || nextFixture.awayTeam.placeholder
                    ? null
                    : nextFixture.providerMatchId
                }
                kickoffAt={nextFixture.kickoffAt}
                currentTime={state.serverTime}
                settled={false}
                fallback={(
                  <LocalMatchCard
                    fixture={nextFixture}
                    mode={fixturePresentationMode(nextFixture, state.nextFixtureId)}
                  />
                )}
              />
            </div>
          )}
          {!showNextWidget && (
            <LocalMatchCard fixture={selectedFixture} mode={selectedMode} />
          )}
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
            <button
              className="wb-stat-link"
              type="button"
              aria-haspopup="dialog"
              aria-label={`本场总奖池 ${money(fixturePool)}，查看${selectedEntries.length}人金额明细`}
              onClick={() => setSheet("pool")}
            >
              <span>本场总奖池</span><strong>{money(fixturePool)}</strong>
            </button>
            <button
              className="wb-stat-link"
              type="button"
              aria-haspopup="dialog"
              aria-label={`参与人数${selectedEntries.length}人，共${state.participants.length}人，查看参与明细`}
              onClick={() => setSheet("pool")}
            >
              <span>参与人数</span><strong>{selectedEntries.length}<small> / {state.participants.length}</small></strong>
            </button>
            <div><span>{selectedFixture.settlement ? "本场滚存" : "上场滚入"}</span><strong>{money(rollover)}</strong></div>
          </div>
          </div>
        </section>

        <section className="wb-carousel-section" aria-labelledby="wb-carousel-title">
          <div className="wb-carousel-heading">
            <div><h2 id="wb-carousel-title">参与卡片</h2><p>左右滑动切换比赛，上方信息同步更新</p></div>
            <div className="wb-dots" aria-label="比赛页码">{fixtures.map((fixture) => <span key={fixture.id} className={fixture.id === selectedFixture.id ? "is-current" : ""} />)}</div>
          </div>
          <div
            className="wb-fixture-track"
            ref={trackRef}
            onScroll={handleTrackScroll}
            onPointerDownCapture={markCarouselInteraction}
            onWheelCapture={markCarouselInteraction}
            onKeyDownCapture={markCarouselInteraction}
          >
            {fixtures.map((fixture) => {
              const entries = state.entries.filter((entry) => entry.fixtureId === fixture.id);
              const bets = state.bets.filter((bet) => bet.fixtureId === fixture.id);
              const active = fixture.id === locallyActiveFixtureId;
              const selected = fixture.id === selectedFixture.id;
              const mode = fixturePresentationMode(fixture, state.nextFixtureId);
              const emptyCopy = lockedCardCopy(fixture, mode);
              const fixtureLeaderboard = leaderboardByFixture.get(fixture.id) ?? [];
              const fixtureRollover = fixture.settlement
                ? Math.max(0, fixture.settlement.eligiblePoolCents - fixture.settlement.paidCents)
                : 0;
              return (
                <article
                  className={`wb-fixture-card${selected ? " is-selected" : ""}${active ? " is-active" : " is-readonly"}${mode === "completed" ? " is-completed" : ""}${mode.startsWith("upcoming") ? " is-upcoming" : ""}`}
                  key={fixture.id}
                  data-fixture-id={fixture.id}
                  data-presentation={mode}
                  onFocus={() => {
                    if (hasExplicitFixtureSelection.current) setSelectedFixtureId(fixture.id);
                  }}
                >
                  <header className="wb-card-head">
                    <div><b>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</b><span>{shanghaiDateTime(fixture.kickoffAt)} · {STAGE_LABEL[fixture.stage]}</span></div>
                    <span className="wb-card-lock">{active ? `${shanghaiTime(fixture.lockAt)} 锁定` : statusLabel(fixture, locallyActiveFixtureId, state.nextFixtureId)}</span>
                  </header>
                  <div className={`wb-card-body${mode === "completed" ? " wb-card-body-completed" : ""}`}>
                    {mode === "completed" ? (
                      entries.length > 0 ? (
                        <div className="wb-completed-content">
                          <div className="wb-ranking-title">
                            <strong>本场排行榜</strong>
                            <span>剩余 {money(fixtureRollover)} 滚入下一场</span>
                          </div>
                          <PoolPodium rows={fixtureLeaderboard} />
                          <button
                            className="wb-history-trigger"
                            type="button"
                            aria-haspopup="dialog"
                            aria-label={`查看 ${fixture.homeTeam.name} 对 ${fixture.awayTeam.name} 的投注历史，共 ${entries.length} 人 ${bets.length} 注`}
                            onFocus={(event) => event.stopPropagation()}
                            onClick={() => openBetHistory(fixture.id)}
                          >
                            <span className="wb-history-trigger-mark" aria-hidden="true">账</span>
                            <span>
                              <b>查看投注历史</b>
                              <small>
                                {entries.length}人 · {bets.length}注 · 投入 {money(entries.reduce((sum, entry) => sum + entry.stakeCents, 0))} · 收获 {money(bets.reduce((sum, bet) => sum + bet.payoutCents, 0))}
                              </small>
                            </span>
                            <strong aria-hidden="true">›</strong>
                          </button>
                        </div>
                      ) : (
                        <div className="wb-card-empty"><span>终</span><b>{emptyCopy.title}</b><p>{emptyCopy.body}</p></div>
                      )
                    ) : (
                      <>
                        {(entries.length > 0 || (active && activeDraftPeople.length > 0)) && (
                          <div className="wb-entry-table-head">
                            <span>下注人</span><span>项目</span><span>赔率</span>
                          </div>
                        )}
                        {entries.filter((entry) => !(active && entry.canEdit)).map((entry) => {
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
                                    <span className="wb-entry-bet-result">
                                      <strong>{bet.odds.toFixed(2)}</strong>
                                      {fixture.recordStatus === "settled" && (
                                        <small data-status={bet.status}>{betSettlementLabel(bet)}</small>
                                      )}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}

                        {active && activeDraftPeople.map((person) => {
                          const slots = drafts[person.id] ?? [];
                          const editingEntry = entries.find(
                            (entry) => entry.participantId === person.id && entry.canEdit,
                          );
                          return (
                            <div className="wb-draft" key={person.id}>
                              <div className="wb-draft-head">
                                <div>
                                  <ParticipantAvatar participantId={person.id} className="wb-avatar-draft" />
                                  <strong>{person.name}<span>{editingEntry ? "管理员已解锁" : "未锁定"}</span></strong>
                                </div>
                                {editingEntry ? (
                                  <button
                                    className="wb-remove-entry-button"
                                    type="button"
                                    onClick={() => {
                                      setPendingParticipant(person.id);
                                      setSheet("remove-confirm");
                                    }}
                                  >
                                    移除下注
                                  </button>
                                ) : (
                                  <button type="button" onClick={() => setDrafts((current) => ({ ...current, [person.id]: [] }))}>移除</button>
                                )}
                              </div>
                              <div className="wb-draft-slots">
                                {slots.map((offer, slot) => (
                                  <button className={offer ? "has-offer" : ""} type="button" key={slot} onClick={() => openOdds(person.id, slot)}>
                                    <i>{slot + 1}</i><span>{offer ? <><b>{offer.label}</b><small>{MARKET_LABEL[offerGroup(offer.marketType)] ?? offer.marketType}</small></> : <><b>选择第{slot + 1}注</b><small>点此打开本场全部玩法</small></>}</span>{offer ? <strong>{offer.odds.toFixed(2)}</strong> : <strong>＋</strong>}
                                  </button>
                                ))}
                              </div>
                              <div className="wb-draft-actions">
                                <button
                                  type="button"
                                  disabled={slots.length <= 1}
                                  onClick={() => setDrafts((current) => ({
                                    ...current,
                                    [person.id]: (current[person.id] ?? []).slice(0, -1),
                                  }))}
                                >
                                  － 减一注
                                </button>
                                <button type="button" disabled={slots.length >= 3} onClick={() => setDrafts((current) => ({ ...current, [person.id]: [...(current[person.id] ?? []), null] }))}>＋ 加一注</button>
                                <button type="button" className="wb-lock-button" disabled={slots.some((offer) => !offer)} onClick={() => { setPendingParticipant(person.id); setSheet("confirm"); }}>{editingEntry ? "重新锁定注单" : "锁定并加入奖池"}</button>
                              </div>
                            </div>
                          );
                        })}

                        {active && (
                          <button className="wb-add-person" type="button" onClick={() => setSheet("people")}>
                            <span>＋</span><b>添加参与人</b><small>{state.participants.length}人中选择，完成1–3注后单独锁定</small>
                          </button>
                        )}
                        {!active && entries.length === 0 && (
                          <div className="wb-card-empty"><span>锁</span><b>{emptyCopy.title}</b><p>{emptyCopy.body}</p></div>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        {error && <button className="wb-error" type="button" onClick={() => setError(null)}>{error}<span>×</span></button>}
      </main>

      {sheet === "ladder" && (
        <DialogShell
          className="wb-ladder-sheet"
          title="天梯榜"
          eyebrow={`已结算 ${ladderTotals.settledFixtures} 场· 全部参与人按净收益排名`}
          onClose={() => setSheet(null)}
        >
          <div className="wb-sheet-body wb-history-body">
            <div className="wb-history-summary" aria-label="天梯榜汇总">
              <div><span>总投入</span><strong>{money(ladderTotals.invested)}<small>{ladderTotals.betCount}注</small></strong></div>
              <div><span>总派彩</span><strong>{money(ladderTotals.payout)}</strong></div>
              <div><span>总净盈亏</span><strong data-net={ladderTotals.payout - ladderTotals.invested >= 0 ? "pos" : "neg"}>{money(ladderTotals.payout - ladderTotals.invested)}</strong></div>
            </div>
            <p className="wb-history-scope">
              <b>净收益排名</b>
              <span>
                按总派彩 - 总投入从高到低排序，相同净收益共享名次。
              </span>
            </p>
            <div className="wb-history-list">
              {ladderRows.map((row) => {
                const netStatus = row.net > 0 ? "pos" : row.net < 0 ? "neg" : "zero";
                const highlight = row.rank <= 3 ? `top-${row.rank}` : "none";
                return (
                  <section
                    className="wb-history-person wb-ladder-person-card"
                    key={row.id}
                    data-highlight={highlight}
                    data-rank={row.rank}
                  >
                    <header>
                      <span className="wb-history-person-name">
                        <span className="wb-ladder-rank-badge" aria-label={`第${row.rank}名`}>{row.rank}</span>
                        <ParticipantAvatar participantId={row.id} className="wb-avatar-history" />
                        <span>
                          <b>{row.name}</b>
                          <small>{row.fixtureCount}场· {row.betCount}注 · 中{row.wonCount}</small>
                        </span>
                      </span>
                      <span className="wb-history-person-total wb-ladder-person-total">
                        <small>投入 {money(row.invested)} · 派彩 {money(row.payout)}</small>
                        <strong data-net={netStatus}>净 {row.net > 0 ? "+" : ""}{money(row.net)}</strong>
                      </span>
                    </header>
                  </section>
                );
              })}
            </div>
          </div>
        </DialogShell>
      )}

      {sheet === "history" && historyFixture && (
        <DialogShell
          className="wb-history-sheet"
          title="投注历史"
          eyebrow={historyFixture.regularTimeScore
            ? `${historyFixture.matchCode} · ${historyFixture.homeTeam.name} ${historyFixture.regularTimeScore.home}:${historyFixture.regularTimeScore.away} ${historyFixture.awayTeam.name}`
            : `${historyFixture.matchCode} · ${historyFixture.homeTeam.name} vs ${historyFixture.awayTeam.name}`}
          onClose={() => setSheet(null)}
        >
          <div className="wb-sheet-body wb-history-body">
            <div className="wb-history-summary" aria-label="本场投注历史汇总">
              <div><span>参与</span><strong>{historyRows.length}人<small> · {historyBetCount}注</small></strong></div>
              <div><span>总投入</span><strong>{money(historyStakeCents)}</strong></div>
              <div><span>总收获</span><strong>{money(historyPayoutCents)}</strong></div>
            </div>
            <p className="wb-history-scope">
              <b>90分钟结算</b>
              <span>
                仅常规时间与伤停补时，不含加时赛和点球大战。
                {historyFixture.settlement && historyFixture.settlement.scaleBps < 10_000
                  ? ` 本场中奖应返按 ${(historyFixture.settlement.scaleBps / 100).toFixed(2)}% 同比例折算。`
                  : ""}
              </span>
            </p>
            {historyRows.length > 0 ? (
              <div className="wb-history-list">
                {historyRows.map((entry) => (
                  <section className="wb-history-person" key={entry.id}>
                    <header>
                      <span className="wb-history-person-name">
                        <ParticipantAvatar participantId={entry.participantId} className="wb-avatar-history" />
                        <span>
                          <b>{entry.name}</b>
                          <small>{entry.bets.length}注 · {shanghaiDateTime(entry.lockedAt)}锁定</small>
                        </span>
                      </span>
                      <span className="wb-history-person-total">
                        <small>投入 {money(entry.stakeCents)}</small>
                        <strong>收获 {money(entry.payoutCents)}</strong>
                      </span>
                    </header>
                    <div className="wb-history-bets">
                      {entry.bets.map((bet, index) => (
                        <div className="wb-history-bet" data-status={bet.status} key={bet.id}>
                          <div className="wb-history-bet-title">
                            <span aria-hidden="true">{index + 1}</span>
                            <span>
                              <b>{bet.label}</b>
                              <small>{MARKET_LABEL[offerGroup(bet.marketType)] ?? bet.marketType}</small>
                            </span>
                          </div>
                          <dl>
                            <div><dt>投入</dt><dd>{money(bet.stakeCents)}</dd></div>
                            <div><dt>锁定赔率</dt><dd>{bet.odds.toFixed(2)}</dd></div>
                            <div>
                              <dt>结算结果</dt>
                              <dd data-status={bet.status}>
                                <span className="wb-history-result-mark" aria-hidden="true">
                                  {betSettlementMark(bet.status)}
                                </span>
                                <span>{betSettlementLabel(bet)}</span>
                              </dd>
                            </div>
                          </dl>
                          {bet.status === "won" && bet.theoreticalPayoutCents !== bet.payoutCents && (
                            <p className="wb-history-adjustment">
                              理论应返 {money(bet.theoreticalPayoutCents)}，按本场奖池折算后实收 {money(bet.payoutCents)}。
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="wb-pool-empty"><b>本场没有投注记录</b><p>没有可供展示的已锁定注单。</p></div>
            )}
          </div>
        </DialogShell>
      )}

      {sheet === "pool" && (
        <DialogShell
          className="wb-pool-detail-sheet"
          title="本场奖池明细"
          eyebrow={`${selectedFixture.matchCode} · ${selectedFixture.homeTeam.name} vs ${selectedFixture.awayTeam.name}`}
          onClose={() => setSheet(null)}
        >
          <div className="wb-sheet-body wb-pool-detail">
            <div className="wb-pool-detail-summary">
              <div><span>本场总奖池</span><strong>{money(fixturePool)}</strong></div>
              <div><span>参与</span><strong>{selectedEntries.length}人 · {fixtureBetCount}注</strong></div>
            </div>
            {carriedIn > 0 && (
              <p className="wb-pool-carry"><span>上场滚入</span><strong>{money(carriedIn)}</strong><small>已计入本场总奖池</small></p>
            )}
            <div className="wb-pool-detail-heading">
              <strong>每人投入</strong><span>本场合计 {money(fixtureStake)}</span>
            </div>
            {participantBreakdown.length ? (
              <ul className="wb-pool-people">
                {participantBreakdown.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <ParticipantAvatar participantId={entry.participantId} className="wb-avatar-pool" />
                      <b>{entry.name}</b>
                    </span>
                    <strong>{money(entry.stakeCents)}<small>，{entry.betCount}注</small></strong>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="wb-pool-empty">
                <b>{carriedIn > 0 ? "本场暂时没有参与人" : "还没有人加入本场"}</b>
                <p>{carriedIn > 0 ? `当前 ${money(fixturePool)} 全部来自上场滚入。` : "锁定注单后，金额和注数会显示在这里。"}</p>
              </div>
            )}
            <p className="wb-pool-detail-note">仅统计正式注单；管理员解锁编辑期间，原注单仍计入奖池。</p>
          </div>
        </DialogShell>
      )}

      {sheet === "people" && (
        <DialogShell title="选择参与人" eyebrow={`${selectedFixture.homeTeam.name} vs ${selectedFixture.awayTeam.name}`} onClose={() => setSheet(null)}>
          <div className="wb-sheet-body">
            <p className="wb-sheet-note">每个人单独完成并锁定。锁定后仅管理员可在截止前为某个人开放修改。</p>
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
            )) : <div className="wb-no-offers"><b>本场赔率还未导入</b><p>请先在管理面板粘贴赔率 JSON。</p><button type="button" onClick={() => void openManage()}>打开管理</button></div>}
          </div>
          <footer className="wb-sheet-footer">
            <div><span>理论应返</span><strong>{pickedOfferId ? money(Math.round(1000 * (selectedFixture.offers.find((offer) => offer.id === pickedOfferId)?.odds ?? 0))) : "—"}</strong></div>
            <button type="button" disabled={!pickedOfferId} onClick={confirmOdds}>确认这一注</button>
          </footer>
        </DialogShell>
      )}

      {sheet === "confirm" && pendingParticipant && (
        <DialogShell
          title={pendingEntry?.canEdit ? "确认重新锁定" : "确认锁定"}
          eyebrow={pendingEntry?.canEdit ? "将以本次选择替换原注单" : "确认后正式加入本场奖池"}
          onClose={() => setSheet(null)}
        >
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
            <p className="wb-sheet-note">
              {pendingEntry?.canEdit
                ? "重新锁定后才会原子替换原注单；在此之前，原注单始终有效并计入奖池。"
                : "确认后，此人正式加入本场奖池。每注固定10元；截止前管理员可为此人单独解锁修改。"}
            </p>
          </div>
          <footer className="wb-sheet-footer wb-confirm-footer"><button type="button" disabled={busy} onClick={() => void lockEntry()}>{busy ? "正在锁定…" : pendingEntry?.canEdit ? "确认更新并重新锁定" : "确认锁定并加入奖池"}</button></footer>
        </DialogShell>
      )}

      {sheet === "remove-confirm" && pendingParticipant && selectedFixture && (
        <DialogShell
          title="确认移除下注"
          eyebrow="将从本场奖池中删除此人的全部正式注单"
          onClose={() => {
            setSheet(null);
            setPendingParticipant(null);
          }}
        >
          <div className="wb-sheet-body">
            {error && (
              <div className="wb-sheet-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">×</button>
              </div>
            )}
            {pendingEntry?.canEdit ? (
              <>
                <div className="wb-confirm-person">
                  <span>
                    <ParticipantAvatar
                      participantId={pendingParticipant}
                      className="wb-avatar-confirm"
                    />
                    <b>{state.participants.find((person) => person.id === pendingParticipant)?.name}</b>
                  </span>
                  <strong>{pendingEntry.betCount}注 · {money(pendingEntry.stakeCents)}</strong>
                </div>
                <div className="wb-confirm-list">
                  {state.bets
                    .filter((bet) => bet.fixtureId === selectedFixture.id && bet.participantId === pendingParticipant)
                    .map((bet, index) => (
                      <p key={bet.id}><span>{index + 1}. {bet.label}</span><strong>{bet.odds.toFixed(2)}</strong></p>
                    ))}
                </div>
                <p className="wb-sheet-note">
                  移除后，此人的全部正式注单会立即退出本场奖池；锁定时间前仍可重新添加。其他人的下注不受影响。
                </p>
              </>
            ) : (
              <div className="wb-no-offers">
                <b>下注状态已经变化</b>
                <p>这组下注已恢复锁定、被移除或超过操作时间，请返回比赛卡查看最新状态。</p>
                <button type="button" onClick={() => { setSheet(null); setPendingParticipant(null); }}>返回比赛卡</button>
              </div>
            )}
          </div>
          {pendingEntry?.canEdit && (
            <footer className="wb-sheet-footer wb-confirm-footer">
              <button className="wb-remove-confirm-button" type="button" disabled={busy} onClick={() => void removeUnlockedEntry()}>
                {busy ? "正在移除…" : "确认移除全部下注"}
              </button>
            </footer>
          )}
        </DialogShell>
      )}

      {sheet === "admin-login" && (
        <DialogShell
          className="wb-admin-login-sheet"
          title="管理员验证"
          eyebrow="请输入4位管理密码"
          initialFocusRef={adminPinInputRef}
          onClose={() => {
            setAdminPin("");
            setAdminPinError(null);
            setSheet(null);
          }}
        >
          <form className="wb-admin-login" onSubmit={(event) => void authenticateAdmin(event)}>
            <p>验证后可同步赛果、导入赔率和单独解锁下注。</p>
            <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
            <label htmlFor="wb-admin-pin">管理密码</label>
            <input
              ref={adminPinInputRef}
              id="wb-admin-pin"
              name="admin-pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              pattern="[0-9]{4}"
              maxLength={4}
              value={adminPin}
              onChange={(event) => {
                setAdminPin(event.target.value.replace(/\D/g, "").slice(0, 4));
                setAdminPinError(null);
              }}
              aria-invalid={Boolean(adminPinError)}
              aria-describedby={adminPinError ? "wb-admin-pin-error" : undefined}
            />
            {adminPinError && <p className="wb-admin-login-error" id="wb-admin-pin-error" role="alert">{adminPinError}</p>}
            <button type="submit" disabled={adminBusy || adminPin.length !== 4}>
              {adminBusy ? "正在验证…" : "进入管理"}
            </button>
          </form>
        </DialogShell>
      )}

      {sheet === "manage" && managedFixture && managedReviewState && (
        <DialogShell
          title="比赛管理"
          eyebrow={`${managedFixture.matchCode} · ${managedFixture.homeTeam.name} vs ${managedFixture.awayTeam.name}`}
          onClose={() => setSheet(null)}
        >
          <div className="wb-sheet-body wb-manage-body">
            <nav className="wb-admin-fixture-picker" aria-label="选择要管理的比赛">
              {fixtures.map((fixture) => {
                const reviewState = adminReviewState(fixture, fixtures, estimatedServerNowMs);
                const selected = fixture.id === managedFixture.id;
                return (
                  <button
                    type="button"
                    key={fixture.id}
                    data-state={reviewState.kind}
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() => selectManagedFixture(fixture)}
                  >
                    <span><b>{fixture.matchCode}</b><small>{STAGE_LABEL[fixture.stage]}</small></span>
                    <strong>{reviewState.label}</strong>
                  </button>
                );
              })}
            </nav>

            <div className="wb-admin-fixture-summary">
              <span><b>{managedFixture.homeTeam.name}</b><i>vs</i><b>{managedFixture.awayTeam.name}</b></span>
              <small>{shanghaiDateTime(managedFixture.kickoffAt)} 北京时间</small>
              <em data-state={managedReviewState.kind}>{managedReviewState.label}</em>
            </div>

            {error && (
              <div className="wb-sheet-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">×</button>
              </div>
            )}

            <section className="wb-admin-unlock">
              <header>
                <div><h3>下注解锁</h3><p>只影响 {managedFixture.matchCode} 的所选参与人，其他人的下注不变。</p></div>
                <span>{managedIsActive ? `可调整至 ${shanghaiTime(managedFixture.lockAt)}` : "当前不可调整"}</span>
              </header>
              {managedIsActive ? (
                managedParticipantBreakdown.length ? (
                  <ul>
                    {managedParticipantBreakdown.map((entry) => (
                      <li key={entry.id}>
                        <span>
                          <ParticipantAvatar participantId={entry.participantId} className="wb-avatar-admin" />
                          <span><b>{entry.name}</b><small>{money(entry.stakeCents)} · {entry.betCount}注{entry.canEdit ? " · 编辑中" : ""}</small></span>
                        </span>
                        <button
                          type="button"
                          className={entry.canEdit ? "is-unlocked" : ""}
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setUnlockTarget(entry.participantId);
                            setSheet("unlock-confirm");
                          }}
                        >
                          {entry.canEdit ? "恢复锁定" : "解锁编辑"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="wb-admin-unlock-empty">{managedFixture.matchCode} 还没有已锁定参与人。</p>
                )
              ) : (
                <p className="wb-admin-unlock-empty">只可调整当前开放投注的比赛；切换比赛不会影响其他场次的下注。</p>
              )}
            </section>

            <section className="wb-admin-section">
              <div><h3>赛果同步</h3><p>检查所有已到时间的比赛；API 不可用时仍可在下方人工复核。</p></div>
              <button type="button" disabled={busy} onClick={() => void syncResults()}>立即检查</button>
            </section>

            <section className="wb-admin-form">
              <h3>导入 {managedFixture.matchCode} 赔率 JSON</h3>
              <textarea aria-label={`${managedFixture.matchCode} 赔率 JSON`} value={oddsJson} onChange={(event) => setOddsJson(event.target.value)} spellCheck={false} />
              <button
                type="button"
                disabled={busy || managedOddsLocked || managedFixture.homeTeam.placeholder || managedFixture.awayTeam.placeholder}
                onClick={() => void importOdds()}
              >
                {managedOddsLocked ? "本场已固定锁定" : `导入到 ${managedFixture.matchCode}`}
              </button>
            </section>

            <section className="wb-admin-form wb-manual-result-form">
              <header className="wb-manual-result-head">
                <div><h3>人工复核比分</h3><p id="wb-manual-result-note">{managedReviewState.detail}</p></div>
                <span data-state={managedReviewState.kind}>{managedReviewState.label}</span>
              </header>

              {managedReviewState.kind === "settled" ? (
                <div className="wb-admin-result-summary">
                  <div><span>90分钟</span><strong>{managedFixture.regularTimeScore ? `${managedFixture.regularTimeScore.home} : ${managedFixture.regularTimeScore.away}` : "— : —"}</strong></div>
                  {managedFixture.afterExtraTimeScore && (
                    <div><span>加时后累计</span><strong>{managedFixture.afterExtraTimeScore.home} : {managedFixture.afterExtraTimeScore.away}</strong></div>
                  )}
                  {managedFixture.penaltyShootoutScore && (
                    <div><span>点球大战</span><strong>{managedFixture.penaltyShootoutScore.home} : {managedFixture.penaltyShootoutScore.away}</strong></div>
                  )}
                  <div><span>最终胜方</span><strong>{managedWinnerTeam?.name ?? "已锁定"}</strong></div>
                  <p>{managedFixture.resolvedAt ? `${shanghaiDateTime(managedFixture.resolvedAt)} 完成复核` : "本地账本已完成结算"}</p>
                </div>
              ) : managedReviewState.canSubmit ? (
                <>
                  <fieldset className="wb-result-score-group">
                    <legend>半场比分 <small>仅有半全场玩法时必填</small></legend>
                    <div className="wb-score-inputs">
                      <label>{managedFixture.homeTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={halfHome} onChange={(event) => { setHalfHome(normalizeScoreInput(event.target.value)); setManualResultError(null); }} placeholder="可空" /></label>
                      <label>{managedFixture.awayTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={halfAway} onChange={(event) => { setHalfAway(normalizeScoreInput(event.target.value)); setManualResultError(null); }} placeholder="可空" /></label>
                    </div>
                  </fieldset>

                  <fieldset className="wb-result-score-group is-required">
                    <legend>90分钟比分 <small>常规时间＋伤停补时</small></legend>
                    <div className="wb-score-inputs">
                      <label>{managedFixture.homeTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={fullHome} onChange={(event) => updateRegulationScore("home", event.target.value)} placeholder="必填" /></label>
                      <label>{managedFixture.awayTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={fullAway} onChange={(event) => updateRegulationScore("away", event.target.value)} placeholder="必填" /></label>
                    </div>
                  </fieldset>

                  {regulationIsDraw && (
                    <fieldset className="wb-result-score-group is-resolution">
                      <legend>加时后累计比分 <small>包含90分钟比分</small></legend>
                      <div className="wb-score-inputs">
                        <label>{managedFixture.homeTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={afterExtraHome} onChange={(event) => updateAfterExtraScore("home", event.target.value)} placeholder="必填" /></label>
                        <label>{managedFixture.awayTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={afterExtraAway} onChange={(event) => updateAfterExtraScore("away", event.target.value)} placeholder="必填" /></label>
                      </div>
                    </fieldset>
                  )}

                  {regulationIsDraw && afterExtraIsDraw && (
                    <fieldset className="wb-result-score-group is-penalty">
                      <legend>点球大战比分 <small>只填点球，不计入比赛比分</small></legend>
                      <div className="wb-score-inputs">
                        <label>{managedFixture.homeTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={penaltyHome} onChange={(event) => { setPenaltyHome(normalizeScoreInput(event.target.value)); setManualResultError(null); }} placeholder="必填" /></label>
                        <label>{managedFixture.awayTeam.name}<input inputMode="numeric" pattern="[0-9]*" value={penaltyAway} onChange={(event) => { setPenaltyAway(normalizeScoreInput(event.target.value)); setManualResultError(null); }} placeholder="必填" /></label>
                      </div>
                    </fieldset>
                  )}

                  {manualResultError && (
                    <div className="wb-sheet-error wb-manual-result-error" role="alert">
                      <span>{manualResultError}</span>
                      <button type="button" onClick={() => setManualResultError(null)} aria-label="关闭赛果错误提示">×</button>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-describedby="wb-manual-result-note"
                    onClick={() => void saveManualResult()}
                  >
                    {busy ? "正在写入本地账本…" : `复核并结算 ${managedFixture.matchCode}`}
                  </button>
                </>
              ) : (
                <div className="wb-admin-result-unavailable" data-state={managedReviewState.kind}>
                  <b>{managedReviewState.label}</b>
                  <p>{managedReviewState.detail}</p>
                </div>
              )}
            </section>
          </div>
        </DialogShell>
      )}

      {sheet === "unlock-confirm" && unlockTargetEntry && managedFixture && (
        <DialogShell
          title={!managedIsActive
            ? "本场已到固定锁定时间"
            : unlockTargetEntry.canEdit
              ? "恢复锁定这份下注？"
              : `解锁${state.participants.find((person) => person.id === unlockTarget)?.name ?? "该参与人"}的下注？`}
          eyebrow={`${managedFixture.matchCode} · ${managedIsActive ? "仅影响此人" : "下注不再可调整"}`}
          onClose={() => setSheet("manage")}
        >
          <div className="wb-sheet-body">
            {error && (
              <div className="wb-sheet-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">×</button>
              </div>
            )}
            <div className="wb-confirm-person">
              <span>
                <ParticipantAvatar participantId={unlockTargetEntry.participantId} className="wb-avatar-confirm" />
                <b>{state.participants.find((person) => person.id === unlockTargetEntry.participantId)?.name}</b>
              </span>
              <strong>{unlockTargetEntry.betCount}注 · {money(unlockTargetEntry.stakeCents)}</strong>
            </div>
            <div className="wb-confirm-list">
              {state.bets
                .filter((bet) => bet.fixtureId === managedFixture.id && bet.participantId === unlockTargetEntry.participantId)
                .map((bet, index) => <p key={bet.id}><span>{index + 1}. {bet.label}</span><strong>{bet.odds.toFixed(2)}</strong></p>)}
            </div>
            <p className="wb-sheet-note">
              {!managedIsActive
                ? "固定锁定时间已到，原注单保持有效；当前不能再改变任何人的解锁状态。"
                : unlockTargetEntry.canEdit
                ? "恢复锁定会关闭此人的编辑权限，原注单继续有效；其他参与人的下注不受影响。"
                : "解锁后原注单仍然有效并计入奖池；可在比赛卡中修改或移除。修改需重新锁定后才会替换，移除需再次确认。其他参与人的下注不受影响。"}
            </p>
          </div>
          <footer className="wb-sheet-footer wb-confirm-footer">
            <button type="button" disabled={busy || !managedIsActive} onClick={() => void setSelectedEntryUnlocked(unlockTargetEntry, !unlockTargetEntry.canEdit)}>
              {!managedIsActive ? "已固定锁定" : busy ? "正在调整…" : unlockTargetEntry.canEdit ? "确认恢复锁定" : "确认单独解锁"}
            </button>
          </footer>
        </DialogShell>
      )}

      {sheet === "rules" && (
        <DialogShell title="奖池规则" eyebrow="简单、透明、无庄家风险" onClose={() => setSheet(null)}>
          <div className="wb-sheet-body wb-rules">
            <ol><li><b>每注固定10元</b><span>每人每场1–3注；个人点击锁定后才正式加入奖池。</span></li><li><b>赔率不设上下限</b><span>中奖彩票理论奖金 = 10元 × 锁定赔率。</span></li><li><b>只看90分钟</b><span>常规时间与伤停补时有效，不含加时赛及点球大战。</span></li><li><b>奖池不足同比缩放</b><span>所有中奖者按理论奖金占比同比例折算，任何人都不用补钱。</span></li><li><b>剩余自动滚存</b><span>本场支付后仍有余额，则全额进入下一场奖池。</span></li><li><b>逐人解锁调整</b><span>固定锁定时间前，管理员可只为某个人开放修改或移除；操作完成前原注单仍有效。</span></li></ol>
          </div>
        </DialogShell>
      )}

      {toast && <div className="wb-toast" role="status">{toast}</div>}
    </div>
  );
}
