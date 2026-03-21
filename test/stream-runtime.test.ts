import { TextEncoder } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStream, streamEvents } from "../src/dust-stream.js";

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
});
