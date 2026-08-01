import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Full control over registerMcpServer/startMcpHeartbeat/listenMcpRequests, the
// same way test/mcp-registration-guard.test.ts does: this test cares about how
// many times (and with what `getTools`) registration happens across turns, not
// about real network timing.
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

import dustExtension from "../src/dust.js";
import { makeCredentials, makeSseStream, piToolContextFields, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

const ALL_SEVEN = ["bash", "read", "write", "edit", "grep", "find", "ls"];

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

describe("MCP tool catalogue tracks pi's active tools across turns (issue #51)", () => {
  useTempAgentDir();

  let capturedStreamSimple: any;
  let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
  let getActiveToolsMock: ReturnType<typeof vi.fn<() => string[]>>;

  const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

  /** Registers a fresh mock MCP server for one turn's `ensureMcpServer` call. */
  function armRegistration(serverId: string) {
    registerMcpServerMock.mockResolvedValueOnce(serverId);
    startMcpHeartbeatMock.mockImplementationOnce(() => setInterval(() => { /* inert */ }, 999_999));
    listenMcpRequestsMock.mockImplementationOnce(() => new Promise(() => { /* stays open for the test */ }));
  }

  async function runTurn(userText: string, convSId: string, userMsgSId: string, agentMsgSId: string, first: boolean) {
    if (first) {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationResponse(convSId, userMsgSId, agentMsgSId)) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) }));
    } else {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ message: { sId: userMsgSId } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationResponse(convSId, userMsgSId, agentMsgSId)) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) }));
    }

    const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: userText }] });
    for await (const _ of stream) { /* drain */ }
    vi.unstubAllGlobals();
  }

  beforeEach(async () => {
    registerMcpServerMock.mockReset();
    startMcpHeartbeatMock.mockReset();
    listenMcpRequestsMock.mockReset();
    getActiveToolsMock = vi.fn().mockReturnValue(ALL_SEVEN);

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
      getActiveTools: () => getActiveToolsMock(),
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

    armRegistration("srv-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not re-register when the active tool set is unchanged", async () => {
    await runTurn("First", "conv-1", "m1", "am1", true);
    getActiveToolsMock.mockReturnValue(ALL_SEVEN);
    await runTurn("Second", "conv-1", "m2", "am2", false);

    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
  });

  it("re-registers with a filtered catalogue when a tool is disabled, and settles without looping", async () => {
    await runTurn("First", "conv-1", "m1", "am1", true);
    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
    expect(listenMcpRequestsMock.mock.calls[0][0].getTools().map((t: any) => t.name)).toEqual(ALL_SEVEN);

    // Turn 2: the user (or another extension) disabled everything but `read`.
    getActiveToolsMock.mockReturnValue(["read"]);
    armRegistration("srv-2");
    await runTurn("Second", "conv-1", "m2", "am2", false);

    expect(registerMcpServerMock).toHaveBeenCalledTimes(2);
    // The safety assertion: Dust's fresh registration cannot see `bash`.
    expect(listenMcpRequestsMock.mock.calls[1][0].getTools().map((t: any) => t.name)).toEqual(["read"]);

    // Turn 3: still just `read` — must not re-register again.
    await runTurn("Third", "conv-1", "m3", "am3", false);
    expect(registerMcpServerMock).toHaveBeenCalledTimes(2);

    // Turn 4: re-enabled — re-registers once more with the full catalogue.
    getActiveToolsMock.mockReturnValue(ALL_SEVEN);
    armRegistration("srv-3");
    await runTurn("Fourth", "conv-1", "m4", "am4", false);

    expect(registerMcpServerMock).toHaveBeenCalledTimes(3);
    expect(listenMcpRequestsMock.mock.calls[2][0].getTools().map((t: any) => t.name)).toEqual(ALL_SEVEN);
  });

  it("refuses (at isToolActive, ahead of approval and pre-approvals) a tool no longer active mid-turn (the safety case from issue #51)", async () => {
    await runTurn("First", "conv-1", "m1", "am1", true);

    // The user disabled everything but `read` mid-turn — before the *next*
    // turn's boundary check has a chance to re-register. Dust's cached
    // catalogue still lists `bash`, so nothing stops it from sending a
    // tools/call for it; `isToolActive` is what the listener checks before
    // ever reaching the approval prompt or `executeMcpTool`.
    getActiveToolsMock.mockReturnValue(["read"]);
    const isToolActive = listenMcpRequestsMock.mock.calls[0][0].isToolActive;

    expect(isToolActive("bash")).toBe(false);
    expect(isToolActive("read")).toBe(true);
  });

  it("isToolActive fails open when pi's active tools are unreadable", async () => {
    getActiveToolsMock.mockImplementation(() => {
      throw new Error("extension is stale");
    });
    await runTurn("First", "conv-1", "m1", "am1", true);

    const isToolActive = listenMcpRequestsMock.mock.calls[0][0].isToolActive;

    expect(isToolActive("bash")).toBe(true);
  });

  it("a tool appearing from another extension does not cost a re-registration", async () => {
    await runTurn("First", "conv-1", "m1", "am1", true);

    getActiveToolsMock.mockReturnValue([...ALL_SEVEN, "todo_write"]);
    await runTurn("Second", "conv-1", "m2", "am2", false);

    // We can't execute `todo_write`, so the catalogue we'd advertise is
    // unchanged even though pi's raw active list grew.
    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
  });

  it("never re-registers, and never throws, when the host has no getActiveTools", async () => {
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
      // No getActiveTools at all — an older host.
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

    armRegistration("srv-1");
    await runTurn("First", "conv-1", "m1", "am1", true);
    await runTurn("Second", "conv-1", "m2", "am2", false);

    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
    expect(listenMcpRequestsMock.mock.calls[0][0].getTools().map((t: any) => t.name)).toEqual(ALL_SEVEN);
  });

  it("treats a throwing getActiveTools as unreadable rather than failing the turn", async () => {
    getActiveToolsMock.mockImplementation(() => {
      throw new Error("extension is stale");
    });

    await runTurn("First", "conv-1", "m1", "am1", true);
    await runTurn("Second", "conv-1", "m2", "am2", false);

    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
    expect(listenMcpRequestsMock.mock.calls[0][0].getTools().map((t: any) => t.name)).toEqual(ALL_SEVEN);
  });
});
