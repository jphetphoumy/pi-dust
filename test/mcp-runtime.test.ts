import { TextEncoder } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("retries after a non-ok MCP SSE response until aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: null,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
    });

    await Promise.resolve();
    abortController.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("[dust:mcp] SSE non-ok response: HTTP 503");
  });

  it("ignores malformed MCP JSON frames and still responds to later valid requests", async () => {
    const postedBodies: string[] = [];
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
        return { ok: true, json: async () => ({ success: true }) };
      })
      .mockRejectedValueOnce(new Error("stop-listener"));

    vi.stubGlobal("fetch", fetchMock);

    await listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      authHeaders: { Authorization: "Bearer token" },
      serverId: "srv-1",
      abortController: new AbortController(),
      buildConfirmMessage: () => "confirm",
      executeMcpTool: () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
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
