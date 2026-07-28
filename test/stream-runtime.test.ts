import { TextEncoder } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStream, findAgentMessageSId, streamEvents } from "../src/dust-stream.js";

function makeSseBody(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ eventId: "evt", data: event })}\n\n`));
      }
      controller.close();
    },
  });
}

describe("dust stream runtime helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries SSE opening after transient 5xx failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        body: makeSseBody([{ type: "agent_message_success" }]),
      });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createEventStream();
    const events: unknown[] = [];
    const promise = streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });

    const reader = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    await reader;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.some((event: { type?: string }) => event.type === "done")).toBe(true);
  });

  it("retries SSE opening after a thrown fetch error", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        ok: true,
        body: makeSseBody([{ type: "agent_message_success" }]),
      });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createEventStream();
    const promise = streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("throws a session expired error when SSE responds with 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));

    await expect(
      streamEvents({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        conversationSId: "conv-1",
        agentMsgSId: "msg-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
        signal: undefined,
        stream: createEventStream(),
        model: { id: "agent-1", api: "dust", provider: "dust" },
        handleToolApproveExecution: async () => true,
        postValidateAction: async () => undefined,
        recordPreApproval: () => undefined,
        resolveApprovalGate: () => undefined,
      }),
    ).rejects.toThrow(/session expired/i);
  });

  it("throws on non-retryable SSE failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }));

    await expect(
      streamEvents({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        conversationSId: "conv-1",
        agentMsgSId: "msg-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
        signal: undefined,
        stream: createEventStream(),
        model: { id: "agent-1", api: "dust", provider: "dust" },
        handleToolApproveExecution: async () => true,
        postValidateAction: async () => undefined,
        recordPreApproval: () => undefined,
        resolveApprovalGate: () => undefined,
      }),
    ).rejects.toThrow("Failed to stream events: HTTP 404");
  });

  it("throws when the SSE response has no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, body: null }));

    await expect(
      streamEvents({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        conversationSId: "conv-1",
        agentMsgSId: "msg-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
        signal: undefined,
        stream: createEventStream(),
        model: { id: "agent-1", api: "dust", provider: "dust" },
        handleToolApproveExecution: async () => true,
        postValidateAction: async () => undefined,
        recordPreApproval: () => undefined,
        resolveApprovalGate: () => undefined,
      }),
    ).rejects.toThrow("SSE response has no body");
  });

  it("does not inject tool marker text into the assistant message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeSseBody([
        { type: "generation_tokens", classification: "tokens", text: "prefix" },
        { type: "tool_params", action: { functionCallName: "bash" } },
        { type: "agent_message_success" },
      ]),
    }));

    const stream = createEventStream();
    const events: unknown[] = [];
    const read = (async () => {
      for await (const event of stream) events.push(event);
    })();

    await streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });
    await read;

    // Tool calls render as their own transcript entry via pi's native
    // renderers, so tool_params must not add text to the message.
    const deltas = events.filter((e: any) => e.type === "text_delta");
    expect(deltas.every((e: any) => !e.delta.includes("[Tool:"))).toBe(true);
    expect(deltas.some((e: any) => e.delta === "prefix")).toBe(true);
  });

  it("keeps the transcript clean when a tool has no name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeSseBody([
        { type: "tool_params", action: {} },
        { type: "agent_message_success" },
      ]),
    }));

    const stream = createEventStream();
    const events: unknown[] = [];
    const read = (async () => {
      for await (const event of stream) events.push(event);
    })();

    await streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });
    await read;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "done" }),
      ]),
    );
  });

  it("retries a quiet stream before giving up, then emits done", async () => {
    // Dust caps each agent event stream at 60s and expects the client to
    // resume, so a closed stream is not the end of the turn. Only after several
    // silent windows do we conclude the turn is over.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: makeSseBody([]) });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createEventStream();
    const events: unknown[] = [];
    const read = (async () => {
      for await (const event of stream) events.push(event);
    })();

    const promise = streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    await read;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "done", reason: "stop" }),
      ]),
    );
  });
  it("throws when no matching agent message is found", () => {
    expect(() => findAgentMessageSId([[{ type: "user_message", sId: "u1" }]], "u1")).toThrow(
      "No agent message found in conversation content",
    );
  });
});

describe("dust stream resumption", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("resumes mid-turn instead of reporting the turn complete", async () => {
    // Dust closes the events stream after 60s even while the agent is still
    // working. Treating that as completion truncated long turns: the assistant
    // message stopped mid-sentence with stopReason "stop".
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeSseBody([{ type: "generation_tokens", classification: "tokens", text: "working" }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: makeSseBody([
          { type: "generation_tokens", classification: "tokens", text: " done" },
          { type: "agent_message_success" },
        ]),
      });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createEventStream();
    const events: unknown[] = [];
    const read = (async () => {
      for await (const event of stream) events.push(event);
    })();

    const promise = streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    await read;

    // The second window must have been opened, and with a cursor.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("lastEventId=");

    // The turn completes only once the terminal event arrives, carrying the
    // text from both windows.
    const done = events.find((e: any) => e.type === "done") as any;
    expect(done.message.content[0].text).toBe("working done");
  });
});

describe("dust stream auth recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes and resumes on a mid-stream 401 instead of ending the session", async () => {
    // Dust access tokens last ~15 minutes, shorter than a long turn. Declaring
    // the session expired on the first 401 forced a re-login and made the
    // extension unusable for long tasks.
    let token = "stale";
    const refreshAuth = vi.fn(async () => { token = "fresh"; return true; });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, body: makeSseBody([{ type: "agent_message_success" }]) });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createEventStream();
    const promise = streamEvents({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      conversationSId: "conv-1",
      agentMsgSId: "msg-1",
      getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
      refreshAuth,
      signal: undefined,
      stream,
      model: { id: "agent-1", api: "dust", provider: "dust" },
      handleToolApproveExecution: async () => true,
      postValidateAction: async () => undefined,
      recordPreApproval: () => undefined,
      resolveApprovalGate: () => undefined,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    // The retry carried the refreshed token, and the turn completed normally.
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("gives up when the refresh itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(
      streamEvents({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        conversationSId: "conv-1",
        agentMsgSId: "msg-1",
        getAuthHeaders: () => ({ Authorization: "Bearer stale" }),
        refreshAuth: async () => false,
        signal: undefined,
        stream: createEventStream(),
        model: { id: "agent-1", api: "dust", provider: "dust" },
        handleToolApproveExecution: async () => true,
        postValidateAction: async () => undefined,
        recordPreApproval: () => undefined,
        resolveApprovalGate: () => undefined,
      }),
    ).rejects.toThrow(/session expired/i);
  });
});
