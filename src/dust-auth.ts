import { DUST_EU_URL, DUST_HEADERS, DUST_US_URL, REGION_CLAIM, SESSION_EXPIRED_MESSAGE, WORKOS_CLIENT_ID, WORKOS_DOMAIN } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type { DustAgent, DustCredentials, LoginCallbacks, Workspace } from "./dust-types.js";
import { errorMessage, parseAgentConfigurationsResponse, parseDeviceCodeResponse, parseMeResponse, parseTokenResponse } from "./dust-validation.js";

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

export function workspaceLabel(ws: Workspace): string {
  return `${ws.name} (${ws.role})`;
}

export function dustApiUrl(region: string): string {
  return region === "europe-west1" ? DUST_EU_URL : DUST_US_URL;
}

/**
 * Base for Dust's *private* API (`/api/w/:wId/…`), as opposed to the versioned
 * `/api/v1` surface the conversation endpoints use.
 *
 * These routes sit behind `sessionAuth`, which accepts a bearer token as well
 * as a cookie, so the WorkOS access token we already hold reaches them — no
 * extra scope and no API key. Credits and Pod files both live here.
 */
export function privateApiBaseUrl(region: string, workspaceId: string): string {
  return `${dustApiUrl(region)}/api/w/${workspaceId}`;
}

export function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function loginFn(callbacks: LoginCallbacks): Promise<DustCredentials> {
  const { onAuth, onProgress, onPrompt, signal } = callbacks;
  debugLog("dust:auth", "Starting device login");

  const deviceRes = await fetch(`https://${WORKOS_DOMAIN}/user_management/authorize/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: WORKOS_CLIENT_ID,
      scope: "openid profile email",
    }),
    signal,
  });

  if (!deviceRes.ok) {
    debugLog("dust:auth", "Device code request failed", { status: deviceRes.status });
    throw new Error(`Device code request failed: ${deviceRes.status}`);
  }

  const device = parseDeviceCodeResponse(await deviceRes.json());
  debugLog("dust:auth", "Received device code response", device);

  onAuth({
    url: device.verification_uri_complete,
    instructions: `Enter code ${device.user_code} at ${device.verification_uri}`,
  });

  const interval = Math.max(1, device.interval);
  const maxAttempts = Math.floor(device.expires_in / interval);
  let attempts = 0;
  let tokenData = null;

  while (attempts < maxAttempts) {
    if (signal?.aborted) throw new Error("Authentication aborted");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval * 1000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Authentication aborted"));
      });
    });

    const pollRes = await fetch(`https://${WORKOS_DOMAIN}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: WORKOS_CLIENT_ID,
      }),
      signal,
    });

    const pollData = await pollRes.json();
    debugLog("dust:auth", "Received device auth poll response", pollData);
    if (typeof pollData === "object" && pollData !== null && "error" in pollData && typeof pollData.error === "string") {
      if (pollData.error === "authorization_pending") {
        onProgress?.("Waiting for browser authorization…");
        attempts++;
      } else if (pollData.error === "slow_down") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        attempts++;
      } else {
        const description = typeof pollData.error_description === "string" ? pollData.error_description : pollData.error;
        throw new Error(`Authentication error: ${description}`);
      }
    } else {
      tokenData = parseTokenResponse(pollData, "device authentication response");
      break;
    }
  }

  if (!tokenData) {
    throw new Error("Authentication timed out");
  }

  let region = "us-central1";
  try {
    const payload = decodeJwtPayload(tokenData.access_token);
    const claim = payload[REGION_CLAIM];
    if (typeof claim === "string") region = claim;
  } catch {
    // fall back to default region
  }

  const apiUrl = dustApiUrl(region);
  const meRes = await fetch(`${apiUrl}/api/v1/me`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
    },
    signal,
  });

  if (!meRes.ok) {
    debugLog("dust:auth", "Failed fetching workspaces", { status: meRes.status, apiUrl });
    throw new Error(`Failed to fetch workspaces: ${meRes.status}`);
  }

  const meData = parseMeResponse(await meRes.json());
  debugLog("dust:auth", "Fetched workspace profile", meData);
  const workspaces = meData.user.workspaces;
  const username = meData.user.username ?? "";

  const list = workspaces.map((ws, index) => `  ${index + 1}. ${ws.name} (${ws.role})`).join("\n");
  onProgress?.(`Your workspaces:\n${list}`);

  const selection = await onPrompt({
    message: "Select workspace number:",
    placeholder: "1",
  });

  const idx = parseInt(selection, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= workspaces.length) {
    throw new Error("Invalid workspace selection");
  }

  const workspaceId = workspaces[idx].sId;
  const agentsRes = await fetch(`${apiUrl}/api/v1/w/${workspaceId}/assistant/agent_configurations`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      ...DUST_HEADERS,
    },
    signal,
  });

  const agentsData = agentsRes.ok
    ? parseAgentConfigurationsResponse(await agentsRes.json())
    : { agentConfigurations: [] as DustAgent[] };
  debugLog("dust:auth", "Fetched workspace agents", {
    workspaceId,
    status: agentsRes.status,
    count: agentsData.agentConfigurations.length,
  });

  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 30_000,
    workspaceId,
    workspaces,
    agents: agentsData.agentConfigurations,
    region,
    username,
  };
}

export async function refreshToken(credentials: DustCredentials): Promise<DustCredentials> {
  debugLog("dust:auth", "Refreshing token");
  const res = await fetch(`https://${WORKOS_DOMAIN}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: WORKOS_CLIENT_ID,
      refresh_token: credentials.refresh ?? "",
    }),
  });

  if (!res.ok) {
    debugLog("dust:auth", "Token refresh failed", { status: res.status });

    // 401, and 400 which is what WorkOS actually returns for an expired or
    // revoked refresh token (OAuth `invalid_grant`). Treating 400 as a generic
    // failure leaves the dead session unmarked, so every session_start retries
    // the same doomed refresh and re-reports the error.
    if (res.status === 401 || res.status === 400) {
      if (res.status === 400) {
        const body = await Promise.resolve(res.text?.()).catch(() => "");
        debugLog("dust:auth", "Token refresh rejected", { body });
      }
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = parseTokenResponse(await res.json(), "refresh token response");
  debugLog("dust:auth", "Token refresh succeeded", data);
  return {
    ...credentials,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 30_000,
  };
}

export async function fetchAgents(
  accessToken: string,
  apiUrl: string,
  workspaceId: string,
): Promise<{ agents: DustAgent[] | null; unauthorized: boolean }> {
  try {
    debugLog("dust:auth", "Fetching agents", { apiUrl, workspaceId });
    const res = await fetch(`${apiUrl}/api/v1/w/${workspaceId}/assistant/agent_configurations`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...DUST_HEADERS,
      },
    });
    if (!res.ok) {
      console.error(`[dust] fetchAgents failed: HTTP ${res.status}`, { workspaceId, apiUrl });
      debugLog("dust:auth", "Agent fetch failed", { status: res.status, workspaceId, apiUrl });
      return { agents: null, unauthorized: res.status === 401 };
    }
    const data = parseAgentConfigurationsResponse(await res.json());
    debugLog("dust:auth", "Agent fetch succeeded", { workspaceId, count: data.agentConfigurations.length });
    return { agents: data.agentConfigurations, unauthorized: false };
  } catch (err) {
    console.error(`[dust] fetchAgents error: ${errorMessage(err)}`, err);
    debugLog("dust:auth", "Agent fetch threw", { workspaceId, apiUrl, error: errorMessage(err) });
    return { agents: null, unauthorized: false };
  }
}
