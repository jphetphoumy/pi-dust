import { describe, expect, it } from "vitest";
import {
  buildSubagentToolDefinition,
  formatDuration,
  formatTokens,
  isSubagentDetails,
  renderSubagentLines,
} from "../src/dust-subagent-render.js";
import type { SubagentDetails, SubagentRun } from "../src/dust-types.js";

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agent: "scout",
    task: "find auth",
    model: "dust/claude-haiku",
    status: "ok",
    tools: [],
    lastMessage: "",
    output: "",
    usage: { input: 1200, output: 340, cacheRead: 8100, cacheWrite: 0, cost: 0, contextTokens: 11000, turns: 2 },
    durationMs: 8100,
    contextWindow: 100_000,
    ...overrides,
  };
}

const single = (run: SubagentRun): SubagentDetails => ({ mode: "single", runs: [run] });

describe("subagent progress rendering", () => {
  it("heads the block with status, agent, model, tool count and duration", () => {
    const lines = renderSubagentLines(
      single(makeRun({ tools: [{ tool: "ls", args: "test/", status: "done" }] })),
    );

    expect(lines[0]).toBe("✓ scout (dust/claude-haiku) — 1 tool · 8.1s");
  });

  it("marks the in-flight call and leaves finished ones unmarked", () => {
    const lines = renderSubagentLines(
      single(
        makeRun({
          status: "running",
          tools: [
            { tool: "ls", args: "test/", status: "done" },
            { tool: "read", args: "test/mcp.test.ts", status: "running" },
          ],
        }),
      ),
    );

    expect(lines[0]).toContain("⟳ scout");
    expect(lines[1]).toBe("    ls: test/");
    expect(lines[2]).toBe("  ▸ read: test/mcp.test.ts");
  });

  it("shows a failed run with the error icon", () => {
    expect(renderSubagentLines(single(makeRun({ status: "failed" })))[0]).toContain("✗");
  });

  it("renders the usage line with a context gauge", () => {
    const lines = renderSubagentLines(single(makeRun()));
    const usage = lines.find((line) => line.includes("↑"));

    expect(usage).toContain("↑1.2k");
    expect(usage).toContain("↓340");
    expect(usage).toContain("R8.1k");
    expect(usage).toContain("ctx:11k/100k (11%)");
  });

  it("withholds the final output until expanded", () => {
    const details = single(makeRun({ output: "auth lives in src/auth.ts" }));

    expect(renderSubagentLines(details).join("\n")).not.toContain("auth lives in");
    expect(renderSubagentLines(details, { expanded: true }).join("\n")).toContain(
      "auth lives in src/auth.ts",
    );
  });

  it("truncates a long thinking line to the available width", () => {
    const lines = renderSubagentLines(single(makeRun({ lastMessage: "x".repeat(400) })), {
      width: 60,
    });
    const thinking = lines.find((line) => line.includes("x"));

    expect(thinking && thinking.length).toBeLessThanOrEqual(62);
    expect(thinking).toContain("…");
  });

  it("counts completed runs in the header for parallel and chain modes", () => {
    const lines = renderSubagentLines({
      mode: "parallel",
      runs: [makeRun(), makeRun({ status: "running" })],
    });

    expect(lines[0]).toBe("parallel: 1/2 done");
  });

  it("numbers chain steps", () => {
    const lines = renderSubagentLines({
      mode: "chain",
      runs: [makeRun({ step: 1 }), makeRun({ step: 2, agent: "planner" })],
    });

    expect(lines.join("\n")).toContain("1. scout");
    expect(lines.join("\n")).toContain("2. planner");
  });

  it("applies theme slots when a painter is supplied", () => {
    const lines = renderSubagentLines(single(makeRun()), {
      paint: (slot, text) => `<${slot}>${text}</${slot}>`,
    });

    expect(lines[0]).toContain("<success>✓</success>");
    expect(lines[0]).toContain("<toolTitle>scout</toolTitle>");
  });
});

describe("formatting helpers", () => {
  it("abbreviates token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(45_000)).toBe("45k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  it("formats durations by magnitude", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(8100)).toBe("8.1s");
    expect(formatDuration(125_000)).toBe("2m05s");
  });

  it("recognises a details payload", () => {
    expect(isSubagentDetails(single(makeRun()))).toBe(true);
    expect(isSubagentDetails({ mode: "single" })).toBe(false);
    expect(isSubagentDetails(null)).toBe(false);
    expect(isSubagentDetails("nope")).toBe(false);
  });
});

describe("subagent tool definition", () => {
  const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };
  const definition = buildSubagentToolDefinition() as {
    name: string;
    renderCall: (args: unknown, theme: unknown) => { render: (w: number) => string[] };
    renderResult: (
      result: unknown,
      options: unknown,
      theme: unknown,
    ) => { render: (w: number) => string[] };
  };

  const draw = (component: { render: (w: number) => string[] }) => component.render(120).join("\n");

  it("labels a single call with the agent and a task preview", () => {
    const text = draw(definition.renderCall({ agent: "scout", task: "find auth code" }, theme));

    expect(text).toContain("subagent");
    expect(text).toContain("scout — find auth code");
  });

  it("labels parallel and chain calls by shape", () => {
    expect(
      draw(definition.renderCall({ tasks: [{ agent: "a" }, { agent: "b" }] }, theme)),
    ).toContain("parallel (2 tasks)");
    expect(draw(definition.renderCall({ chain: [{ agent: "a" }] }, theme))).toContain(
      "chain (1 steps)",
    );
  });

  it("renders the structured block when details are present", () => {
    const text = draw(
      definition.renderResult(
        { details: single(makeRun({ tools: [{ tool: "ls", args: "test/", status: "done" }] })) },
        { expanded: false },
        theme,
      ),
    );

    expect(text).toContain("✓ scout");
    expect(text).toContain("ls: test/");
  });

  it("falls back to result text when there are no details", () => {
    // Early validation errors return before any run exists.
    const text = draw(
      definition.renderResult(
        { content: [{ text: "Provide exactly one of: {agent, task}" }] },
        { expanded: false },
        theme,
      ),
    );

    expect(text).toContain("Provide exactly one of");
  });
});
