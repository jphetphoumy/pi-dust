import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subagents are child `pi` processes, so every test here stubs `spawn`.
 * Nothing in this suite may start a real pi.
 */
const spawnCalls: Array<{
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
  proc: FakeChildProcess;
}> = [];

let scriptChild: (
  proc: FakeChildProcess,
  call: { args: string[]; proc: FakeChildProcess },
) => void = (proc) => proc.finish(0);

class FakeStdin extends EventEmitter {
  written = "";
  end(chunk?: string): void {
    if (chunk) this.written += chunk;
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  killed = false;
  signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.killed = true;
    // A real child exits after SIGTERM; without this the awaited promise hangs.
    setImmediate(() => this.emit("close", null));
    return true;
  }

  emitJson(event: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  }

  finish(code: number): void {
    setImmediate(() => this.emit("close", code));
  }
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    const proc = new FakeChildProcess();
    const call = { command, args, options, proc } as (typeof spawnCalls)[number];
    spawnCalls.push(call);
    setImmediate(() => scriptChild(proc, call));
    return proc;
  },
}));

import type { StreamAccumulator } from "../src/dust-subagent.js";

const {
  allowedSubagentTools,
  buildSubagentConfirmMessage,
  buildSubagentSpec,
  consumeJsonLine,
  executeSubagent,
  isSubagentChild,
  mapWithConcurrencyLimit,
  SUBAGENT_DEPTH_ENV,
  SUBAGENT_TOOLS_ENV,
  SUBAGENT_TOOL_NAME,
} = await import("../src/dust-subagent.js");
const { executeMcpTool, getMcpTools } = await import("../src/dust-tools.js");
const { agentDir, useTempAgentDir } = await import("./helpers/dust-fixtures.js");

/** An assistant `message_end` event as emitted by `pi --mode json`. */
function assistantMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      model: "dust/worker-bot",
      stopReason: "end",
      ...overrides,
    },
  };
}

function writeAgentFile(name: string, fields: Record<string, string>, body = "Be brief."): void {
  const dir = join(agentDir(), "agents");
  mkdirSync(dir, { recursive: true });
  const frontmatter = Object.entries({ name, ...fields })
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

const cwds: string[] = [];
function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-dust-subagent-cwd-"));
  cwds.push(dir);
  return dir;
}

function makeCtx(cwd: string): any {
  return {
    cwd,
    model: { id: "orchestrator", provider: "dust", input: ["text"] },
    thinkingLevel: "off",
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
  scriptChild = (proc) => proc.finish(0);
  delete process.env[SUBAGENT_DEPTH_ENV];
  delete process.env[SUBAGENT_TOOLS_ENV];
});

afterEach(() => {
  delete process.env[SUBAGENT_DEPTH_ENV];
  delete process.env[SUBAGENT_TOOLS_ENV];
  while (cwds.length > 0) rmSync(cwds.pop() as string, { recursive: true, force: true });
});

