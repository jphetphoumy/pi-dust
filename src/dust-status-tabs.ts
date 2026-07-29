import type { CreditGroupBy } from "./dust-types.js";

/**
 * Tabs of the `/status` panel.
 *
 * Overview and Conversations have bespoke sources; the rest are the same
 * breakdown endpoint grouped along a different dimension. Dust's analytics
 * dimensions are `usage_type | agent | user | origin | api_key` — there is no
 * "by model", because credits (AWU) are metered per message, not per model, and
 * no `user` tab either, since `my-usage-analytics` is already scoped to you.
 */
export interface StatusTab {
  id: string;
  label: string;
  /** Set on tabs served by the grouped breakdown endpoint. */
  groupBy?: CreditGroupBy;
  /** Column heading for the breakdown's label column. */
  heading?: string;
  /** Shown when the breakdown comes back empty. */
  empty?: string;
}

export const STATUS_TABS: StatusTab[] = [
  { id: "overview", label: "Overview" },
  { id: "agent", label: "Agents", groupBy: "agent", heading: "Agent", empty: "No agent usage in this period." },
  { id: "usage_type", label: "Type", groupBy: "usage_type", heading: "Usage type", empty: "No usage in this period." },
  { id: "origin", label: "Source", groupBy: "origin", heading: "Source", empty: "No usage in this period." },
  { id: "api_key", label: "API key", groupBy: "api_key", heading: "API key", empty: "No API-key usage in this period." },
  { id: "conversations", label: "Conversations", heading: "Conversation", empty: "No conversations in this period." },
];

/** Windows the `d` / `w` / `m` keys cycle between, mirroring Claude Code's toggle. */
export interface StatusPeriod {
  id: string;
  days: number;
  label: string;
  key: string;
}

export const STATUS_PERIODS: StatusPeriod[] = [
  { id: "day", days: 1, label: "Last 24h", key: "d" },
  { id: "week", days: 7, label: "Last 7 days", key: "w" },
  { id: "month", days: 30, label: "Last 30 days", key: "m" },
];

export const DEFAULT_PERIOD = STATUS_PERIODS[2];

export function periodByKey(key: string): StatusPeriod | undefined {
  return STATUS_PERIODS.find((period) => period.key === key);
}

/**
 * Cache key for a tab's data. Only the grouped breakdowns vary with the window;
 * `my-top-conversations` takes no range parameter and is always 30 days, so
 * keying it by period would refetch identical data on every toggle.
 */
export function tabCacheKey(tab: StatusTab, period: StatusPeriod): string {
  return tab.groupBy ? `${tab.id}:${period.days}` : tab.id;
}

/** Whether the `d`/`w`/`m` toggle changes anything on this tab. */
export function respectsPeriod(tab: StatusTab): boolean {
  return Boolean(tab.groupBy);
}

export function nextTabIndex(current: number, delta: number, count = STATUS_TABS.length): number {
  return (current + delta + count) % count;
}
