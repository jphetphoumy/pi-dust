import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import { getStoredCredentials } from "./dust-state.js";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  formatAgentList,
  resolveDustModelSpec,
} from "./dust-subagent-agents.js";
import { renderSubagentLines } from "./dust-subagent-render.js";
import type {
  McpToolArgs,
  SubagentDetails,
  SubagentRun,
  SubagentToolCall,
} from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * Depth marker on the child process. Its presence is what hides `subagent`
 * from the child's own tool catalogue, so a subagent cannot spawn subagents.
 */
export const SUBAGENT_DEPTH_ENV = "PI_DUST_SUBAGENT_DEPTH";
/**
 * Comma-separated tool allowlist for the child.
 *
 * pi's `--tools` only filters pi's *native* tools; a Dust child receives its
 * tools from this extension's MCP bridge instead, which `--tools` never sees.
 * This variable is how an agent file's `tools:` reaches that bridge.
 */
export const SUBAGENT_TOOLS_ENV = "PI_DUST_SUBAGENT_TOOLS";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const KILL_GRACE_MS = 5000;
/** Grace after a finished turn for trailing stdout to arrive. */
const TURN_SETTLE_MS = 300;

/** True when this process is itself a subagent. */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  const depth = Number.parseInt(env[SUBAGENT_DEPTH_ENV] ?? "", 10);
  return Number.isFinite(depth) && depth > 0;
}

