import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyRuntimeContext,
  buildSessionContext,
  DustSessionRuntime,
  invalidateCredentials,
  invalidateRuntimeCredentials,
  shouldRefreshAccessToken,
} from "../src/dust-runtime.js";
import { persistCredentialState } from "../src/dust-state.js";
import { agentDir, makeCredentials, readState, seedLoggedIn, sessionPath, useTempAgentDir } from "./helpers/dust-fixtures.js";

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
});
