import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { StatusLoader } from "./dust-status-loader.js";
import { renderBreakdownTab, renderOverviewTab } from "./dust-status-tab-render.js";
import {
  DEFAULT_PERIOD,
  nextTabIndex,
  periodByKey,
  respectsPeriod,
  STATUS_PERIODS,
  STATUS_TABS,
  type StatusPeriod,
} from "./dust-status-tabs.js";

const SPINNER_INTERVAL_MS = 120;
/** Rows reserved for the tab bar, blank lines and the footer hint. */
const CHROME_HEIGHT = 6;

/**
 * The interactive `/status` panel.
 *
 * Keyboard model mirrors what pi users already know from other tabbed TUIs:
 * ←/→/tab switch tabs, ↑/↓ scroll the body, d/w/m change the window on tabs
 * where it applies, r forces a refresh, Esc closes.
 */
export class DustStatusPanel implements Component {
  private tabIndex = 0;
  private period: StatusPeriod = DEFAULT_PERIOD;
  private scroll = 0;
  private tick = 0;
  private spinner: ReturnType<typeof setInterval> | null = null;
  private lastBodyHeight = 20;

  constructor(
    private readonly theme: Theme,
    private readonly loader: StatusLoader,
    private readonly requestRender: () => void,
    private readonly done: (result: undefined) => void,
    private readonly onRefresh: () => void,
    private readonly height = 0,
  ) {
    this.loader.ensureLoaded(STATUS_TABS[this.tabIndex], this.period);
    this.startSpinner();
  }

  /**
   * Animates the spinner only while something is actually pending, so an idle
   * panel is not repainting ten times a second.
   */
  private startSpinner(): void {
    this.spinner = setInterval(() => {
      if (!this.isPending()) return;
      this.tick++;
      this.requestRender();
    }, SPINNER_INTERVAL_MS);
    // Never hold the process open for a spinner.
    this.spinner.unref?.();
  }

  private isPending(): boolean {
    if (this.loader.overview.status === "loading" || this.loader.overviewRefreshing) return true;
    const slice = this.loader.breakdown(STATUS_TABS[this.tabIndex], this.period);
    return slice?.status === "loading";
  }

  dispose(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
    }
  }

  invalidate(): void { /* nothing cached between renders */ }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.dispose();
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.selectTab(nextTabIndex(this.tabIndex, 1));
    } else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      this.selectTab(nextTabIndex(this.tabIndex, -1));
    } else if (matchesKey(data, "down")) {
      this.scroll++;
    } else if (matchesKey(data, "up")) {
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (matchesKey(data, "pageDown")) {
      this.scroll += Math.max(1, this.lastBodyHeight - 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - Math.max(1, this.lastBodyHeight - 1));
    } else if (matchesKey(data, "home")) {
      this.scroll = 0;
    } else if (matchesKey(data, "r")) {
      this.onRefresh();
    } else {
      const period = periodByKey(data.toLowerCase());
      // The window only means something where a breakdown is grouped; on
      // Overview and Conversations the key is a no-op rather than a lie.
      if (period && respectsPeriod(STATUS_TABS[this.tabIndex])) {
        this.period = period;
        this.scroll = 0;
        this.loader.ensureLoaded(STATUS_TABS[this.tabIndex], this.period);
      } else {
        return;
      }
    }

    this.requestRender();
  }

  private selectTab(index: number): void {
    this.tabIndex = index;
    this.scroll = 0;
    this.loader.ensureLoaded(STATUS_TABS[index], this.period);
  }

  private renderTabBar(): string {
    const th = this.theme;
    return `  ${STATUS_TABS.map((tab, index) => (
      index === this.tabIndex ? th.bold(th.fg("accent", tab.label)) : th.fg("dim", tab.label)
    )).join("   ")}`;
  }

  private renderFooter(): string {
    const th = this.theme;
    const hints = ["←/→/tab to switch", "↑/↓ to scroll"];
    if (respectsPeriod(STATUS_TABS[this.tabIndex])) {
      hints.push(STATUS_PERIODS.map((period) => `${period.key} ${period.id}`).join(" · "));
    }
    hints.push("r to refresh", "Esc to close");
    return `  ${th.fg("dim", hints.join(" · "))}`;
  }

  private renderBody(): string[] {
    const tab = STATUS_TABS[this.tabIndex];
    if (tab.id === "overview") {
      return renderOverviewTab(this.loader.overview, this.loader.overviewRefreshing, this.tick);
    }

    const slice = this.loader.breakdown(tab, this.period);
    return slice ? renderBreakdownTab(tab, this.period, slice, this.tick) : [];
  }

  render(width: number): string[] {
    const th = this.theme;
    const body = this.renderBody();

    // Height 0 means "no viewport cap given" — show everything rather than
    // guessing, and let the host scroll.
    const bodyHeight = this.height > 0 ? Math.max(1, this.height - CHROME_HEIGHT) : body.length;
    this.lastBodyHeight = bodyHeight;

    const maxScroll = Math.max(0, body.length - bodyHeight);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visible = body.slice(this.scroll, this.scroll + bodyHeight);

    const lines = [
      this.renderTabBar(),
      th.fg("borderMuted", "  " + "─".repeat(Math.max(0, Math.min(width, 100) - 4))),
      ...visible,
    ];

    if (maxScroll > 0) {
      lines.push("", `  ${th.fg("dim", `${this.scroll + 1}-${this.scroll + visible.length} of ${body.length}`)}`);
    }
    lines.push("", this.renderFooter());

    // Trim any line that would wrap, so the panel never reflows mid-gauge.
    return lines.map((line) => (visibleWidth(line) > width ? truncate(line, width) : line));
  }
}

/**
 * Cuts a styled line to a visible width. Escape sequences carry no width, so
 * they are copied through and never counted.
 */
export function truncate(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;

  let out = "";
  let visible = 0;
  let index = 0;

  while (index < line.length && visible < width - 1) {
    if (line[index] === "\x1b") {
      const end = line.indexOf("m", index);
      if (end === -1) break;
      out += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    out += line[index];
    visible += visibleWidth(line[index]);
    index++;
  }

  return `${out}…`;
}
