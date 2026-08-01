import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dustAuth from "../src/dust-auth.js";
import { fetchCreditsJson } from "../src/dust-credits.js";
import {
  applyRuntimeContext,
  buildSessionContext,
  DustSessionRuntime,
  invalidateCredentials,
  invalidateRuntimeCredentials,
  shouldRefreshAccessToken,
} from "../src/dust-runtime.js";
import { persistCredentialState } from "../src/dust-state.js";
import { agentDir, makeCredentials, makeSessionContext, readState, seedLoggedIn, sessionPath, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust runtime", () => {
  useTempAgentDir();

  it("creates and resolves the approval gate", async () => {
    const runtime = new DustSessionRuntime();
    runtime.createApprovalGate();

    const gate = runtime.pendingApprovalPromise;
    expect(gate).not.toBeNull();

    runtime.resolveApprovalGate();
    await expect(gate).resolves.toBeUndefined();
    expect(runtime.pendingApprovalPromise).toBeNull();
  });

  it("clearMcpState aborts MCP requests and clears approval state", () => {
    const runtime = new DustSessionRuntime();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");

    runtime.mcpServerId = "mcp-1";
    runtime.mcpRequestsAbortController = abortController;
    runtime.preApprovedActions.set("action-1", true);
    runtime.createApprovalGate();

    runtime.clearMcpState();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(runtime.mcpServerId).toBeNull();
    expect(runtime.mcpRequestsAbortController).toBeNull();
    expect(runtime.preApprovedActions.size).toBe(0);
    expect(runtime.pendingApprovalPromise).toBeNull();
  });

  it("clearMcpState resolves a pending approval gate instead of hanging it (issue #32 defect 5)", async () => {
    // A listener can be parked awaiting this gate (tools/call blocked on a
    // pending tool_approve_execution). If a registration is lost while that
    // await is live, clearMcpState() nulling the resolver without calling it
    // would leave the listener's await pending forever — it never returns to
    // reader.read(), so it never observes the abort either, leaking its
    // reader lock and response body for good.
    const runtime = new DustSessionRuntime();
    runtime.mcpServerId = "mcp-1";
    runtime.mcpRequestsAbortController = new AbortController();
    runtime.createApprovalGate();
    const gate = runtime.pendingApprovalPromise;

    runtime.clearMcpState();

    await expect(gate).resolves.toBeUndefined();
    expect(runtime.pendingApprovalPromise).toBeNull();
  });

  it("clearMcpState cancels an active turn — registration lost mid-turn, not just between turns", async () => {
    // The merge of the resilience fix (clearMcpState() re-registers on a lost
    // registration) with the cancel feature (clearMcpState() also cancels
    // whatever turn is in flight) created this interaction, and nothing
    // exercised it: mcp.test.ts's heartbeat-403 case fires clearMcpState()
    // between turns, when activeTurn is already null, so cancelActiveTurn()
    // there is a no-op. A registration lost *during* a turn is the case that
    // actually has local tool work to stop.
    const runtime = new DustSessionRuntime();
    runtime.mcpServerId = "mcp-1";
    runtime.mcpRequestsAbortController = new AbortController();
    runtime.preApprovedActions.set("action-1", true);
    runtime.createApprovalGate();
    const gate = runtime.pendingApprovalPromise;

    const turn = runtime.beginTurn("conv-1", "umsg-1", "amsg-1");
    expect(turn.cancelled).toBe(false);
    expect(turn.toolAbortController.signal.aborted).toBe(false);

    runtime.clearMcpState();

    // cancelActiveTurn()'s effects: the turn is marked cancelled, its local
    // tool work is aborted, and pre-approvals collected for it are dropped
    // (a tool call refused for being cancelled never consumes its entry, so
    // leaving the queue in place would auto-approve an unrelated tool call in
    // a later turn).
    expect(turn.cancelled).toBe(true);
    expect(turn.toolAbortController.signal.aborted).toBe(true);
    expect(runtime.preApprovedActions.size).toBe(0);
    expect(runtime.isTurnCancelled()).toBe(true);
    expect(runtime.activeTurn).toBeNull();

    // And the approval gate is still resolved (not left hanging), same as
    // the no-active-turn case above.
    await expect(gate).resolves.toBeUndefined();
    expect(runtime.pendingApprovalPromise).toBeNull();
  });

  it("buildSessionContext persists conversation ids in extension state", () => {
    const old = sessionPath("old.jsonl");
    const current = sessionPath("session-a.jsonl");
    seedLoggedIn(makeCredentials({ conversations: { [old]: "conv-old" } }));
    const ctx = {
      modelRegistry: {},
      sessionManager: { getSessionFile: vi.fn().mockReturnValue(current) },
    } as any;

    const sessionContext = buildSessionContext(ctx);
    sessionContext.saveConversationId("conv-123");

    expect(readState()).toMatchObject({
      conversations: {
        [old]: "conv-old",
        [current]: "conv-123",
      },
    });
  });

  it("saving a conversation sweeps out sessions whose file is gone", () => {
    // The map is append-only otherwise, so without a sweep it grows for the
    // life of the install — deleted sessions and scratch dirs included.
    const alive = sessionPath("alive.jsonl");
    seedLoggedIn(makeCredentials({
      conversations: { [alive]: "conv-alive", "/sessions/deleted.jsonl": "conv-deleted" },
    }));
    const ctx = {
      modelRegistry: {},
      sessionManager: { getSessionFile: vi.fn().mockReturnValue(sessionPath("new.jsonl")) },
    } as any;

    buildSessionContext(ctx).saveConversationId("conv-new");

    const conversations = readState().conversations as Record<string, string>;
    expect(conversations[alive]).toBe("conv-alive");
    expect(conversations).not.toHaveProperty("/sessions/deleted.jsonl");
  });

  // Root ignores directory permissions, so the unreadable-path setup below
  // proves nothing there.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)("keeps mappings it cannot stat, rather than reading them as deleted", () => {
    // `existsSync` answers false for a file it merely cannot reach, which would
    // turn one unreadable sessions directory into "every session deleted".
    const unreachableDir = join(agentDir(), "locked");
    mkdirSync(unreachableDir, { recursive: true });
    const unreachable = join(unreachableDir, "s.jsonl");
    writeFileSync(unreachable, "");
    chmodSync(unreachableDir, 0o000);

    try {
      seedLoggedIn(makeCredentials({ conversations: { [unreachable]: "conv-unreachable" } }));
      const ctx = {
        modelRegistry: {},
        sessionManager: { getSessionFile: vi.fn().mockReturnValue(sessionPath("new.jsonl")) },
      } as any;

      buildSessionContext(ctx).saveConversationId("conv-new");

      expect(readState().conversations).toMatchObject({ [unreachable]: "conv-unreachable" });
    } finally {
      chmodSync(unreachableDir, 0o755);
    }
  });

  it("persisting a stale credential snapshot leaves the conversation map alone", () => {
    // Handlers read a credential at the top and write it back much later. If
    // that write carried the snapshot's conversation map, a conversation
    // attached or created in between would be silently dropped.
    const first = sessionPath("session-a.jsonl");
    const second = sessionPath("session-b.jsonl");
    const stale = makeCredentials({ conversations: { [first]: "conv-old" } });
    seedLoggedIn(stale);
    const ctx = {
      modelRegistry: {},
      sessionManager: { getSessionFile: vi.fn().mockReturnValue(second) },
    } as any;

    buildSessionContext(ctx).saveConversationId("conv-new");
    persistCredentialState({ ...stale, agents: [{ sId: "a1", name: "a1", description: "" }] });

    expect(readState()).toMatchObject({
      conversations: { [first]: "conv-old", [second]: "conv-new" },
    });
  });

  it("applyRuntimeContext wires the UI confirm callback", async () => {
    const runtime = new DustSessionRuntime();
    const confirm = vi.fn().mockResolvedValue(false);
    const ctx = {
      modelRegistry: {},
      ui: { confirm },
    } as any;

    applyRuntimeContext(runtime, ctx);

    await expect(runtime.confirmFn("Allow tool", "details")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith("Allow tool", "details");
  });

  it("invalidateRuntimeCredentials marks state invalidated and clears runtime state", () => {
    const runtime = new DustSessionRuntime();
    seedLoggedIn(makeCredentials());
    const ctx = {
      modelRegistry: {},
      sessionManager: { getSessionFile: vi.fn().mockReturnValue("session-a") },
    } as any;

    runtime.sessionContext = buildSessionContext(ctx);
    runtime.conversationId = "conv-1";
    runtime.mcpServerId = "mcp-1";
    runtime.preApprovedActions.set("action-1", true);

    const cred = makeCredentials({ access: "access-1", refresh: "refresh-1" });
    invalidateRuntimeCredentials(runtime, cred);

    expect(readState()).toMatchObject({ invalidated: true });
    expect(runtime.conversationId).toBeNull();
    expect(runtime.mcpServerId).toBeNull();
    expect(runtime.preApprovedActions.size).toBe(0);
  });

  it("shouldRefreshAccessToken supports an explicit skew window", () => {
    expect(shouldRefreshAccessToken(Date.now() + 10_000, 0)).toBe(false);
    expect(shouldRefreshAccessToken(Date.now() + 10_000, 30_000)).toBe(true);
  });

  it("invalidateCredentials returns a tokenless copy", () => {
    expect(invalidateCredentials(makeCredentials())).toEqual(
      expect.objectContaining({ access: "", refresh: "", expires: 0 }),
    );
  });

  describe("refreshAccessToken", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("prefers the host's resolveAccessToken and holds the result", async () => {
      const runtime = new DustSessionRuntime();
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;
      runtime.sessionContext = makeSessionContext({
        resolveAccessToken: async () => "host-token",
        getAccessToken: () => "stale",
      });

      await expect(runtime.refreshAccessToken()).resolves.toBe(true);

      // Held in memory rather than round-tripped through storage — storage
      // cannot carry a directly-resolved token at all.
      expect(runtime.currentAccessToken()).toBe("host-token");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to a direct WorkOS refresh when the host has nothing", async () => {
      const runtime = new DustSessionRuntime();
      const setCredentials = vi.fn();
      globalThis.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "direct-token", refresh_token: "new-ref", expires_in: 3600 }),
      })) as never;
      runtime.sessionContext = makeSessionContext({
        setCredentials,
        resolveAccessToken: async () => null,
        getAccessToken: () => "stale",
      });

      await expect(runtime.refreshAccessToken()).resolves.toBe(true);

      expect(runtime.currentAccessToken()).toBe("direct-token");
      expect(setCredentials).toHaveBeenCalledWith(expect.objectContaining({ access: "direct-token" }));
    });

    it("falls back to fallbackCredentials when sessionContext has none of its own", async () => {
      const runtime = new DustSessionRuntime();
      const fallback = makeCredentials({ refresh: "fallback-ref" });
      globalThis.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "direct-token", refresh_token: "new-ref", expires_in: 3600 }),
      })) as never;
      runtime.sessionContext = makeSessionContext({
        getCredentials: () => null,
        resolveAccessToken: async () => null,
        getAccessToken: () => "",
      });

      await expect(runtime.refreshAccessToken(fallback)).resolves.toBe(true);
      expect(runtime.currentAccessToken()).toBe("direct-token");
    });

    it("returns false, and leaves nothing held, when neither path produces a token", async () => {
      const runtime = new DustSessionRuntime();
      globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 400 })) as never;
      runtime.sessionContext = makeSessionContext({
        resolveAccessToken: async () => null,
        getAccessToken: () => "stale",
      });

      await expect(runtime.refreshAccessToken()).resolves.toBe(false);
      expect(runtime.currentAccessToken()).toBe("stale");
    });

    it("returns false and never calls fetch when there are no credentials at all (issue #40 divergence point)", async () => {
      // This is the exact branch where the old credits-local refresh and the
      // old stream-local refresh used to diverge: credits returned false
      // here, stream fell back to its own `liveCred`. With no
      // fallbackCredentials passed either, refreshAccessToken() must bail out
      // before ever touching the network.
      const runtime = new DustSessionRuntime();
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;
      const refreshTokenSpy = vi.spyOn(dustAuth, "refreshToken");
      runtime.sessionContext = makeSessionContext({
        getCredentials: () => null,
        resolveAccessToken: async () => null,
      });

      await expect(runtime.refreshAccessToken()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      // Proves the `!credentials` guard actually short-circuits before ever
      // attempting a refresh — without this, a deleted guard would still
      // fall through to `refreshToken(null)` throwing inside a try/catch
      // that also swallows the error and returns false, leaving the
      // assertions above green for the wrong reason.
      expect(refreshTokenSpy).not.toHaveBeenCalled();
    });

    it("single-flights concurrent callers into one refresh", async () => {
      // Two callers hitting a 401 in the same window — e.g. /status and the
      // MCP listener — must not race two direct refreshes against the same
      // rotating refresh token; the second must await the first's attempt.
      const runtime = new DustSessionRuntime();
      let resolveAccessTokenCalls = 0;
      let resolveHost!: (token: string | null) => void;
      runtime.sessionContext = makeSessionContext({
        resolveAccessToken: () => {
          resolveAccessTokenCalls++;
          return new Promise((resolve) => { resolveHost = resolve; });
        },
        getAccessToken: () => "stale",
      });

      const first = runtime.refreshAccessToken();
      const second = runtime.refreshAccessToken();
      resolveHost("shared-token");

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(resolveAccessTokenCalls).toBe(1);
      expect(runtime.currentAccessToken()).toBe("shared-token");
    });

    it("dedupes a credits fetch's 401 with a concurrent stream-provider-style refresh call", async () => {
      // dust-credits.ts's call site (`runtime.refreshAccessToken()`, no
      // fallback) and dust-stream-provider.ts's (`runtime.refreshAccessToken(liveCred)`,
      // with one) must land on the very same in-flight refresh when they race,
      // not just when the same call site races itself.
      const runtime = new DustSessionRuntime();
      let resolveAccessTokenCalls = 0;
      let resolveHost!: (token: string | null) => void;
      runtime.sessionContext = makeSessionContext({
        resolveAccessToken: () => {
          resolveAccessTokenCalls++;
          return new Promise((resolve) => { resolveHost = resolve; });
        },
        getAccessToken: () => "stale",
      });
      const refreshSpy = vi.spyOn(runtime, "refreshAccessToken");

      let usageCalls = 0;
      const fetchMock = vi.fn((url: string, init?: { headers: Record<string, string> }) => {
        if (!url.includes("credits/my-usage")) throw new Error(`unexpected fetch: ${url}`);
        usageCalls++;
        return Promise.resolve(
          init?.headers.Authorization === "Bearer shared-token"
            ? { ok: true, status: 200, json: () => Promise.resolve({ member: {} }) }
            : { ok: false, status: 401 },
        );
      });
      globalThis.fetch = fetchMock as never;

      // Credits call site.
      const creditsPromise = fetchCreditsJson(runtime, "https://x/api/w/w1/credits/my-usage");
      // Stream-provider call site, closing over its own `liveCred` fallback.
      const streamPromise = runtime.refreshAccessToken(makeCredentials({ access: "other" }));

      // Wait for both call sites to have actually joined the flight — not
      // just for the first to have started it — before letting the host
      // token resolve. Waiting on resolveAccessTokenCalls alone would pass
      // trivially, since the stream call site's own refreshAccessToken() call
      // above already bumps it to 1 synchronously.
      await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(2));
      resolveHost("shared-token");

      await expect(streamPromise).resolves.toBe(true);
      await expect(creditsPromise).resolves.toEqual({ member: {} });
      expect(resolveAccessTokenCalls).toBe(1);
      expect(usageCalls).toBe(2);
    });
  });

  describe("tool catalogue diff (issue #51)", () => {
    it("reports no change on the first observation — there is no baseline yet", () => {
      const runtime = new DustSessionRuntime();

      expect(runtime.toolCatalogueChanged(["bash", "read"])).toBe(false);
    });

    it("ignores ordering — it is a set comparison", () => {
      const runtime = new DustSessionRuntime();
      runtime.toolCatalogueChanged(["bash", "read"]);

      expect(runtime.toolCatalogueChanged(["read", "bash"])).toBe(false);
    });

    it("reports a change when the set shrinks, then settles — no re-registration loop", () => {
      const runtime = new DustSessionRuntime();
      runtime.toolCatalogueChanged(["bash", "read"]);

      expect(runtime.toolCatalogueChanged(["read"])).toBe(true);
      expect(runtime.toolCatalogueChanged(["read"])).toBe(false);
    });

    it("an unreadable turn (null) neither reports a change nor clobbers the baseline", () => {
      const runtime = new DustSessionRuntime();
      runtime.toolCatalogueChanged(["bash", "read"]);

      expect(runtime.toolCatalogueChanged(null)).toBe(false);
      // The baseline from before the null turn is still in force.
      expect(runtime.toolCatalogueChanged(["read"])).toBe(true);
    });

    it("clearMcpState does not reset the baseline", () => {
      const runtime = new DustSessionRuntime();
      runtime.toolCatalogueChanged(["bash", "read"]);

      runtime.clearMcpState();

      expect(runtime.toolCatalogueChanged(["read"])).toBe(true);
    });

    it("resetSessionState resets the baseline — a new session starts with none", () => {
      const runtime = new DustSessionRuntime();
      runtime.toolCatalogueChanged(["bash", "read"]);

      runtime.resetSessionState();

      expect(runtime.toolCatalogueChanged(["read"])).toBe(false);
    });

    it("does not mutate the array passed in", () => {
      const runtime = new DustSessionRuntime();
      const names = ["read", "bash"];

      runtime.toolCatalogueChanged(names);

      expect(names).toEqual(["read", "bash"]);
    });

    it("recordAdvertisedTools overwrites the baseline unconditionally, reconciling it with ground truth", () => {
      const runtime = new DustSessionRuntime();
      // toolCatalogueChanged left a stale baseline behind (e.g. an
      // unreadable turn kept whatever predated it).
      runtime.toolCatalogueChanged(["bash", "read"]);

      // Dust actually fetched the catalogue and got something else — record
      // what was really handed over.
      runtime.recordAdvertisedTools(["read"]);

      // The next diff compares against the true value, not the stale guess.
      expect(runtime.toolCatalogueChanged(["read"])).toBe(false);
      expect(runtime.toolCatalogueChanged(["bash", "read"])).toBe(true);
    });

    it("recordAdvertisedTools does not mutate the array passed in", () => {
      const runtime = new DustSessionRuntime();
      const names = ["read", "bash"];

      runtime.recordAdvertisedTools(names);

      expect(names).toEqual(["read", "bash"]);
    });
  });
});
