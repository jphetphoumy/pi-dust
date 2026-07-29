import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, fetchAgents, refreshToken } from "./dust-auth.js";
import { describeConversation, resolveAttachment, verifyConversation } from "./dust-conversation.js";
import type { ConversationAttachment } from "./dust-conversation.js";
import { debugLog } from "./dust-debug.js";
import { refreshApprovalStatus } from "./dust-approval.js";
import { applyRuntimeContext, HOST_TOKEN_ASSUMED_TTL_MS, invalidateCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import {
  clearInvalidated,
  forgetConversationId,
  getStoredCredentials,
  markInvalidated,
  persistCredentialState,
  saveConversationId,
} from "./dust-state.js";
import { errorMessage } from "./dust-validation.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import type {
  DustCredentials,
  DustSessionStartEvent,
  ExtensionAPIWithEvents,
  PiRuntimeContext,
} from "./dust-types.js";

const SESSION_START_REFRESH_SKEW_MS = 0;

/**
 * pi awaits this handler while starting a session, and `fetch` has no response
 * timeout of its own, so an unreachable Dust would otherwise hang startup for
 * as long as the socket stays open. Failing the check is cheap: an unverified
 * conversation is still used.
 */
const VERIFY_TIMEOUT_MS = 5_000;

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
 *
 * Either success path also publishes into `runtime.refreshedAccessToken` —
 * the in-memory holder every `getAuthHeaders()` in dust-stream-provider.ts
 * prefers over storage. Without that, this refresh and the holder could
 * diverge: storage picks up the fresh token immediately, but the holder (if
 * still live from an earlier direct refresh elsewhere in the same session)
 * would keep outranking it with something older until it happened to expire.
 */
