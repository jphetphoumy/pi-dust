import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WORKOS_DOMAIN = "api.workos.com";
const WORKOS_CLIENT_ID = "client_01JGCT55T7FVDG9XF74925R1KT";
const REGION_CLAIM = "https://dust.tt/region";
const DUST_US_URL = "https://dust.tt";
const DUST_EU_URL = "https://eu.dust.tt";
const DUST_CLI_VERSION = "0.4.4";

const DUST_HEADERS = {
  "User-Agent": "Dust CLI",
  "X-Dust-CLI-Version": DUST_CLI_VERSION,
};

type Workspace = { sId: string; name: string; role: string };
type DustAgent = { sId: string; name: string; description: string };

// In-memory conversation ID for the current pi session.
// Null means "no conversation yet" → next streamSimple call will create one.
// Persisted across restarts in cred.conversations[sessionFile].
let currentConversationId: string | null = null;

// MCP server state — one server per conversation session.
let currentMcpServerId: string | null = null;
let mcpHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let mcpRequestsAbortController: AbortController | null = null;

// Dynamically-updated session context. Updated on session_start and session_switch
// so that dustRealStream always reads the current session file at call time — not
// the one that was active when the extension first loaded.
let currentSessionContext: {
  getSessionFile: () => string | undefined;
  saveConversationId: (id: string) => void;
  getCredentials: () => any;
  setCredentials: (cred: any) => void;
} = {
  getSessionFile: () => undefined,
  saveConversationId: () => { /* no-op until session_start wires it up */ },
  getCredentials: () => null,
  setCredentials: () => { /* no-op until session_start wires it up */ },
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

function workspaceLabel(ws: Workspace): string {
  return `${ws.name} (${ws.role})`;
}

function dustApiUrl(region: string): string {
  return region === "europe-west1" ? DUST_EU_URL : DUST_US_URL;
}

/** Convert an agent name to a URL/display-safe slug, e.g. "AgentSonnet" → "agent-sonnet". */
function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")   // CamelCase → camel-case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2") // e.g. "MyHTTPClient" → "My-HTTP-Client"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")            // non-alphanumeric runs → hyphen
    .replace(/^-+|-+$/g, "");               // trim leading/trailing hyphens
}

// ---------------------------------------------------------------------------
// MCP tool definitions (the tools we expose to Dust agents)
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: "bash",
    description:
      "Execute a bash command on the user's machine. Returns stdout and stderr. Use for running commands, scripts, and shell operations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description:
      "Read the contents of a file on the user's machine. Supports offset and limit for large files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a file on the user's machine by replacing an exact string. Fails if oldText is not found.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        oldText: { type: "string", description: "Exact text to find and replace" },
        newText: { type: "string", description: "New text to replace the old text with" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

function executeBash(args: Record<string, unknown>): McpToolResult {
  const command = String(args.command ?? "");
  const timeoutSecs = typeof args.timeout === "number" ? args.timeout : undefined;
  try {
    const stdout = execSync(command, {
      timeout: timeoutSecs !== undefined ? timeoutSecs * 1000 : undefined,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { content: [{ type: "text", text: stdout }], isError: false };
  } catch (err: any) {
    // execSync throws on non-zero exit; err.stdout / err.stderr may have output
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n") || String(err.message);
    return { content: [{ type: "text", text: output }], isError: true };
  }
}

function executeRead(args: Record<string, unknown>): McpToolResult {
  const filePath = String(args.path ?? "");
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const offset = typeof args.offset === "number" ? args.offset - 1 : 0; // 1-indexed → 0-indexed
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const sliced = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
    return { content: [{ type: "text", text: sliced.join("\n") }], isError: false };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error reading file: ${err.message}` }], isError: true };
  }
}

function executeEdit(args: Record<string, unknown>): McpToolResult {
  const filePath = String(args.path ?? "");
  const oldText = String(args.oldText ?? "");
  const newText = String(args.newText ?? "");
  try {
    const content = readFileSync(filePath, "utf8");
    if (!content.includes(oldText)) {
      return {
        content: [{ type: "text", text: `Error: oldText not found in ${filePath}` }],
        isError: true,
      };
    }
    const updated = content.replace(oldText, newText);
    writeFileSync(filePath, updated, "utf8");
    return { content: [{ type: "text", text: `Successfully edited ${filePath}` }], isError: false };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error editing file: ${err.message}` }], isError: true };
  }
}

