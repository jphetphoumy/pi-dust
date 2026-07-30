import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podSync from "../src/dust-pod-sync.js";
import { savePodBinding } from "../src/dust-state.js";
import * as tools from "../src/dust-tools.js";
import {
  makeConversationResponse,
  makeCredentials,
  makeModel,
  makePendingSseStream,
  makeSseStream,
  makeStreamSimpleFn,
  useTempAgentDir,
  waitForMcpResult,
} from "./helpers/dust-fixtures.js";

/**
 * Wiring tests for pod mode inside the stream provider: binding the
 * conversation to the pod, steering the agent at the free tools, and keeping
 * the local tree in step around the turn.
 */
describe("pod mode in the Dust stream", () => {
  useTempAgentDir();

  const root = process.cwd();
  let emptyReport: () => podSync.SyncReport;

  beforeEach(() => {
    emptyReport = () => ({ pushed: [], pulled: [], conflicted: [], skipped: [] });
    vi.spyOn(podRuntime, "podApiFor").mockReturnValue({
      baseUrl: "https://x/api/w/w1",
      getAuthHeaders: () => ({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * Must be called *after* `makeStreamSimpleFn`: that helper seeds a logged-in
   * state file, which rewrites `dust-state.json` wholesale and would drop a
   * binding written before it.
   */
  function bindPod(): void {
    savePodBinding(root, { podId: "vlt_pod", name: "proj", seen: {} });
  }

  /** Mock chain for one clean turn: MCP register, MCP stream, create, SSE. */
  function makeTurnFetchMock() {
    return vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
      })
      .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: makeSseStream([
          { type: "generation_tokens", classification: "tokens", text: "ok" },
          { type: "agent_message_success" },
        ]),
      });
  }

  async function drain(streamSimple: (model: unknown, ctx: unknown) => AsyncIterable<unknown>) {
    const events: unknown[] = [];
    for await (const event of streamSimple(makeModel(), { messages: [{ role: "user", content: "Hi" }] })) {
      events.push(event);
    }
    return events;
  }

  function createConversationBody(fetchMock: { mock: { calls: unknown[][] } }) {
    const call = (fetchMock.mock.calls as [string, { body?: string }][]).find(
      ([url, init]) => url.endsWith("/assistant/conversations") && init?.body !== undefined,
    );
    if (!call) throw new Error("no create-conversation call");
    return JSON.parse(String(call[1].body));
  }

  it("binds the conversation to the pod, which is the only way the mount appears", async () => {
    vi.spyOn(podSync, "syncPod").mockResolvedValue(emptyReport());
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    bindPod();
    const fetchMock = makeTurnFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await drain(streamSimple);

    expect(createConversationBody(fetchMock).spaceId).toBe("vlt_pod");
  });

  it("omits spaceId entirely when no pod is bound", async () => {
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    const fetchMock = makeTurnFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await drain(streamSimple);

    expect(createConversationBody(fetchMock)).not.toHaveProperty("spaceId");
  });

  it("steers the agent at the free files__* tools and names the mount", async () => {
    // Without this inversion the agent keeps using our MCP tools, which are
    // billed as an external server — the ingest would then cost credits and
    // save none.
    vi.spyOn(podSync, "syncPod").mockResolvedValue(emptyReport());
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    bindPod();
    const fetchMock = makeTurnFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await drain(streamSimple);

    const content = createConversationBody(fetchMock).message.content;
    expect(content).toContain("/files/pod-vlt_pod");
    expect(content).toContain("ALWAYS use the `files__*` tools");
    expect(content).toContain("Do NOT use `pi_dust_extension__read`");
  });

  it("keeps the local-tools guidance when no pod is bound", async () => {
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    const fetchMock = makeTurnFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await drain(streamSimple);

    const content = createConversationBody(fetchMock).message.content;
    expect(content).toContain("NEVER use `files__create`");
    expect(content).not.toContain("/files/pod-");
  });

  it("pushes before the turn and pulls after it, never the reverse", async () => {
    // Pushing after the turn would overwrite the agent's edits with the stale
    // local copy; pulling before it would clobber the user's own edits.
    const syncPod = vi.spyOn(podSync, "syncPod").mockResolvedValue(emptyReport());
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    bindPod();
    vi.stubGlobal("fetch", makeTurnFetchMock());

    await drain(streamSimple);

    const options = syncPod.mock.calls.map((call) => call[3]);
    expect(options).toEqual([
      { push: true, pull: false },
      { push: false, pull: true },
    ]);
  });

  /**
   * Drives one turn in which the agent makes a single `bash` tool call, and
   * records an interleaved trace of pod syncs and the bash execution itself.
   *
   * The agent SSE is held open until the tool result is posted back, the way a
   * real turn behaves — a stream that completes immediately would let the
   * post-turn sync run before the tool call is even handled, and the ordering
   * these tests are about would be an artefact of the mock.
   *
   * The trace is the point: asserting only on the sync arguments cannot tell a
   * pull that happened *before* bash from one that happened after, and those
   * are exactly the two cases that matter.
   */
  async function runTurnWithBash(
    onSync: (root: string, bound: { seen: Record<string, { podMs: number; hash: string }> }) => void,
  ): Promise<string[]> {
    const trace: string[] = [];
    vi.spyOn(podSync, "syncPod").mockImplementation(async (_api, root, bound, options) => {
      trace.push(options?.push && !options.pull ? "push" : "pull");
      onSync(root, bound);
      return emptyReport();
    });
    vi.spyOn(tools, "executeMcpTool").mockImplementation(async (name) => {
      trace.push(`exec:${name}`);
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    });

    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    bindPod();

    const encoder = new TextEncoder();
    const toolsCall = {
      jsonrpc: "2.0",
      id: "tc-pod-1",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "echo hi" } },
    };

    let finishTurn: (() => void) | null = null;
    const agentSse = new ReadableStream({
      start(controller) {
        // Dust approves the call on the agent stream before our MCP listener is
        // allowed to run it. Without this the tool waits on the approval gate,
        // the gate waits on the stream, and the stream waits on the tool.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          eventId: "a0",
          data: {
            type: "tool_approve_execution",
            actionId: "action-1",
            conversationId: "conv-1",
            messageId: "amsg-1",
            stake: "never_ask",
            inputs: { command: "echo hi" },
            metadata: { toolName: "bash" },
          },
        })}\n\n`));
        finishTurn = () => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ eventId: "a1", data: { type: "agent_message_success" } })}\n\n`),
          );
          controller.close();
        };
      },
    });

    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/mcp/register")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        });
      }
      if (url.includes("/mcp/requests")) {
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "e0", data: toolsCall })}\n\n`));
              // Left open: closing it makes the listener reconnect in a loop.
            },
          }),
        });
      }
      if (url.includes("/mcp/results")) {
        // The tool result is what lets the agent finish, so the turn ends here.
        finishTurn?.();
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      if (url.endsWith("/assistant/conversations")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        });
      }
      return Promise.resolve({ ok: true, body: agentSse, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    await drain(streamSimple);
    await waitForMcpResult(fetchMock as never, "tc-pod-1");
    return trace;
  }

  it("pulls the tree down before running bash, so a local test run sees the agent's edits", async () => {
    // Without this the agent edits main.py in the pod, runs pytest locally
    // against the pre-edit file, and is told its own fix failed.
    const trace = await runTurnWithBash(() => {});

    expect(trace).toEqual(["push", "pull", "exec:bash", "pull"]);
  });

  it("re-reads the binding at each sync point, so a mid-turn pull's watermark is not lost", async () => {
    // Regression: the post-turn sync used to reuse the binding captured at the
    // top of the turn. The pre-bash pull advances `seen` and persists it, so
    // the stale snapshot made the post-turn pass compare against watermarks
    // predating its own earlier pull — and report a spurious conflict on a file
    // it had already reconciled.
    const seenByCall: string[][] = [];
    await runTurnWithBash((root, bound) => {
      seenByCall.push(Object.keys(bound.seen));
      // Stand in for a real sync advancing and persisting the watermark.
      bound.seen = { ...bound.seen, [`f${seenByCall.length}.py`]: { podMs: 1, hash: "h" } };
      savePodBinding(root, bound as never);
    });

    expect(seenByCall).toHaveLength(3);
    expect(seenByCall[0]).toEqual([]);
    expect(seenByCall[1]).toEqual(["f1.py"]);
    // Each pass must see every watermark its predecessors persisted.
    expect(seenByCall[2]).toEqual(["f1.py", "f2.py"]);
  });

  it("still answers the turn when a pod sync fails", async () => {
    // A drifted tree is worth reporting, but it is not a reason to throw away
    // an answer the agent already produced.
    vi.spyOn(podSync, "syncPod").mockRejectedValue(new Error("pod listing 500"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const streamSimple = await makeStreamSimpleFn(makeCredentials({ agents: [] }));
    bindPod();
    vi.stubGlobal("fetch", makeTurnFetchMock());

    const events = await drain(streamSimple);

    expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
    expect(errors.mock.calls.flat().join(" ")).toContain("pod listing 500");
  });
});
