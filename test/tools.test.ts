import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_TIMEOUT_MS } from "../src/dust-constants.js";
import { buildConfirmMessage, executeMcpTool, getMcpTools } from "../src/dust-tools.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * pi's tool implementations take the ExtensionContext as their final execute()
 * argument. The file tools only read `cwd`; bash additionally reads
 * `sessionManager.getSessionId()`, `model` and `thinkingLevel` to populate
 * PI_SESSION_ID and friends for the spawned command.
 */
function makeCtx(cwd: string): any {
  return {
    cwd,
    // `input` matters: read consults it to decide whether images can be
    // returned. Our registered Dust models declare ["text"] the same way.
    model: { id: "test-model", provider: "dust", input: ["text"] },
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
      getEntries: () => [],
    },
  };
}

describe("dust local tools", () => {
  it("advertises pi's own built-in tools, not reimplementations", () => {
    const tools = getMcpTools(makeCtx(process.cwd()));
    const names = tools.map((t) => t.name);

    // pi's default built-ins plus its search tools, all sourced from pi itself.
    expect(names).toEqual(expect.arrayContaining(["bash", "read", "write", "edit"]));
    expect(names).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  });

  it("exposes a description and JSON schema for every tool", () => {
    for (const tool of getMcpTools(makeCtx(process.cwd()))) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      // TypeBox schemas are already JSON Schema, so they pass through to MCP.
      expect(tool.inputSchema, `${tool.name} schema`).toMatchObject({ type: "object" });
    }
  });

  it("advertises a Dust timeout override on every tool, under the 11-minute activity ceiling", () => {
    // Dust's default MCP request timeout is 3 minutes and expires while the
    // local approval dialog is open; `_meta.dust.timeoutMs` overrides it.
    // Dust's Temporal activity ceiling is max(10min, 3min) + 60s = 11 minutes.
    expect(MCP_TOOL_TIMEOUT_MS).toBeLessThan(11 * 60 * 1000);
    for (const tool of getMcpTools(makeCtx(process.cwd()))) {
      expect(tool._meta, `${tool.name} _meta`).toEqual({ dust: { timeoutMs: MCP_TOOL_TIMEOUT_MS } });
    }
  });

  it("creates a file through pi's write tool", async () => {
    const dir = makeTempDir("pi-dust-write-");
    try {
      const result = await executeMcpTool(
        "write",
        { path: join(dir, "tasks", "main.yml"), content: "---\n- name: task\n" },
        makeCtx(dir),
      );

      expect(result.isError).toBe(false);
      expect(readFileSync(join(dir, "tasks", "main.yml"), "utf8")).toBe("---\n- name: task\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a file through pi's read tool", async () => {
    const dir = makeTempDir("pi-dust-read-");
    const filePath = join(dir, "sample.txt");
    try {
      writeFileSync(filePath, "line-1\nline-2\nline-3", "utf8");

      const result = await executeMcpTool("read", { path: filePath }, makeCtx(dir));

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("line-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an error instead of throwing when a tool fails", async () => {
    const dir = makeTempDir("pi-dust-fail-");
    try {
      const result = await executeMcpTool(
        "read",
        { path: join(dir, "does-not-exist.txt") },
        makeCtx(dir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a command through pi's bash tool", async () => {
    const result = await executeMcpTool(
      "bash",
      { command: "echo hello-from-bash" },
      makeCtx(process.cwd()),
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("hello-from-bash");
  });

  it("reports unknown tools", async () => {
    const result = await executeMcpTool("not-a-tool", {}, makeCtx(process.cwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("summarises tool arguments for the approval prompt", () => {
    expect(buildConfirmMessage("bash", { command: "ls -la" })).toBe("ls -la");
    expect(buildConfirmMessage("write", { path: "/tmp/f.txt", content: "a\nb" }))
      .toContain("2 lines");
    expect(buildConfirmMessage("edit", { path: "/tmp/f.txt", oldText: "a", newText: "b" }))
      .toContain("/tmp/f.txt");
  });

  it("falls back to JSON formatting for unknown confirmation messages", () => {
    const result = buildConfirmMessage("custom-tool", { answer: 42, nested: { ok: true } });

    expect(result).toBe(JSON.stringify({ answer: 42, nested: { ok: true } }));
  });
});
