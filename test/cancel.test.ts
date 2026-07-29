import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventStream, streamEvents } from "../src/dust-stream.js";
import { cancelMessageGeneration } from "../src/dust-stream-provider.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import {
  makeConversationResponse,
  makeModel,
  makePendingSseStream,
  makeSseStream,
  makeStreamSimpleFn,
  useTempAgentDir,
  waitForCall,
  waitForMcpResult,
} from "./helpers/dust-fixtures.js";

const BASE_URL = "https://dust.test/api/v1/w/ws-1";

function makeStreamEventsOptions(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: BASE_URL,
    conversationSId: "conv-1",
    agentMsgSId: "amsg-1",
    getAuthHeaders: () => ({ Authorization: "Bearer token" }),
    refreshAuth: async () => false,
    signal: undefined as AbortSignal | undefined,
    stream: createEventStream(),
    model: makeModel(),
    handleToolApproveExecution: async () => true,
    postValidateAction: async () => undefined,
    recordPreApproval: () => undefined,
    resolveApprovalGate: () => undefined,
    ...overrides,
  };
}

describe("cancellation", () => {
  useTempAgentDir();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("cancelMessageGeneration", () => {
    it("POSTs the agent message ids to the conversation cancel endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      await cancelMessageGeneration(BASE_URL, { Authorization: "Bearer token" }, "conv-1", ["amsg-1"]);

      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
      expect(url).toBe(`${BASE_URL}/assistant/conversations/conv-1/cancel`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ messageIds: ["amsg-1"] });
      expect(init.headers.Authorization).toBe("Bearer token");
    });

    // The turn is already over when this runs; a failure here must not surface
    // as an extra error on top of the cancellation the user asked for.
    it("swallows a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(cancelMessageGeneration(BASE_URL, {}, "conv-1", ["amsg-1"])).resolves.toBeUndefined();
    });

    it("swallows a thrown request", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      await expect(cancelMessageGeneration(BASE_URL, {}, "conv-1", ["amsg-1"])).resolves.toBeUndefined();
    });
  });

  describe("runtime turn state", () => {
    it("aborts local tool work and marks the turn cancelled", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "amsg-1");

      expect(runtime.isTurnCancelled()).toBe(false);
      const cancelled = runtime.cancelActiveTurn();

      expect(cancelled).toBe(turn);
      expect(turn.toolAbortController.signal.aborted).toBe(true);
      expect(runtime.isTurnCancelled()).toBe(true);
    });

    it("cancels a turn only once", () => {
      const runtime = new DustSessionRuntime();
      runtime.beginTurn("conv-1", "amsg-1");

      expect(runtime.cancelActiveTurn()).not.toBeNull();
      expect(runtime.cancelActiveTurn()).toBeNull();
    });

    it("releases a tool waiting on the approval gate", async () => {
      const runtime = new DustSessionRuntime();
      runtime.createApprovalGate();
      const gate = runtime.pendingApprovalPromise;
      runtime.beginTurn("conv-1", "amsg-1");

      runtime.cancelActiveTurn();

      await expect(gate).resolves.toBeUndefined();
    });

    // Dust tool calls can land after the stream has closed, so the cancellation
    // has to stay visible until the next turn starts.
    it("keeps reporting a cancelled turn once it has ended", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "amsg-1");
      runtime.cancelActiveTurn();
      runtime.endTurn(turn);

      expect(runtime.isTurnCancelled()).toBe(true);

      runtime.beginTurn("conv-1", "amsg-2");
      expect(runtime.isTurnCancelled()).toBe(false);
    });

    it("does not clear a newer turn when an older one ends", () => {
      const runtime = new DustSessionRuntime();
      const first = runtime.beginTurn("conv-1", "amsg-1");
      const second = runtime.beginTurn("conv-1", "amsg-2");

      runtime.endTurn(first);

      expect(runtime.activeTurn).toBe(second);
    });

    it("ends any live turn when the session state is cleared", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "amsg-1");

      runtime.resetSessionState();

      expect(turn.toolAbortController.signal.aborted).toBe(true);
      expect(runtime.activeTurn).toBeNull();
    });
  });

  describe("streamEvents", () => {
    it("ends as aborted, keeping the text generated so far", async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      const token = encoder.encode(
        `data: ${JSON.stringify({ eventId: "e0", data: { type: "generation_tokens", classification: "tokens", text: "Partial" } })}\n\n`,
      );

      // One token, then a read that only settles when the fetch is aborted —
      // which is what a real turn looks like when the user hits escape while
      // the agent is mid-answer.
      let delivered = false;
      const reader = {
        read: () => {
          if (!delivered) {
            delivered = true;
            return Promise.resolve({ value: token, done: false });
          }
          return new Promise((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            }, { once: true });
          });
        },
        releaseLock: () => undefined,
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } }));

      const stream = createEventStream();
      const promise = streamEvents(makeStreamEventsOptions({ stream, signal: controller.signal }) as never);

      await waitForCall(() => (delivered ? true : undefined), "the first token");
      controller.abort();
      await promise;

      await expect(stream.result()).resolves.toMatchObject({
        stopReason: "aborted",
        content: [{ type: "text", text: "Partial" }],
      });
    });

    it("does not open a stream when the signal is already aborted", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const stream = createEventStream();

      await streamEvents(makeStreamEventsOptions({
        stream,
        signal: AbortSignal.abort(),
      }) as never);

      expect(fetchMock).not.toHaveBeenCalled();
      await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
    });
  });

  describe("streamSimple", () => {
    /**
     * A response body that stays open until `signal` aborts, then rejects the
     * pending read — what `fetch` does to an in-flight stream when its signal
     * fires. `makePendingSseStream` ignores the signal, so a turn parked on it
     * would never notice the cancellation.
     */
    function abortableBody(signal: AbortSignal) {
      return {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            }, { once: true });
          }),
          releaseLock: () => undefined,
        }),
      };
    }

    /**
     * Register MCP, hold the MCP request stream open, create the conversation,
     * then hang on the agent event stream — the state a turn is in when the
     * user hits escape.
     */
    function makeHangingTurnFetch(signal: AbortSignal) {
      return vi.fn()
        // 1. POST /mcp/register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-cancel-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-cancel-1", "umsg-1", "amsg-cancel-1")),
        })
        // 4. GET .../events — open, but never produces a terminal event
        .mockResolvedValue({ ok: true, body: abortableBody(signal) });
    }

    it("tells Dust to cancel the agent message when the turn is aborted", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const controller = new AbortController();
      const fetchMock = makeHangingTurnFetch(controller.signal);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });

      // Wait until the event stream is open: only then is there an agent loop to stop.
      await waitForCall(
        () => (fetchMock.mock.calls as [string][]).find(([url]) => String(url).includes("/events")),
        "the agent event stream to open",
      );
      controller.abort();

      const cancelCall = await waitForCall(
        () => (fetchMock.mock.calls as [string, { body?: string }][]).find(([url]) => String(url).endsWith("/cancel")),
        "the cancel request",
      );
      expect(cancelCall[0]).toContain("/assistant/conversations/conv-cancel-1/cancel");
      expect(JSON.parse(cancelCall[1].body!)).toEqual({ messageIds: ["amsg-cancel-1"] });

      await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
    });

    it("reports an aborted turn as cancelled rather than as a failure", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const controller = new AbortController();
      const fetchMock = makeHangingTurnFetch(controller.signal);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });

      await waitForCall(
        () => (fetchMock.mock.calls as [string][]).find(([url]) => String(url).includes("/events")),
        "the agent event stream to open",
      );
      controller.abort();

      const events: Array<{ type: string; reason?: string }> = [];
      for await (const event of stream) {
        events.push(event as { type: string; reason?: string });
      }

      expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
      await expect(stream.result()).resolves.toMatchObject({ errorMessage: "Cancelled by user." });
    });

    it("refuses tool calls that arrive after the turn was cancelled", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const controller = new AbortController();
      const encoder = new TextEncoder();
      // Held open so the tool call can be delivered after the cancellation, the
      // way an in-flight Dust tool request lands just after escape.
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({
        start(c) { mcpController = c; },
      });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-cancel-3", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: mcpBody })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-cancel-3", "umsg-3", "amsg-cancel-3")),
        })
        .mockResolvedValue({ ok: true, body: abortableBody(controller.signal), json: () => Promise.resolve({}) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });
      await waitForCall(
        () => (fetchMock.mock.calls as [string][]).find(([url]) => String(url).includes("/events")),
        "the agent event stream to open",
      );
      controller.abort();
      await stream.result();

      const request = {
        jsonrpc: "2.0",
        id: "req-after-cancel",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "touch /tmp/pi-dust-should-not-exist" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));
      mcpController.close();

      const posted = await waitForMcpResult(fetchMock, "req-after-cancel");
      expect(posted.result.result.isError).toBe(true);
      expect(posted.result.result.content[0].text).toBe("Tool execution cancelled by user.");
    });

    it("does not cancel a turn that already completed", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-cancel-2", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-cancel-2", "umsg-2", "amsg-cancel-2")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const controller = new AbortController();
      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });
      await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });

      // A late abort — pi tearing the turn down — must not cancel a message
      // that already finished, nor whatever runs next in the conversation.
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect((fetchMock.mock.calls as [string][]).filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(0);
    });
  });
});
