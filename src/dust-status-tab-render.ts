import type { BreakdownSlice, SliceState } from "./dust-status-loader.js";
import { formatCredits, renderStatusPanel } from "./dust-status-render.js";
import type { StatusPeriod, StatusTab } from "./dust-status-tabs.js";
import type { CreditBreakdownEntry, DustStatusData } from "./dust-types.js";

const BAR_WIDTH = 24;
const MAX_ROWS = 10;
/** Conversation titles are whole prompts; without a cap one row sets the column width. */
const MAX_LABEL = 44;

function clampLabel(label: string): string {
  return label.length <= MAX_LABEL ? label : `${label.slice(0, MAX_LABEL - 1)}…`;
}

/** Frames for the inline spinner; advanced by the panel's ticker. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

/**
 * Bar scaled to the largest row rather than to any ceiling.
 *
 * A breakdown has no limit to fill against — the question is "which of these is
 * big", so the top row spans the full width and the rest read relative to it.
 */
function relativeBar(credits: number, max: number, width = BAR_WIDTH): string {
  if (max <= 0) return "";
  return "█".repeat(Math.max(credits > 0 ? 1 : 0, Math.round((credits / max) * width)));
}

export function renderBreakdownRows(entries: CreditBreakdownEntry[], heading: string): string[] {
  const ranked = [...entries]
    .sort((a, b) => b.credits - a.credits)
    .slice(0, MAX_ROWS)
    .map((entry) => ({ ...entry, label: clampLabel(entry.label) }));
  const total = entries.reduce((sum, entry) => sum + entry.credits, 0);
  const max = ranked[0]?.credits ?? 0;

  const labelWidth = Math.max(heading.length, ...ranked.map((entry) => entry.label.length)) + 2;
  const creditsWidth = Math.max(7, ...ranked.map((entry) => formatCredits(entry.credits).length));

  const lines = [
    `  ${heading.padEnd(labelWidth, " ")}${"credits".padStart(creditsWidth, " ")}   ${"share".padStart(5, " ")}`,
    "",
  ];

  for (const entry of ranked) {
    const share = total > 0 ? `${Math.round((entry.credits / total) * 100)}%` : "—";
    lines.push(
      `  ${entry.label.padEnd(labelWidth, " ")}${formatCredits(entry.credits).padStart(creditsWidth, " ")}`
      + `   ${share.padStart(5, " ")}  ${relativeBar(entry.credits, max)}`,
    );
  }

  if (entries.length > MAX_ROWS) {
    lines.push("", `  … and ${entries.length - MAX_ROWS} more`);
  }
  const count = entries.length;
  lines.push("", `  Total: ${formatCredits(total)} credits across ${count} ${count === 1 ? "entry" : "entries"}`);

  return lines;
}

/** Body of a breakdown tab, covering the loading and failure states too. */
export function renderBreakdownTab(
  tab: StatusTab,
  period: StatusPeriod,
  slice: SliceState<BreakdownSlice>,
  tick: number,
): string[] {
  const scope = tab.groupBy ? period.label : "Last 30 days";
  const header = [`  ${scope} · your usage across all devices`, ""];

  if (slice.status === "loading") {
    return [...header, `  ${spinnerFrame(tick)} Loading…`];
  }
  if (slice.status === "error") {
    return [...header, `  ${slice.message}`];
  }
  if (slice.value.entries.length === 0) {
    return [...header, `  ${tab.empty ?? "Nothing to show."}`];
  }

  return [...header, ...renderBreakdownRows(slice.value.entries, tab.heading ?? "Name")];
}

/** Body of the Overview tab, reusing the static panel minus its title row. */
export function renderOverviewTab(
  slice: SliceState<DustStatusData>,
  refreshing: boolean,
  tick: number,
  now = new Date(),
): string[] {
  if (slice.status === "loading") {
    return ["", `  ${spinnerFrame(tick)} Reading your Dust credit usage…`];
  }
  if (slice.status === "error") {
    return ["", `  ${slice.message}`];
  }

  // Drop the panel's own " Dust  Status" title; the tab bar already says it.
  const body = renderStatusPanel(slice.value, now).slice(1);
  return refreshing ? [...body, "", `  ${spinnerFrame(tick)} refreshing…`] : body;
}
