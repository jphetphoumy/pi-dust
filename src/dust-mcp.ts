import { CANCELLED_TOOL_MESSAGE, DUST_MCP_PROTOCOL_VERSION, MCP_REGISTRATION_LOST_MESSAGE, MCP_SERVER_NAME, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type { JsonObject } from "./dust-types.js";
import { parseMcpRegisterResponse, parseMcpRequest, isRecord } from "./dust-validation.js";
import { type McpToolResult } from "./dust-tools.js";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

// Dust closes the MCP requests SSE stream after ~5 minutes server-side (see
// the `data: done` handling below). A heartbeat interval equal to that window
// races the boundary: the two loops jitter independently, so either can fire
// microseconds after the other and look like the server closed the
// registration out from under a live heartbeat. Keeping the heartbeat
// comfortably shorter — with a bit of jitter so many sessions started at once
// do not all beat in lockstep — keeps it clear of the edge.
const HEARTBEAT_BASE_INTERVAL_MS = 4 * 60 * 1000;
const HEARTBEAT_JITTER_MS = 30_000;

function heartbeatIntervalMs(): number {
  return HEARTBEAT_BASE_INTERVAL_MS + Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
}

// At most one refresh attempt per connect per this window. A plain "have we
// refreshed yet" boolean only resets on a fully successful connect, so a run
// of retryable failures (503s, empty bodies) between a refresh and the next
// 401 would never reset it — minutes later, a genuine 401 would be treated as
// fatal without ever trying a refresh that would have worked. Gating by
// elapsed time instead means a 401 far enough past the last attempt always
// gets a fresh try, while a tight double-401 still only refreshes once.
const REFRESH_RETRY_COOLDOWN_MS = 60_000;

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
  refreshAuth: () => Promise<boolean>,
  onRegistrationLost: () => void,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      debugLog("dust:mcp", "Sending MCP heartbeat", { serverId });
      // Headers are resolved per beat: this outlives the access token, and a
      // stale one lets the registration lapse, taking the tools with it.
      const res = await fetch(`${baseUrl}/mcp/heartbeat`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          // The access token aged out between beats. Refresh so the next tick
          // (and getAuthHeaders() everywhere else) picks up a live token —
          // there is nothing to retry immediately, the beat itself is best-effort.
          debugLog("dust:mcp", "MCP heartbeat unauthorized, refreshing token", { status: res.status });
          await refreshAuth();
          return;
        }
        if (res.status === 403 || res.status === 404) {
          // The server-side registration is gone (e.g. it lapsed while this
          // beat was stale). Nothing left to heartbeat — tell the caller so it
          // can clear state and let the next turn re-register.
          debugLog("dust:mcp", "MCP heartbeat registration lost", { status: res.status });
          onRegistrationLost();
          return;
        }
        debugLog("dust:mcp", "MCP heartbeat non-ok response", { status: res.status });
      }
    } catch (error) {
      debugLog("dust:mcp", "MCP heartbeat request failed", { error: String(error) });
      // Network-level heartbeat failures are non-fatal; the next beat retries.
    }
  }, heartbeatIntervalMs());
}

interface ListenMcpRequestsOptions {
  baseUrl: string;
  /** Resolved per request: the token rotates during a long session. */
  getAuthHeaders: () => Record<string, string>;
  /**
   * Attempts a token refresh after a 401 on connect. Returns true if a retry
   * is worthwhile. Mirrors `streamEvents`'s `refreshAuth` (dust-stream.ts) —
   * same fallback chain, reused rather than reimplemented.
   */
  refreshAuth: () => Promise<boolean>;
  serverId: string;
  abortController: AbortController;
  buildConfirmMessage: (toolName: string, args: JsonObject) => string;
  getTools: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  executeMcpTool: (name: string, args: JsonObject) => Promise<McpToolResult>;
  getConfirmFn: () => (title: string, message: string) => Promise<boolean>;
  getPendingApprovalPromise: () => Promise<void> | null;
  preApprovedActions: Map<string, boolean>;
  /**
   * True when the tool call belongs to a turn the user cancelled — matched on
   * the request id where possible, falling back to the current turn. Required
   * rather than defaulted: a missing check here means tool calls from a
   * cancelled turn run on the user's machine, so it must not fail open.
   */
  isCancelledRequest: (requestId: unknown) => boolean;
}

