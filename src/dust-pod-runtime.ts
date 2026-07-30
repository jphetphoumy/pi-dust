import { privateApiBaseUrl } from "./dust-auth.js";
import { DUST_HEADERS } from "./dust-constants.js";
import type { PodApi } from "./dust-pod.js";
import type { DustSessionRuntime } from "./dust-runtime.js";

/**
 * Builds a `PodApi` bound to the session's live credentials.
 *
 * Auth is read through `runtime.currentAccessToken()` on every request rather
 * than captured once: an ingest of a few hundred files easily outlives a
 * 15-minute access token. Refresh goes through the runtime's shared
 * single-flight for the same reason the credit client does — the event stream,
 * the MCP listener and the heartbeat all rotate the same refresh token.
 */
export function podApiFor(runtime: DustSessionRuntime): PodApi {
  const cred = runtime.sessionContext.getCredentials();
  const workspaceId = cred?.workspaceId;
  if (!workspaceId) {
    throw new Error("Not logged in to Dust. Run /login first.");
  }

  return {
    baseUrl: privateApiBaseUrl(cred?.region ?? "us-central1", workspaceId),
    getAuthHeaders: () => {
      const token = runtime.currentAccessToken();
      return token ? { Authorization: `Bearer ${token}`, ...DUST_HEADERS } : { ...DUST_HEADERS };
    },
    refreshAuth: () => runtime.refreshAccessToken(),
  };
}
