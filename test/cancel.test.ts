import { afterEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { createEventStream, streamEvents } from "../src/dust-stream.js";
import { cancelMessageGeneration, cancelPendingAgentMessage } from "../src/dust-stream-provider.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import type { PiEventStream } from "../src/dust-types.js";
import {
  makeConversationGetResponse,
  makeConversationResponse,
  makeCredentials,
  makeModel,
  makePendingSseStream,
  makeSseStream,
  makeStreamSimpleFn,
  piToolContextFields,
  seedLoggedIn,
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
    onCancelled: () => undefined,
    ...overrides,
  };
}

/**
 * Same wiring as `makeStreamSimpleFn`, but with the approval dialog injected
 * through `session_switch` — the path pi uses to hand the extension its UI.
 */
async function makeStreamSimpleFnWithConfirm(
  confirmFn: (title: string, message: string) => Promise<boolean>,
): Promise<(model: unknown, context: unknown, options?: unknown) => PiEventStream> {
  const creds = makeCredentials();
  seedLoggedIn(creds);
  let capturedStreamSimple: (model: unknown, context: unknown, options?: unknown) => PiEventStream;
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let sessionSwitchHandler: ((event: unknown, ctx: unknown) => void) | undefined;

  const mockApi = {
    registerProvider: vi.fn((_name: string, config: Record<string, never>) => {
      capturedStreamSimple = config.streamSimple;
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: never) => {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "session_switch") sessionSwitchHandler = handler;
    }),
  };

  dustExtension(mockApi as never);

  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ agentConfigurations: creds.agents }),
  }));

  const makeCtx = () => ({
    modelRegistry: {},
    ...piToolContextFields(),
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/sessions/cancel.json"),
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("cancel-session"),
    },
    ui: { confirm: confirmFn },
  });

  await sessionStartHandler!({}, makeCtx());
  vi.unstubAllGlobals();
  sessionSwitchHandler!({ reason: "new" }, makeCtx());

  return capturedStreamSimple!;
}

