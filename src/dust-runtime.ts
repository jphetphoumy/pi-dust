import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import {
  getStoredCredentials,
  markInvalidated,
  persistCredentialState,
  saveConversationId as persistConversationId,
} from "./dust-state.js";
import type { DustCredentials, PiRuntimeContext } from "./dust-types.js";

export interface SessionContextController {
  getSessionFile: () => string | undefined;
  saveConversationId: (id: string) => void;
  getCredentials: () => DustCredentials | null;
  setCredentials: (cred: DustCredentials) => void;
  /**
   * Asks pi to resolve the provider's current access token, running its OAuth
   * refresh-and-persist path if the stored one is stale. Returns null when the
   * host has no such API (pre-0.81) or the refresh failed, in which case the
   * caller falls back to refreshing directly.
   */
  resolveAccessToken: () => Promise<string | null>;
  /**
   * Current access token, re-read rather than captured. Dust tokens live about
   * 15 minutes, which is shorter than a long agent turn.
   */
  getAccessToken: () => string;
}

const NOOP_SESSION_CONTEXT: SessionContextController = {
  getSessionFile: () => undefined,
  saveConversationId: () => { /* no-op until session_start wires it up */ },
  getCredentials: () => null,
  setCredentials: () => { /* no-op until session_start wires it up */ },
  resolveAccessToken: async () => null,
  getAccessToken: () => "",
};

const NOOP_CONFIRM = async () => true;

interface HeldAccessToken {
  token: string;
  expiresAt: number;
}

/**
 * pi's own `resolveAccessToken` host path doesn't report an expiry (it just
 * hands back an apiKey), but it persists the rotation to auth.json itself,
 * essentially synchronously. The in-memory holder only needs to survive long
 * enough to bridge the gap until a later `getAccessToken()` read reflects
 * that write — this is a conservative assumed lifetime for that bridge, well
 * under Dust's ~15 minute token life, not a claim about the token's real
 * expiry.
 */
export const HOST_TOKEN_ASSUMED_TTL_MS = 5 * 60 * 1000;

export class DustSessionRuntime {
  /** Extension API handle, used to append tool-call entries to the transcript. */
  pi: ExtensionAPI | null = null;
  /** Raw pi context, needed to invoke pi's built-in tool implementations. */
  extensionContext: PiRuntimeContext | null = null;
  conversationId: string | null = null;
  mcpServerId: string | null = null;
  mcpHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  mcpRequestsAbortController: AbortController | null = null;
  sessionContext: SessionContextController = NOOP_SESSION_CONTEXT;
  /**
   * The most recently refreshed access token, held in memory with an expiry.
   *
   * Invariants:
   * - **Written by**: `refreshAuth`'s two branches (dust-stream-provider.ts,
   *   shared single-flight via `refreshInFlight` below), the pre-stream
   *   refresh block in `dustRealStream`, and `refreshExpiredToken` at
   *   session_start (dust-session-events.ts) — every place that resolves a
   *   token outside of pi's own persisted storage.
   * - **Read by**: `DustSessionRuntime#currentAccessToken()`, the single
   *   accessor every `getAuthHeaders()`/auth-header builder in
   *   dust-stream-provider.ts must go through — never read this field
   *   directly.
   * - **Expires**: entries carry their own `expiresAt` and are ignored (and
   *   dropped) once past it, falling through to storage instead. This is
   *   what makes it safe for it to unconditionally win otherwise: a stale
   *   entry cannot outrank a fresher stored token forever, only until it
   *   naturally times out.
   * - **Cleared by**: `resetSessionState()`, `onLogin` (dust.ts — a fresh
   *   login must not let a previous account's or workspace's live token keep
   *   outranking the new one), and every `markInvalidated()` path (a dead
   *   session has nothing left worth holding onto).
   *
   * Why this exists at all: `setCredentials` (persistCredentialState)
   * deliberately drops the token trio — auth.json is pi-owned, and we can no
   * longer write it — so a refresh done through the direct WorkOS fallback
   * (as opposed to pi's own `resolveAccessToken` host path, which persists
   * the rotation itself) would otherwise vanish the instant it's "saved":
   * every later auth-header build would keep reading the same stale token
   * out of storage and loop back into the same 401.
   */
  refreshedAccessToken: HeldAccessToken | null = null;
  /**
   * Single-flight guard for `refreshAuth`. The event stream, the MCP
   * listener, and the MCP heartbeat can all hit a 401 in the same window and
   * each call `refreshAuth` — without memoizing the in-flight attempt here,
   * two concurrent direct refreshes would race the same rotating refresh
   * token: WorkOS honors the first and answers `invalid_grant` to the
   * second, which would then report a false refresh failure and invalidate a
   * session that had, in fact, just been refreshed successfully.
   */
  refreshInFlight: Promise<boolean> | null = null;
  confirmFn: (title: string, message: string) => Promise<boolean> = NOOP_CONFIRM;
  /**
   * When true, tool calls run without prompting. Session-scoped and off by
   * default, so a fresh session never silently executes tools.
   */
  autoApprove = false;
  preApprovedActions = new Map<string, boolean>();
  pendingApprovalPromise: Promise<void> | null = null;
  private resolveApprovalGateFn: (() => void) | null = null;

