import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Api, Model, OAuthCredentials } from "@mariozechner/pi-ai";
import { DUST_HEADERS, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, fetchAgents, loginFn, refreshToken, slugify, workspaceLabel } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { listenMcpRequests, registerMcpServer, startMcpHeartbeat } from "./dust-mcp.js";
import { createEventStream, findAgentMessageSId, makeEmptyMessage, streamEvents } from "./dust-stream.js";
import { buildConfirmMessage, executeMcpTool } from "./dust-tools.js";
import type {
  DustAgent,
  DustCredentials,
  DustModel,
  ExtensionAPIWithEvents,
  PiRuntimeContext,
  StreamContextLike,
  StreamOptionsLike,
  ToolApproveExecutionEvent,
  Workspace,
} from "./dust-types.js";
import {
  errorMessage,
  parseConversationCreateResponse,
  parseConversationFetchResponse,
  parsePostMessageResponse,
} from "./dust-validation.js";

interface SessionContextController {
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

type DustProviderModel = Model<Api> & { sId: string };
const EMPTY_CREDENTIALS: DustCredentials = { type: "oauth", access: "", refresh: "", expires: 0 };

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

class DustSessionRuntime {
  conversationId: string | null = null;
  mcpServerId: string | null = null;
  mcpHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  mcpRequestsAbortController: AbortController | null = null;
  sessionContext: SessionContextController = NOOP_SESSION_CONTEXT;
  confirmFn: (title: string, message: string) => Promise<boolean> = async () => true;
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

  invalidateCurrentCredentials(credentials: DustCredentials): void {
    debugLog("dust:session", "Invalidating current credentials");
    this.sessionContext.setCredentials(invalidateCredentials(credentials));
    this.conversationId = null;
    this.clearMcpState();
  }
}

function invalidateCredentials(credentials: DustCredentials): DustCredentials {
  return {
    ...credentials,
    access: "",
    refresh: "",
    expires: 0,
  };
}

const runtime = new DustSessionRuntime();

function buildSessionContext(ctx: PiRuntimeContext): SessionContextController {
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

async function handleToolApproveExecution(event: ToolApproveExecutionEvent): Promise<boolean> {
  if (event.stake === "never_ask") {
    return true;
  }
  const toolName = event.metadata?.toolName ?? "unknown";
  const inputs = event.inputs ?? {};
  return runtime.confirmFn(`Allow tool: ${toolName}`, buildConfirmMessage(toolName, inputs));
}

async function postValidateAction(
  baseUrl: string,
  authHeaders: Record<string, string>,
  conversationId: string,
  messageId: string,
  actionId: string,
  approved: boolean,
): Promise<void> {
  const url = `${baseUrl}/assistant/conversations/${conversationId}/messages/${messageId}/validate-action`;
  debugLog("dust:session", "Posting validate-action", { conversationId, messageId, actionId, approved, url });
  await fetch(url, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, approved: approved ? "approved" : "rejected" }),
  });
}

