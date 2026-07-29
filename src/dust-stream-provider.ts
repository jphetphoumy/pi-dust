import { DUST_HEADERS, MCP_REGISTRATION_LOST_MESSAGE, MCP_TOOL_PREFIX, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { isAbortError, listenMcpRequests, registerMcpServer, startMcpHeartbeat } from "./dust-mcp.js";
import { createEventStream, findAgentMessageSId, makeEmptyMessage, streamEvents } from "./dust-stream.js";
import { buildConfirmMessage, executeMcpTool, getMcpTools } from "./dust-tools.js";
import { appendToolEntry } from "./dust-tool-render.js";
import type { ChatMessageLike, DustCredentials, DustModel, StreamContextLike, StreamOptionsLike, ToolApproveExecutionEvent } from "./dust-types.js";
import { errorMessage, parseConversationCreateResponse, parseConversationFetchResponse, parsePostMessageResponse } from "./dust-validation.js";
import { invalidateRuntimeCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import type { DustSessionRuntime } from "./dust-runtime.js";

const STREAM_REFRESH_SKEW_MS = 30_000;

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

function isRegistrationLostError(error: unknown): boolean {
  return error instanceof Error && error.message === MCP_REGISTRATION_LOST_MESSAGE;
}

function buildAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...DUST_HEADERS,
  };
}

function extractMessageText(message: ChatMessageLike): string {
  const rawContent = message.content ?? "";
  return Array.isArray(rawContent)
    ? rawContent.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
    : String(rawContent);
}

function extractUserText(context: StreamContextLike): string {
  const messages = context?.messages ?? [];
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  return lastUserMessage ? extractMessageText(lastUserMessage) : "";
}

function extractSystemPrompt(context: StreamContextLike): string {
  return context?.systemPrompt ?? "";
}

/**
 * Steers the agent towards the local tools.
 *
 * Dust ships an internal `files` MCP server whose `files__create` / `files__edit`
 * tools write to the conversation's own storage — that is what produces a
 * download link instead of a file on disk. Those run server-side and never reach
 * our MCP server, and the message API exposes no way to disable or redirect
 * them, so the only lever is telling the agent which tool to reach for.
 */