/** Tool names this process may expose, or null when unrestricted. */
export function allowedSubagentTools(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env[SUBAGENT_TOOLS_ENV];
  if (raw === undefined) return null;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  // An explicitly empty list means "no tools", which is a meaningful
  // restriction and must not decay into "unrestricted".
  return new Set(names);
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  finalOutput: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`in ${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`out ${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`cacheR ${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`cacheW ${formatTokens(usage.cacheWrite)}`);
  if (usage.contextTokens) parts.push(`ctx ${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(", ");
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function resultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr.trim() || result.finalOutput || "(no output)";
  }
  return result.finalOutput || "(no output)";
}

function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted.]`;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dust-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  // 0o600: the system prompt is written where any local user could otherwise
  // read it.
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

/**
 * This extension's entry file, so a child runs the same build as its parent.
 *
 * Without pinning it the child falls back to whatever pi discovers, which is a
 * different build — or, when the parent was started with `-e`, quietly not the
 * one under test.
 */
export function resolveExtensionEntry(): string | null {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const name of ["dust.ts", "dust.js"]) {
      const candidate = path.join(here, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* fall through to pi's own discovery */
  }
  return null;
}

/**
 * How to re-invoke pi for a child process.
 *
 * Prefers the script this process was started from so the child is the same
 * build as the parent, and falls back to a `pi` on PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

export interface StreamAccumulator {
  finalOutput: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Set once the child has finished its turn and has nothing more to say. */
  turnComplete?: boolean;
  /** Tool calls seen so far, in order, for the progress log. */
  tools: SubagentToolCall[];
  /** Latest assistant prose, shown as the current "thinking" line. */
  lastMessage: string;
}

/** A live run the caller re-renders whenever the child makes progress. */
interface ProgressSink {
  run: SubagentRun;
  notify: () => void;
}

/**
 * Stop reasons that mean "more is coming".
 *
 * Anything else ends the turn — including `error` and `aborted`, where waiting
 * for further output would just hang.
 */
const NON_TERMINAL_STOP_REASONS = new Set(["toolUse", "tool_use", "toolCall"]);

/**
 * Folds one NDJSON line of `pi --mode json` output into the running result.
 *
 * Exported for tests: this is the whole contract with pi's JSON mode, and it is
 * far cheaper to verify here than through a spawned process.
 */
export function consumeJsonLine(line: string, acc: StreamAccumulator): void {
  if (!line.trim()) return;

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof event !== "object" || event === null) return;
  const record = event as Record<string, unknown>;

  // A tool result closes the most recent still-running call, which is what
  // moves the `▸` marker along the tool log.
  if (record.type === "tool_result_end") {
    for (let i = acc.tools.length - 1; i >= 0; i--) {
      if (acc.tools[i].status === "running") {
        acc.tools[i].status = "done";
        break;
      }
    }
    return;
  }

  if (record.type !== "message_end") return;

  const message = record.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "assistant") return;

  acc.usage.turns++;

  const usage = message.usage as Record<string, unknown> | undefined;
  if (usage) {
    acc.usage.input += Number(usage.input) || 0;
    acc.usage.output += Number(usage.output) || 0;
    acc.usage.cacheRead += Number(usage.cacheRead) || 0;
    acc.usage.cacheWrite += Number(usage.cacheWrite) || 0;
    const cost = usage.cost as Record<string, unknown> | undefined;
    acc.usage.cost += Number(cost?.total) || 0;
    acc.usage.contextTokens = Number(usage.totalTokens) || acc.usage.contextTokens;
  }

  if (!acc.model && typeof message.model === "string") acc.model = message.model;
  if (typeof message.stopReason === "string") {
    acc.stopReason = message.stopReason;
    if (!NON_TERMINAL_STOP_REASONS.has(message.stopReason)) acc.turnComplete = true;
  }
  if (typeof message.errorMessage === "string") acc.errorMessage = message.errorMessage;

  // The last assistant text block is the subagent's answer; earlier ones are
  // intermediate narration around tool calls.
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const block = part as Record<string, unknown>;

      if (block.type === "text" && typeof block.text === "string") {
        acc.finalOutput = block.text;
        acc.lastMessage = block.text;
      }

      if (block.type === "toolCall" && typeof block.name === "string") {
        acc.tools.push({
          tool: block.name,
          args: summariseToolArgs(block.name, block.arguments),
          status: "running",
        });
      }
    }
  }
}

/**
 * One-line argument summary for the tool log, mirroring how pi labels its own
 * tool rows (`$ cmd`, a path, a `/pattern/`) rather than dumping JSON.
 */
export function summariseToolArgs(toolName: string, rawArgs: unknown): string {
  if (typeof rawArgs !== "object" || rawArgs === null) return "";
  const args = rawArgs as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  switch (toolName) {
    case "bash":
      return `$ ${str(args.command)}`;
    case "read":
    case "write":
    case "edit":
      return str(args.path ?? args.file_path);
    case "ls":
      return str(args.path ?? args.dir) || ".";
    case "grep":
    case "find": {
      const pattern = str(args.pattern ?? args.query);
      const where = str(args.path);
      const scope = where ? ` in ${where}` : "";
      return pattern ? `/${pattern}/${scope}` : scope.trim();
    }
    default: {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json;
    }
  }
}

function buildChildEnv(agent: AgentConfig, depth: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [SUBAGENT_DEPTH_ENV]: String(depth + 1) };
  if (agent.tools && agent.tools.length > 0) {
    env[SUBAGENT_TOOLS_ENV] = agent.tools.join(",");
  }
  return env;
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  fallbackModelId: string | null,
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  progress?: ProgressSink,
): Promise<SingleResult> {
  const base: SingleResult = {
    agent: agentName,
    task,
    exitCode: 1,
    finalOutput: "",
    stderr: "",
    usage: emptyUsage(),
    step,
  };

  const agent = agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return { ...base, errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.` };
  }

  const startedAt = Date.now();
  const credentials = getStoredCredentials();
  const resolution = resolveDustModelSpec(agent, credentials, fallbackModelId);
  if ("error" in resolution) return { ...base, errorMessage: resolution.error };

  const args = ["--mode", "json", "-p", "--no-session", "--model", resolution.spec];

  // The child must load this exact extension, not whatever pi would discover:
  // it needs the same subagent guards and the same approval policy as its parent.
  const extensionEntry = resolveExtensionEntry();
  if (extensionEntry) args.push("--no-extensions", "-e", extensionEntry);
  // Restricts the child's native pi tools. The MCP-side restriction travels
  // separately, via SUBAGENT_TOOLS_ENV.
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  const depth = Number.parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10) || 0;

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const acc: StreamAccumulator = { finalOutput: "", usage: emptyUsage(), tools: [], lastMessage: "" };
  let stderr = "";

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // The task goes on stdin, not as a positional argument: `pi -p` with a
    // positional prompt waits on stdin anyway and never produces output.
    debugLog("dust:subagent", "Spawning subagent", {
      agent: agent.name,
      model: resolution.spec,
      tools: agent.tools,
      depth: depth + 1,
    });

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(agent, depth),
      });

      proc.stdin?.on("error", () => {
        /* child may exit before the task is flushed */
      });
      proc.stdin?.end(`Task: ${task}\n`);

      const syncProgress = () => {
        if (!progress) return;
        progress.run.status = "running";
        progress.run.tools = acc.tools.map((call) => ({ ...call }));
        progress.run.lastMessage = acc.lastMessage;
        progress.run.usage = { ...acc.usage };
        progress.run.model = acc.model ?? progress.run.model;
        progress.run.durationMs = Date.now() - startedAt;
        progress.notify();
      };

      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      /**
       * A child loading pi-dust does not exit when its turn ends: the MCP
       * heartbeat timer and the SSE listener keep its event loop alive. Waiting
       * for `close` would hang until Dust times out the parent's tool call, so
       * the finished turn is the completion signal and the child is then
       * stopped.
       */
      let doneTimer: NodeJS.Timeout | null = null;
      const finishWhenTurnComplete = () => {
        if (!acc.turnComplete || doneTimer) return;
        // Small grace so any trailing stdout is folded in before shutdown.
        doneTimer = setTimeout(() => {
          if (buffer.trim()) consumeJsonLine(buffer, acc);
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, KILL_GRACE_MS).unref?.();
          settle(0);
        }, TURN_SETTLE_MS);
        doneTimer.unref?.();
      };

      let buffer = "";
      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeJsonLine(line, acc);
        syncProgress();
        finishWhenTurnComplete();
      });
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (doneTimer) clearTimeout(doneTimer);
        if (buffer.trim()) consumeJsonLine(buffer, acc);
        settle(code ?? 0);
      });
      proc.on("error", () => settle(1));

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, KILL_GRACE_MS).unref?.();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    const result: SingleResult = {
      ...base,
      exitCode,
      finalOutput: acc.finalOutput,
      stderr,
      usage: acc.usage,
      model: acc.model ?? resolution.spec,
      stopReason: wasAborted ? "aborted" : acc.stopReason,
      errorMessage: acc.errorMessage,
    };

    if (progress) {
      progress.run.status = isFailedResult(result) ? "failed" : "ok";
      progress.run.tools = acc.tools.map((call) => ({ ...call, status: "done" as const }));
      progress.run.lastMessage = "";
      progress.run.output = resultOutput(result);
      progress.run.usage = { ...acc.usage };
      progress.run.model = result.model;
      progress.run.durationMs = Date.now() - startedAt;
      progress.notify();
    }

    return result;
  } catch (err: unknown) {
    return { ...base, stderr, errorMessage: errorMessage(err) };
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* best effort */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* best effort */
      }
    }
  }
}