function dustRealStream(
  cred: DustCredentials,
  model: DustModel,
  context: StreamContextLike,
  options?: StreamOptionsLike,
) {
  const stream = createEventStream();
  let liveCred: DustCredentials = runtime.sessionContext.getCredentials() ?? cred;

  (async () => {
    try {
      const signal = options?.signal;
      liveCred = runtime.sessionContext.getCredentials() ?? cred;
      debugLog("dust:session", "Starting Dust stream", {
        modelId: model.id,
        existingConversationId: runtime.conversationId,
      });

      if (typeof liveCred.expires === "number" && liveCred.expires <= Date.now() + 30_000) {
        try {
          liveCred = await refreshToken(liveCred);
          runtime.sessionContext.setCredentials(liveCred);
          debugLog("dust:session", "Pre-stream token refresh succeeded");
        } catch (err) {
          if (isSessionExpiredError(err)) {
            runtime.invalidateCurrentCredentials(liveCred);
            throw err;
          }
          console.error(`[dust] token refresh failed before stream: ${errorMessage(err)}`);
        }
      }

      const accessToken = liveCred.access ?? "";
      const workspaceId = liveCred.workspaceId ?? "";
      const region = liveCred.region ?? "us-central1";
      const username = liveCred.username ?? "unknown";
      const apiUrl = dustApiUrl(region);
      const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;
      const agentSId = model.sId ?? "";
      debugLog("dust:session", "Resolved stream context", { workspaceId, region, baseUrl, agentSId, username });

      const authHeaders = {
        Authorization: `Bearer ${accessToken}`,
        ...DUST_HEADERS,
      };

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      if (!runtime.mcpServerId) {
        const serverId = await registerMcpServer(baseUrl, authHeaders);
        runtime.mcpServerId = serverId;
        runtime.mcpHeartbeatTimer = startMcpHeartbeat(baseUrl, authHeaders, serverId);
        runtime.createApprovalGate();

        const abortController = new AbortController();
        runtime.mcpRequestsAbortController = abortController;
        listenMcpRequests({
          baseUrl,
          authHeaders,
          serverId,
          abortController,
          buildConfirmMessage,
          executeMcpTool,
          getConfirmFn: () => runtime.confirmFn,
          getPendingApprovalPromise: () => runtime.pendingApprovalPromise,
          preApprovedActions: runtime.preApprovedActions,
        }).catch((err) => {
          console.error(`[dust:mcp] listenMcpRequests fatal: ${err}`);
        });
      }

      const messages = context?.messages ?? [];
      const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
      const rawContent = lastUserMessage?.content ?? "";
      const userText = Array.isArray(rawContent)
        ? rawContent.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
        : String(rawContent);
      debugLog("dust:session", "Prepared user message", { userText, currentConversationId: runtime.conversationId });

      let conversationSId: string;
      let userMessageSId: string;

      if (!runtime.conversationId) {
        const reqBody = {
          title: userText.substring(0, 50) + (userText.length > 50 ? "..." : ""),
          visibility: "unlisted",
          message: {
            content: userText,
            mentions: [{ configurationId: agentSId }],
            context: {
              username,
              timezone,
              origin: "cli",
              clientSideMCPServerIds: runtime.mcpServerId ? [runtime.mcpServerId] : null,
            },
          },
        };
        debugLog("dust:session", "Creating Dust conversation", reqBody);

        const res = await fetch(`${baseUrl}/assistant/conversations`, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(reqBody),
          signal,
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          debugLog("dust:session", "Create conversation failed", { status: res.status, errBody });
          if (res.status === 401) {
            throw new Error(SESSION_EXPIRED_MESSAGE);
          }
          throw new Error(`Failed to create conversation: HTTP ${res.status} — ${errBody}`);
        }

        const data = parseConversationCreateResponse(await res.json());
        debugLog("dust:session", "Created Dust conversation", data);
        conversationSId = data.conversation.sId;
        userMessageSId = data.message.sId;
        runtime.conversationId = conversationSId;
        runtime.sessionContext.saveConversationId(conversationSId);

        const agentMsgSId = findAgentMessageSId(data.conversation.content, userMessageSId);
        await streamEvents({
          baseUrl,
          conversationSId,
          agentMsgSId,
          authHeaders,
          signal,
          stream,
          model,
          handleToolApproveExecution,
          postValidateAction: (conversationId, messageId, actionId, approved) =>
            postValidateAction(baseUrl, authHeaders, conversationId, messageId, actionId, approved),
          recordPreApproval: (actionId, approved) => runtime.preApprovedActions.set(actionId, approved),
          resolveApprovalGate: () => runtime.resolveApprovalGate(),
        });
      } else {
        conversationSId = runtime.conversationId;
        debugLog("dust:session", "Posting message to existing conversation", { conversationSId, userText });

        const msgRes = await fetch(`${baseUrl}/assistant/conversations/${conversationSId}/messages`, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: userText,
            mentions: [{ configurationId: agentSId }],
            context: {
              username,
              timezone,
              origin: "cli",
              clientSideMCPServerIds: runtime.mcpServerId ? [runtime.mcpServerId] : null,
            },
          }),
          signal,
        });

        if (!msgRes.ok) {
          debugLog("dust:session", "Post message failed", { status: msgRes.status, conversationSId });
          if (msgRes.status === 401) {
            throw new Error(SESSION_EXPIRED_MESSAGE);
          }
          throw new Error(`Failed to post message: HTTP ${msgRes.status}`);
        }

        const msgData = parsePostMessageResponse(await msgRes.json());
        debugLog("dust:session", "Posted user message", msgData);
        userMessageSId = msgData.message.sId;

        const convRes = await fetch(`${baseUrl}/assistant/conversations/${conversationSId}`, {
          headers: authHeaders,
          signal,
        });

        if (!convRes.ok) {
          debugLog("dust:session", "Fetch conversation failed", { status: convRes.status, conversationSId });
          if (convRes.status === 401) {
            throw new Error(SESSION_EXPIRED_MESSAGE);
          }
          throw new Error(`Failed to fetch conversation: HTTP ${convRes.status}`);
        }

        const convData = parseConversationFetchResponse(await convRes.json());
        debugLog("dust:session", "Fetched updated conversation", convData);
        const agentMsgSId = findAgentMessageSId(convData.conversation.content, userMessageSId);
        await streamEvents({
          baseUrl,
          conversationSId,
          agentMsgSId,
          authHeaders,
          signal,
          stream,
          model,
          handleToolApproveExecution,
          postValidateAction: (conversationId, messageId, actionId, approved) =>
            postValidateAction(baseUrl, authHeaders, conversationId, messageId, actionId, approved),
          recordPreApproval: (actionId, approved) => runtime.preApprovedActions.set(actionId, approved),
          resolveApprovalGate: () => runtime.resolveApprovalGate(),
        });
      }
    } catch (error) {
      debugLog("dust:session", "Dust stream failed", { error: errorMessage(error) });
      if (isSessionExpiredError(error)) {
        runtime.invalidateCurrentCredentials(liveCred);
      }
      const message = makeEmptyMessage(model);
      message.stopReason = "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
    } finally {
      runtime.resolveApprovalGate();
    }
  })();

  return stream;
}

