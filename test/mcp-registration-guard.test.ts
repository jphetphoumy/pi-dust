import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Full control over registerMcpServer/startMcpHeartbeat/listenMcpRequests:
// the scenario under test (a stale callback from a superseded registration)
// needs to fire those callbacks at exact moments that real network timing
// can't reliably reproduce in a test.
const registerMcpServerMock = vi.fn();
const startMcpHeartbeatMock = vi.fn();
const listenMcpRequestsMock = vi.fn();

vi.mock("../src/dust-mcp.js", () => ({
  registerMcpServer: (...args: unknown[]) => registerMcpServerMock(...args),
  startMcpHeartbeat: (...args: unknown[]) => startMcpHeartbeatMock(...args),
  listenMcpRequests: (...args: unknown[]) => listenMcpRequestsMock(...args),
  isAbortError: (error: unknown, signal?: AbortSignal) =>
    Boolean(signal?.aborted) || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")),
}));

import { MCP_REGISTRATION_LOST_MESSAGE } from "../src/dust-constants.js";
import dustExtension from "../src/dust.js";
import { makeCredentials, makeSseStream, piToolContextFields, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

function conversationResponse(convSId: string, msgSId: string, agentMsgSId: string) {
  return {
    conversation: {
      sId: convSId,
      content: [
        [{ type: "user_message", sId: msgSId }],
        [{ type: "agent_message", sId: agentMsgSId, parentMessageId: msgSId }],
      ],
    },
    message: { sId: msgSId },
  };
}

describe("MCP registration-lost callbacks are scoped to their own registration (issue #32 defect 3)", () => {
  useTempAgentDir();

  let capturedStreamSimple: any;
  let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

  const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

  beforeEach(async () => {
    registerMcpServerMock.mockReset();
    startMcpHeartbeatMock.mockReset();
    listenMcpRequestsMock.mockReset();

    const creds = makeCredentials();
    seedLoggedIn(creds);
    const mockApi = {
      registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
        capturedStreamSimple = config.streamSimple;
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "session_start") sessionStartHandler = handler;
      }),
    };
    dustExtension(mockApi as any);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ agentConfigurations: creds.agents }),
    }));
    const ctx = {
      modelRegistry: {},
      ...piToolContextFields(),
      sessionManager: {
        getSessionFile: vi.fn().mockReturnValue("/s/s1.json"),
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    };
    await sessionStartHandler!({}, ctx);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ignores a stale heartbeat's registration-lost signal once a newer server has registered", async () => {
    let onRegistrationLostA: (() => void) | undefined;
    let rejectListenerA: ((err: unknown) => void) | undefined;

    registerMcpServerMock.mockResolvedValueOnce("srv-A");
    startMcpHeartbeatMock.mockImplementationOnce((..._args: unknown[]) => {
      onRegistrationLostA = _args[4] as () => void;
      return setInterval(() => { /* never fires within this test */ }, 999_999);
    });
    // Listener A "stays alive" until we reject it ourselves, standing in for
    // an open SSE connection.
    listenMcpRequestsMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectListenerA = reject;
    }));

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn()
      // createConversation
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationResponse("conv-1", "m1", "am1")) })
      // streamEvents
      .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) }));

    const stream1 = capturedStreamSimple(model, { messages: [{ role: "user", content: "First" }] });
    for await (const _ of stream1) { /* drain */ }

    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
    expect(onRegistrationLostA).toBeDefined();
    expect(rejectListenerA).toBeDefined();
    vi.unstubAllGlobals();

    // Listener A independently discovers the registration is gone — a real
    // SSE 404, the actual trigger for a lost registration — and the runtime
    // clears state for real, because at this moment it IS the current
    // registration. Poll for an actual side effect of clearMcpState()
    // (it clears the heartbeat interval) instead of flushing a fixed number
    // of microtasks: a fixed count only proves today's synchronous handler
    // ran, and would silently stop proving anything the moment the catch
    // chain gains one more `await`.
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    rejectListenerA!(new Error(MCP_REGISTRATION_LOST_MESSAGE));
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    // Turn 2: mcpServerId was cleared, so this registers a fresh server, B.
    registerMcpServerMock.mockResolvedValueOnce("srv-B");
    startMcpHeartbeatMock.mockImplementationOnce(() => setInterval(() => { /* inert */ }, 999_999));
    listenMcpRequestsMock.mockImplementationOnce(() => new Promise(() => { /* stays open */ }));

    vi.stubGlobal("fetch", vi.fn()
      // postMessageToConversation (conversationId "conv-1" survives)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ message: { sId: "m2" } }) })
      // fetchConversationAgentMessageId
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationResponse("conv-1", "m2", "am2")) })
      // streamEvents
      .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) }));

    const stream2 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Second" }] });
    for await (const _ of stream2) { /* drain */ }

    expect(registerMcpServerMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();

    // Heartbeat A's long-in-flight request finally resolves (e.g. a stale
    // 403). Without the identity guard this would clear B's live
    // registration mid-session — it must be a no-op instead. This callback is
    // synchronous today, so there is no async gap to wait out here; turn 3
    // below is the actual assertion.
    onRegistrationLostA!();

    // Turn 3: if B's registration had been wiped, ensureMcpServer would
    // register a third time. It must not.
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ message: { sId: "m3" } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationResponse("conv-1", "m3", "am3")) })
      .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) }));

    const stream3 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Third" }] });
    for await (const _ of stream3) { /* drain */ }

    expect(registerMcpServerMock).toHaveBeenCalledTimes(2);
  });
});
