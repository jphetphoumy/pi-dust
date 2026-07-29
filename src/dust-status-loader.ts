import { fetchTopConversations, fetchUsageBreakdown } from "./dust-credits.js";
import { debugLog } from "./dust-debug.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { type StatusPeriod, type StatusTab, tabCacheKey } from "./dust-status-tabs.js";
import type { CreditBreakdownEntry, DustStatusData } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

export type SliceState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export interface BreakdownSlice {
  entries: CreditBreakdownEntry[];
}

/**
 * Backs the interactive panel.
 *
 * The panel must appear instantly, so nothing here blocks: the overview starts
 * as whatever was cached (possibly nothing) and each tab's data is fetched the
 * first time that tab is opened. Every state change calls `onChange`, which the
 * component turns into a re-render.
 */
export class StatusLoader {
  overview: SliceState<DustStatusData>;
  /** Set while a fresh overview is in flight over a previously-loaded one. */
  overviewRefreshing = false;
  private readonly breakdowns = new Map<string, SliceState<BreakdownSlice>>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly runtime: DustSessionRuntime,
    private readonly baseUrl: string,
    private readonly onChange: () => void,
    private readonly signal?: AbortSignal,
    cachedOverview?: DustStatusData | null,
  ) {
    this.overview = cachedOverview
      ? { status: "ready", value: cachedOverview }
      : { status: "loading" };
  }

  /**
   * Adopts a freshly-collected overview. Called once the (slow) live read
   * resolves, which is why the panel can open before it does.
   */
  setOverview(next: DustStatusData | Error): void {
    this.overviewRefreshing = false;
    this.overview = next instanceof Error
      ? (this.overview.status === "ready" ? this.overview : { status: "error", message: next.message })
      : { status: "ready", value: next };
    this.onChange();
  }

  markOverviewRefreshing(): void {
    this.overviewRefreshing = true;
    this.onChange();
  }

  breakdown(tab: StatusTab, period: StatusPeriod): SliceState<BreakdownSlice> | null {
    if (!tab.groupBy && tab.id !== "conversations") return null;
    return this.breakdowns.get(tabCacheKey(tab, period)) ?? { status: "loading" };
  }

  /**
   * Starts a tab's fetch if it has neither run nor is running. Safe to call on
   * every render and every tab switch; the in-flight set makes it idempotent.
   */
  ensureLoaded(tab: StatusTab, period: StatusPeriod): void {
    if (!tab.groupBy && tab.id !== "conversations") return;

    const key = tabCacheKey(tab, period);
    if (this.breakdowns.has(key) || this.inFlight.has(key)) return;

    this.inFlight.add(key);
    void this.load(tab, period)
      .then((state) => {
        this.breakdowns.set(key, state);
      })
      .catch((err) => {
        this.breakdowns.set(key, { status: "error", message: errorMessage(err) });
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.onChange();
      });
  }

  private async load(tab: StatusTab, period: StatusPeriod): Promise<SliceState<BreakdownSlice>> {
    debugLog("dust:status", "Loading breakdown", { tab: tab.id, days: period.days });

    if (tab.id === "conversations") {
      const result = await fetchTopConversations(this.runtime, this.baseUrl, this.signal);
      return result === null
        ? { status: "error", message: "Could not load conversations." }
        : { status: "ready", value: { entries: result.conversations } };
    }

    const result = await fetchUsageBreakdown(this.runtime, this.baseUrl, tab.groupBy!, period.days, this.signal);
    return result === null
      ? { status: "error", message: "Could not load this breakdown." }
      : { status: "ready", value: { entries: result.groups } };
  }
}
