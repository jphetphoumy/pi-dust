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
    // Switching session or losing credentials ends any turn in flight; its
    // local tools must not keep running against the old session.
    this.cancelActiveTurn();
    this.activeTurn = null;
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
