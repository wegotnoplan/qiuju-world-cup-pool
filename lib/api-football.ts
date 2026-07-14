import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiFootballCache } from "@/db/schema";
import type { ApiFootballFixturePayload } from "@/lib/app-data";
export {
  findApiFootballFixture,
  normalizeApiFootballFixture,
} from "@/lib/app-data";
export type { ApiFootballFixturePayload } from "@/lib/app-data";

const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_CACHE_TTL_SECONDS = 15 * 60;
const MIN_ERROR_RETRY_SECONDS = 60;

export type ApiFootballEndpoint = "fixtures" | "standings";

export interface ApiFootballEnvelope<T = unknown> {
  get?: unknown;
  parameters?: unknown;
  errors?: unknown;
  results?: unknown;
  paging?: unknown;
  response?: T;
}

export type ApiFootballErrorCode =
  | "NOT_CONFIGURED"
  | "PLAN_RESTRICTED"
  | "QUOTA_EXCEEDED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "UPSTREAM_ERROR";

export class ApiFootballRequestError extends Error {
  readonly code: ApiFootballErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number;

  constructor(
    code: ApiFootballErrorCode,
    message: string,
    status: number,
    retryAfterSeconds = MIN_ERROR_RETRY_SECONDS,
  ) {
    super(message);
    this.name = "ApiFootballRequestError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ApiFootballFetchResult<T = unknown> {
  envelope: ApiFootballEnvelope<T>;
  body: string;
  cacheState: "hit" | "miss" | "stale";
  quotaLimit: number | null;
  quotaRemaining: number | null;
  expiresAt: string;
}

interface FetchApiFootballOptions {
  endpoint: ApiFootballEndpoint;
  params: URLSearchParams | Record<string, string>;
  ttlSeconds?: number;
  allowStaleOnError?: boolean;
}

const inFlight = new Map<string, Promise<ApiFootballFetchResult>>();

function asPositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedParams(
  input: URLSearchParams | Record<string, string>,
): URLSearchParams {
  const pairs =
    input instanceof URLSearchParams
      ? [...input.entries()]
      : Object.entries(input);
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey
      ? leftValue.localeCompare(rightValue)
      : leftKey.localeCompare(rightKey),
  );
  const result = new URLSearchParams();
  for (const [key, value] of pairs) result.append(key, value);
  return result;
}

function cacheKey(endpoint: ApiFootballEndpoint, params: URLSearchParams): string {
  return `${endpoint}?${params.toString()}`;
}

function getApiFootballKey(): string | null {
  const key = process.env.API_FOOTBALL_KEY;
  return key?.trim() || null;
}

function errorMessages(errors: unknown): string[] {
  if (Array.isArray(errors)) {
    return errors.flatMap((value) =>
      typeof value === "string" ? [value] : errorMessages(value),
    );
  }
  if (errors && typeof errors === "object") {
    return Object.entries(errors).flatMap(([key, value]) => {
      if (typeof value === "string") return [`${key}: ${value}`];
      return errorMessages(value);
    });
  }
  return typeof errors === "string" && errors.trim() ? [errors.trim()] : [];
}

export function apiFootballEnvelopeError(
  envelope: ApiFootballEnvelope,
): ApiFootballRequestError | null {
  const messages = errorMessages(envelope.errors);
  if (messages.length === 0) return null;
  const combined = messages.join("; ");
  const lowered = combined.toLowerCase();
  if (
    lowered.includes("plan") ||
    lowered.includes("subscription") ||
    lowered.includes("access to this season")
  ) {
    return new ApiFootballRequestError(
      "PLAN_RESTRICTED",
      "当前 API-Football 套餐不开放 2026 世界杯数据；请升级套餐或改用人工赛果。",
      403,
      3_600,
    );
  }
  if (
    lowered.includes("limit") ||
    lowered.includes("quota") ||
    lowered.includes("too many")
  ) {
    return new ApiFootballRequestError(
      "QUOTA_EXCEEDED",
      "API-Football 免费调用额度已用完，请稍后或次日再试。",
      429,
      3_600,
    );
  }
  return new ApiFootballRequestError(
    "UPSTREAM_ERROR",
    `API-Football 拒绝了本次请求：${combined}`,
    502,
  );
}

function fixtureStatusesFromEnvelope(envelope: ApiFootballEnvelope): string[] {
  if (!Array.isArray(envelope.response)) return [];
  return envelope.response.flatMap((item) => {
    const short = (item as ApiFootballFixturePayload | undefined)?.fixture?.status?.short;
    return typeof short === "string" ? [short.toUpperCase()] : [];
  });
}