describe("pi JSON stream parsing", () => {
  function emptyAcc(): StreamAccumulator {
    return {
      finalOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      tools: [],
      lastMessage: "",
    };
  }

  function fold(lines: unknown[]): StreamAccumulator {
    const acc = emptyAcc();
    for (const line of lines) consumeJsonLine(JSON.stringify(line), acc);
    return acc;
  }

  it("accumulates usage across turns and keeps the last assistant text", () => {
    const acc = fold([assistantMessage("first pass"), assistantMessage("final answer")]);

    expect(acc.finalOutput).toBe("final answer");
    expect(acc.usage.turns).toBe(2);
    expect(acc.usage.input).toBe(200);
    expect(acc.usage.output).toBe(40);
    expect(acc.usage.contextTokens).toBe(120);
    expect(acc.model).toBe("dust/worker-bot");
  });

  it("sums cost from the nested cost.total field", () => {
    const acc = fold([
      assistantMessage("a", { usage: { input: 1, output: 1, cost: { total: 0.25 } } }),
      assistantMessage("b", { usage: { input: 1, output: 1, cost: { total: 0.5 } } }),
    ]);

    expect(acc.usage.cost).toBeCloseTo(0.75);
  });

  it("records stopReason and errorMessage", () => {
    const acc = fold([assistantMessage("", { stopReason: "error", errorMessage: "boom" })]);

    expect(acc.stopReason).toBe("error");
    expect(acc.errorMessage).toBe("boom");
  });

  it("ignores blank lines, malformed JSON and non-assistant events", () => {
    const acc = emptyAcc();

    consumeJsonLine("", acc);
    consumeJsonLine("   ", acc);
    consumeJsonLine("{not json", acc);
    consumeJsonLine(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult" } }), acc);
    consumeJsonLine(JSON.stringify({ type: "message_end", message: { role: "user" } }), acc);

    expect(acc.usage.turns).toBe(0);
    expect(acc.finalOutput).toBe("");
  });
});

describe("concurrency limiter", () => {
  it("never exceeds the limit and preserves input order", async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return item * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrencyLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("subagent environment guards", () => {
  it("detects a subagent child from the depth marker", () => {
    expect(isSubagentChild({})).toBe(false);
    expect(isSubagentChild({ [SUBAGENT_DEPTH_ENV]: "0" })).toBe(false);
    expect(isSubagentChild({ [SUBAGENT_DEPTH_ENV]: "1" })).toBe(true);
    expect(isSubagentChild({ [SUBAGENT_DEPTH_ENV]: "not-a-number" })).toBe(false);
  });

  it("parses the tool allowlist, treating empty as a real restriction", () => {
    expect(allowedSubagentTools({})).toBeNull();
    expect(allowedSubagentTools({ [SUBAGENT_TOOLS_ENV]: "read, grep ,ls" })).toEqual(
      new Set(["read", "grep", "ls"]),
    );
    // Not null: an agent granted no tools must not silently get all of them.
    expect(allowedSubagentTools({ [SUBAGENT_TOOLS_ENV]: "" })).toEqual(new Set());
  });
});

describe("subagent in the MCP catalogue", () => {
  useTempAgentDir();

  it("advertises subagent alongside pi's built-in tools", () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });

    const tools = getMcpTools(makeCtx(makeCwd()));
    const subagent = tools.find((tool) => tool.name === SUBAGENT_TOOL_NAME);

    expect(subagent).toBeDefined();
    expect(subagent?.description).toContain("scout (user): Fast recon");
    expect(subagent?.inputSchema).toMatchObject({ type: "object" });
  });

  it("withholds subagent from a subagent so it cannot recurse", () => {
    process.env[SUBAGENT_DEPTH_ENV] = "1";

    const names = getMcpTools(makeCtx(makeCwd())).map((tool) => tool.name);

    expect(names).not.toContain(SUBAGENT_TOOL_NAME);
    expect(names).toContain("read");
  });

  it("narrows the catalogue to the tools the agent was granted", () => {
    process.env[SUBAGENT_DEPTH_ENV] = "1";
    process.env[SUBAGENT_TOOLS_ENV] = "read,grep";

    const names = getMcpTools(makeCtx(makeCwd())).map((tool) => tool.name);

    expect(names.sort()).toEqual(["grep", "read"]);
  });

  it("refuses a tool outside the allowlist even if Dust asks for it", async () => {
    process.env[SUBAGENT_DEPTH_ENV] = "1";
    process.env[SUBAGENT_TOOLS_ENV] = "read";

    const result = await executeMcpTool("bash", { command: "echo nope" }, makeCtx(makeCwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not available to this subagent");
  });

  it("refuses a nested subagent call", async () => {
    process.env[SUBAGENT_DEPTH_ENV] = "1";

    const result = await executeMcpTool(
      SUBAGENT_TOOL_NAME,
      { agent: "scout", task: "recurse" },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot spawn further subagents");
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("subagent approval message", () => {
  it("describes each mode", () => {
    expect(buildSubagentConfirmMessage({ agent: "scout", task: "find auth" })).toContain(
      "scout: find auth",
    );
    expect(
      buildSubagentConfirmMessage({
        tasks: [
          { agent: "scout", task: "a" },
          { agent: "scout", task: "b" },
        ],
      }),
    ).toContain("parallel, 2 task(s)");
    expect(
      buildSubagentConfirmMessage({ chain: [{ agent: "scout", task: "a" }], agentScope: "both" }),
    ).toContain("chain, 1 step(s) [scope: both]");
  });

  it("falls back to JSON when no mode is recognisable", () => {
    expect(buildSubagentConfirmMessage({ nonsense: true })).toBe(JSON.stringify({ nonsense: true }));
  });
});

describe("subagent execution", () => {
  useTempAgentDir();

  it("spawns a headless, sessionless pi on the agent's Dust model", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot", tools: "read, grep" });
    scriptChild = (proc) => {
      proc.emitJson(assistantMessage("found it in src/auth.ts"));
      proc.finish(0);
    };
    const cwd = makeCwd();

    const result = await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(cwd));

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("found it in src/auth.ts");

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.args).toEqual(expect.arrayContaining(["--mode", "json", "-p", "--no-session"]));
    expect(call.args).toEqual(expect.arrayContaining(["--model", "dust/worker-bot"]));
    expect(call.args).toEqual(expect.arrayContaining(["--tools", "read,grep"]));
    // The task travels on stdin: `pi -p` with a positional prompt still waits
    // on stdin and never produces output.
    expect(call.proc.stdin.written).toBe("Task: find auth\n");
    expect(call.args).not.toContain("Task: find auth");
    expect(call.options.cwd).toBe(cwd);
  });

  it("marks the child so it cannot recurse and restricts its MCP tools", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot", tools: "read, grep" });
    scriptChild = (proc) => proc.finish(0);

    await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(makeCwd()));

    const env = spawnCalls[0].options.env ?? {};
    expect(env[SUBAGENT_DEPTH_ENV]).toBe("1");
    expect(env[SUBAGENT_TOOLS_ENV]).toBe("read,grep");
  });

  it("leaves the MCP tool allowlist unset when the agent grants all tools", async () => {
    writeAgentFile("worker", { description: "General purpose", model: "worker-bot" });
    scriptChild = (proc) => proc.finish(0);

    await executeSubagent({ agent: "worker", task: "do it" }, makeCtx(makeCwd()));

    expect(spawnCalls[0].options.env?.[SUBAGENT_TOOLS_ENV]).toBeUndefined();
    expect(spawnCalls[0].args).not.toContain("--tools");
  });

  it("inherits the session's Dust agent when the file declares no model", async () => {
    writeAgentFile("scout", { description: "Fast recon" });
    scriptChild = (proc) => proc.finish(0);

    await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(makeCwd()));

    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(["--model", "dust/orchestrator"]));
  });

  it("returns when the turn ends even though the child never exits", async () => {
    // A child loading pi-dust keeps its event loop alive (MCP heartbeat + SSE
    // listener), so `close` never fires. Waiting for it hung until Dust
    // timed the parent's tool call out with MCP error -32001.
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => {
      proc.emitJson(assistantMessage("found it"));
      // Deliberately no finish(): the process stays alive forever.
    };

    const result = await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(makeCwd()));

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("found it");
    // The stuck child must be cleaned up rather than leaked.
    expect(spawnCalls[0].proc.signals).toContain("SIGTERM");
  });

  it("keeps waiting while the child is still calling tools", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => {
      // A mid-turn message: more output is still coming, so this must not
      // be mistaken for the end of the run.
      proc.emitJson(assistantMessage("let me look", { stopReason: "toolUse" }));
      setTimeout(() => {
        proc.emitJson(assistantMessage("final answer"));
        proc.finish(0);
      }, 20);
    };

    const result = await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(makeCwd()));

    expect(result.content[0].text).toContain("final answer");
  });

  it("reports an unknown agent without spawning", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });

    const result = await executeSubagent({ agent: "ghost", task: "x" }, makeCtx(makeCwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown agent: "ghost"');
    expect(spawnCalls).toHaveLength(0);
  });

  it("requires exactly one mode", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    const ctx = makeCtx(makeCwd());

    const none = await executeSubagent({}, ctx);
    const both = await executeSubagent(
      { agent: "scout", task: "a", tasks: [{ agent: "scout", task: "b" }] },
      ctx,
    );

    for (const result of [none, both]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("exactly one");
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it("surfaces a non-zero exit as a tool error", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => {
      proc.stderr.emit("data", Buffer.from("model unavailable"));
      proc.finish(2);
    };

    const result = await executeSubagent({ agent: "scout", task: "x" }, makeCtx(makeCwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model unavailable");
  });

  it("treats stopReason error as a failure even on a clean exit", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => {
      proc.emitJson(assistantMessage("", { stopReason: "error", errorMessage: "rate limited" }));
      proc.finish(0);
    };

    const result = await executeSubagent({ agent: "scout", task: "x" }, makeCtx(makeCwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limited");
  });

  it("kills the child with SIGTERM when the turn is aborted", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    const controller = new AbortController();
    scriptChild = () => controller.abort();

    const result = await executeSubagent(
      { agent: "scout", task: "long job" },
      makeCtx(makeCwd()),
      controller.signal,
    );

    expect(spawnCalls[0].proc.signals).toContain("SIGTERM");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("aborted");
  });
});

describe("subagent parallel mode", () => {
  useTempAgentDir();

  it("runs every task and summarises the outcomes", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc, call) => {
      const task = call.proc.stdin.written.trim();
      proc.emitJson(assistantMessage(`done: ${task}`));
      proc.finish(0);
    };

    const result = await executeSubagent(
      {
        tasks: [
          { agent: "scout", task: "find models" },
          { agent: "scout", task: "find providers" },
        ],
      },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(false);
    expect(spawnCalls).toHaveLength(2);
    expect(result.content[0].text).toContain("2/2 succeeded");
    expect(result.content[0].text).toContain("done: Task: find models");
    expect(result.content[0].text).toContain("done: Task: find providers");
  });

  it("reports a partial failure without failing the whole call", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc, call) => {
      if (call.proc.stdin.written.includes("bad")) {
        proc.stderr.emit("data", Buffer.from("nope"));
        proc.finish(1);
        return;
      }
      proc.emitJson(assistantMessage("ok"));
      proc.finish(0);
    };

    const result = await executeSubagent(
      {
        tasks: [
          { agent: "scout", task: "good" },
          { agent: "scout", task: "bad" },
        ],
      },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("1/2 succeeded");
    expect(result.content[0].text).toContain("failed");
  });

  it("rejects more tasks than the cap without spawning", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });

    const result = await executeSubagent(
      { tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "scout", task: `t${i}` })) },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Max is 8");
    expect(spawnCalls).toHaveLength(0);
  });

  it("truncates a task output that exceeds the per-task cap", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => {
      proc.emitJson(assistantMessage("x".repeat(60 * 1024)));
      proc.finish(0);
    };

    const result = await executeSubagent(
      { tasks: [{ agent: "scout", task: "dump" }] },
      makeCtx(makeCwd()),
    );

    expect(result.content[0].text).toContain("bytes omitted");
    expect(result.content[0].text.length).toBeLessThan(60 * 1024);
  });
});

