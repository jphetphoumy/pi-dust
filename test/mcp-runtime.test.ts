import { TextEncoder } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_EXPIRED_MESSAGE } from "../src/dust-constants.js";
import { listenMcpRequests, startMcpHeartbeat } from "../src/dust-mcp.js";

function makeMcpRequestStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

describe("dust MCP runtime helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries after a non-ok MCP SSE response with exponential backoff", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: null })
      .mockResolvedValueOnce({ ok: false, status: 503, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it("throws SESSION_EXPIRED_MESSAGE on HTTP 401 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    await expect(
      listenMcpRequests({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        authHeaders: { Authorization: "Bearer token" },
        serverId: "srv-1",
        abortController,
        buildConfirmMessage: () => "confirm",
        executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
        getConfirmFn: () => async () => true,
        getPendingApprovalPromise: () => null,
        preApprovedActions: new Map(),
      }),
    ).rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])("aborts and resolves on terminal HTTP %i without retrying", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    await listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("does not open the MCP SSE request loop when already aborted", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    abortController.abort();

    await listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("retries after a thrown MCP SSE fetch until aborted", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it("ignores malformed MCP JSON frames and still responds to later valid requests", async () => {
    const postedBodies: string[] = [];
    const abortController = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeMcpRequestStream([
          "data: {not-json}\n\n",
          `data: ${JSON.stringify({
            eventId: "evt-1",
            data: { jsonrpc: "2.0", id: "req-1", method: "initialize", params: {} },
          })}\n\n`,
        ]),
      })
      .mockImplementationOnce(async (_url: string, options: { body: string }) => {
        postedBodies.push(options.body);
        abortController.abort();
        return { ok: true, json: async () => ({ success: true }) };
      });

    vi.stubGlobal("fetch", fetchMock);

    await listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    expect(postedBodies).toHaveLength(1);
    const responseEnvelope = JSON.parse(postedBodies[0]);
    expect(responseEnvelope.serverId).toBe("srv-1");
    expect(responseEnvelope.result.id).toBe("req-1");
    expect(responseEnvelope.result.result.serverInfo.name).toBe("pi-dust-extension");
  });

  it("swallows heartbeat fetch failures", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("heartbeat failed"));
    vi.stubGlobal("fetch", fetchMock);

    const timer = startMcpHeartbeat(
      "https://dust.test/api/v1/w/ws-1",
      { Authorization: "Bearer token" },
      "srv-1",
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    clearInterval(timer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
