import { DUST_HEADERS, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { HOST_TOKEN_ASSUMED_TTL_MS, type DustSessionRuntime } from "./dust-runtime.js";
import type {
  CreditGroupBy,
  CreditTotals,
  FairUseCredits,
  MemberUsage,
  TopConversations,
  UsageAnalytics,
} from "./dust-types.js";
import {
  errorMessage,
  parseCreditSeriesResponse,
  parseFairUseCreditsResponse,
  parseMyTopConversationsResponse,
  parseMyUsageAnalyticsResponse,
  parseMyUsageResponse,
} from "./dust-validation.js";

/**
 * The credit endpoints live under the *private* API (`/api/w/:wId/…`), not the
 * versioned `/api/v1` surface. They are mounted behind `sessionAuth`, which
 * accepts either a cookie or a bearer token, so the WorkOS access token we
 * already hold is enough — no extra scope, no API key.
 */
export function creditsBaseUrl(region: string, workspaceId: string): string {
  return `${dustApiUrl(region)}/api/w/${workspaceId}`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...DUST_HEADERS,
  };
}

/**
 * GETs a credit endpoint, refreshing once on 401.
 *
 * Dust access tokens live about 15 minutes, which is shorter than a session, so
 * `/status` can easily be run with a stale one. Refresh goes through pi first
 * (`resolveAccessToken`) because pi persists the rotated refresh token; a direct
 * refresh is only the fallback for hosts without that API.
 *
 * Reads through `runtime.currentAccessToken()` rather than storage directly:
 * several of these run concurrently (`Promise.all` in `collectStatusData`), and
 * a direct refresh from any one of them — or from the MCP listener/heartbeat, or
 * the event stream, all sharing the same runtime — lives only in
 * `runtime.refreshedAccessToken` until it naturally expires (see its doc on
 * `DustSessionRuntime`); storage alone would miss it and 401 needlessly.
 */
export async function fetchCreditsJson(
  runtime: DustSessionRuntime,
  url: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const request = (token: string) => fetch(url, { headers: authHeaders(token), signal });

  let token = runtime.currentAccessToken();
  if (!token) {
    debugLog("dust:credits", "No access token available", { url });
    return null;
  }

  let res = await request(token);

  if (res.status === 401) {
    debugLog("dust:credits", "Credit request unauthorized, refreshing", { url });
    const refreshed = await refreshAccessToken(runtime);
    if (!refreshed) {
      debugLog("dust:credits", "Credit request refresh failed", { url });
      return null;
    }
    token = refreshed;
    res = await request(token);
  }

  if (!res.ok) {
    debugLog("dust:credits", "Credit request failed", { url, status: res.status });
    return null;
  }

  try {
    return await res.json();
  } catch (err) {
    debugLog("dust:credits", "Credit response was not JSON", { url, error: errorMessage(err) });
    return null;
  }
}

/**
 * Single-flighted on `runtime.refreshInFlight` — the same field the event
 * stream, the MCP listener and the MCP heartbeat share (dust-stream-provider.ts)
 * — so a 401 here concurrent with one of theirs (or with another of the
 * `Promise.all`'d credit fetches above) awaits the one attempt already under
 * way instead of racing it with a second direct refresh against the same
 * rotating refresh token.
 */