function executeMcpTool(name: string, args: Record<string, unknown>): McpToolResult {
  switch (name) {
    case "bash":
      return executeBash(args);
    case "read":
      return executeRead(args);
    case "edit":
      return executeEdit(args);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// MCP server registration and heartbeat
// ---------------------------------------------------------------------------

async function registerMcpServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp/register`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ serverName: "pi-dust-extension" }),
  });
  if (!res.ok) {
    throw new Error(`MCP register failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { serverId: string; expiresAt: string };
  return data.serverId;
}

function startMcpHeartbeat(
  baseUrl: string,
  authHeaders: Record<string, string>,
  serverId: string,
): void {
  if (mcpHeartbeatTimer) {
    clearInterval(mcpHeartbeatTimer);
  }
  mcpHeartbeatTimer = setInterval(async () => {
    try {
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
}

// ---------------------------------------------------------------------------
// MCP request listener (runs alongside agent SSE, processes tools/call & tools/list)
// ---------------------------------------------------------------------------

async function listenMcpRequests(
  baseUrl: string,
  authHeaders: Record<string, string>,
  serverId: string,
  abortController: AbortController,
): Promise<void> {
  const url = `${baseUrl}/mcp/requests?serverId=${encodeURIComponent(serverId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...authHeaders, Accept: "text/event-stream" },
      signal: abortController.signal,
    });
  } catch {
    // aborted or network error — silently exit
    return;
  }

  if (!res.ok || !res.body) return;

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
            let parsed: any;
            try {
              parsed = JSON.parse(json);
            } catch {
              continue;
            }

            // Dust wraps in { eventId, data } — unwrap if present
            const request = parsed.data ?? parsed;

            if (request.method === "tools/list") {
              // Respond with the list of tools we expose
              const responseMsg = {
                jsonrpc: "2.0",
                id: request.id,
                result: { tools: MCP_TOOLS },
              };
              await fetch(`${baseUrl}/mcp/results`, {
                method: "POST",
                headers: { ...authHeaders, "Content-Type": "application/json" },
                body: JSON.stringify({ result: responseMsg, serverId }),
              });
            } else if (request.method === "tools/call") {
              const toolName: string = request.params?.name ?? "";
              const toolArgs: Record<string, unknown> = request.params?.arguments ?? {};
              const toolResult = executeMcpTool(toolName, toolArgs);
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


// Mirrors the EventStream / AssistantMessageEventStream from @mariozechner/pi-ai
// without requiring an external import (which may not resolve in the test env).
// pi's agent-loop calls: stream[Symbol.asyncIterator]() to iterate events,
// and stream.result() to get the final AssistantMessage promise.
// ---------------------------------------------------------------------------

interface AssistantMessageLike {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

function makeEmptyMessage(model: any): AssistantMessageLike {
  return {
    role: "assistant",
    content: [],
    api: model.api ?? "dust",
    provider: model.provider ?? "dust",
    model: model.id ?? "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

interface PiEventStream {
  push(event: any): void;
  end(): void;
  result(): Promise<AssistantMessageLike>;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

function createEventStream(): PiEventStream {
  const queue: any[] = [];
  const waiters: Array<(r: IteratorResult<any>) => void> = [];
  let done = false;
  let resolveResult!: (v: AssistantMessageLike) => void;
  const resultPromise = new Promise<AssistantMessageLike>((res) => { resolveResult = res; });

  return {
    push(event: any) {
      if (done) return;
      if (event.type === "done") {
        done = true;
        resolveResult(event.message);
      } else if (event.type === "error") {
        done = true;
        resolveResult(event.error);
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end() {
      if (!done) {
        done = true;
      }
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined as any, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise<IteratorResult<any>>((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<any>> {
          return Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };
}

/**
 * Real streamSimple implementation.
 *
 * Returns a PiEventStream (AsyncIterable + result()) compatible with pi's
 * AssistantMessageEventStream interface.
 *
 * Credentials (`cred`) are closed over from `buildDustProviderConfig` scope
 * so they are always available regardless of what pi does with model fields.
 *
 * Conversation lifecycle:
 *   - First call: POST /assistant/conversations  → save sId to currentConversationId
 *   - Subsequent calls: POST /conversations/{id}/messages + GET /conversations/{id}
 *   - After either: GET /conversations/{id}/messages/{agentMsgId}/events  (SSE)
 */
function dustRealStream(
  cred: any,
  model: any,
  context: any,
  options?: any,
): PiEventStream {
  const stream = createEventStream();

  (async () => {
    try {
      const signal: AbortSignal | undefined = options?.signal;

      // Use the latest credentials from storage (may have been refreshed since cred was passed in).
      let liveCred = currentSessionContext.getCredentials() ?? cred;

      // Refresh the token proactively if it has expired or will expire in the next 30s.
      if (typeof liveCred.expires === "number" && liveCred.expires <= Date.now() + 30_000) {
        try {
          liveCred = await refreshToken(liveCred);
          currentSessionContext.setCredentials(liveCred);
        } catch (err) {
          console.error(`[dust] token refresh failed before stream: ${(err as Error).message}`);
          // Continue with stale token — request will likely 401 and surface a clear error.
        }
      }

      const accessToken: string = liveCred.access ?? "";
      const workspaceId: string = liveCred.workspaceId ?? "";
      const region: string = liveCred.region ?? "us-central1";
      const username: string = liveCred.username ?? "unknown";
      const apiUrl = dustApiUrl(region);
      const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;
      const agentSId: string = model.sId ?? "";

      const authHeaders = {
        Authorization: `Bearer ${accessToken}`,
        ...DUST_HEADERS,
      };

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Register MCP server once per conversation session.
      if (!currentMcpServerId) {
        const serverId = await registerMcpServer(`${baseUrl}`, authHeaders);
        currentMcpServerId = serverId;
        startMcpHeartbeat(baseUrl, authHeaders, serverId);
        // Start MCP request listener in background (detached).
        const ac = new AbortController();
        mcpRequestsAbortController = ac;
        listenMcpRequests(baseUrl, authHeaders, serverId, ac).catch(() => { /* non-fatal */ });
      }

      // Extract the last user message text from context.
      // pi passes content as either a plain string or an array of content blocks.
      const messages: any[] = context?.messages ?? [];
      const lastUserMessage = [...messages].reverse().find((m: any) => m.role === "user");
      const rawContent = lastUserMessage?.content ?? "";
      const userText: string = Array.isArray(rawContent)
        ? rawContent
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("")
        : String(rawContent);

      let conversationSId: string;
      let userMessageSId: string;

      if (!currentConversationId) {
        // ------------------------------------------------------------------ first message
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
            },
          },
        };

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
          if (res.status === 401) {
            throw new Error("Dust session expired — run /logout then /login to re-authenticate.");
          }
          throw new Error(`Failed to create conversation: HTTP ${res.status} — ${errBody}`);
        }

        const data = (await res.json()) as any;
        conversationSId = data.conversation.sId;
        userMessageSId = data.message.sId;

        currentConversationId = conversationSId;
        currentSessionContext.saveConversationId(conversationSId);

        // Agent message sId is embedded in the conversation content returned inline.
        const agentMsgSId = findAgentMessageSId(data.conversation.content, userMessageSId);

        await streamEvents(baseUrl, conversationSId, agentMsgSId, authHeaders, signal, stream, model);
      } else {
        // ------------------------------------------------------------------ subsequent message
        conversationSId = currentConversationId;

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
            },
          }),
          signal,
        });

        if (!msgRes.ok) {
          if (msgRes.status === 401) {
            throw new Error("Dust session expired — run /logout then /login to re-authenticate.");
          }
          throw new Error(`Failed to post message: HTTP ${msgRes.status}`);
        }

        const msgData = (await msgRes.json()) as any;
        userMessageSId = msgData.message.sId;

        // Fetch the conversation to find the agent message sId.
        const convRes = await fetch(`${baseUrl}/assistant/conversations/${conversationSId}`, {
          headers: authHeaders,
          signal,
        });

        if (!convRes.ok) {
          if (convRes.status === 401) {
            throw new Error("Dust session expired — run /logout then /login to re-authenticate.");
          }
          throw new Error(`Failed to fetch conversation: HTTP ${convRes.status}`);
        }

        const convData = (await convRes.json()) as any;
        const agentMsgSId = findAgentMessageSId(convData.conversation.content, userMessageSId);

        await streamEvents(baseUrl, conversationSId, agentMsgSId, authHeaders, signal, stream, model);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errMessage = makeEmptyMessage(model);
      errMessage.stopReason = "error";
      errMessage.errorMessage = errMsg;
      stream.push({ type: "error", reason: "error", error: errMessage });
      stream.end();
    }
  })();

  return stream;
}
/** Find the sId of the agent_message whose parentMessageId equals userMessageSId. */
function findAgentMessageSId(content: any[][], userMessageSId: string): string {
  for (const versions of content) {
    const latest = versions[versions.length - 1];
    if (latest?.type === "agent_message" && latest?.parentMessageId === userMessageSId) {
      return latest.sId as string;
    }
  }
  throw new Error("No agent message found in conversation content");
}

/** Stream SSE events from the agent message events endpoint, mapping to pi stream events. */
async function streamEvents(
  baseUrl: string,
  conversationSId: string,
  agentMsgSId: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  stream: PiEventStream,
  model: any,
): Promise<void> {
  const sseUrl = `${baseUrl}/assistant/conversations/${conversationSId}/messages/${agentMsgSId}/events`;

  const res = await fetch(sseUrl, {
    headers: {
      ...authHeaders,
      Accept: "text/event-stream",
    },
    signal,
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Dust session expired — run /logout then /login to re-authenticate.");
    }
    throw new Error(`Failed to stream events: HTTP ${res.status}`);
  }

  if (!res.body) {
    throw new Error("SSE response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // Build up the complete text as we go so we can put it in the final message.
  let fullText = "";

  // Partial AssistantMessage updated on each text_delta.
  const partial = makeEmptyMessage(model);

  // Minimal SSE parser: accumulate lines, emit on blank line.
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });

        // Split on SSE double-newline boundaries and process complete frames.
        const frames = buffer.split("\n\n");
        // The last element may be incomplete — keep it in the buffer.
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          // Each frame is one or more "field: value" lines.
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const json = line.slice(5).trim();
              if (!json) continue;
              let parsed: any;
              try {
                parsed = JSON.parse(json);
              } catch {
                continue;
              }

              // Wire format: { eventId: "...", data: { type: "...", ... } }
              const event = parsed.data ?? parsed;

              if (event.type === "generation_tokens") {
                if (event.classification === "tokens") {
                  const delta: string = event.text ?? "";
                  fullText += delta;
                  // Update partial content in place.
                  if (partial.content.length === 0) {
                    partial.content.push({ type: "text", text: fullText });
                  } else {
                    (partial.content[0] as any).text = fullText;
                  }
                  stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
                }
                // chain_of_thought: discard
              } else if (event.type === "tool_params") {
                // Emit a text_delta so the user sees which tool is being called.
                const toolName: string = event.action?.toolName ?? event.action?.functionCallName ?? "tool";
                const indicator = `\n[Tool: ${toolName}]\n`;
                fullText += indicator;
                if (partial.content.length === 0) {
                  partial.content.push({ type: "text", text: fullText });
                } else {
                  (partial.content[0] as any).text = fullText;
                }
                stream.push({ type: "text_delta", contentIndex: 0, delta: indicator, partial: { ...partial } });
              } else if (event.type === "agent_message_success") {
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                return;
              } else if (event.type === "agent_generation_cancelled") {
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                return;
              } else if (event.type === "agent_error") {
                throw new Error(event.error?.message ?? "Agent error");
              } else if (event.type === "user_message_error") {
                throw new Error(event.error?.message ?? "User message error");
              }
              // agent_action_success, tool_error, tool_* — handled by MCP listener loop
            }
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  // If SSE stream ended without an explicit done event, synthesize one.
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
  finalMessage.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end();
}

function buildDustProviderConfig(
  pi: ExtensionAPI,
  cred: any,
) {
  const agents: DustAgent[] = cred.agents ?? [];
  const apiUrl = dustApiUrl(cred.region ?? "us-central1");
  const workspaceId: string = cred.workspaceId ?? "";
  const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;

  // Snapshot credentials at config-build time. The streamSimple closure
  // captures this reference so credentials are always available at call time,
  // regardless of what pi does with model object fields.
  let latestCred = cred;

  pi.registerProvider("dust", {
    api: "dust" as any,
    baseUrl,
    streamSimple: (model: unknown, context: unknown, options?: unknown) =>
      dustRealStream(latestCred, model, context, options) as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => loginFn(callbacks),
      refreshToken,
      getApiKey: (credentials) => credentials.access as string,
      modifyModels: (models, credentials) => {
        // Fallback path: called by the registry on initial load when credentials
        // already exist. Replaces any stale dust models with the current agent list.
        const c = credentials as any;
        const agents2: DustAgent[] = c.agents ?? [];
        const apiUrl2 = dustApiUrl(c.region ?? "us-central1");
        const workspaceId2: string = c.workspaceId ?? "";
        const baseUrl2 = `${apiUrl2}/api/v1/w/${workspaceId2}`;
        const dustModels = agents2.map((agent) => ({
          provider: "dust",
          id: slugify(agent.name),
          sId: agent.sId,
          name: agent.name,
          api: "dust" as any,
          baseUrl: baseUrl2,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 8_000,
          headers: { ...DUST_HEADERS },
        }));
        return [...(models as any[]).filter((m: any) => m.provider !== "dust"), ...dustModels];
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
}

async function loginFn(callbacks: any) {
  const { onAuth, onProgress, onPrompt, signal } = callbacks;

  // Step 1: Request device code
  const deviceRes = await fetch(
    `https://${WORKOS_DOMAIN}/user_management/authorize/device`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: WORKOS_CLIENT_ID,
        scope: "openid profile email",
      }),
      signal,
    }
  );

  if (!deviceRes.ok) {
    throw new Error(`Device code request failed: ${deviceRes.status}`);
  }

  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Notify caller with auth URL
  onAuth({
    url: device.verification_uri_complete,
    instructions: `Enter code ${device.user_code} at ${device.verification_uri}`,
  });

  // Step 3: Poll for token
  const interval = Math.max(1, device.interval);
  const maxAttempts = Math.floor(device.expires_in / interval);
  let attempts = 0;
  let tokenData: { access_token: string; refresh_token: string; expires_in: number } | null = null;

  while (attempts < maxAttempts) {
    if (signal?.aborted) throw new Error("Authentication aborted");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval * 1000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Authentication aborted"));
      });
    });

    const pollRes = await fetch(
      `https://${WORKOS_DOMAIN}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: WORKOS_CLIENT_ID,
        }),
        signal,
      }
    );

    const pollData = (await pollRes.json()) as any;

    if ("error" in pollData) {
      if (pollData.error === "authorization_pending") {
        onProgress?.("Waiting for browser authorization…");
        attempts++;
      } else if (pollData.error === "slow_down") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        attempts++;
      } else {
        throw new Error(
          `Authentication error: ${pollData.error_description || pollData.error}`
        );
      }
    } else {
      tokenData = pollData;
      break;
    }
  }

  if (!tokenData) {
    throw new Error("Authentication timed out");
  }

  // Step 4: Decode JWT to get region
  let region = "us-central1";
  try {
    const payload = decodeJwtPayload(tokenData.access_token);
    const r = payload[REGION_CLAIM];
    if (typeof r === "string") region = r;
  } catch {
    // use default region
  }

  const apiUrl = dustApiUrl(region);

  // Step 5: Fetch workspaces
  const meRes = await fetch(`${apiUrl}/api/v1/me`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
    },
    signal,
  });

  if (!meRes.ok) {
    throw new Error(`Failed to fetch workspaces: ${meRes.status}`);
  }

  const meData = (await meRes.json()) as {
    user: { workspaces: Workspace[]; username: string };
  };
  const workspaces = meData.user.workspaces;
  const username = meData.user.username ?? "";

  // Step 6: Display workspaces and prompt for selection
  const list = workspaces
    .map((ws, i) => `  ${i + 1}. ${ws.name} (${ws.role})`)
    .join("\n");
  onProgress?.(`Your workspaces:\n${list}`);

  const selection = await onPrompt({
    message: "Select workspace number:",
    placeholder: "1",
  });

  const idx = parseInt(selection, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= workspaces.length) {
    throw new Error("Invalid workspace selection");
  }

  const workspaceId = workspaces[idx].sId;

  // Step 7: Fetch agents for selected workspace
  const agentsRes = await fetch(
    `${apiUrl}/api/v1/w/${workspaceId}/assistant/agent_configurations`,
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        ...DUST_HEADERS,
      },
      signal,
    }
  );

  const agentsData = agentsRes.ok ? ((await agentsRes.json()) as any) : { agentConfigurations: [] };
  const agents: DustAgent[] = agentsData.agentConfigurations ?? [];

  // Step 8: Return credentials (with workspaces and agents for later use)
  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 30_000,
    workspaceId,
    workspaces,
    agents,
    region,
    username,
  };
}

async function refreshToken(credentials: any) {
  const res = await fetch(
    `https://${WORKOS_DOMAIN}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: WORKOS_CLIENT_ID,
        refresh_token: credentials.refresh as string,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    ...credentials,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 30_000,
  };
}