function buildToolGuidance(cwd: string): string {
  return [
    "Tool usage rules for this session:",
    `- You are driving a CLI on the user's own machine, working directory: ${cwd}.`,
    `- Files the user asks for are LOCAL files. Always use the \`${MCP_TOOL_PREFIX}__*\` tools:`,
    `  \`${MCP_TOOL_PREFIX}__write\` to create or overwrite, \`${MCP_TOOL_PREFIX}__edit\` to modify,`,
    `  \`${MCP_TOOL_PREFIX}__read\` to read, \`${MCP_TOOL_PREFIX}__bash\` to run commands.`,
    "- NEVER use `files__create`, `files__edit` or any other `files__*` tool for the user's files:",
    "  those write to Dust conversation storage, not to the user's machine, and the user cannot use them.",
    "- Do not create files with bash heredocs; use the write tool.",
  ].join("\n");
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
  refreshAuth: () => Promise<boolean>,
): Promise<void> {
  if (runtime.mcpServerId) {
    return;
  }

  const serverId = await registerMcpServer(baseUrl, authHeaders);
  runtime.mcpServerId = serverId;

  // The listener and heartbeat outlive the access token that registered the
  // server, so they must not close over the headers used above. Prefer a
  // freshly refreshed token held in memory (see `refreshedAccessToken` on
  // DustSessionRuntime — `setCredentials` cannot persist it), then the stored
  // credential, and fall back to those headers only if nothing is available.
  const getAuthHeaders = (): Record<string, string> => {
    const access = runtime.refreshedAccessToken || runtime.sessionContext.getCredentials()?.access;
    return access ? buildAuthHeaders(access) : authHeaders;
  };

  // Registration lapsed server-side (heartbeat got a 403/404, or the listener
  // reconnect did): nothing left to talk to. Clear the runtime's MCP state so
  // the next turn's ensureMcpServer call re-registers and reconnects, instead
  // of short-circuiting on a dead `mcpServerId` forever.
  //
  // This callback is bound to `serverId` from this specific registration. A
  // stale beat can still be in flight after a newer registration replaced
  // this one (heartbeat A's fetch resolves after listener A already lost its
  // registration and a fresh B took over) — without the identity check, A's
  // late callback would tear down B's live server mid-turn.
  const onRegistrationLost = (): void => {
    if (runtime.mcpServerId !== serverId) {
      debugLog("dust:mcp", "Ignoring registration-lost signal from a superseded MCP heartbeat", { serverId });
      return;
    }
    debugLog("dust:mcp", "MCP registration lost, clearing runtime state for re-registration");
    runtime.clearMcpState();
  };

  runtime.mcpHeartbeatTimer = startMcpHeartbeat(baseUrl, getAuthHeaders, serverId, refreshAuth, onRegistrationLost);
  runtime.createApprovalGate();

  const abortController = new AbortController();
  runtime.mcpRequestsAbortController = abortController;
  listenMcpRequests({
    baseUrl,
    getAuthHeaders,
    refreshAuth,
    serverId,
    abortController,
    buildConfirmMessage,
    getTools: () => getMcpTools(runtime.extensionContext as never),
    executeMcpTool: async (name, args) => {
      const startedAt = Date.now();
      const result = await executeMcpTool(name, args, runtime.extensionContext as never);
      // Dust tool calls bypass pi's tool pipeline, so nothing would appear in
      // the transcript. Record the call so it renders like a native one.
      if (runtime.pi) {
        appendToolEntry(
          runtime.pi,
          name,
          args,
          result,
          Date.now() - startedAt,
          (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd(),
        );
      }
      return result;
    },
    getConfirmFn: () => runtime.confirmFn,
    getPendingApprovalPromise: () => runtime.pendingApprovalPromise,
    preApprovedActions: runtime.preApprovedActions,
  }).catch((err) => {
    // Shutting the session down aborts the listener; that is not a failure.
    if (isAbortError(err, abortController.signal)) {
      debugLog("dust:mcp", "MCP listener stopped by abort");
      return;
    }
    // This listener is bound to `serverId` from its own registration. A later
    // turn's registration may have already superseded it (its own SSE 404
    // fired and cleared state, and a fresh one started) before this rejection
    // was handled — acting on a stale failure here would tear down the fresh
    // registration or invalidate still-valid credentials that belong to it.
    if (runtime.mcpServerId !== serverId) {
      debugLog("dust:mcp", "Ignoring failure from a superseded MCP listener", { serverId, error: String(err) });
      return;
    }

    if (isRegistrationLostError(err)) {
      // Self-healing: the next turn's ensureMcpServer re-registers, so this
      // is not a "fatal" condition worth logging as an error.
      debugLog("dust:mcp", "MCP registration lost, clearing runtime state for re-registration", { serverId });
      runtime.clearMcpState();
      return;
    }

    console.error(`[dust:mcp] listenMcpRequests fatal: ${err}`);
    // Session expired means the refresh attempted inside listenMcpRequests
    // already failed — only now is it safe to invalidate credentials and
    // force a re-login. invalidateRuntimeCredentials also clears MCP state.
    if (isSessionExpiredError(err)) {
      const credentials = runtime.sessionContext.getCredentials();
      if (credentials) {
        debugLog("dust:session", "MCP session expired after failed refresh, invalidating credentials in runtime context");
        invalidateRuntimeCredentials(runtime, credentials);
      } else {
        debugLog("dust:session", "Session expired but no credentials found in runtime context — clearing MCP state only");
        runtime.clearMcpState();
      }
      return;
    }
    // Any other unexpected terminal exit must not leave a dead
    // mcpServerId/heartbeat/abort controller behind — clear them so the next
    // turn re-registers instead of running toolless.
    runtime.clearMcpState();
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
  systemPrompt?: string,
): Promise<{ conversationSId: string; userMessageSId: string; agentMessageSId: string }> {
  const messageContent = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;
  const reqBody = {
    title: userText.substring(0, 50) + (userText.length > 50 ? "..." : ""),
    visibility: "unlisted",
    message: {
      content: messageContent,
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
          // Prefer pi's own refresh: it runs our `oauth.refreshToken` hook and
          // persists the rotated token. Refreshing directly would rotate the
          // refresh token and discard it, since we can no longer write auth.json.
          const hostToken = await runtime.sessionContext.resolveAccessToken();
          if (hostToken) {
            liveCred = { ...(runtime.sessionContext.getCredentials() ?? liveCred), access: hostToken };
            runtime.refreshedAccessToken = hostToken;
            debugLog("dust:session", "Pre-stream token refresh delegated to host");
          } else {
            try {
              liveCred = await refreshToken(liveCred);
              runtime.sessionContext.setCredentials(liveCred);
              // setCredentials (persistCredentialState) drops the token trio —
              // it never reaches auth.json — so without this, every later
              // getAuthHeaders() would keep reading the old, still-expired
              // token back out of storage.
              if (liveCred.access) {
                runtime.refreshedAccessToken = liveCred.access;
              }
              debugLog("dust:session", "Pre-stream token refresh succeeded");
            } catch (err) {
              if (isSessionExpiredError(err)) {
                invalidateRuntimeCredentials(runtime, liveCred);
                throw err;
              }
              console.error(`[dust] token refresh failed before stream: ${errorMessage(err)}`);
            }
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

        // A turn can outlive the ~15 minute access token, so the long-lived
        // event stream re-reads the current token per request instead of
        // pinning the one this turn started with. A refresh done through the
        // direct fallback below lives only in `refreshedAccessToken` — it
        // never reaches storage — so that takes priority over the stored one.
        const getAuthHeaders = (): Record<string, string> => {
          const current = runtime.refreshedAccessToken || runtime.sessionContext.getAccessToken();
          return current ? buildAuthHeaders(current) : authHeaders;
        };

        // Called after a 401: refresh through pi (which persists the rotation)
        // and fall back to a direct refresh. Returning false means the session
        // really is dead.
        const refreshAuth = async (): Promise<boolean> => {
          const hostToken = await runtime.sessionContext.resolveAccessToken();
          if (hostToken) {
            runtime.refreshedAccessToken = hostToken;
            return true;
          }
          try {
            const refreshed = await refreshToken(runtime.sessionContext.getCredentials() ?? liveCred);
            runtime.sessionContext.setCredentials(refreshed);
            // persistCredentialState drops access/refresh/expires (auth.json
            // is pi-owned, we can no longer write it), so the rotated token
            // would otherwise vanish the instant it's "saved": every later
            // getAuthHeaders() call — ours and the MCP listener/heartbeat's —
            // would keep re-reading the same expired token from storage and
            // loop straight back into the same 401.
            if (refreshed.access) {
              runtime.refreshedAccessToken = refreshed.access;
            }
            return Boolean(refreshed.access);
          } catch (err) {
            debugLog("dust:session", "Refresh after 401 failed", { error: errorMessage(err) });
            return false;
          }
        };

        await ensureMcpServer(runtime, baseUrl, authHeaders, refreshAuth);

        const userText = extractUserText(context);
        const cwd = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
        const systemPrompt = [extractSystemPrompt(context), buildToolGuidance(cwd)]
          .filter((part) => part.length > 0)
          .join("\n\n");
        debugLog("dust:session", "Prepared user message", { userText, systemPrompt, currentConversationId: runtime.conversationId });

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
            systemPrompt || undefined,
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
          getAuthHeaders,
          refreshAuth,
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
