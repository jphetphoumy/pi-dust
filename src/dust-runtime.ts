import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshToken } from "./dust-auth.js";
import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
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
  DustStatusData,
  PiRuntimeContext,
  TopConversations,
  UsageAnalytics,
} from "./dust-types.js";
import { agentMessageIdFromMcpRequestId, errorMessage } from "./dust-validation.js";

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
/** Enough to cover any turn whose tool calls could still be in flight. */
const MAX_REMEMBERED_CANCELLED_MESSAGES = 50;

/**
 * The Dust-side half of one pi turn.
 *
 * Cancelling a turn needs the agent message the Dust agent loop is running
 * under, and a way to kill local tool work that the (session-lifetime) MCP
 * listener started on its behalf.
 */
export interface ActiveDustTurn {
  conversationSId: string;
  userMessageSId: string;
  /**
   * Null until the lookup that follows the user message resolves. Posting that
   * message is what starts the agent loop, so a turn exists — and can be
   * cancelled — before its agent message is known.
   */
  agentMessageSId: string | null;
  /** Aborted when the user cancels, so in-flight local tools stop too. */
  toolAbortController: AbortController;
  cancelled: boolean;
}

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
  /** Last fully-built overview, repainted instantly when the session has not moved. */
  lastOverview: DustStatusData | null = null;
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
    this.lastOverview = null;
    this.analytics = null;
    this.topConversations = null;
  }
}

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
   * - **Written by**: `refreshAccessToken()` below (its own two branches;
   *   `refreshAuth` in dust-stream-provider.ts is now a one-line delegate to
   *   it), the pre-stream refresh block in `dustRealStream`
   *   (dust-stream-provider.ts), and `refreshExpiredToken` at session_start
   *   (dust-session-events.ts) — every place that resolves a token outside of
   *   pi's own persisted storage. The latter two still hand-roll their own
   *   refresh body rather than calling `refreshAccessToken()`; see that
   *   method's doc for why they're out of scope here.
   * - **Read by**: `DustSessionRuntime#currentAccessToken()`, the single
   *   accessor every auth-header builder in dust-stream-provider.ts and
   *   `dust-credits.ts`'s `fetchCreditsJson` must go through — never read
   *   this field directly.
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
   * Single-flight guard for `refreshAccessToken()`. The event stream, the MCP
   * listener, the MCP heartbeat, and `/status` credit fetches can all hit a
   * 401 in the same window and each call `refreshAccessToken()` — without
   * memoizing the in-flight attempt here, two concurrent direct refreshes
   * would race the same rotating refresh token: WorkOS honors the first and
   * answers `invalid_grant` to the second, which would then report a false
   * refresh failure and invalidate a session that had, in fact, just been
   * refreshed successfully.
   */
  refreshInFlight: Promise<boolean> | null = null;
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
  /** The turn currently streaming, if any. */
  activeTurn: ActiveDustTurn | null = null;
  /**
   * Whether the most recent turn was cancelled. Dust tool calls can arrive
   * after the stream has already closed, so the verdict has to outlive the turn
   * itself; the next turn clears it.
   */
  private lastTurnCancelled = false;
  /** Agent messages the user cancelled, for correlating late tool calls. */
  private cancelledAgentMessages = new Set<string>();
  /** Content hash → Dust file id, for `@` files attached to `attachmentCacheConversationId`. */
  private attachmentFileIds = new Map<string, string>();
  private attachmentCacheConversationId: string | null = null;

  beginTurn(
    conversationSId: string,
    userMessageSId: string,
    agentMessageSId: string | null = null,
  ): ActiveDustTurn {
    this.lastTurnCancelled = false;
    const turn: ActiveDustTurn = {
      conversationSId,
      userMessageSId,
      agentMessageSId,
      toolAbortController: new AbortController(),
      cancelled: false,
    };
    this.activeTurn = turn;
    return turn;
  }

  /** Clears `activeTurn` only if `turn` is still the current one. */
  endTurn(turn: ActiveDustTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
  }

  /**
   * Marks the current turn cancelled and aborts its local tool work. Returns
   * the turn so the caller can tell Dust to stop it, or null if none is live.
   */
  cancelActiveTurn(): ActiveDustTurn | null {
    const turn = this.activeTurn;
    if (!turn || turn.cancelled) {
      return null;
    }
    turn.cancelled = true;
    this.lastTurnCancelled = true;
    if (turn.agentMessageSId) {
      this.markAgentMessageCancelled(turn.agentMessageSId);
    }
    turn.toolAbortController.abort();
    // Pre-approvals belong to the turn that collected them. A tool call refused
    // for being cancelled never consumes its entry, so leaving the queue in
    // place would auto-approve an unrelated tool call in a later turn.
    this.preApprovedActions.clear();
    // A tool waiting on approval must not block the MCP listener forever once
    // the turn it belonged to is gone.
    this.resolveApprovalGate();
    return turn;
  }

  isTurnCancelled(): boolean {
    return this.activeTurn ? this.activeTurn.cancelled : this.lastTurnCancelled;
  }

  /**
   * Records an agent message whose loop the user cancelled.
   *
   * Cancelling is asynchronous on Dust's side, so a cancelled loop can still
   * emit tool calls after the user has started another turn — by which point
   * the current-turn check has moved on and would let them through.
   */
  markAgentMessageCancelled(agentMessageSId: string): void {
    this.cancelledAgentMessages.add(agentMessageSId);
    // Bounded: only recent turns can still have requests in flight, and this
    // set lives for the whole session.
    while (this.cancelledAgentMessages.size > MAX_REMEMBERED_CANCELLED_MESSAGES) {
      const oldest = this.cancelledAgentMessages.values().next();
      if (oldest.done) break;
      this.cancelledAgentMessages.delete(oldest.value);
    }
  }

  /**
   * Whether this MCP request should be refused: either it names an agent
   * message the user cancelled, or — when the request carries no usable id —
   * the current turn is cancelled.
   */
  isCancelledRequest(requestId: unknown): boolean {
    const agentMessageSId = agentMessageIdFromMcpRequestId(requestId);
    if (agentMessageSId !== null && this.cancelledAgentMessages.has(agentMessageSId)) {
      return true;
    }
    return this.isTurnCancelled();
  }

  /** Publishes a freshly refreshed token, valid until `expiresAt` (ms epoch). */
  setRefreshedAccessToken(token: string, expiresAt: number): void {
    this.refreshedAccessToken = token ? { token, expiresAt } : null;
  }

  /** Drops the held token unconditionally — used by every "session is dead or changed" path. */
  clearRefreshedAccessToken(): void {
    this.refreshedAccessToken = null;
  }

  /**
   * The single accessor every auth-header builder in dust-stream-provider.ts,
   * and `dust-credits.ts`'s credit fetches, must go through — instead of each
   * hand-rolling its own `||` chain over `refreshedAccessToken` and storage.
   * Prefers the in-memory holder while it is still within its assumed
   * lifetime — since storage cannot carry a directly-refreshed token at all
   * (see `refreshedAccessToken`'s doc) — and otherwise falls through to
   * whatever is currently persisted.
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

  /**
   * Refreshes the access token, single-flighted on `refreshInFlight`.
   *
   * Scope: this is the single implementation for 401-recovery refreshes.
   * Every 401-recovery caller — the event stream, the MCP listener/heartbeat
   * (dust-stream-provider.ts, via the one-line `refreshAuth` delegate), and
   * `/status` credit fetches (dust-credits.ts) — hits this same method
   * instead of each rolling its own refresh body, so a 401 concurrent with
   * another caller's refresh awaits that one attempt instead of racing it
   * with a second direct refresh against the same (now-rotated) refresh
   * token.
   *
   * Out of scope: two other refresh bodies predate this method and are *not*
   * merged into it — the proactive pre-stream refresh block in
   * `dustRealStream` (dust-stream-provider.ts, gated on
   * `shouldRefreshAccessToken`) and `refreshExpiredToken` at session_start
   * (dust-session-events.ts). Both still hand-roll their own host-token-then-
   * direct-refresh body and do not go through `refreshInFlight`, so a turn
   * starting (which runs the pre-stream refresh) while `/status` triggers a
   * credits refresh can still race two direct refreshes against the same
   * rotating refresh token. Folding those two into this method is a real
   * behavior change (careful handling of `liveCred` updates and
   * `isSessionExpiredError` needed) and is intentionally left for later work.
   *
   * Prefers pi's own `resolveAccessToken` host path, which persists the
   * rotation to auth.json itself; falls back to a direct WorkOS refresh
   * (`fallbackCredentials` is the caller's own best snapshot of the current
   * credentials, used only if `sessionContext` itself has none — e.g. a
   * turn's `liveCred` closed over before this call).
   *
   * `fallbackCredentials` only matters for whichever call *starts* the
   * flight — a second, concurrent caller just awaits `refreshInFlight` and
   * never gets its own fallback considered. This can't bite in practice
   * (every caller's `sessionContext.getCredentials()` reads the same stored
   * credential, so the fallback is only ever reached when that read is
   * already null for everyone), but it's the shape of the divergent-bodies
   * defect this method exists to prevent, so don't reintroduce a per-caller
   * refresh body to "fix" it.
   */
  async refreshAccessToken(fallbackCredentials?: DustCredentials): Promise<boolean> {
    this.refreshInFlight ??= (async (): Promise<boolean> => {
      const hostToken = await this.sessionContext.resolveAccessToken();
      if (hostToken) {
        this.setRefreshedAccessToken(hostToken, Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
        return true;
      }

      const credentials = this.sessionContext.getCredentials() ?? fallbackCredentials ?? null;
      if (!credentials) return false;

      try {
        const refreshed = await refreshToken(credentials);
        this.sessionContext.setCredentials(refreshed);
        // persistCredentialState drops access/refresh/expires (auth.json is
        // pi-owned, we can no longer write it), so the rotated token would
        // otherwise vanish the instant it's "saved": every later
        // currentAccessToken() read — ours and every other caller's — would
        // keep re-reading the same expired token from storage and loop
        // straight back into the same 401.
        if (refreshed.access) {
          this.setRefreshedAccessToken(refreshed.access, refreshed.expires || Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
        }
        return Boolean(refreshed.access);
      } catch (err) {
        debugLog("dust:session", "Refresh after 401 failed", {
          expired: errorMessage(err) === SESSION_EXPIRED_MESSAGE,
          error: errorMessage(err),
        });
        return false;
      }
    })().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
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

  /**
   * The upload cache for `conversationSId`, emptied when the conversation
   * changes: a Dust file id only means "already attached" inside the one
   * conversation it was attached to.
   */
  attachmentCacheFor(conversationSId: string | null): Map<string, string> {
    if (this.attachmentCacheConversationId !== conversationSId) {
      this.attachmentFileIds.clear();
      this.attachmentCacheConversationId = conversationSId;
    }
    return this.attachmentFileIds;
  }

  /**
   * Records files that were uploaded before the conversation existed, once it
   * does. Deliberately not done at upload time: if the conversation creation
   * that carries them fails, the files are attached to nothing, and a later
   * turn reusing their ids would point the agent at what it cannot read.
   */
  rememberAttachments(conversationSId: string, files: Iterable<[string, string]>): void {
    const cache = this.attachmentCacheFor(conversationSId);
    for (const [hash, fileId] of files) {
      cache.set(hash, fileId);
    }
  }

  clearMcpState(): void {
    // Switching session or losing credentials ends any turn in flight; its
    // local tools must not keep running against the old session.
    this.cancelActiveTurn();
    this.activeTurn = null;
    this.cancelledAgentMessages.clear();
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
    this.attachmentCacheFor(null);
    this.credits.reset();
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
  // The credit figures belong to the dead credential; keeping them would show
  // another account's numbers after a re-login.
  runtime.credits.reset();
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
