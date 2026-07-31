import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import dustExtension from "../../src/dust.js";
import type { SessionContextController } from "../../src/dust-runtime.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let currentAgentDir: string | null = null;

export function agentDir(): string {
  if (!currentAgentDir) {
    throw new Error("useTempAgentDir() must be installed before touching the store");
  }
  return currentAgentDir;
}

/**
 * Points the extension's file-backed store at a throwaway directory.
 *
 * Since pi 0.81 there is no injectable AuthStorage, so `auth.json` (pi's, read
 * only) and `dust-state.json` (ours) are read from disk under
 * PI_CODING_AGENT_DIR. Tests seed and assert on those files instead of mocking
 * a registry object.
 */
export function useTempAgentDir(): void {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[PI_AGENT_DIR_ENV];
    currentAgentDir = mkdtempSync(join(tmpdir(), "pi-dust-test-"));
    process.env[PI_AGENT_DIR_ENV] = currentAgentDir;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[PI_AGENT_DIR_ENV];
    } else {
      process.env[PI_AGENT_DIR_ENV] = previous;
    }
    if (currentAgentDir) {
      rmSync(currentAgentDir, { recursive: true, force: true });
    }
    currentAgentDir = null;
  });
}

function writeJson(name: string, value: unknown): void {
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf8");
}

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(agentDir(), name), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Seeds pi's auth.json with a `dust` credential. */
export function seedAuth(credentials: Record<string, unknown> | null): void {
  writeJson("auth.json", credentials === null ? {} : { dust: credentials });
}

/** Seeds the extension-owned state file. */
export function seedState(state: Record<string, unknown>): void {
  writeJson("dust-state.json", state);
}

/** Reads back the extension-owned state file. */
export function readState(): Record<string, unknown> {
  return readJson<Record<string, unknown>>("dust-state.json") ?? {};
}

/** Reads back pi's auth.json `dust` entry, to assert we never wrote to it. */
export function readAuth(): Record<string, unknown> | null {
  return readJson<Record<string, unknown>>("auth.json")?.dust as Record<string, unknown> ?? null;
}

/**
 * Seeds both halves from a single credential object, the way a logged-in
 * install looks: tokens in auth.json, Dust state in dust-state.json.
 */
export function seedLoggedIn(credentials: Record<string, unknown>): void {
  const { access, refresh, expires, type, ...state } = credentials;
  seedAuth({ type: type ?? "oauth", access, refresh, expires });
  seedState(state);
}

/**
 * An absolute path to a session file that really exists on disk.
 *
 * The conversation map is keyed by session file, and stale keys are swept when
 * a new one is written, so a test that names a session file it never created
 * would be asserting on an entry the extension is entitled to drop. Real files
 * under the temp agent dir keep the tests honest about that.
 */
export function sessionPath(name: string): string {
  const dir = join(agentDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "", "utf8");
  return path;
}

type Workspace = { sId: string; name: string; role: string };
type DustAgent = { sId: string; name: string; description: string };

/**
 * Context fields pi's own tools read during execute().
 *
 * Tool calls from Dust run pi's built-in implementations, which reach into the
 * ExtensionContext: bash needs `sessionManager.getSessionId()`, `model` and
 * `thinkingLevel` for PI_SESSION_ID and friends; read consults `model.input` to
 * decide whether images may be returned. Real pi supplies all of these.
 */
export function piToolContextFields(): Record<string, unknown> {
  return {
    model: { id: "test-model", provider: "dust", input: ["text"] },
    thinkingLevel: "off",
  };
}

export function makePendingSseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start() { /* never enqueue, never close */ } });
}

export function makeCredentials(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    access: "tok",
    refresh: "ref",
    expires: Date.now() + 3600_000,
    workspaceId: "ws-1",
    workspaces: [
      { sId: "ws-1", name: "Acme Corp", role: "admin" },
      { sId: "ws-2", name: "Personal", role: "member" },
    ] as Workspace[],
    agents: [
      { sId: "agent-1", name: "Helper", description: "A helpful agent" },
    ] as DustAgent[],
    region: "us-central1",
    username: "janedoe",
    ...overrides,
  };
}

/**
 * A `SessionContextController` stub with sensible defaults, so tests that
 * only care about one or two custom behaviors (a controllable
 * `resolveAccessToken`, a spy on `setCredentials`, ...) don't have to restate
 * the whole shape every time. Pass `overrides` for the fields a test needs to
 * customize.
 */
export function makeSessionContext(overrides: Partial<SessionContextController> = {}): SessionContextController {
  return {
    getSessionFile: () => undefined,
    saveConversationId: () => {},
    getCredentials: () => makeCredentials(),
    setCredentials: () => {},
    resolveAccessToken: async () => "tok",
    getAccessToken: () => "tok",
    ...overrides,
  };
}