interface TaskItem {
  agent: string;
  task: string;
  cwd?: string;
}

function readTaskItems(value: unknown): TaskItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: TaskItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.agent !== "string" || typeof record.task !== "string") return null;
    items.push({
      agent: record.agent,
      task: record.task,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    });
  }
  return items;
}

function textResult(text: string, isError = false, details?: SubagentDetails) {
  return { content: [{ type: "text" as const, text }], isError, details };
}

const PROGRESS_WIDGET_KEY = "dust-subagent-progress";

function newRun(item: TaskItem, step?: number): SubagentRun {
  return {
    agent: item.agent,
    task: item.task,
    status: "pending",
    tools: [],
    lastMessage: "",
    output: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    durationMs: 0,
    step,
  };
}

/**
 * Live progress box.
 *
 * Transcript entries are immutable once appended, so a running subagent cannot
 * be shown as a row that mutates — the widget is the only surface pi offers for
 * something that changes while a tool runs. It is cleared when the call ends
 * and replaced by the appended row.
 */
function makeProgressReporter(ctx: ExtensionContext | undefined, details: SubagentDetails) {
  const ui = (ctx as { ui?: { setWidget?: (key: string, content: string[] | undefined) => void } })
    ?.ui;
  const setWidget = ui?.setWidget?.bind(ui);
  if (!setWidget) return { notify: () => {}, clear: () => {} };

  return {
    notify: () => {
      try {
        setWidget(PROGRESS_WIDGET_KEY, renderSubagentLines(details));
      } catch {
        /* progress display must never break the run */
      }
    },
    clear: () => {
      try {
        setWidget(PROGRESS_WIDGET_KEY, undefined);
      } catch {
        /* ignore */
      }
    },
  };
}