function buildOAuthDustModels(credentials: OAuthCredentials): DustProviderModel[] {
  const cred = credentials as DustCredentials;
  const agents: DustAgent[] = cred.agents ?? [];
  const apiUrl = dustApiUrl(cred.region ?? "us-central1");
  const workspaceId = cred.workspaceId ?? "";
  const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;

  return agents.map((agent) => ({
    provider: "dust",
    id: slugify(agent.name),
    sId: agent.sId,
    name: agent.name,
    api: "dust" as Api,
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    headers: { ...DUST_HEADERS },
  }));
}

function buildDustProviderConfig(
  pi: ExtensionAPI,
  cred: DustCredentials,
): void {
  const agents: DustAgent[] = cred.agents ?? [];
  const apiUrl = dustApiUrl(cred.region ?? "us-central1");
  const workspaceId = cred.workspaceId ?? "";
  const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;
  let latestCred: DustCredentials = cred;

  pi.registerProvider("dust", {
    api: "dust" as any,
    baseUrl,
    streamSimple: (model: unknown, context: unknown, options?: unknown) =>
      dustRealStream(
        latestCred,
        model as DustModel,
        context as StreamContextLike,
        options as StreamOptionsLike | undefined,
      ) as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => loginFn(callbacks),
      refreshToken: async (credentials) => refreshToken(credentials as DustCredentials),
      getApiKey: (credentials) => (credentials as DustCredentials).access ?? "",
      modifyModels: (models, credentials) => {
        const dustModels = buildOAuthDustModels(credentials);
        return [...models.filter((entry) => entry.provider !== "dust"), ...dustModels];
      },
    },
    models: agents.map((agent) => ({
      id: slugify(agent.name),
      sId: agent.sId,
      name: agent.name,
      api: "dust" as any,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
      headers: { ...DUST_HEADERS },
    })),
  });

  latestCred = cred;
}

