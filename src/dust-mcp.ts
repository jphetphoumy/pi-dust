import { CANCELLED_TOOL_MESSAGE, DUST_MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type { JsonObject } from "./dust-types.js";
import { parseMcpRegisterResponse, parseMcpRequest, isRecord } from "./dust-validation.js";
import { type McpToolResult } from "./dust-tools.js";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

/** True when an error is just this listener being shut down. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function retryDelay(attempt: number): number {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function registerMcpServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  debugLog("dust:mcp", "Registering MCP server", { baseUrl });
  const res = await fetch(`${baseUrl}/mcp/register`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ serverName: MCP_SERVER_NAME }),
  });
  if (!res.ok) {
    debugLog("dust:mcp", "MCP register failed", { status: res.status });
    if (res.status === 401) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`MCP register failed: HTTP ${res.status}`);
  }
  const data = parseMcpRegisterResponse(await res.json());
  debugLog("dust:mcp", "MCP register succeeded", data);
  return data.serverId;
}

export function startMcpHeartbeat(
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
  serverId: string,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      debugLog("dust:mcp", "Sending MCP heartbeat", { serverId });
      // Headers are resolved per beat: this outlives the access token, and a
      // stale one lets the registration lapse, taking the tools with it.
      await fetch(`${baseUrl}/mcp/heartbeat`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
    } catch {
      // heartbeat failures are non-fatal
    }
  }, 5 * 60 * 1000);
}

interface ListenMcpRequestsOptions {
  baseUrl: string;
  /** Resolved per request: the token rotates during a long session. */
  getAuthHeaders: () => Record<string, string>;
  serverId: string;
  abortController: AbortController;
  buildConfirmMessage: (toolName: string, args: JsonObject) => string;
  getTools: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  executeMcpTool: (name: string, args: JsonObject) => Promise<McpToolResult>;
  getConfirmFn: () => (title: string, message: string) => Promise<boolean>;
  getPendingApprovalPromise: () => Promise<void> | null;
  preApprovedActions: Map<string, boolean>;
  /**
   * True once the user cancelled the turn the tool call belongs to. Required
   * rather than defaulted: a missing check here means tool calls from a
   * cancelled turn run on the user's machine, so it must not fail open.
   */
  isTurnCancelled: () => boolean;
}

