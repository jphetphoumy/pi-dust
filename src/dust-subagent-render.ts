import { Container, Text } from "@earendil-works/pi-tui";
import type { SubagentDetails, SubagentRun, SubagentUsage } from "./dust-types.js";

export type Paint = (slot: string, text: string) => string;
const PLAIN: Paint = (_slot, text) => text;

/** Fallback when a run carries no context window of its own. */
const DEFAULT_CONTEXT_WINDOW = 100_000;
const DEFAULT_WIDTH = 100;

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function statusIcon(status: SubagentRun["status"], paint: Paint): string {
  switch (status) {
    case "running":
      return paint("warning", "⟳");
    case "pending":
      return paint("dim", "○");
    case "ok":
      return paint("success", "✓");
    default:
      return paint("error", "✗");
  }
}

/** Single-line truncation. Widget lines must not wrap or the box grows. */
function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  return `${flat.slice(0, Math.max(1, width - 1))}…`;
}

function usageLine(usage: SubagentUsage, contextWindow: number | undefined): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
  if (usage.contextTokens) {
    const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const pct = Math.round((usage.contextTokens / window) * 100);
    parts.push(`ctx:${formatTokens(usage.contextTokens)}/${formatTokens(window)} (${pct}%)`);
  }
  return parts.join(" ");
}

function renderRun(run: SubagentRun, expanded: boolean, width: number, paint: Paint): string[] {
  const lines: string[] = [];
  const label = run.step === undefined ? run.agent : `${run.step}. ${run.agent}`;
  const model = run.model ? ` (${run.model})` : "";
  const toolWord = run.tools.length === 1 ? "tool" : "tools";
  const stats = `${run.tools.length} ${toolWord} · ${formatDuration(run.durationMs)}`;

  lines.push(
    `${statusIcon(run.status, paint)} ${paint("toolTitle", label)}${paint("dim", model)} — ${paint("dim", stats)}`,
  );

  // The in-flight call is marked so a long-running tool is obvious at a glance.
  for (const call of run.tools) {
    const body = call.args ? `${call.tool}: ${call.args}` : call.tool;
    const line = truncate(body, width - 4);
    lines.push(
      call.status === "running"
        ? `  ${paint("warning", `▸ ${line}`)}`
        : `    ${paint("muted", line)}`,
    );
  }

  if (run.lastMessage) {
    lines.push("");
    lines.push(`  ${paint("text", truncate(run.lastMessage, width - 2))}`);
  }

  // The finished answer is the point of the whole call, so it is only elided
  // while collapsed — expanding shows it in full, wrapped rather than cut.
  if (expanded && run.output) {
    lines.push("");
    for (const raw of run.output.split("\n")) lines.push(`  ${raw}`);
  }

  const usage = usageLine(run.usage, run.contextWindow);
  if (usage) {
    lines.push("");
    lines.push(`  ${paint("dim", truncate(usage, width - 2))}`);
  }

  return lines;
}

/**
 * The subagent block, as plain lines.
 *
 * One renderer feeds both surfaces — the live `setWidget` progress box and the
 * transcript row appended when the call ends — so a finished run looks like the
 * running one it replaces.
 */
export function renderSubagentLines(
  details: SubagentDetails,
  options: { expanded?: boolean; width?: number; paint?: Paint } = {},
): string[] {
  const width = Math.max(40, options.width ?? DEFAULT_WIDTH);
  const expanded = options.expanded ?? false;
  const paint = options.paint ?? PLAIN;
  const lines: string[] = [];

  if (details.runs.length > 1) {
    const done = details.runs.filter((run) => run.status === "ok" || run.status === "failed").length;
    lines.push(paint("toolTitle", `${details.mode}: ${done}/${details.runs.length} done`));
    lines.push("");
  }

  details.runs.forEach((run, index) => {
    if (index > 0) lines.push("");
    lines.push(...renderRun(run, expanded, width, paint));
  });

  return lines;
}

export function isSubagentDetails(value: unknown): value is SubagentDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as SubagentDetails;
  return Array.isArray(candidate.runs) && typeof candidate.mode === "string";
}

function taskPreview(args: Record<string, unknown>): string {
  const list = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

  const chain = list(args.chain);
  if (chain.length > 0) return `chain (${chain.length} steps)`;
  const tasks = list(args.tasks);
  if (tasks.length > 0) return `parallel (${tasks.length} tasks)`;

  const agent = typeof args.agent === "string" ? args.agent : "…";
  const task = typeof args.task === "string" ? args.task : "";
  return task ? `${agent} — ${truncate(task, 60)}` : agent;
}

/**
 * A `ToolDefinition` for `subagent`, purely so pi has renderers for it.
 *
 * `subagent` is ours and reaches Dust over MCP, so unlike bash/read/edit there
 * is no pi factory to borrow renderers from — without this the transcript falls
 * back to raw JSON arguments and flat result text.
 */
export function buildSubagentToolDefinition(): Record<string, unknown> {
  return {
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a specialised subagent.",
    parameters: { type: "object" },
    renderCall: (args: Record<string, unknown>, theme: { fg: Paint; bold: (t: string) => string }) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", taskPreview(args ?? {}))}`,
        0,
        0,
      ),
    renderResult: (
      result: { details?: unknown; content?: Array<{ text?: string }> },
      options: { expanded?: boolean },
      theme: { fg: Paint },
    ) => {
      const container = new Container();
      if (!isSubagentDetails(result?.details)) {
        // No structured details (an early validation error): show the text.
        const text = result?.content?.map((block) => block?.text ?? "").join("\n") ?? "";
        container.addChild(new Text(text, 0, 0));
        return container;
      }

      const lines = renderSubagentLines(result.details, {
        expanded: options?.expanded ?? false,
        width: (process.stdout.columns || DEFAULT_WIDTH) - 6,
        paint: (slot, text) => theme.fg(slot, text),
      });
      for (const line of lines) container.addChild(new Text(line, 0, 0));
      return container;
    },
  };
}
