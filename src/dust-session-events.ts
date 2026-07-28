import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, fetchAgents, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { applyRuntimeContext, invalidateCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import {
  clearInvalidated,
  getStoredCredentials,
  markInvalidated,
  persistCredentialState,
} from "./dust-state.js";
import { errorMessage } from "./dust-validation.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import type { DustCredentials, ExtensionAPIWithEvents, PiRuntimeContext } from "./dust-types.js";

const SESSION_START_REFRESH_SKEW_MS = 0;

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

function normalizeStoredCredentials(credentials: DustCredentials): DustCredentials {
  return credentials.type === "oauth"
    ? credentials
    : { ...credentials, type: "oauth" };
}

/**
 * Tells the user the stored Dust session is dead, once, in the UI rather than as
 * a stack trace. Falls back to a one-line console message in headless runs.
 */
function notifyReloginRequired(ctx: PiRuntimeContext): void {
  if (ctx.ui?.notify) {
    ctx.ui.notify(SESSION_EXPIRED_MESSAGE, "warning");
    return;
  }
  console.error(`[dust] ${SESSION_EXPIRED_MESSAGE}`);
}

/**
 * Refreshes an expired access token.
 *
 * Preferred path is `modelRegistry.getProviderAuth("dust")`: pi resolves the
 * provider's auth, which for an OAuth provider runs the `oauth.refreshToken`
 * hook registered in `dust-provider.ts` and — crucially — persists the rotated
 * token back to auth.json. We cannot write auth.json ourselves since pi 0.81,
 * so calling `refreshToken()` directly would rotate the refresh token and then
 * throw the new one away, bricking the session on next start.
 *
 * Older pi builds have no `getProviderAuth`; there we fall back to a direct
 * refresh, which still yields a usable in-memory token for this session.
 */
async function refreshExpiredToken(
  ctx: PiRuntimeContext,
  cred: DustCredentials,
): Promise<DustCredentials> {
  const getProviderAuth = ctx.modelRegistry?.getProviderAuth;

  if (typeof getProviderAuth === "function") {
    try {
      const resolved = await getProviderAuth.call(ctx.modelRegistry, "dust");
      const apiKey = resolved?.auth?.apiKey;
      if (apiKey) {
        debugLog("dust:session", "Refreshed token via pi provider auth");
        // pi persisted the rotation; re-read so we pick up the new expiry.
        return { ...(getStoredCredentials() ?? cred), access: apiKey };
      }
      debugLog("dust:session", "Provider auth returned no api key");
    } catch (err) {
      // pi already surfaced its own ModelsError for this; a second copy with a
      // stack trace just floods the TUI. Details go to the debug log.
      debugLog("dust:session", "Provider auth refresh failed", { error: errorMessage(err) });
      notifyReloginRequired(ctx);
      markInvalidated();
      return invalidateCredentials(cred);
    }
  }

  try {
    const refreshed = await refreshToken(cred);
    persistCredentialState(refreshed);
    debugLog("dust:session", "Refreshed token during session_start");
    return refreshed;
  } catch (err) {
    debugLog("dust:session", "Token refresh failed during session_start", { error: errorMessage(err) });
    if (isSessionExpiredError(err)) {
      markInvalidated();
      notifyReloginRequired(ctx);
      return invalidateCredentials(cred);
    }
    console.error(`[dust] token refresh failed at session_start: ${errorMessage(err)}`);
    return cred;
  }
}

export function registerDustSessionEvents(
  piWithEvents: ExtensionAPIWithEvents,
  runtime: DustSessionRuntime,
  registerProviderForCredentials: (cred: DustCredentials) => void,
): void {
  const registerEvent = piWithEvents.on as (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;

  registerEvent("session_switch", (_event: unknown, ctx: PiRuntimeContext) => {
    const event = _event as { reason?: string };
    debugLog("dust:session", "Handling session_switch", event);
    applyRuntimeContext(runtime, ctx);

    if (event.reason === "resume") {
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const cred = getStoredCredentials();
      runtime.conversationId = (sessionFile && cred?.conversations?.[sessionFile]) ?? null;
      runtime.clearMcpState();
      debugLog("dust:session", "Resumed session", { currentConversationId: runtime.conversationId });
      return;
    }

    runtime.resetSessionState();
    debugLog("dust:session", "Reset session state");
  });

  registerEvent("session_start", async (_event: unknown, ctx: PiRuntimeContext) => {
    const storedCred = getStoredCredentials();
    if (!storedCred) return;
    let cred = normalizeStoredCredentials(storedCred);

    debugLog("dust:session", "Handling session_start", {
      hasAccess: Boolean(cred.access),
      workspaceId: cred.workspaceId,
    });

    if (cred.access && shouldRefreshAccessToken(cred.expires, SESSION_START_REFRESH_SKEW_MS)) {
      cred = normalizeStoredCredentials(await refreshExpiredToken(ctx, cred));
    }

    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    applyRuntimeContext(runtime, ctx);

    const existingEntries = ctx.sessionManager?.getEntries?.() ?? [];
    runtime.conversationId = existingEntries.length > 0 && sessionFile
      ? cred.conversations?.[sessionFile] ?? null
      : null;
    debugLog("dust:session", "Resolved persisted conversation", {
      currentConversationId: runtime.conversationId,
      entryCount: existingEntries.length,
    });

    if (!cred.access) {
      registerProviderForCredentials(cred);
      return;
    }

    const apiUrl = dustApiUrl(cred.region ?? "us-central1");
    const agentFetch = await fetchAgents(cred.access, apiUrl, cred.workspaceId ?? "");
    debugLog("dust:session", "Completed agent refresh on session_start", {
      unauthorized: agentFetch.unauthorized,
      count: agentFetch.agents?.length ?? null,
    });

    if (agentFetch.unauthorized) {
      const invalidatedCred = invalidateCredentials(cred);
      markInvalidated();
      registerProviderForCredentials(invalidatedCred);
      return;
    }

    if (agentFetch.agents !== null) {
      const updatedCred = normalizeStoredCredentials({ ...cred, agents: agentFetch.agents });
      // Dust answered, so whatever marked this session dead no longer holds.
      clearInvalidated();
      persistCredentialState(updatedCred);
      registerProviderForCredentials(updatedCred);
      return;
    }

    registerProviderForCredentials(cred);
  });
}
