import { proRatedCeiling } from "./dust-ceiling.js";
import type { CreditBreakdownEntry, CreditSeries, DustStatusData, FairUseCredits, MemberUsage } from "./dust-types.js";

const DAY_MS = 86_400_000;

const GAUGE_WIDTH = 50;
const LABEL_WIDTH = 22;
/** Dust's own sentinel for "no ceiling" on fair-use plans. */
const UNLIMITED = -1;

/** Eighth-width blocks, so a gauge can land between two full cells. */
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function formatCredits(value: number): string {
  // Thousands separators matter here: monthly ceilings run to four digits.
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function utcMonthDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Labels a bucket with the dates it actually covers, clamped to today.
 *
 * Dust buckets on calendar intervals but queries a trailing window, so the
 * current bucket always runs from its calendar start to *now*, not to the end
 * of the week or month. Labelling it "Jul" or "Jul 28 - Aug 3" would imply
 * complete periods that have not happened yet.
 */
export function formatBucketRange(startMs: number, granularity: string | null, now = new Date()): string {
  const start = new Date(startMs);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  if (granularity === "day") return utcMonthDay(start);

  const endMs = granularity === "month"
    ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
    : startMs + 6 * DAY_MS;
  const clampedEnd = new Date(Math.min(endMs, todayMs));

  if (startMs >= clampedEnd.getTime()) return utcMonthDay(start);
  if (start.getUTCMonth() === clampedEnd.getUTCMonth() && start.getUTCFullYear() === clampedEnd.getUTCFullYear()) {
    return `${utcMonthDay(start)} - ${clampedEnd.getUTCDate()}`;
  }
  return `${utcMonthDay(start)} - ${utcMonthDay(clampedEnd)}`;
}

/** The in-progress period: the last bucket of a calendar-aligned series. */
export function currentBucket(series: CreditSeries | null) {
  if (!series || series.buckets.length === 0) return null;
  return series.buckets[series.buckets.length - 1];
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

export function renderGauge(used: number, limit: number, width = GAUGE_WIDTH, suffix = "used"): string {
  const ratio = limit > 0 ? Math.max(0, used / limit) : 0;
  const fraction = Math.min(1, ratio);
  const cells = fraction * width;
  const full = Math.floor(cells);
  const remainder = Math.round((cells - full) * 8);
  // A remainder that rounds up to a whole cell is just another full block.
  const bar = remainder === 8
    ? "█".repeat(Math.min(width, full + 1))
    : "█".repeat(full) + PARTIAL_BLOCKS[remainder];

  // The bar clamps at full, but the number must not: a pace target can be
  // exceeded several times over, and "100%" would hide by how much.
  const percent = Math.round(ratio * 100);
  return `${bar.padEnd(width, " ")} ${String(percent).padStart(3, " ")}% ${suffix}`;
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

/**
 * The three headline gauges: this month against the ceiling, then this week and
 * today against their pro-rated shares of it.
 *
 * Only the month has a ceiling Dust actually enforces. The week and day targets
 * are the monthly budget spread evenly across the real length of the current
 * month, so they answer "am I pacing above or below budget?" — the label says
 * "pace vs" rather than a limit, because nothing stops you exceeding them.
 */
function renderPeriodGauges(data: DustStatusData, now: Date): string[] {
  const month = currentBucket(data.totals.month);
  const week = currentBucket(data.totals.week);
  const day = currentBucket(data.totals.day);

  if (!month && !week && !day) return [];

  const lines: string[] = [];
  const ceiling = data.monthlyCeiling;

  if (month) {
    const reset = data.usage?.nextCreditResetAt ? formatResetDate(data.usage.nextCreditResetAt) : null;
    const detail = `${formatCredits(month.credits)} / ${formatCredits(ceiling)} credits`;
    lines.push(
      "",
      `  Credits this month${data.ceilingIsFallback ? " (ceiling not reported by Dust)" : ""}`,
      `  ${renderGauge(month.credits, ceiling)}`,
      `  ${reset ? `${detail} · resets ${reset}` : detail}`,
    );
  }

  if (week) {
    const target = proRatedCeiling(ceiling, 7, now);
    lines.push(
      "",
      `  This week (pace vs ${formatCredits(target)})`,
      `  ${renderGauge(week.credits, target, GAUGE_WIDTH, "of pace")}`,
      `  ${formatCredits(week.credits)} credits · ${formatBucketRange(week.startMs, "week", now)}`,
    );
  }

  if (day) {
    const target = proRatedCeiling(ceiling, 1, now);
    lines.push(
      "",
      `  Today (pace vs ${formatCredits(target)})`,
      `  ${renderGauge(day.credits, target, GAUGE_WIDTH, "of pace")}`,
      `  ${formatCredits(day.credits)} credits · ${formatBucketRange(day.startMs, "day", now)}`,
    );
  }

  return lines;
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
export function renderStatusPanel(data: DustStatusData, now = new Date()): string[] {
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

  const periodGauges = renderPeriodGauges(data, now);
  lines.push(...periodGauges);

  // Once the month gauge is up, the seat section only earns its space when it
  // reports an allowance the month gauge is not already drawn against — or a
  // fair-use ceiling, which is a different number entirely. A seat allocation
  // equal to the ceiling, or none at all, would just restate the same credits.
  const seatAllowance = data.usage?.memberUsageLimit;
  const seatAddsNothing = periodGauges.length > 0
    && !data.fairUse
    && (typeof seatAllowance !== "number" || seatAllowance === data.monthlyCeiling);
  if (!seatAddsNothing) {
    lines.push(...renderSeatCredits(data.usage, data.fairUse));
  }

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

  if (!data.usage && !data.fairUse && periodGauges.length === 0) {
    lines.push("", "  Credit figures are unavailable right now.");
  }

  return lines;
}