async function refreshExpiredToken(
  ctx: PiRuntimeContext,
  runtime: DustSessionRuntime,
  cred: DustCredentials,
): Promise<DustCredentials> {
  const getProviderAuth = ctx.modelRegistry?.getProviderAuth;

  if (typeof getProviderAuth === "function") {
    try {
      const resolved = await getProviderAuth.call(ctx.modelRegistry, "dust");
      const apiKey = resolved?.auth?.apiKey;
      if (apiKey) {
        debugLog("dust:session", "Refreshed token via pi provider auth");
        runtime.setRefreshedAccessToken(apiKey, Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
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
      runtime.clearRefreshedAccessToken();
      return invalidateCredentials(cred);
    }
  }

  try {
    const refreshed = await refreshToken(cred);
    persistCredentialState(refreshed);
    debugLog("dust:session", "Refreshed token during session_start");
    if (refreshed.access) {
      runtime.setRefreshedAccessToken(refreshed.access, refreshed.expires || Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
    }
    return refreshed;
  } catch (err) {
    debugLog("dust:session", "Token refresh failed during session_start", { error: errorMessage(err) });
    if (isSessionExpiredError(err)) {
      markInvalidated();
      notifyReloginRequired(ctx);
      runtime.clearRefreshedAccessToken();
      return invalidateCredentials(cred);
    }
    console.error(`[dust] token refresh failed at session_start: ${errorMessage(err)}`);
    return cred;
  }
}

/**
 * Points the runtime at the conversation this session continues, or at nothing
 * so the next message opens a fresh one.
 *
 * The pi transcript and the Dust conversation are two halves of the same
 * session: pi restores its half itself, and this restores ours. Getting it
 * wrong is silent — the transcript still shows the full history while the agent
 * starts from nothing — so every outcome is reported to the user, once the
 * conversation has been confirmed by `confirmAttachment`.
 *
 * Nothing here may await. pi accepts input before extensions finish starting,
 * so a turn can begin while this handler is still running, and until this has
 * assigned it the runtime's conversation is null. A message that arrives first
 * would take the "no conversation yet" path, open a second Dust conversation
 * and store it — after which this would point the session at the conversation
 * it was supposed to continue, one its first message never reached.
 */
function attachConversation(
  runtime: DustSessionRuntime,
  ctx: PiRuntimeContext,
  event: DustSessionStartEvent,
): ConversationAttachment & { sessionFile: string | undefined } {
  const reason = event.reason ?? "startup";
  const sessionFile = ctx.sessionManager?.getSessionFile?.();

  // This session_start replaces whatever session was live before it. An MCP
  // server registered for that one must not be reused, and its pending
  // approvals belong to a conversation we are leaving.
  runtime.clearMcpState();

  const attachment = resolveAttachment({
    reason,
    sessionFile,
    previousSessionFile: event.previousSessionFile,
    parentSessionFile: ctx.sessionManager?.getHeader?.()?.parentSession,
  });

  runtime.conversationId = attachment.conversationId;
  if (!attachment.conversationId) {
    debugLog("dust:session", "Starting without a Dust conversation", { reason, sessionFile });
  }
  return { ...attachment, sessionFile };
}

/**
 * Confirms the attached conversation with Dust and reports the outcome.
 *
 * This is the half that can block, so it cannot assume the runtime still holds
 * what `attachConversation` gave it: a turn that started meanwhile may have hit
 * a 401 and had its credentials invalidated, which detaches the session. The
 * writes below are keyed on values captured before the await, and skipped
 * entirely if the runtime has moved on.
 */
async function confirmAttachment(
  runtime: DustSessionRuntime,
  ctx: PiRuntimeContext,
  cred: DustCredentials,
  attached: ConversationAttachment & { sessionFile: string | undefined },
): Promise<void> {
  const { conversationId, inheritedFrom, sessionFile } = attached;
  if (!conversationId) return;

  const check = cred.access
    ? await verifyConversation(cred, conversationId, AbortSignal.timeout(VERIFY_TIMEOUT_MS))
    : ({ status: "unknown" } as const);

  // A turn that ran during the check and hit a 401 has already detached the
  // session (`invalidateRuntimeCredentials`). It knows more than this answer
  // does, so leave both the runtime and the stored mapping alone.
  if (runtime.conversationId !== conversationId) {
    debugLog("dust:session", "Discarding a check for a session that moved on", { conversationId });
    return;
  }

  if (check.status === "gone") {
    runtime.conversationId = null;
    // Forget the mapping too, or every later start repeats the request and the
    // warning until a message happens to overwrite it. An inherited id is
    // recorded against the ancestor, which is where it has to be dropped —
    // otherwise the fork simply inherits the dead conversation again.
    const staleUnder = inheritedFrom ?? sessionFile;
    if (staleUnder) {
      forgetConversationId(staleUnder);
    }
    ctx.ui?.notify?.(
      `Dust conversation ${conversationId} is no longer available. The next message starts a new one.`,
      "warning",
    );
    return;
  }

  // A fork inherits its parent's conversation, so the mapping still has to be
  // written under the new session file — otherwise the next restart of that
  // fork, which has no `previousSessionFile` to fall back on, loses the thread.
  // Written against the file this call captured, not whatever the runtime's
  // session context points at now.
  if (inheritedFrom && sessionFile) {
    saveConversationId(sessionFile, conversationId);
  }

  const label = describeConversation(conversationId, check.status === "ok" ? check.title : undefined);
  debugLog("dust:session", "Attached to Dust conversation", {
    sessionFile,
    conversationId,
    inheritedFrom,
    verified: check.status === "ok",
  });
  // A session with no token has just been told to log in again. Announcing a
  // conversation it cannot reach on top of that only muddies the message.
  if (!cred.access) return;

  ctx.ui?.notify?.(
    inheritedFrom
      // Forking at an entry shortens pi's transcript; Dust's copy keeps every
      // message, so the agent still remembers what was forked away. Say so
      // rather than let it surprise someone mid-turn.
      ? `Fork continues Dust conversation ${label} — the agent still remembers messages you forked away.`
      : `Resumed Dust conversation ${label}.`,
    "info",
  );
}

export function registerDustSessionEvents(
  piWithEvents: ExtensionAPIWithEvents,
  runtime: DustSessionRuntime,
  registerProviderForCredentials: (cred: DustCredentials) => void,
): void {
  const registerEvent = piWithEvents.on as (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;

  // pi 0.65 folded the old post-transition `session_switch` into this event:
  // startup, /new, /resume and /fork all arrive here, told apart by `reason`.
  registerEvent("session_start", async (_event: unknown, ctx: PiRuntimeContext) => {
    const event = (_event ?? {}) as DustSessionStartEvent;
    const storedCred = getStoredCredentials();
    if (!storedCred) return;
    let cred = normalizeStoredCredentials(storedCred);

    debugLog("dust:session", "Handling session_start", {
      reason: event.reason ?? "startup",
      previousSessionFile: event.previousSessionFile,
      hasAccess: Boolean(cred.access),
      workspaceId: cred.workspaceId,
    });

    // Attach before the first await. Refreshing a token is a network
    // round-trip, and a turn that starts during it while the session is still
    // unattached opens a Dust conversation of its own — leaving the session
    // pointed at a thread its first message never reached.
    applyRuntimeContext(runtime, ctx);
    refreshApprovalStatus(runtime, ctx);
    const attached = attachConversation(runtime, ctx, event);

    if (cred.access && shouldRefreshAccessToken(cred.expires, SESSION_START_REFRESH_SKEW_MS)) {
      cred = normalizeStoredCredentials(await refreshExpiredToken(ctx, runtime, cred));
    }

    await confirmAttachment(runtime, ctx, cred, attached);

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
      runtime.clearRefreshedAccessToken();
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