export async function listenMcpRequests({
  baseUrl,
  getAuthHeaders,
  serverId,
  abortController,
  buildConfirmMessage,
  getTools,
  executeMcpTool,
  getConfirmFn,
  getPendingApprovalPromise,
  preApprovedActions,
  isTurnCancelled,
}: ListenMcpRequestsOptions): Promise<void> {
  const url = `${baseUrl}/mcp/requests?serverId=${encodeURIComponent(serverId)}`;
  let lastEventId: string | null = null;
  let reconnectAttempt = 0;

  while (!abortController.signal.aborted) {
    const reqUrl = lastEventId ? `${url}&lastEventId=${encodeURIComponent(lastEventId)}` : url;

    let res: Response;
    try {
      res = await fetch(reqUrl, {
        headers: { ...getAuthHeaders(), Accept: "text/event-stream" },
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      const delayMs = retryDelay(reconnectAttempt);
      debugLog("dust:mcp", "MCP SSE request failed, retrying", { error: String(error), delayMs, attempt: reconnectAttempt + 1 });
      await waitForRetry(delayMs, abortController.signal);
      reconnectAttempt += 1;
      continue;
    }

    if (!res.ok) {
      if (res.status === 401) {
        debugLog("dust:mcp", "MCP SSE session expired", { status: res.status });
        throw new Error(SESSION_EXPIRED_MESSAGE);
      }
      if (res.status === 403 || res.status === 404) {
        debugLog("dust:mcp", "MCP SSE terminal error, aborting", { status: res.status });
        abortController.abort();
        return;
      }
      const delayMs = retryDelay(reconnectAttempt);
      debugLog("dust:mcp", "MCP SSE non-ok response, retrying", { status: res.status, delayMs, attempt: reconnectAttempt + 1 });
      await waitForRetry(delayMs, abortController.signal);
      reconnectAttempt += 1;
      continue;
    }
    if (!res.body) {
      const delayMs = retryDelay(reconnectAttempt);
      debugLog("dust:mcp", "MCP SSE empty body, retrying", { delayMs, attempt: reconnectAttempt + 1 });
      await waitForRetry(delayMs, abortController.signal);
      reconnectAttempt += 1;
      continue;
    }

    reconnectAttempt = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json) continue;

              // Dust closes each stream with a plain `data: done` sentinel after
              // its 5 minute server-side timeout. It is not JSON.
              if (json === "done") {
                debugLog("dust:mcp", "MCP SSE received done sentinel, reconnecting");
                continue;
              }

              let parsed: unknown;
              try {
                parsed = JSON.parse(json);
              } catch {
                continue;
              }

              // Dust never emits SSE `id:` lines — the cursor rides inside the
              // JSON envelope as `eventId`. Reading `id:` lines left lastEventId
              // null forever, so every reconnect replayed the Redis stream from
              // the beginning and re-delivered past tools/call requests.
              if (isRecord(parsed) && typeof parsed.eventId === "string") {
                lastEventId = parsed.eventId;
              }

              const request = parseMcpRequest(parsed);
              if (!request) continue;
              debugLog("dust:mcp", "Received MCP request", request);

              if (request.method === "initialize") {
                const responseMsg = {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    protocolVersion: DUST_MCP_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: MCP_SERVER_NAME, version: "0.1.0" },
                  },
                };
                await fetch(`${baseUrl}/mcp/results`, {
                  method: "POST",
                  headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                  body: JSON.stringify({ result: responseMsg, serverId }),
                }).catch((error) => { console.error(`[dust:mcp] results POST error: ${error}`); });
                debugLog("dust:mcp", "Posted initialize result", responseMsg);
              } else if (request.method === "tools/list") {
                const responseMsg = {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { tools: getTools() },
                };
                await fetch(`${baseUrl}/mcp/results`, {
                  method: "POST",
                  headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                  body: JSON.stringify({ result: responseMsg, serverId }),
                }).catch((error) => { console.error(`[dust:mcp] results POST error: ${error}`); });
                debugLog("dust:mcp", "Posted tools/list result", { toolCount: getTools().length });
              } else if (request.method === "tools/call") {
                const toolName = typeof request.params?.name === "string" ? request.params.name : "";
                const toolArgs = isRecord(request.params?.arguments) ? request.params.arguments : {};
                const pendingApprovalPromise = getPendingApprovalPromise();
                if (pendingApprovalPromise !== null) {
                  await pendingApprovalPromise;
                }

                // A cancelled turn can still have tool calls in flight: Dust
                // queued them before our cancel reached the agent loop. Refusing
                // them up front also keeps the approval prompt from popping up
                // for a turn the user just stopped.
                let allowed: boolean;
                const cancelled = isTurnCancelled();
                if (cancelled) {
                  debugLog("dust:mcp", "Refusing tool call from a cancelled turn", { toolName });
                  allowed = false;
                } else if (preApprovedActions.size > 0) {
                  const firstEntry = preApprovedActions.entries().next();
                  if (firstEntry.done) {
                    allowed = await getConfirmFn()(
                      `Dust agent wants to run: ${toolName}`,
                      buildConfirmMessage(toolName, toolArgs),
                    );
                  } else {
                    const [firstKey, firstValue] = firstEntry.value;
                    preApprovedActions.delete(firstKey);
                    allowed = firstValue;
                  }
                } else {
                  allowed = await getConfirmFn()(
                    `Dust agent wants to run: ${toolName}`,
                    buildConfirmMessage(toolName, toolArgs),
                  );
                }

                const refusalText = cancelled ? CANCELLED_TOOL_MESSAGE : "Tool execution denied by user.";
                const toolResult = allowed
                  ? await executeMcpTool(toolName, toolArgs)
                  : { content: [{ type: "text", text: refusalText }], isError: true };

                const responseMsg = {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    content: toolResult.content,
                    isError: toolResult.isError,
                  },
                };
                await fetch(`${baseUrl}/mcp/results`, {
                  method: "POST",
                  headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                  body: JSON.stringify({ result: responseMsg, serverId }),
                }).catch((error) => { console.error(`[dust:mcp] results POST error: ${error}`); });
                debugLog("dust:mcp", "Posted tools/call result", {
                  toolName,
                  allowed,
                  isError: toolResult.isError,
                  content: toolResult.content,
                });
              }
            }
          }
        }
        if (done) break;
      }
    } catch (error) {
      // Tearing the session down aborts this stream, which rejects the pending
      // read. That is ordinary shutdown, not a failure — without this the abort
      // escaped and was reported as "listenMcpRequests fatal".
      if (isAbortError(error, abortController.signal)) {
        debugLog("dust:mcp", "MCP SSE aborted, stopping listener");
        return;
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
