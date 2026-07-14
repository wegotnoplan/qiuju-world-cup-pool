"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const WIDGET_SCRIPT_ID = "api-sports-widget-script";
const WIDGET_CONFIG_ID = "api-sports-widget-config";
const WIDGET_SCRIPT_URL = "https://widgets.api-sports.io/3.1.0/widgets.js";

type WidgetState = "checking" | "ready" | "fallback";

interface WidgetSnapshot {
  fixtureId: string | null;
  refresh: string;
  state: WidgetState;
  reason: string;
}

interface ApiEnvelope {
  code?: unknown;
  error?: unknown;
  errors?: unknown;
  results?: unknown;
  response?: unknown;
}

let widgetScriptPromise: Promise<void> | null = null;

function waitForWidgetDefinition(): Promise<void> {
  if (customElements.get("api-sports-widget")) return Promise.resolve();
  return Promise.race([
    customElements.whenDefined("api-sports-widget"),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("赛况组件加载超时")), 12_000);
    }),
  ]).then(() => undefined);
}

function hasApiErrors(errors: unknown): boolean {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

function loadWidgetScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get("api-sports-widget")) return Promise.resolve();
  if (widgetScriptPromise) return widgetScriptPromise;

  const loading = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(WIDGET_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      void waitForWidgetDefinition().then(resolve, reject);
      existing.addEventListener("error", () => reject(new Error("Widget script failed")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.id = WIDGET_SCRIPT_ID;
    script.type = "module";
    script.src = WIDGET_SCRIPT_URL;
    script.addEventListener(
      "load",
      () => void waitForWidgetDefinition().then(resolve, reject),
      { once: true },
    );
    script.addEventListener("error", () => reject(new Error("Widget script failed")), {
      once: true,
    });
    document.head.append(script);
  });
  widgetScriptPromise = loading.catch((error) => {
    widgetScriptPromise = null;
    if (!customElements.get("api-sports-widget")) {
      document.getElementById(WIDGET_SCRIPT_ID)?.remove();
    }
    throw error;
  });

  return widgetScriptPromise;
}

async function ensureWidgetConfig(refresh: string): Promise<void> {
  await loadWidgetScript();
  const existing = document.getElementById(WIDGET_CONFIG_ID);
  if (existing) {
    existing.setAttribute("data-refresh", refresh);
    return;
  }

  const config = document.createElement("api-sports-widget");
  config.id = WIDGET_CONFIG_ID;
  config.setAttribute("data-type", "config");
  config.setAttribute("data-key", "");
  config.setAttribute("data-sport", "football");
  config.setAttribute(
    "data-url-football",
    new URL("/api/api-football/", window.location.origin).href,
  );
  config.setAttribute("data-timezone", "Asia/Shanghai");
  config.setAttribute("data-lang", "en");
  config.setAttribute("data-theme", "WorldCup");
  config.setAttribute("data-refresh", refresh);
  config.setAttribute("data-show-error", "false");
  config.setAttribute("data-show-errors", "false");
  config.setAttribute("data-show-logos", "true");
  config.setAttribute("data-game-tab", "events");
  document.body.append(config);
}

function createGameWidget(host: HTMLDivElement, fixtureId: string, refresh: string) {
  const game = document.createElement("api-sports-widget");
  game.setAttribute("data-type", "game");
  game.setAttribute("data-game-id", fixtureId);
  game.setAttribute("data-refresh", refresh);
  game.setAttribute("data-theme", "WorldCup");
  host.replaceChildren(game);
}

export function ApiSportsGameWidget({
  fixtureId,
  kickoffAt,
  currentTime,
  settled,
  fallback,
}: {
  fixtureId: string | null;
  kickoffAt: string;
  currentTime: string;
  settled: boolean;
  fallback: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<WidgetSnapshot>({
    fixtureId,
    refresh: "false",
    state: fixtureId ? "checking" : "fallback",
    reason: fixtureId ? "正在连接官方赛况…" : "比赛数据 ID 尚未开放",
  });
  const [clockMs, setClockMs] = useState(() => Date.parse(currentTime));
  const kickoffMs = Date.parse(kickoffAt);
  const liveRefresh =
    !settled &&
    Number.isFinite(kickoffMs) &&
    clockMs >= kickoffMs &&
    clockMs < kickoffMs + 3 * 60 * 60 * 1_000;
  const refresh = liveRefresh ? "180" : "false";
  const snapshotIsCurrent =
    snapshot.fixtureId === fixtureId && snapshot.refresh === refresh;
  const widgetState =
    snapshotIsCurrent
      ? snapshot.state
      : fixtureId
        ? "checking"
        : "fallback";
  const fallbackReason =
    snapshotIsCurrent
      ? snapshot.reason
      : fixtureId
        ? "正在连接官方赛况…"
        : "比赛数据 ID 尚未开放";

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const host = hostRef.current;
    host?.replaceChildren();

    if (!fixtureId) {
      return () => {
        cancelled = true;
      };
    }

    void fetch(`/api/api-football/fixtures?id=${encodeURIComponent(fixtureId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as ApiEnvelope;
        const hasResult =
          typeof payload.results === "number"
            ? payload.results > 0
            : Array.isArray(payload.response) && payload.response.length > 0;
        if (!response.ok || hasApiErrors(payload.errors) || !hasResult) {
          const code = typeof payload.code === "string" ? payload.code : "";
          if (code === "NOT_CONFIGURED") throw new Error("本地数据密钥尚未配置");
          if (code === "PLAN_RESTRICTED") throw new Error("当前套餐暂未开放这场 2026 数据");
          if (code === "QUOTA_EXCEEDED") throw new Error("今日免费数据额度已用完");
          throw new Error(
            typeof payload.error === "string" ? payload.error : "数据赛况暂时不可用",
          );
        }
        await ensureWidgetConfig(refresh);
        if (cancelled || !hostRef.current) return;
        createGameWidget(hostRef.current, fixtureId, refresh);
        setSnapshot({ fixtureId, refresh, state: "ready", reason: "" });
      })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setSnapshot({
          fixtureId,
          refresh,
          state: "fallback",
          reason: reason instanceof Error ? reason.message : "数据赛况暂时不可用",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      host?.replaceChildren();
    };
  }, [fixtureId, refresh]);

  return (
    <div
      className="wb-provider-shell"
      data-widget-state={widgetState}
      role="region"
      aria-label="API-SPORTS 数据赛况"
    >
      <div className="wb-provider-bar">
        <span><i aria-hidden="true" />API-SPORTS 数据赛况</span>
        <small>{liveRefresh ? "直播每3分钟刷新" : "按需加载"} · 90′赛果独立校验</small>
      </div>
      {widgetState !== "ready" && (
        <div className="wb-provider-fallback">
          {fallback}
          <p role="status" aria-live="polite"><span aria-hidden="true">◇</span>{fallbackReason}，已使用本地比赛卡</p>
        </div>
      )}
      <div
        className="wb-provider-widget"
        ref={hostRef}
        hidden={widgetState !== "ready"}
        role="region"
        aria-label="API-SPORTS 比赛组件"
      />
    </div>
  );
}