export function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa('{"alg":"none"}');
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.`;
}

export function makeLoginFetchMock({
  jwt,
  workspaces = [{ sId: "ws-1", name: "Acme Corp", role: "admin" }],
  agents = [] as DustAgent[],
  extraPolls = 0,
}: {
  jwt: string;
  workspaces?: Workspace[];
  agents?: DustAgent[];
  extraPolls?: number;
}) {
  const mock = vi.fn();

  mock.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        device_code: "dc-abc",
        user_code: "USER-CODE",
        verification_uri: "https://auth.workos.com/verify",
        verification_uri_complete: "https://api.workos.com/verify",
        expires_in: 300,
        interval: 5,
      }),
  });

  for (let i = 0; i < extraPolls; i++) {
    mock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: "authorization_pending" }),
    });
  }

  mock.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        access_token: jwt,
        refresh_token: "refresh-tok",
        expires_in: 3600,
      }),
  });

  mock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ user: { workspaces, username: "janedoe", fullName: "Jane Doe", email: "jane@example.com" } }),
  });

  mock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ agentConfigurations: agents }),
  });

  return mock;
}

export function makeSseStream(events: object[]): ReadableStream<Uint8Array> {
  const lines = events
    .map((event, i) => `data: ${JSON.stringify({ eventId: `e${i}`, data: event })}\n\n`)
    .join("");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(lines);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The first-message fetch chain (MCP register, MCP requests SSE, create
 * conversation), followed by one SSE window per entry in `windows` — for
 * pinning behaviour across a reconnect without hand-rolling the setup calls
 * in every such test, which ties the test to their exact order.
 */
export function makeReconnectingFetch(
  conversationSId = "conv-1",
  userMessageSId = "msg-1",
  agentMessageSId = "agent-msg-1",
  windows: object[][] = [[]],
) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    })
    .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeConversationResponse(conversationSId, userMessageSId, agentMessageSId)),
    });
  for (const events of windows) {
    fetchMock.mockResolvedValueOnce({ ok: true, body: makeSseStream(events) });
  }
  return fetchMock;
}

export function makeRawSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

export function makeModel() {
  return {
    id: "agent-sonnet",
    sId: "agentSId-1",
    name: "AgentSonnet",
    provider: "dust",
    api: "dust",
  };
}

export async function makeStreamSimpleFn(credOverrides: Record<string, unknown> = {}): Promise<any> {
  const creds = makeCredentials(credOverrides);
  seedLoggedIn(creds);
  let capturedStreamSimple: any;
  let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

  const mockApi = {
    registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
      capturedStreamSimple = config.streamSimple;
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
      if (event === "session_start") sessionStartHandler = handler;
    }),
  };

  dustExtension(mockApi as any);

  const savedFetch = (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ agentConfigurations: creds.agents }),
  }));

  const ctx = {
    modelRegistry: {},
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue(undefined),
      getEntries: vi.fn().mockReturnValue([]),
    },
  };
  await sessionStartHandler!({}, ctx);

  if (savedFetch) {
    vi.stubGlobal("fetch", savedFetch);
  } else {
    vi.unstubAllGlobals();
  }

  return capturedStreamSimple;
}

export function makeConversationResponse(conversationSId: string, userMessageSId: string, agentMessageSId: string) {
  return {
    conversation: {
      sId: conversationSId,
      content: [
        [{ type: "user_message", sId: userMessageSId }],
        [{ type: "agent_message", sId: agentMessageSId, parentMessageId: userMessageSId }],
      ],
    },
    message: { sId: userMessageSId },
  };
}

/**
 * Wait for the POST to /mcp/results carrying `requestId` and return its parsed body.
 *
 * pi's tools execute asynchronously, so the result lands some time after the pi
 * stream drains. Sleeping a fixed interval and then reading the mock is racy in
 * two ways: a tool that spawns a subprocess can overrun any fixed wait on a
 * loaded machine, and because each test installs a fresh fetch mock while the
 * previous test's MCP listener is still alive, a late result from an earlier
 * test can land in this test's mock. Matching on the request id addresses both —
 * we wait for our own result and ignore anyone else's.
 */
export async function waitForMcpResult(fetchMock: { mock: { calls: unknown[][] } }, requestId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [url, init] of fetchMock.mock.calls as [string, { body?: string }][]) {
      if (!String(url).includes("/mcp/results") || !init?.body) continue;
      const body = JSON.parse(init.body);
      if (body.result?.id === requestId) return body;
    }
    if (Date.now() >= deadline) {
      const seen = (fetchMock.mock.calls as [string][]).map(([url]) => String(url));
      throw new Error(`timed out waiting for /mcp/results with id ${requestId}; saw: ${seen.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Wait until `read` returns a defined value, polling instead of sleeping a fixed
 * interval. Same rationale as waitForMcpResult, for assertions that watch for a
 * request rather than a result.
 */
export async function waitForCall<T>(read: () => T | undefined, describeWhat: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${describeWhat}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function makeConversationGetResponse(conversationSId: string, userMessageSId: string, agentMessageSId: string) {
  return {
    conversation: {
      sId: conversationSId,
      content: [
        [{ type: "user_message", sId: userMessageSId }],
        [{ type: "agent_message", sId: agentMessageSId, parentMessageId: userMessageSId }],
      ],
    },
  };
}