  /** Publishes a freshly refreshed token, valid until `expiresAt` (ms epoch). */
  setRefreshedAccessToken(token: string, expiresAt: number): void {
    this.refreshedAccessToken = token ? { token, expiresAt } : null;
  }

  /** Drops the held token unconditionally — used by every "session is dead or changed" path. */
  clearRefreshedAccessToken(): void {
    this.refreshedAccessToken = null;
  }

  /**
   * The single accessor every auth-header builder in dust-stream-provider.ts
   * must go through, instead of each hand-rolling its own `||` chain over
   * `refreshedAccessToken` and storage. Prefers the in-memory holder while it
   * is still within its assumed lifetime — since storage cannot carry a
   * directly-refreshed token at all (see `refreshedAccessToken`'s doc) — and
   * otherwise falls through to whatever is currently persisted.
   */
  currentAccessToken(): string {
    const held = this.refreshedAccessToken;
    if (held) {
      if (held.expiresAt > Date.now()) {
        return held.token;
      }
      // Past its assumed lifetime: drop it rather than let it keep
      // shadowing storage (which may since have rotated to something newer,
      // e.g. after a fresh login) forever.
      this.refreshedAccessToken = null;
    }
    return this.sessionContext.getAccessToken();
  }

  createApprovalGate(): void {
    this.pendingApprovalPromise = new Promise<void>((resolve) => {
      this.resolveApprovalGateFn = resolve;
    });
  }

  resolveApprovalGate(): void {
    if (this.resolveApprovalGateFn) {
      this.resolveApprovalGateFn();
      this.resolveApprovalGateFn = null;
      this.pendingApprovalPromise = null;
    }
  }

  clearMcpState(): void {
    if (this.mcpHeartbeatTimer) {
      clearInterval(this.mcpHeartbeatTimer);
      this.mcpHeartbeatTimer = null;
    }
    if (this.mcpRequestsAbortController) {
      this.mcpRequestsAbortController.abort();
      this.mcpRequestsAbortController = null;
    }
    this.mcpServerId = null;
    this.preApprovedActions.clear();
    // A listener can be parked awaiting this gate (tools/call blocked on a
    // pending tool_approve_execution). Discarding the resolver instead of
    // calling it would leave that await pending forever: the listener never
    // returns to reader.read(), so it never observes the abort above, and its
    // ReadableStreamDefaultReader lock and response body leak for the
    // process's lifetime.
    this.resolveApprovalGate();
  }

  resetSessionState(): void {
    this.conversationId = null;
    this.clearRefreshedAccessToken();
    this.clearMcpState();
  }
}

export function invalidateCredentials(credentials: DustCredentials): DustCredentials {
  return {
    ...credentials,
    access: "",
    refresh: "",
    expires: 0,
  };
}

export function invalidateRuntimeCredentials(runtime: DustSessionRuntime, credentials: DustCredentials): void {
  debugLog("dust:session", "Invalidating current credentials");
  // Zeroing the token fields no longer reaches pi's store, so record the dead
  // session in our own state; `getStoredCredentials` masks the tokens until the
  // next successful login clears the flag.
  runtime.sessionContext.setCredentials(invalidateCredentials(credentials));
  markInvalidated();
  runtime.conversationId = null;
  runtime.clearRefreshedAccessToken();
  runtime.clearMcpState();
}

export function shouldRefreshAccessToken(expiresAt: number | undefined, skewMs = 0): boolean {
  return typeof expiresAt === "number" && expiresAt <= Date.now() + skewMs;
}

export function buildSessionContext(ctx: PiRuntimeContext): SessionContextController {
  return {
    getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
    saveConversationId: (id: string) => {
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) return;
      persistConversationId(sessionFile, id);
    },
    getCredentials: () => getStoredCredentials(),
    getAccessToken: () => getStoredCredentials()?.access ?? "",
    setCredentials: (nextCred: DustCredentials) => persistCredentialState(nextCred),
    resolveAccessToken: async () => {
      const getProviderAuth = ctx.modelRegistry?.getProviderAuth;
      if (typeof getProviderAuth !== "function") return null;
      try {
        const resolved = await getProviderAuth.call(ctx.modelRegistry, "dust");
        return resolved?.auth?.apiKey ?? null;
      } catch (err) {
        debugLog("dust:session", "Provider auth refresh failed", { error: String(err) });
        return null;
      }
    },
  };
}

export function applyRuntimeContext(runtime: DustSessionRuntime, ctx: PiRuntimeContext): void {
  // pi's own tool implementations take the ExtensionContext as their last
  // execute() argument, so the raw context is kept, not just the derived
  // session controller.
  runtime.extensionContext = ctx;
  runtime.sessionContext = buildSessionContext(ctx);
  // Single choke point for both approval paths: Dust's server-side
  // tool_approve_execution gate and the local tools/call gate both land here.
  const confirm = ctx.ui?.confirm;
  runtime.confirmFn = async (title: string, message: string) => {
    if (runtime.autoApprove) {
      debugLog("dust:approval", "Auto-approved without prompting", { title });
      return true;
    }
    return confirm ? confirm(title, message) : NOOP_CONFIRM();
  };
}