async function fetchAgents(accessToken: string, apiUrl: string, workspaceId: string): Promise<DustAgent[] | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v1/w/${workspaceId}/assistant/agent_configurations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...DUST_HEADERS,
        },
      }
    );
    if (!res.ok) {
      console.error(`[dust] fetchAgents failed: HTTP ${res.status}`, { workspaceId, apiUrl });
      return null;
    }
    const data = (await res.json()) as any;
    return data.agentConfigurations ?? [];
  } catch (err) {
    console.error(`[dust] fetchAgents error: ${(err as Error).message}`, err);
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  // Reset session state on each extension load (new session or test isolation).
  currentConversationId = null;
  clearMcpState();

  // Register the OAuth provider and streamSimple without models on initial load.
  // The session_start handler will re-register with explicit models if credentials exist.
  // Pre-login stub: no credentials yet — dustRealStream will fail gracefully if called.
  pi.registerProvider("dust", {
    api: "dust" as any,
    streamSimple: (model: unknown, context: unknown, options?: unknown) =>
      dustRealStream({}, model, context, options) as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => {
        const cred = await loginFn(callbacks);
        // Re-register immediately after login so models appear without a restart.
        buildDustProviderConfig(pi, cred);
        return cred;
      },
      refreshToken,
      getApiKey: (credentials) => credentials.access as string,
      modifyModels: (models, credentials) => {
        // Fallback: called by the registry on initial load when credentials exist.
        const cred = credentials as any;
        const agents: DustAgent[] = cred.agents ?? [];
        const apiUrl = dustApiUrl(cred.region ?? "us-central1");
        const workspaceId: string = cred.workspaceId ?? "";
        const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;
        const dustModels = agents.map((agent) => ({
          provider: "dust",
          id: slugify(agent.name),
          sId: agent.sId,
          name: agent.name,
          api: "dust" as any,
          baseUrl,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 8_000,
          headers: { ...DUST_HEADERS },
        }));
        return [...(models as any[]).filter((m: any) => m.provider !== "dust"), ...dustModels];
      },
    },
  });

  // Handle session switches (/new → reset conversation; /resume → restore it).
  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_switch", (_event: unknown, ctx: any) => {
      const event = _event as { reason?: string };

      // Update the session context to point at the new session file and its storage.
      // This ensures dustRealStream always persists to the right session file.
      currentSessionContext = {
        getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
        saveConversationId: (id: string) => {
          const sf = ctx.sessionManager?.getSessionFile?.();
          if (!sf) return;
          const latestCred = ctx.modelRegistry.authStorage.get("dust") as any;
          if (!latestCred) return;
          const convs: Record<string, string> = { ...(latestCred.conversations ?? {}), [sf]: id };
          ctx.modelRegistry.authStorage.set("dust", { ...latestCred, conversations: convs });
        },
        getCredentials: () => ctx.modelRegistry.authStorage.get("dust"),
        setCredentials: (cred: any) => ctx.modelRegistry.authStorage.set("dust", cred),
      };

      if (event.reason === "resume") {
        // Restore the Dust conversation for the resumed pi session (if any).
        const sessionFile: string | undefined = ctx.sessionManager?.getSessionFile?.();
        const cred = ctx.modelRegistry.authStorage.get("dust") as any;
        const conversations: Record<string, string> = cred?.conversations ?? {};
        currentConversationId = (sessionFile && conversations[sessionFile]) ? conversations[sessionFile] : null;
        // On resume we also reset the MCP server — it will be re-registered on the next message.
        clearMcpState();
      } else {
        // /new → start a fresh Dust conversation.
        currentConversationId = null;
        // Also clear the MCP server so a new one is registered next time.
        clearMcpState();
      }
    });
  }

  // On session start, re-register with explicit models so the registry's
  // refresh() path (which resets OAuth providers before calling loadModels)
  // still populates the model list correctly.
  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_start", async (_event: unknown, ctx: any) => {
      let cred = ctx.modelRegistry.authStorage.get("dust");
      if (cred?.type !== "oauth") return;

      // Refresh the token if it has expired (or will expire in the next 30s).
      if (typeof cred.expires === "number" && cred.expires <= Date.now()) {
        try {
          const refreshed = await refreshToken(cred);
          ctx.modelRegistry.authStorage.set("dust", refreshed);
          cred = refreshed;
        } catch (err) {
          console.error(`[dust] token refresh failed at session_start: ${(err as Error).message}`, err);
          // Fall back to existing (expired) credentials — the agent fetch will
          // likely fail too, but we'll still surface the error rather than silently
          // proceeding with no agents.
        }
      }

      // Wire up the session context so dustRealStream always uses the current
      // session file — even after mid-session /resume switches.
      const sessionFile: string | undefined = ctx.sessionManager?.getSessionFile?.();
      currentSessionContext = {
        getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
        saveConversationId: (id: string) => {
          const sf = ctx.sessionManager?.getSessionFile?.();
          if (!sf) return;
          const latestCred = ctx.modelRegistry.authStorage.get("dust") as any;
          if (!latestCred) return;
          const convs: Record<string, string> = { ...(latestCred.conversations ?? {}), [sf]: id };
          ctx.modelRegistry.authStorage.set("dust", { ...latestCred, conversations: convs });
        },
        getCredentials: () => ctx.modelRegistry.authStorage.get("dust"),
        setCredentials: (cred: any) => ctx.modelRegistry.authStorage.set("dust", cred),
      };

      // If this session already has messages (startup --resume path), restore
      // the Dust conversation ID so replies continue in the same thread.
      const existingEntries: unknown[] = ctx.sessionManager?.getEntries?.() ?? [];
      const isResume = existingEntries.length > 0;
      if (isResume && sessionFile) {
        const conversations: Record<string, string> = (cred as any)?.conversations ?? {};
        currentConversationId = conversations[sessionFile] ?? null;
      } else {
        currentConversationId = null;
      }

      const apiUrl = dustApiUrl(cred.region ?? "us-central1");
      const freshAgents = await fetchAgents(cred.access, apiUrl, cred.workspaceId);

      if (freshAgents !== null) {
        const updatedCred = { ...cred, agents: freshAgents };
        ctx.modelRegistry.authStorage.set("dust", updatedCred);
        buildDustProviderConfig(pi, updatedCred);
      } else {
        // Fetch failed — fall back to stale credentials
        buildDustProviderConfig(pi, cred);
      }
    });
  }

  pi.registerCommand("workspace", {
    description: "Show current Dust workspace and switch between workspaces",
    handler: async (_args, ctx) => {
      const cred = ctx.modelRegistry.authStorage.get("dust") as any;

      if (!cred || !Array.isArray(cred.workspaces) || cred.workspaces.length === 0) {
        ctx.ui.notify("Not logged in to Dust. Run /login first.", "warning");
        return;
      }

      const workspaces: Workspace[] = cred.workspaces;
      const current = workspaces.find((ws) => ws.sId === cred.workspaceId);
      const currentName = current?.name ?? cred.workspaceId;

      const options = workspaces.map(workspaceLabel);
      const selected = await ctx.ui.select(
        `Current workspace: ${currentName}`,
        options,
        {}
      );

      if (!selected) return;

      const picked = workspaces.find((ws) => workspaceLabel(ws) === selected);
      if (!picked || picked.sId === cred.workspaceId) return;

      ctx.modelRegistry.authStorage.set("dust", { ...cred, workspaceId: picked.sId });
      ctx.ui.notify(`Switched to workspace: ${picked.name}`, "info");
    },
  });
}