function currentDustModelId(ctx?: ExtensionContext): string | null {
  const model = (ctx as { model?: { provider?: string; id?: string } } | undefined)?.model;
  if (!model || model.provider !== "dust" || typeof model.id !== "string") return null;
  return model.id;
}

const SUBAGENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Name of the agent to invoke (single mode)" },
    task: { type: "string", description: "Task to delegate (single mode)" },
    tasks: {
      type: "array",
      description: `Array of {agent, task} run concurrently. Max ${MAX_PARALLEL_TASKS}.`,
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          task: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["agent", "task"],
      },
    },
    chain: {
      type: "array",
      description:
        "Array of {agent, task} run in order. Use {previous} in a task to insert the prior step's output.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          task: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["agent", "task"],
      },
    },
    agentScope: {
      type: "string",
      enum: ["user", "project", "both"],
      description: 'Which agent directories to use. Default "user".',
    },
    cwd: { type: "string", description: "Working directory for the agent process (single mode)" },
  },
} as const;

/**
 * The `subagent` entry in the catalogue advertised to Dust.
 *
 * Built per call rather than cached because the agent list is embedded in the
 * description and agent files may be edited mid-session.
 */
export function buildSubagentSpec(ctx?: ExtensionContext) {
  const cwd = ctx?.cwd ?? process.cwd();
  const { agents } = discoverAgents(cwd, "user");

  return {
    name: SUBAGENT_TOOL_NAME,
    description: [
      "Delegate a task to a specialised subagent with its own isolated context window.",
      "Each subagent runs as a separate Dust agent in its own process and returns only its final answer,",
      "so this is the way to do wide exploration without spending this conversation's context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential, with {previous} substitution).",
      `Available agents: ${formatAgentList(agents)}.`,
    ].join(" "),
    inputSchema: SUBAGENT_INPUT_SCHEMA as unknown as Record<string, unknown>,
  };
}

/** Approval dialog body for a `subagent` call. */
export function buildSubagentConfirmMessage(args: McpToolArgs): string {
  const scope = typeof args.agentScope === "string" ? args.agentScope : "user";
  const describe = (item: TaskItem, index?: number) => {
    const prefix = index === undefined ? "" : `${index + 1}. `;
    const preview = item.task.length > 120 ? `${item.task.slice(0, 117)}...` : item.task;
    return `${prefix}${item.agent}: ${preview}`;
  };

  const chain = readTaskItems(args.chain);
  if (chain && chain.length > 0) {
    return `chain, ${chain.length} step(s) [scope: ${scope}]\n${chain.map(describe).join("\n")}`;
  }

  const tasks = readTaskItems(args.tasks);
  if (tasks && tasks.length > 0) {
    return `parallel, ${tasks.length} task(s) [scope: ${scope}]\n${tasks.map(describe).join("\n")}`;
  }

  if (typeof args.agent === "string" && typeof args.task === "string") {
    return `[scope: ${scope}]\n${describe({ agent: args.agent, task: args.task })}`;
  }

  return JSON.stringify(args);
}

/**
 * Runs a `subagent` tool call from Dust.
 *
 * Mirrors `executeMcpTool`'s contract: never throws, always returns text.
 */