export async function listenMcpRequests({
  baseUrl,
  getAuthHeaders,
  refreshAuth,
  serverId,
  abortController,
  buildConfirmMessage,
  getTools,
  executeMcpTool,
  getConfirmFn,
  getPendingApprovalPromise,
  preApprovedActions,
  isCancelledRequest,
}: ListenMcpRequestsOptions): Promise<void> {
  const url = `${baseUrl}/mcp/requests?serverId=${encodeURIComponent(serverId)}`;
  let lastEventId: string | null = null;
  let reconnectAttempt = 0;
  let lastRefreshAttemptAt = 0;

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
        // Dust access tokens live ~15 minutes, well under the ~5 minute
        // interval Dust closes this stream at, so a 401 here usually means
        // the token aged out rather than that the session is dead. Refresh
        // once through the same fallback chain streamEvents uses and retry
        // the connect; only give up if the refresh itself fails. The cooldown
        // is tracked by elapsed time rather than a "have we already tried"
        // flag, so a 401 that shows up long after the last attempt (even one
        // separated by a run of retryable 503s/empty bodies) still gets its
        // own refresh instead of being declared fatal on the spot.
        const now = Date.now();
        if (now - lastRefreshAttemptAt > REFRESH_RETRY_COOLDOWN_MS) {
          lastRefreshAttemptAt = now;
          if (await refreshAuth()) {
            debugLog("dust:mcp", "Refreshed token after MCP SSE 401, retrying connect");
            continue;
          }
        }
        debugLog("dust:mcp", "MCP SSE session expired", { status: res.status });
        throw new Error(SESSION_EXPIRED_MESSAGE);
      }
      if (res.status === 403 || res.status === 404) {
        // The server-side registration itself is gone — reconnecting with a
        // fresh token would not help. Throw instead of silently returning so
        // the caller can clear runtime state and let the next turn
        // re-register, rather than the tools disappearing with no trace.
        debugLog("dust:mcp", "MCP SSE registration lost", { status: res.status });
        throw new Error(MCP_REGISTRATION_LOST_MESSAGE);
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
    // A connect that actually succeeds earns a fresh refresh budget: the
    // cooldown above is meant to survive a run of retryable failures between
    // one refresh and the next 401, not to stay latched after a perfectly
    // good connection that later closes early (a transient drop, or Dust's
    // early `done` sentinel) and immediately hits a 401 of its own.
    lastRefreshAttemptAt = 0;

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

                // The gate above is resolved unconditionally by
                // `clearMcpState()` (registration lost, or a session switch
                // abandoning this listener entirely) so that a parked waiter
                // doesn't hang forever — but waking up is not the same as
                // still being wanted. Without this check, a listener that
                // wakes up aborted would go on to prompt for and EXECUTE the
                // tool call regardless, then POST the result to a
                // registration that's already gone (or, on a session switch,
                // to whatever session is live now instead of the one that
                // asked). This is distinct from a cancelled *turn* below: the
                // listener itself is done for, so there is no one left to
                // post a result to either way.
                if (abortController.signal.aborted) {
                  debugLog("dust:mcp", "MCP listener aborted while parked on the approval gate, skipping tool execution", { toolName });
                  return;
                }

                // A cancelled turn can still have tool calls in flight: Dust
                // queued them before our cancel reached the agent loop. Refusing
                // them up front also keeps the approval prompt from popping up
                // for a turn the user just stopped. The listener itself is
                // still alive here (the check above already returned if not),
                // so this still POSTs a real refusal result back to Dust.
                let allowed: boolean;
                const cancelled = isCancelledRequest(request.id);
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