function effectiveTtlSeconds(
  endpoint: ApiFootballEndpoint,
  envelope: ApiFootballEnvelope,
  requestedTtl?: number,
): number {
  if (requestedTtl !== undefined) return Math.max(30, requestedTtl);
  if (endpoint === "standings") return 6 * 60 * 60;
  const statuses = fixtureStatusesFromEnvelope(envelope);
  const terminal = new Set(["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO"]);
  const live = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);
  if (
    statuses.some((status) => live.has(status))
  ) {
    // The UI refreshes every three minutes while a match is live. A slightly
    // shorter shared cache yields one upstream request per refresh wave, not
    // one request per viewer.
    return 175;
  }
  if (statuses.length > 0 && statuses.every((status) => terminal.has(status))) {
    return 24 * 60 * 60;
  }
  return Math.max(DEFAULT_CACHE_TTL_SECONDS, 30 * 60);
}

async function fetchFresh(
  endpoint: ApiFootballEndpoint,
  params: URLSearchParams,
  ttlSeconds?: number,
): Promise<ApiFootballFetchResult> {
  const key = getApiFootballKey();
  if (!key) {
    throw new ApiFootballRequestError(
      "NOT_CONFIGURED",
      "服务器尚未配置 API_FOOTBALL_KEY。",
      503,
      300,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${API_FOOTBALL_BASE_URL}/${endpoint}?${params}`, {
      headers: {
        Accept: "application/json",
        "x-apisports-key": key,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiFootballRequestError(
      "NETWORK_ERROR",
      "API-Football 暂时无法连接，请稍后重试。",
      503,
    );
  }

  const quotaLimit = asPositiveInteger(
    response.headers.get("x-ratelimit-requests-limit"),
  );
  const quotaRemaining = asPositiveInteger(
    response.headers.get("x-ratelimit-requests-remaining"),
  );
  const body = await response.text();
  let envelope: ApiFootballEnvelope;
  try {
    envelope = JSON.parse(body) as ApiFootballEnvelope;
  } catch {
    throw new ApiFootballRequestError(
      "INVALID_RESPONSE",
      "API-Football 返回了无法解析的数据。",
      502,
    );
  }

  if (!response.ok) {
    const parsedError = apiFootballEnvelopeError(envelope);
    if (parsedError) throw parsedError;
    throw new ApiFootballRequestError(
      response.status === 429 ? "QUOTA_EXCEEDED" : "UPSTREAM_ERROR",
      response.status === 429
        ? "API-Football 免费调用额度已用完，请稍后或次日再试。"
        : `API-Football 请求失败（HTTP ${response.status}）。`,
      response.status === 429 ? 429 : 502,
      response.status === 429 ? 3_600 : MIN_ERROR_RETRY_SECONDS,
    );
  }
  const parsedError = apiFootballEnvelopeError(envelope);
  if (parsedError) throw parsedError;

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + effectiveTtlSeconds(endpoint, envelope, ttlSeconds) * 1_000,
  ).toISOString();
  const db = getDb();
  const keyName = cacheKey(endpoint, params);
  await db
    .insert(apiFootballCache)
    .values({
      cacheKey: keyName,
      endpoint,
      responseBody: body,
      upstreamStatus: response.status,
      quotaLimit,
      quotaRemaining,
      expiresAt,
      updatedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: apiFootballCache.cacheKey,
      set: {
        responseBody: body,
        upstreamStatus: response.status,
        quotaLimit,
        quotaRemaining,
        expiresAt,
        updatedAt: now.toISOString(),
      },
    });

  return {
    envelope,
    body,
    cacheState: "miss",
    quotaLimit,
    quotaRemaining,
    expiresAt,
  };
}

export async function fetchApiFootball<T = unknown>({
  endpoint,
  params: inputParams,
  ttlSeconds,
  allowStaleOnError = false,
}: FetchApiFootballOptions): Promise<ApiFootballFetchResult<T>> {
  const params = normalizedParams(inputParams);
  const key = cacheKey(endpoint, params);
  const db = getDb();
  const [cached] = await db
    .select()
    .from(apiFootballCache)
    .where(eq(apiFootballCache.cacheKey, key))
    .limit(1);
  const nowMs = Date.now();
  if (cached && Date.parse(cached.expiresAt) > nowMs) {
    return {
      envelope: JSON.parse(cached.responseBody) as ApiFootballEnvelope<T>,
      body: cached.responseBody,
      cacheState: "hit",
      quotaLimit: cached.quotaLimit,
      quotaRemaining: cached.quotaRemaining,
      expiresAt: cached.expiresAt,
    };
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<ApiFootballFetchResult<T>>;

  const freshPromise = fetchFresh(endpoint, params, ttlSeconds)
    .catch((error) => {
      if (allowStaleOnError && cached) {
        return {
          envelope: JSON.parse(cached.responseBody) as ApiFootballEnvelope,
          body: cached.responseBody,
          cacheState: "stale" as const,
          quotaLimit: cached.quotaLimit,
          quotaRemaining: cached.quotaRemaining,
          expiresAt: cached.expiresAt,
        };
      }
      throw error;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, freshPromise);
  return freshPromise as Promise<ApiFootballFetchResult<T>>;
}
