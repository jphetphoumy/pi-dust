import type { CreditBreakdownEntry, DustStatusData, FairUseCredits, MemberUsage } from "./dust-types.js";

const GAUGE_WIDTH = 50;
const LABEL_WIDTH = 22;
/** Dust's own sentinel for "no ceiling" on fair-use plans. */
const UNLIMITED = -1;

/** Eighth-width blocks, so a gauge can land between two full cells. */
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function formatCredits(value: number): string {
  return value.toFixed(2);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Renders an ISO timestamp in the machine's own timezone, naming it explicitly
 * so a reset date is never ambiguous between the user's clock and Dust's.
 */
export function formatResetDate(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;

  const date = new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone ? `${date} (${timezone})` : date;
}

export function renderGauge(used: number, limit: number, width = GAUGE_WIDTH): string {
  const fraction = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const cells = fraction * width;
  const full = Math.floor(cells);
  const remainder = Math.round((cells - full) * 8);
  // A remainder that rounds up to a whole cell is just another full block.
  const bar = remainder === 8
    ? "█".repeat(Math.min(width, full + 1))
    : "█".repeat(full) + PARTIAL_BLOCKS[remainder];

  return `${bar.padEnd(width, " ")} ${String(Math.round(fraction * 100)).padStart(3, " ")}% used`;
}

function row(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(LABEL_WIDTH, " ")}${value}`;
}

function isUnlimited(limit: number | null): boolean {
  return limit === UNLIMITED;
}

const BREAKDOWN_LIMIT = 10;

function rankBreakdown(entries: CreditBreakdownEntry[]): CreditBreakdownEntry[] {
  return [...entries].sort((a, b) => b.credits - a.credits).slice(0, BREAKDOWN_LIMIT);
}

/** Both breakdown tables share a column width so they read as one block. */
function renderBreakdown(title: string, entries: CreditBreakdownEntry[], labelWidth: number): string[] {
  if (entries.length === 0) return [];

  return [
    "",
    `  ${title.padEnd(labelWidth, " ")}${"credits".padStart(9, " ")}`,
    ...entries.map((entry) => `  ${entry.label.padEnd(labelWidth, " ")}${formatCredits(entry.credits).padStart(9, " ")}`),
  ];
}

function renderSeatCredits(usage: MemberUsage | null, fairUse: FairUseCredits | null): string[] {
  const consumed = usage?.consumedAwuCredits;
  const allowance = usage?.memberUsageLimit;

  // A seat allocation is the normal paid-plan case: two numbers and a gauge.
  if (typeof consumed === "number" && typeof allowance === "number" && allowance > 0) {
    const reset = usage?.nextCreditResetAt ? formatResetDate(usage.nextCreditResetAt) : null;
    const detail = `${formatCredits(consumed)} / ${formatCredits(allowance)} credits`;
    return [
      "",
      "  Seat credits",
      `  ${renderGauge(consumed, allowance)}`,
      `  ${reset ? `${detail} · resets ${reset}` : detail}`,
    ];
  }

  // Free and fair-use plans carry no seat allocation; `fair-use-credits` is the
  // only ceiling they expose, and it may be explicitly unlimited.
  if (fairUse) {
    if (isUnlimited(fairUse.limit)) {
      const used = fairUse.count ?? consumed;
      return [
        "",
        "  Fair-use credits",
        row("Used", typeof used === "number" ? `${formatCredits(used)} credits` : "unknown"),
        row("Limit", "unlimited"),
      ];
    }
    if (typeof fairUse.limit === "number" && fairUse.limit > 0 && typeof fairUse.count === "number") {
      const timeframe = fairUse.timeframe ? ` · per ${fairUse.timeframe}` : "";
      return [
        "",
        `  Fair-use credits${timeframe}`,
        `  ${renderGauge(fairUse.count, fairUse.limit)}`,
        `  ${formatCredits(fairUse.count)} / ${formatCredits(fairUse.limit)} credits`,
      ];
    }
  }

  if (typeof consumed === "number") {
    return ["", "  Seat credits", row("Consumed", `${formatCredits(consumed)} credits`), row("Allowance", "not set")];
  }

  return [];
}

function renderSpendCap(usage: MemberUsage | null): string[] {
  const cap = usage?.spendLimitAwuCredits;
  const consumed = usage?.consumedAwuCredits;

  if (usage?.spendLimitSource === "none" || typeof cap !== "number" || cap <= 0) return [];

  const frequency = usage?.billingFrequency ? ` (${usage.billingFrequency})` : "";
  const lines = ["", `  Spend cap${frequency}`];
  if (typeof consumed === "number") {
    lines.push(`  ${renderGauge(consumed, cap)}`, `  ${formatCredits(consumed)} / ${formatCredits(cap)} credits`);
  } else {
    lines.push(row("Cap", `${formatCredits(cap)} credits`));
  }
  return lines;
}

function renderWorkspacePool(usage: MemberUsage | null): string[] {
  const fromPool = usage?.consumedFromPoolAwuCredits;
  if (typeof fromPool !== "number") return [];
  return ["", "  Workspace pool", row("Overflow used", `${formatCredits(fromPool)} credits`)];
}

function renderSessionCredits(data: DustStatusData): string {
  if (data.sessionCredits === null) return row("Credits (session)", "unavailable");

  // The delta is against a sample taken partway through the session and Dust
  // lands per-user usage asynchronously, so the number is a floor, not a total.
  const since = data.sessionBaselineAt
    ? ` · measured since ${new Date(data.sessionBaselineAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return row("Credits (session)", `~${formatCredits(data.sessionCredits)}  (approximate${since})`);
}

/** Builds the whole panel. Sections with no usable data are simply absent. */
export function renderStatusPanel(data: DustStatusData): string[] {
  const lines = [
    " Dust  Status",
    "",
    "  Session",
    row("Workspace", `${data.workspaceName} (${data.region})`),
  ];

  if (data.agentName) lines.push(row("Agent", data.agentName));
  lines.push(
    row("Duration (wall)", formatDuration(data.durationMs)),
    row("Messages", `${data.messagesSent} sent`),
    renderSessionCredits(data),
  );

  lines.push(...renderSeatCredits(data.usage, data.fairUse));
  lines.push(...renderSpendCap(data.usage));
  lines.push(...renderWorkspacePool(data.usage));

  const agents = rankBreakdown(data.analytics?.groups ?? []);
  const conversations = rankBreakdown(data.topConversations?.conversations ?? []);
  const labelWidth = Math.max(
    "Top conversations".length,
    ...agents.map((entry) => entry.label.length),
    ...conversations.map((entry) => entry.label.length),
  ) + 2;

  const agentBreakdown = renderBreakdown("Top agents", agents, labelWidth);
  const conversationBreakdown = renderBreakdown("Top conversations", conversations, labelWidth);

  if (agentBreakdown.length > 0 || conversationBreakdown.length > 0) {
    lines.push("", "  What's contributing to your credit usage?", "  Last 30 days · from your Dust workspace, all devices");
    lines.push(...agentBreakdown, ...conversationBreakdown);
  }

  if (!data.usage && !data.fairUse) {
    lines.push("", "  Credit figures are unavailable right now.");
  }

  return lines;
}