export default function (pi: ExtensionAPI) {
  const piWithEvents = pi as ExtensionAPIWithEvents;
  debugLog("dust:init", "Initializing Dust extension");

  runtime.resetSessionState();

  pi.registerProvider("dust", {
    api: "dust" as any,
    streamSimple: (model: unknown, context: unknown, options?: unknown) =>
      dustRealStream(
        EMPTY_CREDENTIALS,
        model as DustModel,
        context as StreamContextLike,
        options as StreamOptionsLike | undefined,
      ) as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => {
        const cred = await loginFn(callbacks);
        buildDustProviderConfig(pi, cred);
        return cred;
      },
      refreshToken: async (credentials) => refreshToken(credentials as DustCredentials),
      getApiKey: (credentials) => (credentials as DustCredentials).access ?? "",
      modifyModels: (models, credentials) => {
        const dustModels = buildOAuthDustModels(credentials);
        return [...models.filter((entry) => entry.provider !== "dust"), ...dustModels];
      },
    },
  });

  if (typeof piWithEvents.on === "function") {
    const registerEvent = piWithEvents.on as (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;

    registerEvent("session_switch", (_event: unknown, ctx: PiRuntimeContext) => {
      const event = _event as { reason?: string };
      debugLog("dust:session", "Handling session_switch", event);
      runtime.sessionContext = buildSessionContext(ctx);
      runtime.confirmFn = ctx.ui?.confirm
        ? (title: string, message: string) => ctx.ui!.confirm!(title, message)
        : async () => true;

      if (event.reason === "resume") {
        const sessionFile = ctx.sessionManager?.getSessionFile?.();
        const cred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
        runtime.conversationId = (sessionFile && cred?.conversations?.[sessionFile]) ?? null;
        runtime.clearMcpState();
        debugLog("dust:session", "Resumed session", { currentConversationId: runtime.conversationId });
      } else {
        runtime.resetSessionState();
        debugLog("dust:session", "Reset session state");
      }
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
      runtime.sessionContext = buildSessionContext(ctx);
      runtime.confirmFn = ctx.ui?.confirm
        ? (title: string, message: string) => ctx.ui!.confirm!(title, message)
        : async () => true;

      const existingEntries = ctx.sessionManager?.getEntries?.() ?? [];
      runtime.conversationId = existingEntries.length > 0 && sessionFile
        ? cred.conversations?.[sessionFile] ?? null
        : null;
      debugLog("dust:session", "Resolved persisted conversation", {
        currentConversationId: runtime.conversationId,
        entryCount: existingEntries.length,
      });

      if (!cred.access) {
        buildDustProviderConfig(pi, cred);
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
        buildDustProviderConfig(pi, invalidatedCred);
        return;
      }

      if (agentFetch.agents !== null) {
        const updatedCred = { ...cred, agents: agentFetch.agents };
        ctx.modelRegistry.authStorage.set("dust", updatedCred);
        buildDustProviderConfig(pi, updatedCred);
      } else {
        buildDustProviderConfig(pi, cred);
      }
    });
  }

  pi.registerCommand("workspace", {
    description: "Show current Dust workspace and switch between workspaces",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const cred = runtimeCtx.modelRegistry.authStorage.get("dust") as DustCredentials | null;

      if (!cred || !Array.isArray(cred.workspaces) || cred.workspaces.length === 0) {
        runtimeCtx.ui?.notify?.("Not logged in to Dust. Run /login first.", "warning");
        return;
      }

      const workspaces: Workspace[] = cred.workspaces;
      const current = workspaces.find((workspace) => workspace.sId === cred.workspaceId);
      const currentName = current?.name ?? cred.workspaceId;
      const selected = await runtimeCtx.ui?.select?.(
        `Current workspace: ${currentName}`,
        workspaces.map(workspaceLabel),
        {},
      );

      if (!selected) return;
      const picked = workspaces.find((workspace) => workspaceLabel(workspace) === selected);
      if (!picked || picked.sId === cred.workspaceId) return;

      runtimeCtx.modelRegistry.authStorage.set("dust", { ...cred, workspaceId: picked.sId });
      debugLog("dust:session", "Switched workspace", { from: cred.workspaceId, to: picked.sId, name: picked.name });
      runtimeCtx.ui?.notify?.(`Switched to workspace: ${picked.name}`, "info");
    },
  });
}
