import { describe, expect, it, vi } from "vitest";
import { appendToolEntry, DUST_TOOL_ENTRY, registerDustToolRenderer } from "../src/dust-tool-render.js";

function makeApi() {
  const renderers = new Map<string, (entry: unknown, opts: { expanded: boolean }, theme: unknown) => unknown>();
  return {
    api: {
      appendEntry: vi.fn(),
      registerEntryRenderer: vi.fn((type: string, renderer: any) => renderers.set(type, renderer)),
    } as any,
    renderers,
  };
}

const theme = {
  bold: (t: string) => t,
  fg: (_slot: string, t: string) => t,
  bg: (_slot: string, t: string) => t,
};

describe("dust tool rendering", () => {
  it("records a completed tool call as a transcript entry", () => {
    const { api } = makeApi();

    appendToolEntry(
      api,
      "bash",
      { command: "echo hi" },
      { content: [{ type: "text", text: "hi" }], isError: false },
      42,
      "/tmp/project",
    );

    expect(api.appendEntry).toHaveBeenCalledWith(
      DUST_TOOL_ENTRY,
      expect.objectContaining({
        toolName: "bash",
        args: { command: "echo hi" },
        text: "hi",
        isError: false,
        durationMs: 42,
        cwd: "/tmp/project",
      }),
    );
  });

  it("renders a recorded bash call through pi's own renderers", () => {
    const { api, renderers } = makeApi();
    registerDustToolRenderer(api);

    const renderer = renderers.get(DUST_TOOL_ENTRY);
    expect(renderer).toBeDefined();

    const component = renderer!(
      {
        data: {
          toolName: "bash",
          args: { command: "echo hi" },
          text: "hi",
          isError: false,
          durationMs: 10,
          cwd: process.cwd(),
        },
      },
      { expanded: false },
      theme,
    );

    // pi's renderCall/renderResult return TUI Components; the bridge must
    // produce one rather than throwing on the reconstructed render context.
    expect(component).toBeDefined();
    expect(typeof (component as { render?: unknown }).render).toBe("function");
  });

  it("renders a subagent call, which has no pi tool definition behind it", () => {
    const { api, renderers } = makeApi();
    registerDustToolRenderer(api);

    // `subagent` is ours, not one of pi's factories, so getToolDefinition
    // returns undefined here. pi's generic tool row must still cope.
    const component = renderers.get(DUST_TOOL_ENTRY)!(
      {
        data: {
          toolName: "subagent",
          args: { agent: "scout", task: "find auth" },
          text: "auth lives in src/auth.ts",
          isError: false,
          durationMs: 1200,
          cwd: process.cwd(),
        },
      },
      { expanded: false },
      theme,
    );

    expect(component).toBeDefined();
    expect(typeof (component as { render?: unknown }).render).toBe("function");
  });

  it("degrades to a component instead of throwing on unusable entry data", () => {
    const { api, renderers } = makeApi();
    registerDustToolRenderer(api);

    const component = renderers.get(DUST_TOOL_ENTRY)!({ data: undefined }, { expanded: false }, theme);

    expect(component).toBeDefined();
  });

  it("skips registration when the host has no entry renderer API", () => {
    const api = { appendEntry: vi.fn() } as any;

    expect(() => registerDustToolRenderer(api)).not.toThrow();
  });
});
