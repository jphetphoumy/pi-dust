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

let currentConversationId: string | null = null;
let currentMcpServerId: string | null = null;
let mcpHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let mcpRequestsAbortController: AbortController | null = null;

let currentSessionContext: {
  getSessionFile: () => string | undefined;
  saveConversationId: (id: string) => void;
  getCredentials: () => DustCredentials | null;
  setCredentials: (cred: DustCredentials) => void;
} = {
  getSessionFile: () => undefined,
  saveConversationId: () => { /* no-op until session_start wires it up */ },
  getCredentials: () => null,
  setCredentials: () => { /* no-op until session_start wires it up */ },
};

let currentConfirmFn: (title: string, message: string) => Promise<boolean> = async () => true;
const preApprovedActions = new Map<string, boolean>();
let pendingApprovalPromise: Promise<void> | null = null;
let resolveApprovalGate: (() => void) | null = null;

type DustProviderModel = Model<Api> & { sId: string };
const EMPTY_CREDENTIALS: DustCredentials = { type: "oauth", access: "", refresh: "", expires: 0 };

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

function resolveCurrentApprovalGate(): void {
  if (resolveApprovalGate) {
    resolveApprovalGate();
    resolveApprovalGate = null;
    pendingApprovalPromise = null;
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

function invalidateCurrentCredentials(credentials: DustCredentials): void {
  debugLog("dust:session", "Invalidating current credentials");
  currentSessionContext.setCredentials(invalidateCredentials(credentials));
  currentConversationId = null;
  clearMcpState();
}

function clearMcpState(): void {
  if (mcpHeartbeatTimer) {
    clearInterval(mcpHeartbeatTimer);
    mcpHeartbeatTimer = null;
  }
  if (mcpRequestsAbortController) {
    mcpRequestsAbortController.abort();
    mcpRequestsAbortController = null;
  }
  currentMcpServerId = null;
  preApprovedActions.clear();
  pendingApprovalPromise = null;
  resolveApprovalGate = null;
}

async function handleToolApproveExecution(event: ToolApproveExecutionEvent): Promise<boolean> {
  if (event.stake === "never_ask") {
    return true;
  }
  const toolName = event.metadata?.toolName ?? "unknown";
  const inputs = event.inputs ?? {};
  return currentConfirmFn(`Allow tool: ${toolName}`, buildConfirmMessage(toolName, inputs));
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
  let liveCred: DustCredentials = currentSessionContext.getCredentials() ?? cred;

  (async () => {
    try {
      const signal = options?.signal;
      liveCred = currentSessionContext.getCredentials() ?? cred;
      debugLog("dust:session", "Starting Dust stream", {
        modelId: model.id,
        existingConversationId: currentConversationId,
      });

      if (typeof liveCred.expires === "number" && liveCred.expires <= Date.now() + 30_000) {
        try {
          liveCred = await refreshToken(liveCred);
          currentSessionContext.setCredentials(liveCred);
          debugLog("dust:session", "Pre-stream token refresh succeeded");
        } catch (err) {
          if (isSessionExpiredError(err)) {
            invalidateCurrentCredentials(liveCred);
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

      if (!currentMcpServerId) {
        const serverId = await registerMcpServer(baseUrl, authHeaders);
        currentMcpServerId = serverId;
        mcpHeartbeatTimer = startMcpHeartbeat(baseUrl, authHeaders, serverId);
        pendingApprovalPromise = new Promise<void>((resolve) => { resolveApprovalGate = resolve; });

        const abortController = new AbortController();
        mcpRequestsAbortController = abortController;
        listenMcpRequests({
          baseUrl,
          authHeaders,
          serverId,
          abortController,
          buildConfirmMessage,
          executeMcpTool,
          getConfirmFn: () => currentConfirmFn,
          getPendingApprovalPromise: () => pendingApprovalPromise,
          preApprovedActions,
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
      debugLog("dust:session", "Prepared user message", { userText, currentConversationId });

      let conversationSId: string;
      let userMessageSId: string;

      if (!currentConversationId) {
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
              clientSideMCPServerIds: currentMcpServerId ? [currentMcpServerId] : null,
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
        currentConversationId = conversationSId;
        currentSessionContext.saveConversationId(conversationSId);

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
          recordPreApproval: (actionId, approved) => preApprovedActions.set(actionId, approved),
          resolveApprovalGate: resolveCurrentApprovalGate,
        });
      } else {
        conversationSId = currentConversationId;
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
              clientSideMCPServerIds: currentMcpServerId ? [currentMcpServerId] : null,
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
          recordPreApproval: (actionId, approved) => preApprovedActions.set(actionId, approved),
          resolveApprovalGate: resolveCurrentApprovalGate,
        });
      }
    } catch (error) {
      debugLog("dust:session", "Dust stream failed", { error: errorMessage(error) });
      if (isSessionExpiredError(error)) {
        invalidateCurrentCredentials(liveCred);
      }
      const message = makeEmptyMessage(model);
      message.stopReason = "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
    } finally {
      resolveCurrentApprovalGate();
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

  currentConversationId = null;
  clearMcpState();

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
      currentSessionContext = {
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

      if (ctx.ui?.confirm) {
        currentConfirmFn = (title: string, message: string) => ctx.ui!.confirm!(title, message);
      }

      if (event.reason === "resume") {
        const sessionFile = ctx.sessionManager?.getSessionFile?.();
        const cred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
        currentConversationId = (sessionFile && cred?.conversations?.[sessionFile]) ?? null;
        clearMcpState();
        debugLog("dust:session", "Resumed session", { currentConversationId });
      } else {
        currentConversationId = null;
        clearMcpState();
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
      currentSessionContext = {
        getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
        saveConversationId: (id: string) => {
          const activeSessionFile = ctx.sessionManager?.getSessionFile?.();
          if (!activeSessionFile) return;
          const latestCred = ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null;
          if (!latestCred) return;
          ctx.modelRegistry.authStorage.set("dust", {
            ...latestCred,
            conversations: { ...(latestCred.conversations ?? {}), [activeSessionFile]: id },
          });
        },
        getCredentials: () => ctx.modelRegistry.authStorage.get("dust") as DustCredentials | null,
        setCredentials: (nextCred: DustCredentials) => ctx.modelRegistry.authStorage.set("dust", nextCred),
      };

      if (ctx.ui?.confirm) {
        currentConfirmFn = (title: string, message: string) => ctx.ui!.confirm!(title, message);
      }

      const existingEntries = ctx.sessionManager?.getEntries?.() ?? [];
      currentConversationId = existingEntries.length > 0 && sessionFile
        ? cred.conversations?.[sessionFile] ?? null
        : null;
      debugLog("dust:session", "Resolved persisted conversation", { currentConversationId, entryCount: existingEntries.length });

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
