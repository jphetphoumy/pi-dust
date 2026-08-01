import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoopArgs, registerDustLoopCommand } from "../src/dust-loop.js";
import { applyRuntimeContext, DustSessionRuntime } from "../src/dust-runtime.js";
import { registerDustSessionEvents } from "../src/dust-session-events.js";

function makeCtx(overrides: { isIdle?: () => boolean } = {}) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    isIdle: overrides.isIdle ?? vi.fn(() => true),
  } as any;
}

/** Registers just the `/loop` command and its `agent_settled` hook. */
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

/** Also wires session lifecycle events (`session_shutdown`), which live in dust-session-events.ts, not dust-loop.ts. */
function registerWithSessionEvents(runtime: DustSessionRuntime) {
  const { commands, events, pi } = register(runtime);
  registerDustSessionEvents(pi, runtime, vi.fn());
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

  it.each(["off", "stop", "Off", "STOP"])("parses %s as a stop request, case-insensitively", (word) => {
    expect(parseLoopArgs(word)).toEqual({ kind: "stop" });
  });

  it.each(["", "status", "   ", "Status"])("parses %j as a status request, case-insensitively", (raw) => {
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

  it("rejects a zero-duration interval instead of swallowing it into the payload", () => {
    expect(parseLoopArgs("0s /x")).toMatchObject({ kind: "error" });
  });

  it("splits on any whitespace, not just a single space", () => {
    expect(parseLoopArgs("5m\t/x")).toEqual({
      kind: "start",
      mode: "interval",
      payload: "/x",
      intervalMs: 300_000,
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

  it("only treats a standalone -- as the escape, not any leading --", () => {
    expect(parseLoopArgs("--check the CI")).toEqual({
      kind: "start",
      mode: "selfPaced",
      payload: "--check the CI",
      intervalMs: null,
      clamped: false,
    });
  });

  it("rejects an attempt to loop /loop itself", () => {
    expect(parseLoopArgs("/loop x")).toMatchObject({ kind: "error" });
    expect(parseLoopArgs("5m /loop x")).toMatchObject({ kind: "error" });
  });

  it("catches a self-reference regardless of trailing whitespace style", () => {
    expect(parseLoopArgs("/loop\tx")).toMatchObject({ kind: "error" });
    expect(parseLoopArgs("/loop")).toMatchObject({ kind: "error" });
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

  it("replaces a running loop rather than stacking a second timer", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m /old", ctx);
    const firstTimer = runtime.loopTimer;
    await commands.get("loop")!("1m /new", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Replacing the running loop.", "info");
    expect(runtime.loopTimer).not.toBe(firstTimer);
    expect(runtime.loop?.payload).toBe("/new");

    // The old timer must be dead — advancing 5m must fire only the new
    // 1m-cadence timer's ticks (5), not a leftover old-cadence tick too.
    pi.sendUserMessage.mockClear();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(5);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("/new");
    expect(pi.sendUserMessage).not.toHaveBeenCalledWith("/old");
  });

  it("skips a tick while the agent is busy, records it, and clears 'waiting' once it resumes", async () => {
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
    // Lifetime skip count is preserved, but the footer's "waiting" flag reflects
    // only the most recent tick, which just succeeded.
    expect(runtime.loop?.skipped).toBe(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dust-loop", expect.not.stringContaining("waiting"));
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

  it("ignores an unrelated turn's agent_settled between iterations", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("/x", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Consume the loop's own settle, arming its cooldown for t=0..5000.
    const onSettled = events.get("agent_settled")!;
    onSettled({}, ctx);

    // A stray settle partway through that cooldown — e.g. the user ran an
    // unrelated /ask — must not re-arm (push out) the deadline. If the guard
    // were missing, this second call would restart the 5s timer and the send
    // below (at the original t=5000) would not have fired yet.
    await vi.advanceTimersByTimeAsync(3_000);
    onSettled({}, ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(runtime.loop?.iterations).toBe(2);

    // The next iteration's own send re-arms `expectingSettle`; a stray settle
    // that arrives before *its* cooldown fires is likewise ignored rather
    // than restarting that cooldown.
    onSettled({}, ctx); // real settle for iteration 2, arms t=0..5000
    await vi.advanceTimersByTimeAsync(3_000);
    onSettled({}, ctx); // stray — must not push the deadline out
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
  });

  it("self-schedules a retry when a self-paced tick finds the agent busy, without needing another settle", async () => {
    const runtime = new DustSessionRuntime();
    let idle = true;
    const ctx = makeCtx({ isIdle: () => idle });
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("/x", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const onSettled = events.get("agent_settled")!;
    onSettled({}, ctx);
    idle = false;
    await vi.advanceTimersByTimeAsync(5_000); // cooldown fires, finds the agent busy, skips
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(runtime.loop?.skipped).toBe(1);

    idle = true;
    await vi.advanceTimersByTimeAsync(5_000); // self-armed retry, agent now idle
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

  it("reports status with and without an active loop, using human-readable wording distinct from the footer", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("loop")!("", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("No loop running.", "info");

    await commands.get("loop")!("5m /x", ctx);
    await commands.get("loop")!("status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Looping every 5m"), "info");
    // The notify body is human phrasing, not the terse "dust-loop: ..." footer text.
    expect(ctx.ui.notify).not.toHaveBeenLastCalledWith(expect.stringContaining("dust-loop:"), "info");
  });

  it("stops the loop on session_shutdown without notifying", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = registerWithSessionEvents(runtime);

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

  it("does not crash, and self-heals on the next tick, when an interval loop's send throws", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);
    pi.sendUserMessage.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(commands.get("loop")!("5m /x", ctx)).resolves.toBeUndefined();
    expect(runtime.loop).not.toBeNull();
    expect(runtime.loop?.iterations).toBe(0);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2); // the throwing call, then a normal tick
    expect(runtime.loop?.iterations).toBe(1);
  });

  it("stops itself, rather than wedging forever, when a self-paced loop's send throws", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);
    pi.sendUserMessage.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await commands.get("loop")!("/x", ctx);

    // A failed send never starts a turn, so `agent_settled` will never arrive
    // to advance a self-paced loop — unlike interval mode, it has no other
    // tick to self-heal on. It must stop itself instead of sitting there
    // with a footer still claiming to be live.
    expect(runtime.loop).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sending the next iteration failed"), "warning");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dust-loop", undefined);
  });

  it("refuses to start a self-paced loop when the host exposes no event API, but interval mode still works", () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const pi = {
      registerCommand: vi.fn((name: string, cfg: any) => commands.set(name, cfg.handler)),
      sendUserMessage: vi.fn(),
    } as any;
    registerDustLoopCommand(pi, runtime);
    runtime.pi = pi;

    return commands.get("loop")!("/x", ctx).then(() => {
      expect(runtime.loop).toBeNull();
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("event API"), "warning");

      return commands.get("loop")!("5m /x", ctx).then(() => {
        expect(runtime.loop?.mode).toBe("interval");
        expect(pi.sendUserMessage).toHaveBeenCalledWith("/x");
      });
    });
  });

  it("applies the -- escape after an interval token too", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, pi } = register(runtime);

    await commands.get("loop")!("5m -- off", ctx);
    expect(runtime.loop?.payload).toBe("off");
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("off");
  });

  it("suppresses the 'Loop stopped.' toast when the loop stops itself at the iteration cap", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands, events, pi } = register(runtime);

    await commands.get("loop")!("/x", ctx);
    const onSettled = events.get("agent_settled")!;
    for (let i = 0; i < 19; i++) {
      onSettled({}, ctx);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(20);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Loop stopped.", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("20-iteration"), "warning");
  });
});
