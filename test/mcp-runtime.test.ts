import { TextEncoder } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_REGISTRATION_LOST_MESSAGE, SESSION_EXPIRED_MESSAGE } from "../src/dust-constants.js";
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

/**
 * A stream that never closes on its own, so a reconnect loop parks instead of
 * cycling — but tears down cleanly once the given controller is aborted, the
 * same way a real fetch's body would.
 */
function makePendingRequestStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => {
        controller.error(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      }, { once: true });
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
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it("refreshes once and retries the connect on HTTP 401, without throwing", async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn()
      // 1. connect -> 401
      .mockResolvedValueOnce({ ok: false, status: 401, body: null })
      // 2. retried connect after refresh -> ok, stays open until aborted
      .mockResolvedValueOnce({ ok: true, body: makePendingRequestStream(abortController.signal) });
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn().mockResolvedValue(true);

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(refreshAuth).toHaveBeenCalledTimes(1);

    abortController.abort();
    await promise;
  });

  it("throws SESSION_EXPIRED_MESSAGE on HTTP 401 when the refresh itself fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn().mockResolvedValue(false);
    const abortController = new AbortController();
    await expect(
      listenMcpRequests({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
        refreshAuth,
        serverId: "srv-1",
        abortController,
        buildConfirmMessage: () => "confirm",
        executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
        getTools: () => [],
        getConfirmFn: () => async () => true,
        getPendingApprovalPromise: () => null,
        preApprovedActions: new Map(),
        isCancelledRequest: () => false,
        isToolActive: () => true,
      }),
    ).rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a second time within the same connect attempt loop", async () => {
    // Two 401s in a row after one refresh means the session really is dead —
    // refreshing again would loop forever instead of surfacing the failure.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, body: null })
      .mockResolvedValueOnce({ ok: false, status: 401, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn().mockResolvedValue(true);
    const abortController = new AbortController();

    await expect(
      listenMcpRequests({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
        refreshAuth,
        serverId: "srv-1",
        abortController,
        buildConfirmMessage: () => "confirm",
        executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
        getTools: () => [],
        getConfirmFn: () => async () => true,
        getPendingApprovalPromise: () => null,
        preApprovedActions: new Map(),
        isCancelledRequest: () => false,
        isToolActive: () => true,
      }),
    ).rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still attempts a refresh on a 401 that arrives well after the last attempt, even with no successful connect in between (issue #32 defect 4)", async () => {
    // A "have we refreshed yet" boolean that only resets on a successful
    // connect would stay latched through a long run of retryable 503s, so a
    // genuine 401 minutes later would be treated as fatal without ever trying
    // a refresh that would have worked. The cooldown is time-based instead,
    // so it must not matter that nothing in between ever connected cleanly.
    const abortController = new AbortController();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 401, body: null };
      if (call <= 8) return { ok: false, status: 503, body: null };
      if (call === 9) return { ok: false, status: 401, body: null };
      // Park here once refreshed and reconnected, instead of an empty stream
      // that would just cycle the loop into another immediate reconnect.
      return { ok: true, body: makePendingRequestStream(abortController.signal) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn().mockResolvedValue(true);

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    // Enough real elapsed time for the exponential backoff between the 503s
    // (1s, 2s, 4s, 8s, 16s, 30s, 30s, ... ) to clear the refresh cooldown
    // window well before the second 401 shows up.
    await vi.advanceTimersByTimeAsync(200_000);

    expect(call).toBeGreaterThanOrEqual(9);
    expect(refreshAuth).toHaveBeenCalledTimes(2);

    abortController.abort();
    await promise;
  });

  it("earns a fresh refresh budget after a connect that actually succeeds, even within the cooldown window", async () => {
    // Without resetting the cooldown on a successful connect, a refresh that
    // is immediately followed by a good connection which then closes early
    // (a transient drop, or Dust's early `done` sentinel) and hits a 401 of
    // its own would have that second 401 blocked by the still-fresh cooldown
    // from the first — even though the connection in between proved the
    // token was genuinely good a moment ago.
    const abortController = new AbortController();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 401, body: null };
      if (call === 2) {
        // A connect that succeeds and then closes immediately (no data, no
        // "done" sentinel needed — an already-finished body is enough).
        return { ok: true, body: makeMcpRequestStream([]) };
      }
      if (call === 3) return { ok: false, status: 401, body: null };
      return { ok: true, body: makePendingRequestStream(abortController.signal) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn().mockResolvedValue(true);

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    // No real time needs to pass between the two 401s — the reset happens on
    // the successful connect in between, not on a clock.
    await vi.waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(4);
    });
    expect(refreshAuth).toHaveBeenCalledTimes(2);

    abortController.abort();
    await promise;
  });

  it("does not execute a tool call if the listener was aborted while parked on the approval gate (issue #32 defect 4)", async () => {
    // clearMcpState() resolves the approval gate unconditionally (so a
    // parked listener doesn't hang forever) and then aborts the controller.
    // Waking up from that gate is not the same as still being wanted: without
    // an abort check right after, the listener would go on to prompt for and
    // EXECUTE the tool call, then POST the result to a registration that's
    // already gone — or, on a session switch, into whatever session is live
    // now instead of the one that asked.
    const callRequest = { jsonrpc: "2.0", id: "req-1", method: "tools/call", params: { name: "bash", arguments: {} } };
    const abortController = new AbortController();

    let resolveGate: (() => void) | undefined;
    const pendingApprovalPromise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let reachedGate = false;
    const getPendingApprovalPromise = () => {
      reachedGate = true;
      return pendingApprovalPromise;
    };

    const executeMcpTool = vi.fn().mockResolvedValue({ content: [{ type: "text" as const, text: "ok" }], isError: false });
    const confirmFn = vi.fn().mockResolvedValue(true);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: makeMcpRequestStream([
        `data: ${JSON.stringify({ eventId: "e1", data: callRequest })}\n\n`,
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool,
      getTools: () => [],
      getConfirmFn: () => confirmFn,
      getPendingApprovalPromise,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    // getPendingApprovalPromise() and the await right after it are adjacent
    // with no await in between, so by the time this flips true the listener
    // is provably already suspended on the gate.
    await vi.waitFor(() => {
      expect(reachedGate).toBe(true);
    });

    // The two effects of clearMcpState(), in order: abort the controller,
    // then resolve the gate so nothing is left hanging.
    abortController.abort();
    resolveGate!();

    await promise;

    expect(confirmFn).not.toHaveBeenCalled();
    expect(executeMcpTool).not.toHaveBeenCalled();
  });

  it("refuses a tools/call for an inactive tool ahead of the approval prompt, without consuming a queued pre-approval (issue #51)", async () => {
    // The regression this guards against: an earlier version of this gate
    // lived inside `executeMcpTool`, which only runs *after* a
    // pre-approval has already been popped off the (FIFO, positional) queue.
    // A call refused there still consumed the entry meant for a different,
    // still-legitimate call, letting that next call fall through to
    // whatever decision happened to be queued next. `isToolActive` must be
    // checked, and must refuse, before `preApprovedActions` is ever touched.
    const callRequest = { jsonrpc: "2.0", id: "req-1", method: "tools/call", params: { name: "bash", arguments: {} } };
    const abortController = new AbortController();
    const executeMcpTool = vi.fn().mockResolvedValue({ content: [{ type: "text" as const, text: "ok" }], isError: false });
    const confirmFn = vi.fn().mockResolvedValue(true);
    // A pre-approval queued for some other, unrelated call — must survive
    // untouched if `bash` is correctly refused before reaching this map.
    const preApprovedActions = new Map([["other-action", true]]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: makeMcpRequestStream([`data: ${JSON.stringify({ eventId: "e1", data: callRequest })}\n\n`]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      // Keeps the loop parked after the one frame above instead of
      // reconnecting and replaying it.
      .mockResolvedValueOnce({ ok: true, body: makePendingRequestStream(abortController.signal) });
    vi.stubGlobal("fetch", fetchMock);

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool,
      getTools: () => [],
      getConfirmFn: () => confirmFn,
      getPendingApprovalPromise: () => null,
      preApprovedActions,
      isCancelledRequest: () => false,
      isToolActive: (name) => name !== "bash",
    });

    await vi.waitFor(() => {
      const resultsCall = (fetchMock.mock.calls as [string, { body?: string }][])
        .find(([url]) => String(url).includes("/mcp/results"));
      expect(resultsCall).toBeDefined();
    });

    const [, resultsInit] = (fetchMock.mock.calls as [string, { body: string }][])
      .find(([url]) => String(url).includes("/mcp/results"))!;
    const posted = JSON.parse(resultsInit.body);
    expect(posted.result.result.isError).toBe(true);
    expect(posted.result.result.content[0].text).toContain("bash");
    expect(posted.result.result.content[0].text).toContain("not currently active");

    expect(confirmFn).not.toHaveBeenCalled();
    expect(executeMcpTool).not.toHaveBeenCalled();
    // The untouched pre-approval, still there for whoever it was meant for.
    expect(preApprovedActions.size).toBe(1);
    expect(preApprovedActions.get("other-action")).toBe(true);

    abortController.abort();
    await promise;
  });

  it.each([403, 404])("throws MCP_REGISTRATION_LOST_MESSAGE on terminal HTTP %i without retrying", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status, body: null });
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    await expect(
      listenMcpRequests({
        baseUrl: "https://dust.test/api/v1/w/ws-1",
        getAuthHeaders: () => ({ Authorization: "Bearer token" }),
        refreshAuth: async () => false,
        serverId: "srv-1",
        abortController,
        buildConfirmMessage: () => "confirm",
        executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
        getTools: () => [],
        getConfirmFn: () => async () => true,
        getPendingApprovalPromise: () => null,
        preApprovedActions: new Map(),
        isCancelledRequest: () => false,
        isToolActive: () => true,
      }),
    ).rejects.toThrow(MCP_REGISTRATION_LOST_MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not open the MCP SSE request loop when already aborted", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    abortController.abort();

    await listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("retries after a thrown MCP SSE fetch until aborted", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
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
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-1",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
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
      () => ({ Authorization: "Bearer token" }),
      "srv-1",
      async () => true,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    clearInterval(timer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token on a 401 heartbeat instead of treating it as success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);
    const onRegistrationLost = vi.fn();

    const timer = startMcpHeartbeat(
      "https://dust.test/api/v1/w/ws-1",
      () => ({ Authorization: "Bearer token" }),
      "srv-1",
      refreshAuth,
      onRegistrationLost,
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    clearInterval(timer);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(onRegistrationLost).not.toHaveBeenCalled();
  });

  it.each([403, 404])("treats a %i heartbeat as a lost registration", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status });
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);
    const onRegistrationLost = vi.fn();

    const timer = startMcpHeartbeat(
      "https://dust.test/api/v1/w/ws-1",
      () => ({ Authorization: "Bearer token" }),
      "srv-1",
      refreshAuth,
      onRegistrationLost,
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    clearInterval(timer);

    expect(onRegistrationLost).toHaveBeenCalledTimes(1);
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it("fires the heartbeat comfortably before Dust's 5 minute stream timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const timer = startMcpHeartbeat(
      "https://dust.test/api/v1/w/ws-1",
      () => ({ Authorization: "Bearer token" }),
      "srv-1",
      async () => true,
      () => {},
    );

    // Just under 5 minutes must already have produced a beat, otherwise the
    // heartbeat and Dust's server-side close race at the same boundary.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    clearInterval(timer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("dust MCP listener shutdown", () => {
  it("resolves quietly when the stream is aborted mid-read", async () => {
    // Tearing down a session aborts the SSE stream, rejecting the pending read.
    // That must not surface as "listenMcpRequests fatal".
    const abortController = new AbortController();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abortController.signal.addEventListener("abort", () => {
          controller.error(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));

    const promise = listenMcpRequests({
      baseUrl: "https://dust.test/api/v1/w/ws-1",
      getAuthHeaders: () => ({ Authorization: "Bearer token" }),
      refreshAuth: async () => false,
      serverId: "srv-abort",
      abortController,
      buildConfirmMessage: () => "confirm",
      executeMcpTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
      getTools: () => [],
      getConfirmFn: () => async () => true,
      getPendingApprovalPromise: () => null,
      preApprovedActions: new Map(),
      isCancelledRequest: () => false,
      isToolActive: () => true,
    });

    await Promise.resolve();
    abortController.abort();

    await expect(promise).resolves.toBeUndefined();
  });
});

describe("dust MCP auth freshness", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("heartbeats with the current token, not the one captured at registration", async () => {
    // The heartbeat outlives the access token that registered the server.
    // Closing over the original headers let the registration lapse once the
    // token rotated, taking the client-side tools with it.
    let token = "old-token";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const timer = startMcpHeartbeat(
      "https://dust.test/api/v1/w/ws-1",
      () => ({ Authorization: `Bearer ${token}` }),
      "srv-rotate",
      async () => true,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    token = "rotated-token";
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    clearInterval(timer);

    const used = fetchMock.mock.calls.map(([, opts]: [string, any]) => opts?.headers?.Authorization);
    expect(used[0]).toBe("Bearer old-token");
    expect(used.at(-1)).toBe("Bearer rotated-token");
  });
});
