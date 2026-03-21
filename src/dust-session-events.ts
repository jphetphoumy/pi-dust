import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, fetchAgents, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { applyRuntimeContext, invalidateCredentials } from "./dust-runtime.js";
import { errorMessage } from "./dust-validation.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import type { DustCredentials, ExtensionAPIWithEvents, PiRuntimeContext } from "./dust-types.js";

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
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
      const cred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
      runtime.conversationId = (sessionFile && cred?.conversations?.[sessionFile]) ?? null;
      runtime.clearMcpState();
      debugLog("dust:session", "Resumed session", { currentConversationId: runtime.conversationId });
      return;
    }

    runtime.resetSessionState();
    debugLog("dust:session", "Reset session state");
  });

  registerEvent("session_start", async (_event: unknown, ctx: PiRuntimeContext) => {
    let cred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
    if (cred?.type !== "oauth") return;

    debugLog("dust:session", "Handling session_start", {
      hasAccess: Boolean(cred.access),
      workspaceId: cred.workspaceId,
    });

    if (typeof cred.expires === "number" && cred.expires <= Date.now()) {
      try {
        const refreshed = await refreshToken(cred);
        ctx.modelRegistry.authStorage.set("dust", refreshed);
        cred = refreshed;
        debugLog("dust:session", "Refreshed token during session_start");
      } catch (err) {
        if (isSessionExpiredError(err)) {
          const invalidatedCred = invalidateCredentials(cred);
          ctx.modelRegistry.authStorage.set("dust", invalidatedCred);
          cred = invalidatedCred;
        }
        console.error(`[dust] token refresh failed at session_start: ${errorMessage(err)}`, err);
        debugLog("dust:session", "Token refresh failed during session_start", { error: errorMessage(err) });
      }
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
      ctx.modelRegistry.authStorage.set("dust", invalidatedCred);
      registerProviderForCredentials(invalidatedCred);
      return;
    }

    if (agentFetch.agents !== null) {
      const updatedCred = { ...cred, agents: agentFetch.agents };
      ctx.modelRegistry.authStorage.set("dust", updatedCred);
      registerProviderForCredentials(updatedCred);
      return;
    }

    registerProviderForCredentials(cred);
  });
}
