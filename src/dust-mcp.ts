import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type { JsonObject } from "./dust-types.js";
import { parseMcpRegisterResponse, parseMcpRequest, isRecord } from "./dust-validation.js";
import { MCP_TOOLS, type McpToolResult } from "./dust-tools.js";

export async function registerMcpServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  debugLog("dust:mcp", "Registering MCP server", { baseUrl });
  const res = await fetch(`${baseUrl}/mcp/register`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ serverName: "pi-dust-extension" }),
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
  authHeaders: Record<string, string>,
  serverId: string,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      debugLog("dust:mcp", "Sending MCP heartbeat", { serverId });
      await fetch(`${baseUrl}/mcp/heartbeat`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
    } catch {
      // heartbeat failures are non-fatal
    }
  }, 5 * 60 * 1000);
}

interface ListenMcpRequestsOptions {
  baseUrl: string;
  authHeaders: Record<string, string>;
  serverId: string;
  abortController: AbortController;
  buildConfirmMessage: (toolName: string, args: JsonObject) => string;
  executeMcpTool: (name: string, args: JsonObject) => McpToolResult;
  getConfirmFn: () => (title: string, message: string) => Promise<boolean>;
  getPendingApprovalPromise: () => Promise<void> | null;
  preApprovedActions: Map<string, boolean>;
}

export async function listenMcpRequests({
  baseUrl,
  authHeaders,
  serverId,
  abortController,
  buildConfirmMessage,
  executeMcpTool,
  getConfirmFn,
  getPendingApprovalPromise,
  preApprovedActions,
}: ListenMcpRequestsOptions): Promise<void> {
  const url = `${baseUrl}/mcp/requests?serverId=${encodeURIComponent(serverId)}`;
  let lastEventId: string | null = null;

  while (!abortController.signal.aborted) {
    const reqUrl = lastEventId ? `${url}&lastEventId=${encodeURIComponent(lastEventId)}` : url;

    let res: Response;
    try {
      res = await fetch(reqUrl, {
        headers: { ...authHeaders, Accept: "text/event-stream" },
        signal: abortController.signal,
      });
    } catch {
      return;
    }

    if (!res.ok || !res.body) {
      console.error(`[dust:mcp] SSE non-ok response: HTTP ${res.status}`);
      debugLog("dust:mcp", "MCP SSE non-ok response", { status: res.status });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        abortController.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      continue;
    }

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
              if (line.startsWith("id:")) {
                lastEventId = line.slice(3).trim();
              }
            }

            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json) continue;

              let parsed: unknown;
              try {
                parsed = JSON.parse(json);
              } catch {
                continue;
              }

              const request = parseMcpRequest(parsed);
              if (!request) continue;
              debugLog("dust:mcp", "Received MCP request", request);

              if (request.method === "initialize") {
                const responseMsg = {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "pi-dust-extension", version: "0.1.0" },
                  },
                };
                await fetch(`${baseUrl}/mcp/results`, {
                  method: "POST",
                  headers: { ...authHeaders, "Content-Type": "application/json" },
                  body: JSON.stringify({ result: responseMsg, serverId }),
                }).catch((error) => { console.error(`[dust:mcp] results POST error: ${error}`); });
                debugLog("dust:mcp", "Posted initialize result", responseMsg);
              } else if (request.method === "tools/list") {
                const responseMsg = {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { tools: MCP_TOOLS },
                };
                await fetch(`${baseUrl}/mcp/results`, {
                  method: "POST",
                  headers: { ...authHeaders, "Content-Type": "application/json" },
                  body: JSON.stringify({ result: responseMsg, serverId }),
                }).catch((error) => { console.error(`[dust:mcp] results POST error: ${error}`); });
                debugLog("dust:mcp", "Posted tools/list result", { toolCount: MCP_TOOLS.length });
              } else if (request.method === "tools/call") {
                const toolName = typeof request.params?.name === "string" ? request.params.name : "";
                const toolArgs = isRecord(request.params?.arguments) ? request.params.arguments : {};
                const pendingApprovalPromise = getPendingApprovalPromise();
                if (pendingApprovalPromise !== null) {
                  await pendingApprovalPromise;
                }

                let allowed: boolean;
                if (preApprovedActions.size > 0) {
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

                const toolResult = allowed
                  ? executeMcpTool(toolName, toolArgs)
                  : { content: [{ type: "text", text: "Tool execution denied by user." }], isError: true };

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
                  headers: { ...authHeaders, "Content-Type": "application/json" },
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
    } finally {
      reader.releaseLock();
    }
  }
}
