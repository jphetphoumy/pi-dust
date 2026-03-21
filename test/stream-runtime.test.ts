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
      authHeaders: { Authorization: "Bearer token" },
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
      authHeaders: { Authorization: "Bearer token" },
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
        authHeaders: { Authorization: "Bearer token" },
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
        authHeaders: { Authorization: "Bearer token" },
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
        authHeaders: { Authorization: "Bearer token" },
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

  it("falls back to functionCallName for tool indicators", async () => {
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
      authHeaders: { Authorization: "Bearer token" },
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
        expect.objectContaining({ type: "text_delta", delta: "\n[Tool: bash]\n" }),
      ]),
    );
  });

  it("uses the generic tool indicator when no tool name is available", async () => {
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
      authHeaders: { Authorization: "Bearer token" },
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
        expect.objectContaining({ type: "text_delta", delta: "\n[Tool: tool]\n" }),
      ]),
    );
  });

  it("emits a final done event when the SSE stream ends without a success event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeSseBody([]),
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
      authHeaders: { Authorization: "Bearer token" },
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
