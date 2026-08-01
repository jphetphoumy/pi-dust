import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoopArgs, registerDustLoopCommand } from "../src/dust-loop.js";
import { applyRuntimeContext, DustSessionRuntime } from "../src/dust-runtime.js";

function makeCtx(overrides: { isIdle?: () => boolean } = {}) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    isIdle: overrides.isIdle ?? vi.fn(() => true),
  } as any;
}

function register(runtime: DustSessionRuntime) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerCommand: vi.fn((name: string, cfg: any) => commands.set(name, cfg.handler)),
    on: vi.fn((event: string, handler: any) => events.set(event, handler)),
    sendUserMessage: vi.fn(),
  } as any;

  registerDustLoopCommand(pi, runtime);
  runtime.pi = pi;
  return { commands, events, pi };
}

describe("parseLoopArgs", () => {
  it("parses an interval plus a slash command", () => {
    expect(parseLoopArgs("5m /babysit-prs")).toEqual({
      kind: "start",
      mode: "interval",
      payload: "/babysit-prs",
      intervalMs: 300_000,
      clamped: false,
    });
  });

  it("parses an interval plus a plain prompt", () => {
    expect(parseLoopArgs("30s check the deploy")).toEqual({
      kind: "start",
      mode: "interval",
      payload: "check the deploy",
      intervalMs: 30_000,
      clamped: false,
    });
  });

  it("treats a bare payload as self-paced", () => {
    expect(parseLoopArgs("/babysit-prs")).toEqual({
      kind: "start",
      mode: "selfPaced",
      payload: "/babysit-prs",
      intervalMs: null,
      clamped: false,
    });
  });

  it.each(["off", "stop"])("parses %s as a stop request", (word) => {
    expect(parseLoopArgs(word)).toEqual({ kind: "stop" });
  });

  it.each(["", "status", "   "])("parses %j as a status request", (raw) => {
    expect(parseLoopArgs(raw)).toEqual({ kind: "status" });
  });

  it("does not misread a non-duration first token as an interval", () => {
    expect(parseLoopArgs("10x /y")).toEqual({
      kind: "start",
      mode: "selfPaced",
      payload: "10x /y",
      intervalMs: null,
      clamped: false,
    });
  });

  it("uses -- to force payload interpretation of a reserved word", () => {
    expect(parseLoopArgs("-- off the lights")).toEqual({
      kind: "start",
      mode: "selfPaced",
      payload: "off the lights",
      intervalMs: null,
      clamped: false,
    });
  });

  it("rejects an attempt to loop /loop itself", () => {
    expect(parseLoopArgs("/loop x")).toMatchObject({ kind: "error" });
    expect(parseLoopArgs("5m /loop x")).toMatchObject({ kind: "error" });
  });

  it("rejects an interval above the 24h ceiling", () => {
    expect(parseLoopArgs("48h /x")).toMatchObject({ kind: "error" });
  });

  it("clamps an interval below the 30s floor instead of rejecting it", () => {
    expect(parseLoopArgs("1s /x")).toEqual({
      kind: "start",
      mode: "interval",
      payload: "/x",
      intervalMs: 30_000,
      clamped: true,
    });
  });

  it("rejects an empty payload after --", () => {
    expect(parseLoopArgs("--")).toMatchObject({ kind: "error" });
  });
});

describe("dust loop command", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the payload immediately, then once per interval", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m /babysit-prs", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/babysit-prs");

    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
  });

  it("skips a tick while the agent is busy, and records it", async () => {
    const runtime = new DustSessionRuntime();
    let idle = true;
    const ctx = makeCtx({ isIdle: () => idle });
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m /x", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    idle = false;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(runtime.loop?.skipped).toBe(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dust-loop", expect.stringContaining("waiting"));

    idle = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("clamps sub-floor intervals and warns", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("loop")!("1s /x", ctx);

    expect(runtime.loop?.intervalMs).toBe(30_000);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("floor"), "warning");
  });

  it("re-fires a self-paced loop after agent_settled, and stops at the iteration cap", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("/x", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const onSettled = events.get("agent_settled")!;
    for (let i = 0; i < 19; i++) {
      onSettled({}, ctx);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(20);
    expect(runtime.loop).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("20-iteration"), "warning");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dust-loop", undefined);

    // Further settles do nothing — the loop is gone.
    onSettled({}, ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(20);
  });

  it("debounces repeated agent_settled events before a self-paced loop's cooldown fires", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("/x", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const onSettled = events.get("agent_settled")!;
    onSettled({}, ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    onSettled({}, ctx);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("stops via /loop off and clears the footer", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m /x", ctx);
    await commands.get("loop")!("off", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop stopped.", "info");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dust-loop", undefined);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1); // only the initial immediate send
  });

  it("reports status with and without an active loop", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("loop")!("", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("No loop running.", "info");

    await commands.get("loop")!("5m /x", ctx);
    await commands.get("loop")!("status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("every 5m"), "info");
  });

  it("stops the loop on session_shutdown without notifying", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("5m /x", ctx);
    events.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(runtime.loop).toBeNull();
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Loop stopped.", "info");

    await vi.advanceTimersByTimeAsync(600_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1); // only the initial immediate send
  });

  it("clears loop state on resetSessionState", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m /x", ctx);
    runtime.resetSessionState();

    expect(runtime.loop).toBeNull();
    expect(runtime.loopTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1); // only the initial immediate send
  });

  it("still registers the command when the host exposes no event API", () => {
    const runtime = new DustSessionRuntime();
    const pi = { registerCommand: vi.fn(), sendUserMessage: vi.fn() } as any;

    expect(() => registerDustLoopCommand(pi, runtime)).not.toThrow();
    expect(pi.registerCommand).toHaveBeenCalledWith("loop", expect.anything());
  });
});
