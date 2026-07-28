import { describe, expect, it, vi } from "vitest";
import {
  applyRuntimeContext,
  buildSessionContext,
  DustSessionRuntime,
  invalidateCredentials,
  invalidateRuntimeCredentials,
  shouldRefreshAccessToken,
} from "../src/dust-runtime.js";
import { makeCredentials, readState, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

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
    seedLoggedIn(makeCredentials({ conversations: { old: "conv-old" } }));
    const ctx = {
      modelRegistry: {},
      sessionManager: { getSessionFile: vi.fn().mockReturnValue("session-a") },
    } as any;

    const sessionContext = buildSessionContext(ctx);
    sessionContext.saveConversationId("conv-123");

    expect(readState()).toMatchObject({
      conversations: {
        old: "conv-old",
        "session-a": "conv-123",
      },
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
