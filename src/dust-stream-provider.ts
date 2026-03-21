import { DUST_HEADERS, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { listenMcpRequests, registerMcpServer, startMcpHeartbeat } from "./dust-mcp.js";
import { createEventStream, findAgentMessageSId, makeEmptyMessage, streamEvents } from "./dust-stream.js";
import { buildConfirmMessage, executeMcpTool } from "./dust-tools.js";
import type { DustCredentials, DustModel, StreamContextLike, StreamOptionsLike, ToolApproveExecutionEvent } from "./dust-types.js";
import { errorMessage, parseConversationCreateResponse, parseConversationFetchResponse, parsePostMessageResponse } from "./dust-validation.js";
import { invalidateRuntimeCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import type { DustSessionRuntime } from "./dust-runtime.js";

const STREAM_REFRESH_SKEW_MS = 30_000;

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

function buildAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...DUST_HEADERS,
  };
}

function extractUserText(context: StreamContextLike): string {
  const messages = context?.messages ?? [];
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const rawContent = lastUserMessage?.content ?? "";

  return Array.isArray(rawContent)
    ? rawContent.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
    : String(rawContent);
}

function buildConversationContext(username: string, timezone: string, runtime: DustSessionRuntime) {
  return {
    username,
    timezone,
    origin: "cli",
    clientSideMCPServerIds: runtime.mcpServerId ? [runtime.mcpServerId] : null,
  };
}

async function ensureMcpServer(
  runtime: DustSessionRuntime,
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  if (runtime.mcpServerId) {
    return;
  }

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

async function createConversation(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  runtime: DustSessionRuntime,
  agentSId: string,
  userText: string,
  username: string,
  timezone: string,
): Promise<{ conversationSId: string; userMessageSId: string; agentMessageSId: string }> {
  const reqBody = {
    title: userText.substring(0, 50) + (userText.length > 50 ? "..." : ""),
    visibility: "unlisted",
    message: {
      content: userText,
      mentions: [{ configurationId: agentSId }],
      context: buildConversationContext(username, timezone, runtime),
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
  const conversationSId = data.conversation.sId;
  const userMessageSId = data.message.sId;
  runtime.conversationId = conversationSId;
  runtime.sessionContext.saveConversationId(conversationSId);

  return {
    conversationSId,
    userMessageSId,
    agentMessageSId: findAgentMessageSId(data.conversation.content, userMessageSId),
  };
}

async function postMessageToConversation(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  runtime: DustSessionRuntime,
  conversationSId: string,
  agentSId: string,
  userText: string,
  username: string,
  timezone: string,
): Promise<string> {
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
      context: buildConversationContext(username, timezone, runtime),
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
  return msgData.message.sId;
}

async function fetchConversationAgentMessageId(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  conversationSId: string,
  userMessageSId: string,
): Promise<string> {
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
  return findAgentMessageSId(convData.conversation.content, userMessageSId);
}

export function createDustStreamHandler(runtime: DustSessionRuntime) {
  async function handleToolApproveExecution(event: ToolApproveExecutionEvent): Promise<boolean> {
    if (event.stake === "never_ask") {
      return true;
    }
    const toolName = event.metadata?.toolName ?? "unknown";
    const inputs = event.inputs ?? {};
    return runtime.confirmFn(`Allow tool: ${toolName}`, buildConfirmMessage(toolName, inputs));
  }

  return function dustRealStream(
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

        // Refresh a little before expiry so a long-lived stream does not start with
        // a token that will expire in the middle of the Dust/MCP exchange.
        if (shouldRefreshAccessToken(liveCred.expires, STREAM_REFRESH_SKEW_MS)) {
          try {
            liveCred = await refreshToken(liveCred);
            runtime.sessionContext.setCredentials(liveCred);
            debugLog("dust:session", "Pre-stream token refresh succeeded");
          } catch (err) {
            if (isSessionExpiredError(err)) {
              invalidateRuntimeCredentials(runtime, liveCred);
              throw err;
            }
            console.error(`[dust] token refresh failed before stream: ${errorMessage(err)}`);
          }
        }

        const accessToken = liveCred.access ?? "";
        const workspaceId = liveCred.workspaceId ?? "";
        const region = liveCred.region ?? "us-central1";
        const username = liveCred.username ?? "unknown";
        const baseUrl = `${dustApiUrl(region)}/api/v1/w/${workspaceId}`;
        const agentSId = model.sId ?? "";
        debugLog("dust:session", "Resolved stream context", { workspaceId, region, baseUrl, agentSId, username });

        const authHeaders = buildAuthHeaders(accessToken);
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        await ensureMcpServer(runtime, baseUrl, authHeaders);

        const userText = extractUserText(context);
        debugLog("dust:session", "Prepared user message", { userText, currentConversationId: runtime.conversationId });

        let conversationSId: string;
        let userMessageSId: string;
        let agentMessageSId: string;

        if (!runtime.conversationId) {
          ({ conversationSId, userMessageSId, agentMessageSId } = await createConversation(
            baseUrl,
            authHeaders,
            signal,
            runtime,
            agentSId,
            userText,
            username,
            timezone,
          ));
        } else {
          conversationSId = runtime.conversationId;
          userMessageSId = await postMessageToConversation(
            baseUrl,
            authHeaders,
            signal,
            runtime,
            conversationSId,
            agentSId,
            userText,
            username,
            timezone,
          );
          agentMessageSId = await fetchConversationAgentMessageId(
            baseUrl,
            authHeaders,
            signal,
            conversationSId,
            userMessageSId,
          );
        }

        await streamEvents({
          baseUrl,
          conversationSId,
          agentMsgSId: agentMessageSId,
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
      } catch (error) {
        debugLog("dust:session", "Dust stream failed", { error: errorMessage(error) });
        if (isSessionExpiredError(error)) {
          invalidateRuntimeCredentials(runtime, liveCred);
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
  };
}