export async function executeSubagent(
  args: McpToolArgs,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  details?: SubagentDetails;
}> {
  const scope: AgentScope =
    args.agentScope === "project" || args.agentScope === "both"
      ? (args.agentScope as AgentScope)
      : "user";
  const cwd = ctx?.cwd ?? process.cwd();
  const { agents, projectAgentsDir } = discoverAgents(cwd, scope);
  const fallbackModelId = currentDustModelId(ctx);

  const chain = readTaskItems(args.chain) ?? [];
  const tasks = readTaskItems(args.tasks) ?? [];
  const hasSingle = typeof args.agent === "string" && typeof args.task === "string";
  const modeCount = Number(chain.length > 0) + Number(tasks.length > 0) + Number(hasSingle);

  if (modeCount !== 1) {
    return textResult(
      `Provide exactly one of: {agent, task}, {tasks: [...]}, {chain: [...]}.\n` +
        `Available agents: ${formatAgentList(agents)}`,
      true,
    );
  }

  const mode: SubagentDetails["mode"] =
    chain.length > 0 ? "chain" : tasks.length > 0 ? "parallel" : "single";
  const items: TaskItem[] =
    chain.length > 0
      ? chain
      : tasks.length > 0
        ? tasks
        : [
            {
              agent: args.agent as string,
              task: args.task as string,
              cwd: typeof args.cwd === "string" ? args.cwd : undefined,
            },
          ];
  const details: SubagentDetails = {
    mode,
    runs: items.map((item, index) => newRun(item, mode === "chain" ? index + 1 : undefined)),
  };
  const reporter = makeProgressReporter(ctx, details);
  const contextWindow = (ctx as { model?: { contextWindow?: number } } | undefined)?.model
    ?.contextWindow;
  for (const entry of details.runs) entry.contextWindow = contextWindow;
  reporter.notify();

  // Every exit path clears the progress box: the appended transcript row takes
  // its place, and a widget left behind would outlive the call.
  const finish = <T>(result: T): T => {
    reporter.clear();
    return result;
  };

  const run = (item: TaskItem, index: number, step?: number) =>
    runSingleAgent(cwd, agents, fallbackModelId, item.agent, item.task, item.cwd, step, signal, {
      run: details.runs[index],
      notify: reporter.notify,
    });

  if (chain.length > 0) {
    const results: SingleResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      const result = await run(
        { ...step, task: step.task.replace(/\{previous\}/g, previousOutput) },
        i,
        i + 1,
      );
      results.push(result);

      if (isFailedResult(result)) {
        return finish(
          textResult(
            `Chain stopped at step ${i + 1} (${step.agent}): ${resultOutput(result)}`,
            true,
            details,
          ),
        );
      }
      previousOutput = result.finalOutput;
    }

    const last = results[results.length - 1];
    const trace = results
      .map((result) => `- step ${result.step} ${result.agent}: ${formatUsage(result.usage, result.model)}`)
      .join("\n");
    return finish(textResult(`${resultOutput(last)}\n\n---\n${trace}`, false, details));
  }

  if (tasks.length > 0) {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return finish(
        textResult(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`, true),
      );
    }

    const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, (item, index) =>
      run(item, index),
    );
    const succeeded = results.filter((result) => !isFailedResult(result)).length;
    const sections = results.map((result) => {
      const status = isFailedResult(result)
        ? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
        : "completed";
      return [
        `### [${result.agent}] ${status}`,
        formatUsage(result.usage, result.model),
        "",
        truncateOutput(resultOutput(result)),
      ].join("\n");
    });

    return finish(
      textResult(
        `Parallel: ${succeeded}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
        succeeded === 0,
        details,
      ),
    );
  }

  const result = await run(items[0], 0);

  if (isFailedResult(result)) {
    const hint =
      scope !== "user" && projectAgentsDir ? `\n(project agents from ${projectAgentsDir})` : "";
    return finish(
      textResult(`Agent ${result.stopReason ?? "failed"}: ${resultOutput(result)}${hint}`, true, details),
    );
  }

  return finish(
    textResult(
      `${truncateOutput(resultOutput(result))}\n\n---\n${formatUsage(result.usage, result.model)}`,
      false,
      details,
    ),
  );
}