async function refreshAccessToken(runtime: DustSessionRuntime): Promise<string | null> {
  runtime.refreshInFlight ??= (async (): Promise<boolean> => {
    const hostToken = await runtime.sessionContext.resolveAccessToken();
    if (hostToken) {
      runtime.setRefreshedAccessToken(hostToken, Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
      return true;
    }

    const credentials = runtime.sessionContext.getCredentials();
    if (!credentials) return false;

    try {
      const refreshed = await refreshToken(credentials);
      runtime.sessionContext.setCredentials(refreshed);
      if (refreshed.access) {
        runtime.setRefreshedAccessToken(refreshed.access, refreshed.expires || Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
      }
      return Boolean(refreshed.access);
    } catch (err) {
      // An expired refresh token is reported by the stream path already; here it
      // just means the panel renders without credit figures.
      debugLog("dust:credits", "Direct refresh failed", {
        expired: errorMessage(err) === SESSION_EXPIRED_MESSAGE,
        error: errorMessage(err),
      });
      return false;
    }
  })().finally(() => {
    runtime.refreshInFlight = null;
  });

  const refreshed = await runtime.refreshInFlight;
  return refreshed ? runtime.currentAccessToken() || null : null;
}

/** Live seat/spend figures. Cheap enough to refetch whenever the session moved. */
export async function fetchMemberUsage(
  runtime: DustSessionRuntime,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<MemberUsage | null> {
  const json = await fetchCreditsJson(runtime, `${baseUrl}/credits/my-usage`, signal);
  return json === null ? null : parseMyUsageResponse(json);
}

/** Fair-use allowance, the only credit ceiling free plans expose. */
export async function fetchFairUseCredits(
  runtime: DustSessionRuntime,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<FairUseCredits | null> {
  const json = await fetchCreditsJson(runtime, `${baseUrl}/fair-use-credits`, signal);
  return json === null ? null : parseFairUseCreditsResponse(json);
}

/**
 * Window sizes for the three period gauges.
 *
 * Dust buckets on a `calendar_interval` over a trailing `[now - (days-1), now]`
 * window, so the *first* bucket of a series is usually truncated but the last
 * one is the complete current period — provided the window reaches back past
 * its start. These sizes guarantee exactly that: 32 days always spans the 1st
 * of the current month, 8 days always spans the current week's Monday, and 7
 * days gives today plus six days of history.
 */
const PERIOD_WINDOWS = {
  month: 32,
  week: 8,
  day: 7,
} as const satisfies Record<keyof CreditTotals, number>;

/**
 * Total credit consumption per calendar period.
 *
 * Requested without `groupBy`, so Dust answers with a single `total` series
 * rather than a breakdown. These are Elasticsearch-backed and land
 * asynchronously, so they can trail the last turn by a short delay.
 */
export async function fetchCreditTotals(
  runtime: DustSessionRuntime,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<CreditTotals> {
  const series = await Promise.all(
    (Object.keys(PERIOD_WINDOWS) as (keyof CreditTotals)[]).map(async (granularity) => {
      const url = `${baseUrl}/credits/my-usage-analytics?days=${PERIOD_WINDOWS[granularity]}&granularity=${granularity}`;
      const json = await fetchCreditsJson(runtime, url, signal);
      return [granularity, json === null ? null : parseCreditSeriesResponse(json)] as const;
    }),
  );

  return Object.fromEntries(series) as unknown as CreditTotals;
}

/**
 * Credit breakdown along one dimension, scoped to the current user.
 *
 * `groupBy` is one of Dust's analytics dimensions — usage type, agent, source,
 * or API key. There is deliberately no "by model": Dust meters credits (AWU),
 * not tokens, and the credit index carries no model field.
 */
export async function fetchUsageBreakdown(
  runtime: DustSessionRuntime,
  baseUrl: string,
  groupBy: CreditGroupBy,
  days: number,
  signal?: AbortSignal,
): Promise<UsageAnalytics | null> {
  const url = `${baseUrl}/credits/my-usage-analytics`
    + `?days=${days}&granularity=day&groupBy=${groupBy}&groupByCount=${BREAKDOWN_GROUP_COUNT}`;
  const json = await fetchCreditsJson(runtime, url, signal);
  return json === null ? null : parseMyUsageAnalyticsResponse(json);
}

/** Dust defaults to 5; the panel has room for more. */
const BREAKDOWN_GROUP_COUNT = 10;

/** Top conversations by credits over the last 30 days. */
export async function fetchTopConversations(
  runtime: DustSessionRuntime,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<TopConversations | null> {
  const json = await fetchCreditsJson(runtime, `${baseUrl}/credits/my-top-conversations`, signal);
  return json === null ? null : parseMyTopConversationsResponse(json);
}
