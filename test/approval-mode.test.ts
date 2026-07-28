import { describe, expect, it, vi } from "vitest";
import { registerDustApprovalMode } from "../src/dust-approval.js";
import { applyRuntimeContext, DustSessionRuntime } from "../src/dust-runtime.js";

function makeCtx() {
  return {
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as any;
}

function register(runtime: DustSessionRuntime) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const shortcuts = new Map<string, (ctx: unknown) => unknown>();
  const pi = {
    registerCommand: vi.fn((name: string, cfg: any) => commands.set(name, cfg.handler)),
    registerShortcut: vi.fn((key: string, cfg: any) => shortcuts.set(key, cfg.handler)),
  } as any;

  registerDustApprovalMode(pi, runtime);
  return { commands, shortcuts };
}

describe("dust approval mode", () => {
  it("prompts for every tool call by default", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);

    // A fresh session must never run tools unattended.
    expect(runtime.autoApprove).toBe(false);
    await runtime.confirmFn("Allow tool: bash", "ls");
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it("stops prompting once auto-approve is on", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("auto")!("", ctx);

    expect(runtime.autoApprove).toBe(true);
    await expect(runtime.confirmFn("Allow tool: bash", "rm -rf /")).resolves.toBe(true);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("toggles back to prompting", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("auto")!("", ctx);
    await commands.get("auto")!("", ctx);

    expect(runtime.autoApprove).toBe(false);
    await runtime.confirmFn("Allow tool: bash", "ls");
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it("accepts explicit on and off", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("auto")!("off", ctx);
    expect(runtime.autoApprove).toBe(false);

    await commands.get("auto")!("on", ctx);
    expect(runtime.autoApprove).toBe(true);

    await commands.get("auto")!("on", ctx);
    expect(runtime.autoApprove).toBe(true);
  });

  it("binds a shortcut that toggles the mode", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { shortcuts } = register(runtime);

    const handler = shortcuts.get("ctrl+shift+space");
    expect(handler).toBeDefined();

    handler!(ctx);
    expect(runtime.autoApprove).toBe(true);
    handler!(ctx);
    expect(runtime.autoApprove).toBe(false);
  });

  it("surfaces the current mode in the footer", async () => {
    const runtime = new DustSessionRuntime();
    const ctx = makeCtx();
    applyRuntimeContext(runtime, ctx);
    const { commands } = register(runtime);

    await commands.get("auto")!("on", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("dust-approval", expect.stringContaining("auto-approve"));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("without asking"), "warning");
  });

  it("still works when the host exposes no shortcut API", () => {
    const runtime = new DustSessionRuntime();
    const pi = { registerCommand: vi.fn() } as any;

    expect(() => registerDustApprovalMode(pi, runtime)).not.toThrow();
    expect(pi.registerCommand).toHaveBeenCalledWith("auto", expect.anything());
  });
});
