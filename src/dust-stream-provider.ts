import { CANCELLED_MESSAGE, CANCELLED_TOOL_MESSAGE, DUST_HEADERS, MCP_TOOL_PREFIX, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { isAbortError, listenMcpRequests, registerMcpServer, startMcpHeartbeat } from "./dust-mcp.js";
import { createEventStream, findAgentMessageSId, isMissingAgentMessageError, makeEmptyMessage, streamEvents } from "./dust-stream.js";
import { buildConfirmMessage, executeMcpTool, getMcpTools } from "./dust-tools.js";
import { appendToolEntry } from "./dust-tool-render.js";
import type { ChatMessageLike, DustCredentials, DustModel, StreamContextLike, StreamOptionsLike, ToolApproveExecutionEvent } from "./dust-types.js";
import { errorMessage, isRecord, parseConversationCreateResponse, parseConversationFetchResponse, parsePostMessageResponse } from "./dust-validation.js";
import { invalidateRuntimeCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import type { ActiveDustTurn, DustSessionRuntime } from "./dust-runtime.js";

const STREAM_REFRESH_SKEW_MS = 30_000;
const CANCEL_REQUEST_TIMEOUT_MS = 10_000;
/** Grace for Dust to attach the agent message before the recovery re-reads. */
const AGENT_MESSAGE_RETRY_DELAY_MS = 500;

async function waitBeforeRetry(): Promise<true> {
  await new Promise((resolve) => setTimeout(resolve, AGENT_MESSAGE_RETRY_DELAY_MS));
  return true;
}

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
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
): Promise<void> {
  if (runtime.mcpServerId) {
    return;
  }

  const serverId = await registerMcpServer(baseUrl, authHeaders);
  runtime.mcpServerId = serverId;

  // The listener and heartbeat outlive the access token that registered the
  // server, so they must not close over the headers used above. Re-read the
  // stored credential each time and fall back to those headers only if nothing
  // is stored yet.
  const getAuthHeaders = (): Record<string, string> => {
    const access = runtime.sessionContext.getCredentials()?.access;
    return access ? buildAuthHeaders(access) : authHeaders;
  };

  runtime.mcpHeartbeatTimer = startMcpHeartbeat(baseUrl, getAuthHeaders, serverId);
  runtime.createApprovalGate();

  const abortController = new AbortController();
  runtime.mcpRequestsAbortController = abortController;
  listenMcpRequests({
    baseUrl,
    getAuthHeaders,
    serverId,
    abortController,
    buildConfirmMessage,
    getTools: () => getMcpTools(runtime.extensionContext as never),
    executeMcpTool: async (name, args) => {
      // Second line of defence behind the listener's own check: the turn can be
      // cancelled while a tool sits at the approval prompt, and running it then
      // would touch the user's machine for a turn they just stopped.
      if (runtime.isTurnCancelled()) {
        debugLog("dust:mcp", "Dropping tool call from a cancelled turn", { name });
        return { content: [{ type: "text", text: CANCELLED_TOOL_MESSAGE }], isError: true };
      }
      const startedAt = Date.now();
      const result = await executeMcpTool(
        name,
        args,
        runtime.extensionContext as never,
        runtime.activeTurn?.toolAbortController.signal,
      );
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
    isCancelledRequest: (requestId) => runtime.isCancelledRequest(requestId),
  }).catch((err) => {
    // Shutting the session down aborts the listener; that is not a failure.
    if (isAbortError(err, abortController.signal)) {
      debugLog("dust:mcp", "MCP listener stopped by abort");
      return;
    }
    console.error(`[dust:mcp] listenMcpRequests fatal: ${err}`);
    // If session expired, invalidate credentials so that the next stream attempt will trigger a re-login
    if (isSessionExpiredError(err)) {
      const credentials = runtime.sessionContext.getCredentials();
      if (credentials) {
        debugLog("dust:session", "MCP session expired, invalidating credentials in runtime context");
        invalidateRuntimeCredentials(runtime, credentials);
      } else {
        debugLog("dust:session", "Session expired but no credentials found in runtime context — nothing to invalidate");
      }
    }
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

/**
 * Hard-stops the Dust agent loop running under `messageIds`.
 *
 * Dust signals the agent's workflow, marks the messages cancelled and publishes
 * `agent_generation_cancelled`. Without this the loop keeps running server-side
 * after the user hits escape — still burning tokens and, worse, still asking our
 * MCP server to run local tools.
 *
 * Deliberately not tied to the turn's abort signal: it is sent *because* that
 * signal fired, so it must outlive it. Failures are logged, never thrown — the
 * turn is already over and there is nothing the user could do about them.
 */
export async function cancelMessageGeneration(
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
  conversationId: string,
  messageIds: string[],
  refreshAuth?: () => Promise<boolean>,
): Promise<void> {
  const url = `${baseUrl}/assistant/conversations/${conversationId}/cancel`;
  debugLog("dust:session", "Cancelling message generation", { conversationId, messageIds, url });

  const post = async (): Promise<Response> => fetch(url, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds }),
    signal: AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
  });

  try {
    let res = await post();
    // The turns most worth cancelling are the long ones, which are also the
    // ones most likely to have outlived the ~15 minute access token. Giving up
    // on the 401 would fail exactly when this matters most.
    if (res.status === 401 && refreshAuth && await refreshAuth()) {
      debugLog("dust:session", "Refreshed token after 401, retrying cancel", { conversationId });
      res = await post();
    }
    if (!res.ok) {
      debugLog("dust:session", "Cancel request failed", { status: res.status, conversationId, messageIds });
      return;
    }
    // Dust answers `{ success: true }`; anything else means the agent loop was
    // not signalled, which would otherwise pass silently as a 200.
    const body = await res.json().catch(() => null);
    if (!isRecord(body) || body.success !== true) {
      debugLog("dust:session", "Cancel request returned an unexpected body", { conversationId, body });
      return;
    }
    debugLog("dust:session", "Cancel request accepted", { conversationId, messageIds });
  } catch (error) {
    debugLog("dust:session", "Cancel request threw", { error: errorMessage(error), conversationId });
  }
}

/**
 * Cancels the agent message Dust spawned for `userMessageSId`, looking it up
 * first.
 *
 * Posting the user message is what starts the agent loop, so a turn cancelled
 * between that POST and learning the agent message's id still has a loop
 * running — with no id, the normal cancel path has nothing to send. Best effort
 * throughout: the lookup runs on its own timeout (the turn's signal is already
 * aborted) and every failure is logged rather than raised.
 */
export async function cancelPendingAgentMessage(
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
  conversationSId: string,
  userMessageSId: string,
  refreshAuth?: () => Promise<boolean>,
): Promise<string | null> {
  debugLog("dust:session", "Recovering agent message id to cancel", { conversationSId, userMessageSId });

  const lookup = async (): Promise<string> => fetchConversationAgentMessageId(
    baseUrl,
    getAuthHeaders(),
    AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
    conversationSId,
    userMessageSId,
  );

  let agentMessageSId: string;
  try {
    agentMessageSId = await lookup();
  } catch (error) {
    // Two failures worth telling apart. An expired token is fixable by
    // refreshing; a conversation that does not carry the agent message yet just
    // needs a moment, and that is exactly the window this recovery exists for,
    // so retrying beats giving up. Anything else is a transport failure.
    const retryable = isMissingAgentMessageError(error)
      ? await waitBeforeRetry()
      : isSessionExpiredError(error) && refreshAuth !== undefined && await refreshAuth();
    if (!retryable) {
      debugLog("dust:session", "Agent message lookup for cancel failed", {
        error: errorMessage(error),
        reason: isMissingAgentMessageError(error) ? "not-materialized" : "transport",
      });
      return null;
    }
    try {
      agentMessageSId = await lookup();
    } catch (retryError) {
      debugLog("dust:session", "Agent message lookup failed on retry", {
        error: errorMessage(retryError),
        reason: isMissingAgentMessageError(retryError) ? "not-materialized" : "transport",
      });
      return null;
    }
  }
  await cancelMessageGeneration(baseUrl, getAuthHeaders, conversationSId, [agentMessageSId], refreshAuth);
  return agentMessageSId;
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
    /** Filled in once the turn is armed; drained in `finally`. */
    const turnCleanup: {
      abortSignal: AbortSignal | null;
      onAbort: (() => void) | null;
      endTurn: (() => void) | null;
    } = { abortSignal: null, onAbort: null, endTurn: null };

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
            debugLog("dust:session", "Pre-stream token refresh delegated to host");
          } else {
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
        // event stream re-reads the stored token per request instead of pinning
        // the one this turn started with.
        const getAuthHeaders = (): Record<string, string> => {
          const current = runtime.sessionContext.getAccessToken();
          return current ? buildAuthHeaders(current) : authHeaders;
        };

        // Called after a 401: refresh through pi (which persists the rotation)
        // and fall back to a direct refresh. Returning false means the session
        // really is dead.
        const refreshAuth = async (): Promise<boolean> => {
          const hostToken = await runtime.sessionContext.resolveAccessToken();
          if (hostToken) return true;
          try {
            const refreshed = await refreshToken(runtime.sessionContext.getCredentials() ?? liveCred);
            runtime.sessionContext.setCredentials(refreshed);
            return Boolean(refreshed.access);
          } catch (err) {
            debugLog("dust:session", "Refresh after 401 failed", { error: errorMessage(err) });
            return false;
          }
        };

        await ensureMcpServer(runtime, baseUrl, authHeaders);

        const userText = extractUserText(context);
        const cwd = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
        const systemPrompt = [extractSystemPrompt(context), buildToolGuidance(cwd)]
          .filter((part) => part.length > 0)
          .join("\n\n");
        debugLog("dust:session", "Prepared user message", { userText, systemPrompt, currentConversationId: runtime.conversationId });

        let agentMessageSId: string;
        let conversationSId: string;
        let userMessageSId: string;

        /**
         * Arms cancellation for this turn. Called as soon as the user message is
         * accepted, because that POST is what starts the agent loop: from here
         * on escape has something real to stop, whether or not the agent message
         * id is known yet.
         */
        const startTurn = (turn: ActiveDustTurn): void => {
          const onAbort = () => {
            const cancelled = runtime.cancelActiveTurn();
            if (!cancelled) return;
            if (cancelled.agentMessageSId) {
              void cancelMessageGeneration(
                baseUrl,
                getAuthHeaders,
                cancelled.conversationSId,
                [cancelled.agentMessageSId],
                refreshAuth,
              );
            } else {
              // Cancelled before the lookup resolved: find the message first,
              // then remember it, so tool calls it emits later are refused too.
              void cancelPendingAgentMessage(
                baseUrl,
                getAuthHeaders,
                cancelled.conversationSId,
                cancelled.userMessageSId,
                refreshAuth,
              ).then((agentMessageSId) => {
                if (agentMessageSId) {
                  runtime.markAgentMessageCancelled(agentMessageSId);
                }
              });
            }
          };
          turnCleanup.onAbort = onAbort;
          if (signal) {
            // The turn may already have been cancelled while we were setting the
            // conversation up; addEventListener alone would never fire then.
            if (signal.aborted) {
              onAbort();
            } else {
              turnCleanup.abortSignal = signal;
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }
          turnCleanup.endTurn = () => runtime.endTurn(turn);
        };

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
          startTurn(runtime.beginTurn(conversationSId, userMessageSId, agentMessageSId));
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
          // Posting the user message is what starts the agent loop, so the turn
          // begins here rather than after the lookup below: escaping during that
          // lookup has to count as a cancellation, not as a turn that never was.
          const turn = runtime.beginTurn(conversationSId, userMessageSId);
          startTurn(turn);
          agentMessageSId = await fetchConversationAgentMessageId(
            baseUrl,
            authHeaders,
            signal,
            conversationSId,
            userMessageSId,
          );
          turn.agentMessageSId = agentMessageSId;
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
          // Approving is two awaits long (the dialog, then validate-action), so
          // the turn can be cancelled underneath it. Recording then would put an
          // entry back into a queue `cancelActiveTurn` had just cleared, where
          // it would positionally approve some later turn's tool call.
          recordPreApproval: (actionId, approved) => {
            if (runtime.isTurnCancelled()) {
              debugLog("dust:session", "Dropping pre-approval for a cancelled turn", { actionId });
              return;
            }
            runtime.preApprovedActions.set(actionId, approved);
          },
          resolveApprovalGate: () => runtime.resolveApprovalGate(),
          // Dust stopped the loop itself; no cancel request to send, but the
          // turn is over and any tool call still in flight must be refused.
          onCancelled: () => { runtime.cancelActiveTurn(); },
        });
      } catch (error) {
        // Aborting mid-setup (before the SSE stream owns the abort) surfaces as
        // a rejected fetch. That is the user cancelling, not a failure.
        const aborted = options?.signal?.aborted === true;
        debugLog("dust:session", aborted ? "Dust stream aborted" : "Dust stream failed", { error: errorMessage(error) });
        if (!aborted && isSessionExpiredError(error)) {
          invalidateRuntimeCredentials(runtime, liveCred);
        }
        const message = makeEmptyMessage(model);
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = aborted ? CANCELLED_MESSAGE : errorMessage(error);
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        stream.end();
      } finally {
        runtime.resolveApprovalGate();
        const { abortSignal, onAbort, endTurn } = turnCleanup;
        if (abortSignal && onAbort) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        endTurn?.();
      }
    })();

    return stream;
  };
}
