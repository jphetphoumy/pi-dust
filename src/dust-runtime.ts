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
}

const NOOP_SESSION_CONTEXT: SessionContextController = {
  getSessionFile: () => undefined,
  saveConversationId: () => { /* no-op until session_start wires it up */ },
  getCredentials: () => null,
  setCredentials: () => { /* no-op until session_start wires it up */ },
  resolveAccessToken: async () => null,
};

const NOOP_CONFIRM = async () => true;

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