describe("cancellation", () => {
  useTempAgentDir();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("cancelMessageGeneration", () => {
    const headers = () => ({ Authorization: "Bearer token" });

    it("POSTs the agent message ids to the conversation cancel endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      await cancelMessageGeneration(BASE_URL, headers, "conv-1", ["amsg-1"]);

      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
      expect(url).toBe(`${BASE_URL}/assistant/conversations/conv-1/cancel`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ messageIds: ["amsg-1"] });
      expect(init.headers.Authorization).toBe("Bearer token");
    });

    // Long turns are both the ones most worth cancelling and the ones most
    // likely to have outlived the ~15 minute access token.
    it("refreshes and retries once when the token has expired", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);
      let token = "stale";
      const refreshAuth = vi.fn(async () => { token = "fresh"; return true; });

      await cancelMessageGeneration(BASE_URL, () => ({ Authorization: `Bearer ${token}` }), "conv-1", ["amsg-1"], refreshAuth);

      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, retry] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
      expect(retry.headers.Authorization).toBe("Bearer fresh");
    });

    it("does not retry when the refresh fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      vi.stubGlobal("fetch", fetchMock);

      await cancelMessageGeneration(BASE_URL, headers, "conv-1", ["amsg-1"], async () => false);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The turn is already over when this runs; a failure here must not surface
    // as an extra error on top of the cancellation the user asked for.
    it("swallows a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(cancelMessageGeneration(BASE_URL, headers, "conv-1", ["amsg-1"])).resolves.toBeUndefined();
    });

    it("swallows a thrown request", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      await expect(cancelMessageGeneration(BASE_URL, headers, "conv-1", ["amsg-1"])).resolves.toBeUndefined();
    });

    // A 200 carrying an error envelope would otherwise read as success.
    it("does not report success for a 200 without a success body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ error: { message: "nope" } }),
      }));

      await expect(cancelMessageGeneration(BASE_URL, headers, "conv-1", ["amsg-1"])).resolves.toBeUndefined();
    });
  });

  describe("cancelPendingAgentMessage", () => {
    it("looks the agent message up, then cancels it", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "umsg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      await cancelPendingAgentMessage(BASE_URL, () => ({ Authorization: "Bearer token" }), "conv-1", "umsg-1");

      const [cancelUrl, cancelInit] = fetchMock.mock.calls[1] as [string, { body: string }];
      expect(cancelUrl).toBe(`${BASE_URL}/assistant/conversations/conv-1/cancel`);
      expect(JSON.parse(cancelInit.body)).toEqual({ messageIds: ["amsg-1"] });
    });

    // The recovery runs right after the user message was accepted, which is
    // exactly when Dust may not have attached the agent message yet.
    it("retries once when the agent message has not materialized yet", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "umsg-1" }]] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "umsg-1", "amsg-late")),
        })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      await cancelPendingAgentMessage(BASE_URL, () => ({}), "conv-1", "umsg-1");

      const cancelCall = (fetchMock.mock.calls as [string, { body?: string }][]).find(([url]) => String(url).endsWith("/cancel"));
      expect(cancelCall).toBeDefined();
      expect(JSON.parse(cancelCall![1].body!)).toEqual({ messageIds: ["amsg-late"] });
    });

    // The cancel POST can stall for seconds. Until the id is recorded, tool
    // calls from that loop cannot be told apart from a later turn's, so the
    // caller has to learn it as the lookup lands, not when Dust answers.
    it("reports the agent message id before dispatching the cancel", async () => {
      const order: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/cancel")) {
          order.push("cancel-post");
          return { ok: true, status: 200, json: () => Promise.resolve({ success: true }) };
        }
        return { ok: true, json: () => Promise.resolve(makeConversationGetResponse("conv-1", "umsg-1", "amsg-1")) };
      });
      vi.stubGlobal("fetch", fetchMock);

      await cancelPendingAgentMessage(
        BASE_URL,
        () => ({}),
        "conv-1",
        "umsg-1",
        undefined,
        (agentMessageSId) => order.push(`resolved:${agentMessageSId}`),
      );

      expect(order).toEqual(["resolved:amsg-1", "cancel-post"]);
    });

    it("gives up quietly when the lookup fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        cancelPendingAgentMessage(BASE_URL, () => ({}), "conv-1", "umsg-1"),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("runtime turn state", () => {
    it("aborts local tool work and marks the turn cancelled", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "umsg-1", "amsg-1");

      expect(runtime.isTurnCancelled()).toBe(false);
      const cancelled = runtime.cancelActiveTurn();

      expect(cancelled).toBe(turn);
      expect(turn.toolAbortController.signal.aborted).toBe(true);
      expect(runtime.isTurnCancelled()).toBe(true);
    });

    // A refused tool call never consumes its pre-approval entry, and the queue
    // is positional: a leftover would silently approve an unrelated tool call
    // in the next turn.
    it("discards pre-approvals collected by the cancelled turn", () => {
      const runtime = new DustSessionRuntime();
      runtime.beginTurn("conv-1", "umsg-1", "amsg-1");
      runtime.preApprovedActions.set("action-1", true);

      runtime.cancelActiveTurn();

      expect(runtime.preApprovedActions.size).toBe(0);
    });

    // Dust's cancel is asynchronous (a Temporal signal), so a cancelled loop can
    // still emit a tool call after the user has started the next turn — by which
    // point the current-turn verdict has moved on.
    it("refuses a late tool call from a cancelled turn during a later turn", () => {
      const runtime = new DustSessionRuntime();
      runtime.beginTurn("conv-1", "umsg-1", "amsg-1");
      runtime.cancelActiveTurn();
      runtime.beginTurn("conv-1", "umsg-2", "amsg-2");

      expect(runtime.isTurnCancelled()).toBe(false);
      expect(runtime.isCancelledRequest("mcp_req_conv-1_amsg-1_11111111-2222-3333-4444-555555555555_1")).toBe(true);
      expect(runtime.isCancelledRequest("mcp_req_conv-1_amsg-2_11111111-2222-3333-4444-555555555555_2")).toBe(false);
    });

    // An id we cannot attribute must not be treated as belonging to a live turn.
    it("falls back to the current turn for unrecognised request ids", () => {
      const runtime = new DustSessionRuntime();
      runtime.beginTurn("conv-1", "umsg-1", "amsg-1");

      expect(runtime.isCancelledRequest("something-else")).toBe(false);
      runtime.cancelActiveTurn();
      expect(runtime.isCancelledRequest("something-else")).toBe(true);
      expect(runtime.isCancelledRequest(42)).toBe(true);
    });

    it("cancels a turn only once", () => {
      const runtime = new DustSessionRuntime();
      runtime.beginTurn("conv-1", "umsg-1", "amsg-1");

      expect(runtime.cancelActiveTurn()).not.toBeNull();
      expect(runtime.cancelActiveTurn()).toBeNull();
    });

    it("releases a tool waiting on the approval gate", async () => {
      const runtime = new DustSessionRuntime();
      runtime.createApprovalGate();
      const gate = runtime.pendingApprovalPromise;
      runtime.beginTurn("conv-1", "umsg-1", "amsg-1");

      runtime.cancelActiveTurn();

      await expect(gate).resolves.toBeUndefined();
    });

    // Dust tool calls can land after the stream has closed, so the cancellation
    // has to stay visible until the next turn starts.
    it("keeps reporting a cancelled turn once it has ended", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "umsg-1", "amsg-1");
      runtime.cancelActiveTurn();
      runtime.endTurn(turn);

      expect(runtime.isTurnCancelled()).toBe(true);

      runtime.beginTurn("conv-1", "umsg-2", "amsg-2");
      expect(runtime.isTurnCancelled()).toBe(false);
    });

    it("does not clear a newer turn when an older one ends", () => {
      const runtime = new DustSessionRuntime();
      const first = runtime.beginTurn("conv-1", "umsg-1", "amsg-1");
      const second = runtime.beginTurn("conv-1", "umsg-2", "amsg-2");

      runtime.endTurn(first);

      expect(runtime.activeTurn).toBe(second);
    });

    it("ends any live turn when the session state is cleared", () => {
      const runtime = new DustSessionRuntime();
      const turn = runtime.beginTurn("conv-1", "umsg-1", "amsg-1");

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

    // Posting the user message already started the agent loop, so escaping
    // before we learn the agent message id must still stop it.
    it("cancels an agent loop started before the turn could begin", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let conversationFetches = 0;
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({ start(c) { mcpController = c; } });

      const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
        const target = String(url);
        if (target.endsWith("/mcp/register")) {
          return { ok: true, json: () => Promise.resolve({ serverId: "mcp-cancel-4", expiresAt: new Date(Date.now() + 300_000).toISOString() }) };
        }
        if (target.includes("/mcp/requests")) {
          return { ok: true, body: mcpBody };
        }
        // Turn one: create the conversation and finish, so turn two follows the
        // post-message path where the agent message id is fetched separately.
        if (target.endsWith("/assistant/conversations")) {
          return { ok: true, json: () => Promise.resolve(makeConversationResponse("conv-cancel-4", "umsg-4", "amsg-cancel-4")) };
        }
        if (target.includes("/events")) {
          return { ok: true, body: makeSseStream([{ type: "agent_message_success" }]) };
        }
        if (target.endsWith("/messages") && init?.method === "POST") {
          return { ok: true, json: () => Promise.resolve({ message: { sId: "umsg-5" } }) };
        }
        if (target.endsWith("/cancel")) {
          return { ok: true, status: 200, json: () => Promise.resolve({ success: true }) };
        }
        // GET the conversation: the user hits escape during the first lookup;
        // the second is the recovery lookup, which runs on its own signal.
        conversationFetches += 1;
        if (conversationFetches === 1) {
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return { ok: true, json: () => Promise.resolve(makeConversationGetResponse("conv-cancel-4", "umsg-5", "amsg-cancel-5")) };
      });
      vi.stubGlobal("fetch", fetchMock);

      const first = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, {});
      await expect(first.result()).resolves.toMatchObject({ stopReason: "stop" });

      const second = streamSimple(makeModel(), { messages: [{ role: "user", content: "And again" }] }, { signal: controller.signal });
      await expect(second.result()).resolves.toMatchObject({ stopReason: "aborted" });

      const cancelCall = await waitForCall(
        () => (fetchMock.mock.calls as [string, { body?: string }][]).find(([url]) => String(url).endsWith("/cancel")),
        "the cancel request",
      );
      expect(JSON.parse(cancelCall[1].body!)).toEqual({ messageIds: ["amsg-cancel-5"] });

      // The loop cancelled above may already have issued a tool call. Escaping
      // in this window has to refuse it like any other cancelled turn, not run
      // it because the turn had not formally started.
      const request = {
        jsonrpc: "2.0",
        id: "req-mid-setup",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "touch /tmp/pi-dust-should-not-exist" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));

      const posted = await waitForMcpResult(fetchMock, "req-mid-setup");
      expect(posted.result.result.isError).toBe(true);
      expect(posted.result.result.content[0].text).toBe("Tool execution cancelled by user.");
    });

    // Approving spans two awaits (dialog, then validate-action). Cancelling
    // underneath it must not leave an approval behind: the queue is positional,
    // so a leftover would approve some later turn's tool call.
    it("does not let a pre-approval that resolved after the cancel approve the next turn", async () => {
      const confirmFn = vi.fn(async (_title: string, _message: string) => true);
      const streamSimple = await makeStreamSimpleFnWithConfirm(confirmFn);
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({ start(c) { mcpController = c; } });
      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-late",
        conversationId: "conv-cancel-7",
        messageId: "amsg-7",
        stake: "medium",
        inputs: { command: "ls" },
        metadata: { toolName: "bash" },
      };
      let eventStreams = 0;

      const fetchMock = vi.fn(async (url: string) => {
        const target = String(url);
        if (target.endsWith("/mcp/register")) {
          return { ok: true, json: () => Promise.resolve({ serverId: "mcp-cancel-7", expiresAt: new Date(Date.now() + 300_000).toISOString() }) };
        }
        if (target.includes("/mcp/requests")) return { ok: true, body: mcpBody };
        if (target.endsWith("/assistant/conversations")) {
          return { ok: true, json: () => Promise.resolve(makeConversationResponse("conv-cancel-7", "umsg-7", "amsg-7")) };
        }
        if (target.includes("/validate-action")) {
          // The user escapes while this turn's approval is being posted.
          controller.abort();
          return { ok: true, json: () => Promise.resolve({}) };
        }
        if (target.endsWith("/cancel")) return { ok: true, status: 200, json: () => Promise.resolve({ success: true }) };
        if (target.endsWith("/messages")) {
          return { ok: true, json: () => Promise.resolve({ message: { sId: "umsg-8" } }) };
        }
        if (target.includes("/events")) {
          eventStreams += 1;
          // Turn one asks for approval; turn two just completes.
          return eventStreams === 1
            ? { ok: true, body: makeSseStream([approveEvent]) }
            : { ok: true, body: makeSseStream([{ type: "agent_message_success" }]) };
        }
        return { ok: true, json: () => Promise.resolve(makeConversationGetResponse("conv-cancel-7", "umsg-8", "amsg-8")) };
      });
      vi.stubGlobal("fetch", fetchMock);

      const first = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });
      await expect(first.result()).resolves.toMatchObject({ stopReason: "aborted" });

      const second = streamSimple(makeModel(), { messages: [{ role: "user", content: "Again" }] }, {});
      await expect(second.result()).resolves.toMatchObject({ stopReason: "stop" });

      // Turn two's own tool call must still be prompted for. A pre-approval left
      // behind by turn one would be consumed here instead, running it silently.
      const request = {
        jsonrpc: "2.0",
        id: "mcp_req_conv-cancel-7_amsg-8_11111111-2222-3333-4444-555555555555_1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "echo hi" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));

      await waitForCall(
        () => confirmFn.mock.calls.find(([title]) => String(title).includes("Dust agent wants to run")),
        "the approval prompt for turn two's tool call",
      );
    });

    // `postValidateAction` is not tied to the turn's signal, so an approval can
    // land after the *next* turn has started. Guarding on whichever turn is
    // current would have stopped guarding by then.
    it("drops a pre-approval that lands after the next turn has started", async () => {
      const confirmFn = vi.fn(async (_title: string, _message: string) => true);
      const streamSimple = await makeStreamSimpleFnWithConfirm(confirmFn);
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({ start(c) { mcpController = c; } });
      let releaseValidateAction!: () => void;
      const validateActionLanded = new Promise<void>((resolve) => { releaseValidateAction = resolve; });
      let eventStreams = 0;

      const fetchMock = vi.fn(async (url: string) => {
        const target = String(url);
        if (target.endsWith("/mcp/register")) {
          return { ok: true, json: () => Promise.resolve({ serverId: "mcp-cancel-8", expiresAt: new Date(Date.now() + 300_000).toISOString() }) };
        }
        if (target.includes("/mcp/requests")) return { ok: true, body: mcpBody };
        if (target.endsWith("/assistant/conversations")) {
          return { ok: true, json: () => Promise.resolve(makeConversationResponse("conv-cancel-8", "umsg-9", "amsg-9")) };
        }
        if (target.includes("/validate-action")) {
          // Held open across the cancellation and the whole of turn two.
          await validateActionLanded;
          return { ok: true, json: () => Promise.resolve({}) };
        }
        if (target.endsWith("/cancel")) return { ok: true, status: 200, json: () => Promise.resolve({ success: true }) };
        if (target.endsWith("/messages")) {
          return { ok: true, json: () => Promise.resolve({ message: { sId: "umsg-10" } }) };
        }
        if (target.includes("/events")) {
          eventStreams += 1;
          return eventStreams === 1
            ? {
              ok: true,
              body: makeSseStream([{
                type: "tool_approve_execution",
                actionId: "action-crossing",
                conversationId: "conv-cancel-8",
                messageId: "amsg-9",
                stake: "medium",
                inputs: { command: "ls" },
                metadata: { toolName: "bash" },
              }]),
            }
            : { ok: true, body: makeSseStream([{ type: "agent_message_success" }]) };
        }
        return { ok: true, json: () => Promise.resolve(makeConversationGetResponse("conv-cancel-8", "umsg-10", "amsg-10")) };
      });
      vi.stubGlobal("fetch", fetchMock);

      // Turn one parks on validate-action, then the user escapes.
      const first = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });
      await waitForCall(
        () => (fetchMock.mock.calls as [string][]).find(([url]) => String(url).includes("/validate-action")),
        "the validate-action POST",
      );
      controller.abort();

      // Turn two runs and completes while turn one is still parked.
      const second = streamSimple(makeModel(), { messages: [{ role: "user", content: "Again" }] }, {});
      await expect(second.result()).resolves.toMatchObject({ stopReason: "stop" });

      // Only now does turn one's approval land.
      releaseValidateAction();
      await first.result();

      const request = {
        jsonrpc: "2.0",
        id: "mcp_req_conv-cancel-8_amsg-10_11111111-2222-3333-4444-555555555555_1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "echo hi" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));

      await waitForCall(
        () => confirmFn.mock.calls.find(([title]) => String(title).includes("Dust agent wants to run")),
        "the approval prompt for turn two's tool call",
      );
    });

    // A tool call that arrives mid-turn parks on the approval gate. Cancelling
    // has to release it and refuse it — not wake it up into a prompt for a turn
    // the user already escaped out of.
    it("releases a tool waiting on the approval gate and refuses it", async () => {
      const confirmFn = vi.fn(async () => true);
      const streamSimple = await makeStreamSimpleFnWithConfirm(confirmFn);
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({ start(c) { mcpController = c; } });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-cancel-5", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: mcpBody })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-cancel-5", "umsg-5", "amsg-cancel-5")),
        })
        .mockResolvedValue({ ok: true, status: 200, body: abortableBody(controller.signal), json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal });
      await waitForCall(
        () => (fetchMock.mock.calls as [string][]).find(([url]) => String(url).includes("/events")),
        "the agent event stream to open",
      );

      // Delivered while the turn is live, so it parks on the approval gate.
      const request = {
        jsonrpc: "2.0",
        id: "req-at-gate",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "touch /tmp/pi-dust-should-not-exist" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(confirmFn).not.toHaveBeenCalled();

      controller.abort();
      await stream.result();

      const posted = await waitForMcpResult(fetchMock, "req-at-gate");
      expect(posted.result.result.isError).toBe(true);
      expect(posted.result.result.content[0].text).toBe("Tool execution cancelled by user.");
      // Never prompted: the user escaped, so there was nothing left to approve.
      expect(confirmFn).not.toHaveBeenCalled();
    });

    // Dust can cancel the generation itself (web UI, another client). The local
    // abort signal never fires there, so the runtime has to learn about it some
    // other way — otherwise a late tool call would still run.
    it("refuses later tool calls when Dust reports the generation cancelled", async () => {
      const streamSimple = await makeStreamSimpleFn();
      const encoder = new TextEncoder();
      let mcpController!: ReadableStreamDefaultController<Uint8Array>;
      const mcpBody = new ReadableStream<Uint8Array>({ start(c) { mcpController = c; } });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-cancel-6", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: mcpBody })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-cancel-6", "umsg-6", "amsg-cancel-6")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_generation_cancelled" }]) })
        .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimple(makeModel(), { messages: [{ role: "user", content: "Hello" }] }, {});
      await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });

      const request = {
        jsonrpc: "2.0",
        id: "req-after-dust-cancel",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "touch /tmp/pi-dust-should-not-exist" } },
      };
      mcpController.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "mcp-e0", data: request })}\n\n`));
      mcpController.close();

      const posted = await waitForMcpResult(fetchMock, "req-after-dust-cancel");
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
