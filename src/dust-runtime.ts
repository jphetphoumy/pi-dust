import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import {
  getStoredCredentials,
  markInvalidated,
  persistCredentialState,
  saveConversationId as persistConversationId,
} from "./dust-state.js";
import type {
  DustCredentials,
  FairUseCredits,
  MemberUsage,
  CreditTotals,
  PiRuntimeContext,
  TopConversations,
  UsageAnalytics,
} from "./dust-types.js";

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

/**
 * Per-session counters and caches behind `/status`.
 *
 * Dust reports credits per *billing period*, never per session, so the session
 * figure is a delta against a baseline sample — approximate by construction, and
 * labelled as such in the panel.
 */
export class DustCreditTracker {
  startedAt = Date.now();
  messagesSent = 0;
  /**
   * First `consumedAwuCredits` observed this session, with when it was taken.
   * Sampled on the first live read rather than at session start, so a user who
   * never opens `/status` never pays for the request.
   */
  baselineCredits: number | null = null;
  baselineAt: number | null = null;
  /**
   * Set when a turn completes, cleared when live figures are refetched. Live
   * data is only served from memory while this is false — i.e. while nothing has
   * happened that could have moved the numbers.
   */
  dirty = false;
  /** Last live read, reused only while `dirty` is false. */
  lastConsumedCredits: number | null = null;
  cachedUsage: MemberUsage | null = null;
  cachedFairUse: FairUseCredits | null = null;
  cachedTotals: CreditTotals = { month: null, week: null, day: null };
  /** 30-day aggregates; they do not meaningfully move within one session. */
  analytics: UsageAnalytics | null = null;
  topConversations: TopConversations | null = null;

  recordMessageSent(): void {
    this.messagesSent++;
  }

  recordTurnCompleted(): void {
    this.dirty = true;
  }

  /** Folds a fresh `consumedAwuCredits` reading in, returning the session delta. */
  observeConsumedCredits(consumed: number | null): number | null {
    this.dirty = false;
    if (consumed === null) return null;

    this.lastConsumedCredits = consumed;
    if (this.baselineCredits === null) {
      this.baselineCredits = consumed;
      this.baselineAt = Date.now();
    }
    return Math.max(0, consumed - this.baselineCredits);
  }

  /** The delta implied by the last reading, without issuing a new one. */
  sessionDelta(): number | null {
    if (this.lastConsumedCredits === null || this.baselineCredits === null) return null;
    return Math.max(0, this.lastConsumedCredits - this.baselineCredits);
  }

  /**
   * Drops everything derived from the workspace or the credential. The elapsed
   * clock restarts too: a switched workspace is, for credit purposes, a new
   * session.
   */
  reset(): void {
    this.startedAt = Date.now();
    this.messagesSent = 0;
    this.baselineCredits = null;
    this.baselineAt = null;
    this.dirty = false;
    this.lastConsumedCredits = null;
    this.cachedUsage = null;
    this.cachedFairUse = null;
    this.cachedTotals = { month: null, week: null, day: null };
    this.analytics = null;
    this.topConversations = null;
  }
}

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
  confirmFn: (title: string, message: string) => Promise<boolean> = NOOP_CONFIRM;
  /**
   * When true, tool calls run without prompting. Session-scoped and off by
   * default, so a fresh session never silently executes tools.
   */
  autoApprove = false;
  /** Session counters and credit caches read by `/status`. */
  credits = new DustCreditTracker();
  preApprovedActions = new Map<string, boolean>();
  pendingApprovalPromise: Promise<void> | null = null;
  private resolveApprovalGateFn: (() => void) | null = null;

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
    this.pendingApprovalPromise = null;
    this.resolveApprovalGateFn = null;
  }

  resetSessionState(): void {
    this.conversationId = null;
    this.credits.reset();
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
  // The credit figures belong to the dead credential; keeping them would show
  // another account's numbers after a re-login.
  runtime.credits.reset();
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
