import { debugLog } from "./dust-debug.js";
import type { DustCredentials, PiRuntimeContext } from "./dust-types.js";

export interface SessionContextController {
  getSessionFile: () => string | undefined;
  saveConversationId: (id: string) => void;
  getCredentials: () => DustCredentials | null;
  setCredentials: (cred: DustCredentials) => void;
}

const NOOP_SESSION_CONTEXT: SessionContextController = {
  getSessionFile: () => undefined,
  saveConversationId: () => { /* no-op until session_start wires it up */ },
  getCredentials: () => null,
  setCredentials: () => { /* no-op until session_start wires it up */ },
};

const NOOP_CONFIRM = async () => true;

export class DustSessionRuntime {
  conversationId: string | null = null;
  mcpServerId: string | null = null;
  mcpHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  mcpRequestsAbortController: AbortController | null = null;
  sessionContext: SessionContextController = NOOP_SESSION_CONTEXT;
  confirmFn: (title: string, message: string) => Promise<boolean> = NOOP_CONFIRM;
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
  runtime.sessionContext.setCredentials(invalidateCredentials(credentials));
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
      const latestCred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
      if (!latestCred) return;
      ctx.modelRegistry.authStorage.set("dust", {
        ...latestCred,
        conversations: { ...(latestCred.conversations ?? {}), [sessionFile]: id },
      });
    },
    getCredentials: () => ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null,
    setCredentials: (nextCred: DustCredentials) => ctx.modelRegistry.authStorage.set("dust", nextCred),
  };
}

export function applyRuntimeContext(runtime: DustSessionRuntime, ctx: PiRuntimeContext): void {
  runtime.sessionContext = buildSessionContext(ctx);
  runtime.confirmFn = ctx.ui?.confirm
    ? (title: string, message: string) => ctx.ui!.confirm!(title, message)
    : NOOP_CONFIRM;
}