describe("subagent chain mode", () => {
  useTempAgentDir();

  it("substitutes the previous step's output into the next task", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    writeAgentFile("planner", { description: "Plans", model: "planner-bot" });
    scriptChild = (proc, call) => {
      const isScout = call.args.includes("dust/worker-bot");
      proc.emitJson(assistantMessage(isScout ? "auth lives in src/auth.ts" : "the plan"));
      proc.finish(0);
    };

    const result = await executeSubagent(
      {
        chain: [
          { agent: "scout", task: "find auth" },
          { agent: "planner", task: "plan a refactor given: {previous}" },
        ],
      },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(false);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1].proc.stdin.written).toBe(
      "Task: plan a refactor given: auth lives in src/auth.ts\n",
    );
    // Only the last step's output is returned to the caller.
    expect(result.content[0].text).toContain("the plan");
  });

  it("stops at the first failing step", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    writeAgentFile("planner", { description: "Plans", model: "planner-bot" });
    scriptChild = (proc) => {
      proc.stderr.emit("data", Buffer.from("scout crashed"));
      proc.finish(1);
    };

    const result = await executeSubagent(
      {
        chain: [
          { agent: "scout", task: "find auth" },
          { agent: "planner", task: "plan given {previous}" },
        ],
      },
      makeCtx(makeCwd()),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Chain stopped at step 1 (scout)");
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("subagent spec", () => {
  useTempAgentDir();

  it("names no agents when none are defined", () => {
    expect(buildSubagentSpec(makeCtx(makeCwd())).description).toContain("Available agents: none");
  });
});

describe("subagent approval policy", () => {
  it("approves tools without prompting inside a subagent child", async () => {
    // Headless children have no one to answer ctx.ui.confirm, which returns
    // false there — every tool call was denied and the agent reported it had
    // no tools. The parent's approval plus the tools: allowlist are the gate.
    process.env[SUBAGENT_DEPTH_ENV] = "1";
    const { registerDustApprovalMode } = await import("../src/dust-approval.js");
    const { DustSessionRuntime } = await import("../src/dust-runtime.js");

    const runtime = new DustSessionRuntime();
    expect(runtime.autoApprove).toBe(false);

    registerDustApprovalMode({ registerCommand: () => {} } as never, runtime);

    expect(runtime.autoApprove).toBe(true);
  });

  it("leaves a normal session prompting for every tool", async () => {
    const { registerDustApprovalMode } = await import("../src/dust-approval.js");
    const { DustSessionRuntime } = await import("../src/dust-runtime.js");

    const runtime = new DustSessionRuntime();
    registerDustApprovalMode({ registerCommand: () => {} } as never, runtime);

    expect(runtime.autoApprove).toBe(false);
  });
});

describe("subagent approval exemption", () => {
  it("never gates the subagent tool itself", async () => {
    const { requiresApproval } = await import("../src/dust-tools.js");

    // Delegation does no work on its own; the child's reach is already bounded
    // by the agent file's tools: allowlist and the no-recursion depth guard.
    expect(requiresApproval(SUBAGENT_TOOL_NAME)).toBe(false);
  });

  it("still gates every tool that touches the machine", async () => {
    const { requiresApproval } = await import("../src/dust-tools.js");

    for (const tool of ["bash", "write", "edit", "read", "grep", "find", "ls"]) {
      expect(requiresApproval(tool), tool).toBe(true);
    }
  });
});

describe("subagent extension propagation", () => {
  useTempAgentDir();

  it("pins the child to this build instead of pi's discovery", async () => {
    writeAgentFile("scout", { description: "Fast recon", model: "worker-bot" });
    scriptChild = (proc) => proc.finish(0);

    await executeSubagent({ agent: "scout", task: "find auth" }, makeCtx(makeCwd()));

    const args = spawnCalls[0].args;
    // Without this the child loads a different pi-dust, so its approval policy
    // and subagent guards silently differ from the parent's.
    expect(args).toContain("--no-extensions");
    const flagIndex = args.indexOf("-e");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toMatch(/dust\.(ts|js)$/);
  });
});
