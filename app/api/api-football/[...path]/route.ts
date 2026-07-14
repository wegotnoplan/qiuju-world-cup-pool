import { getDb } from "@/db";
import { fixtures } from "@/db/schema";
import {
  ApiFootballRequestError,
  fetchApiFootball,
  type ApiFootballEndpoint,
} from "@/lib/api-football";
import { FIXTURES } from "@/lib/app-data";

export const dynamic = "force-dynamic";

const ROUTE_PREFIX = "/api/api-football/";
const WORLD_CUP_LEAGUE_ID = "1";
const WORLD_CUP_SEASON = "2026";
const LEAGUE_FIXTURE_QUERY_KEYS = new Set(["league", "season", "timezone"]);
const STANDINGS_QUERY_KEYS = new Set(["league", "season"]);

class ProxyRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function endpointFromUrl(url: URL): ApiFootballEndpoint {
  const endpoint = url.pathname
    .slice(ROUTE_PREFIX.length)
    .replace(/^\/+|\/+$/g, "");
  if (endpoint === "fixtures" || endpoint === "standings") return endpoint;
  throw new ProxyRequestError("仅允许访问 fixtures 和 standings。", 404);
}

function rejectUnknownKeys(params: URLSearchParams, allowed: Set<string>) {
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new ProxyRequestError(`不允许的 API-Football 参数：${key}`);
    }
  }
}

function rejectDuplicateKeys(params: URLSearchParams) {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) {
      throw new ProxyRequestError(`参数不能重复：${key}`);
    }
    seen.add(key);
  }
}

async function boundProviderIds(): Promise<Set<string>> {
  const seeded = FIXTURES.flatMap((fixture) =>
    fixture.providerMatchId ? [fixture.providerMatchId] : [],
  );
  const rows = await getDb().select({ providerMatchId: fixtures.providerMatchId }).from(fixtures);
  for (const row of rows) {
    if (row.providerMatchId) seeded.push(row.providerMatchId);
  }
  return new Set(seeded);
}

async function sanitizedParams(
  endpoint: ApiFootballEndpoint,
  source: URLSearchParams,
): Promise<URLSearchParams> {
  rejectDuplicateKeys(source);
  const params = new URLSearchParams(source);
  if (endpoint === "standings") {
    rejectUnknownKeys(params, STANDINGS_QUERY_KEYS);
    params.set("league", WORLD_CUP_LEAGUE_ID);
    params.set("season", WORLD_CUP_SEASON);
    return params;
  }

  const id = params.get("id");
  if (id) {
    rejectUnknownKeys(params, new Set(["id"]));
    if (!/^\d{1,12}$/.test(id)) {
      throw new ProxyRequestError("比赛 ID 格式无效。", 400);
    }
    const allowed = await boundProviderIds();
    if (!allowed.has(id)) {
      throw new ProxyRequestError("只能查询已经绑定到本奖池的比赛 ID。", 403);
    }
    return new URLSearchParams({ id });
  }

  // The league widget has one canonical request shape. Date discovery is
  // server-only, so a browser cannot manufacture cache keys to drain quota.
  rejectUnknownKeys(params, LEAGUE_FIXTURE_QUERY_KEYS);
  const timezone = params.get("timezone");
  if (timezone && timezone !== "Asia/Shanghai") {
    throw new ProxyRequestError("timezone 仅允许 Asia/Shanghai。", 400);
  }
  params.set("league", WORLD_CUP_LEAGUE_ID);
  params.set("season", WORLD_CUP_SEASON);
  params.set("timezone", "Asia/Shanghai");
  return params;
}

function publicError(error: unknown): Response {
  if (error instanceof ProxyRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ApiFootballRequestError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      {
        status: error.status,
        headers: { "Retry-After": String(error.retryAfterSeconds) },
      },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  const missingTable = message.includes("no such table");
  return Response.json(
    {
      error: missingTable
        ? "API-Football 缓存表尚未初始化，请先应用最新 D1 migration。"
        : "API-Football 代理暂时不可用。",
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const endpoint = endpointFromUrl(url);
    const params = await sanitizedParams(endpoint, url.searchParams);
    const result = await fetchApiFootball({
      endpoint,
      params,
      allowStaleOnError: true,
    });
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      "X-API-Football-Cache": result.cacheState,
    });
    if (result.quotaLimit !== null) {
      headers.set("X-API-Football-Quota-Limit", String(result.quotaLimit));
    }
    if (result.quotaRemaining !== null) {
      headers.set(
        "X-API-Football-Quota-Remaining",
        String(result.quotaRemaining),
      );
    }
    return new Response(result.body, { status: 200, headers });
  } catch (error) {
    return publicError(error);
  }
}
