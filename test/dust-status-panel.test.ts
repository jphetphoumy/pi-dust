import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { StatusLoader } from "../src/dust-status-loader.js";
import { DustStatusPanel, panelHeight, truncate } from "../src/dust-status-panel.js";
import { renderBreakdownRows, renderBreakdownTab, renderOverviewTab, spinnerFrame } from "../src/dust-status-tab-render.js";
import {
  DEFAULT_PERIOD,
  nextTabIndex,
  periodByKey,
  respectsPeriod,
  STATUS_PERIODS,
  STATUS_TABS,
  tabCacheKey,
} from "../src/dust-status-tabs.js";
import type { DustStatusData } from "../src/dust-types.js";
import { makeSessionContext, useTempAgentDir } from "./helpers/dust-fixtures.js";

/** Theme is only ever used for styling, so identity functions keep assertions plain. */
const THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as never;

// The loader's fetches go through `runtime.currentAccessToken()`, which falls
// through to `sessionContext.getAccessToken()`, so the runtime needs a session
// context that actually yields a token; the factory's plain "tok" default is
// all any test here needs.
const SESSION_CONTEXT = makeSessionContext();

// Rebuilt fresh in `beforeEach` below so mutable runtime state (a held
// refreshed token, an in-flight refresh) never leaks from one test into the
// next.
let RUNTIME: DustSessionRuntime;

const OVERVIEW: DustStatusData = {
  workspaceName: "Acme", region: "us-central1", agentName: "@dust",
  durationMs: 60_000, messagesSent: 2, sessionCredits: 1.5, sessionBaselineAt: null,
  usage: null, fairUse: null,
  totals: { month: null, week: null, day: null },
  monthlyCeiling: 8000, ceilingIsFallback: true,
  analytics: null, topConversations: null,
};

// eslint-disable-next-line no-control-regex -- SGR sequences start with a real ESC byte.
const ANSI = /\x1b\[[0-9;]*m/g;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function breakdownBody(groups: [string, string, number][]) {
  return {
    granularity: "day",
    groups: groups.map(([groupKey, name]) => ({ groupKey, name })),
    points: [{ timestamp: Date.UTC(2026, 6, 1), values: Object.fromEntries(groups.map(([k, , c]) => [k, c])) }],
  };
}

describe("dust /status panel", () => {
  useTempAgentDir();

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    RUNTIME = new DustSessionRuntime();
    RUNTIME.sessionContext = SESSION_CONTEXT;
  });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  describe("tabs", () => {
    it("offers Overview plus one tab per Dust analytics dimension", () => {
      expect(STATUS_TABS.map((tab) => tab.id)).toEqual([
        "overview", "agent", "usage_type", "origin", "api_key", "conversations",
      ]);
    });

    it("cycles tab indices in both directions", () => {
      expect(nextTabIndex(0, 1)).toBe(1);
      expect(nextTabIndex(STATUS_TABS.length - 1, 1)).toBe(0);
      expect(nextTabIndex(0, -1)).toBe(STATUS_TABS.length - 1);
    });

    it("maps the d/w/m keys to windows", () => {
      expect(periodByKey("d")?.days).toBe(1);
      expect(periodByKey("w")?.days).toBe(7);
      expect(periodByKey("m")?.days).toBe(30);
      expect(periodByKey("x")).toBeUndefined();
      expect(DEFAULT_PERIOD.days).toBe(30);
    });

    it("only lets the window vary for grouped breakdowns", () => {
      const agent = STATUS_TABS.find((tab) => tab.id === "agent")!;
      const conversations = STATUS_TABS.find((tab) => tab.id === "conversations")!;

      expect(respectsPeriod(agent)).toBe(true);
      // my-top-conversations takes no range parameter, so keying it by period
      // would refetch identical data on every toggle.
      expect(respectsPeriod(conversations)).toBe(false);
      expect(tabCacheKey(agent, STATUS_PERIODS[0])).toBe("agent:1");
      expect(tabCacheKey(conversations, STATUS_PERIODS[0])).toBe("conversations");
      expect(tabCacheKey(conversations, STATUS_PERIODS[2])).toBe("conversations");
    });
  });

  describe("loader", () => {
    it("starts ready when handed a cached overview, and loading otherwise", () => {
      expect(new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW).overview)
        .toEqual({ status: "ready", value: OVERVIEW });
      expect(new StatusLoader(RUNTIME, "u", () => {}).overview).toEqual({ status: "loading" });
    });

    it("fetches a breakdown once per tab and window, then serves it from memory", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(breakdownBody([["a", "@dust", 18.4]]))));
      globalThis.fetch = fetchMock as never;

      const onChange = vi.fn();
      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", onChange);
      const tab = STATUS_TABS[1];

      loader.ensureLoaded(tab, DEFAULT_PERIOD);
      loader.ensureLoaded(tab, DEFAULT_PERIOD);
      await vi.waitFor(() => expect(loader.breakdown(tab, DEFAULT_PERIOD)?.status).toBe("ready"));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalled();
      loader.ensureLoaded(tab, DEFAULT_PERIOD);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refetches when the window changes", async () => {
      const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse(breakdownBody([["a", "@dust", 1]]))));
      globalThis.fetch = fetchMock as never;

      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", () => {});
      const tab = STATUS_TABS[1];

      loader.ensureLoaded(tab, STATUS_PERIODS[2]);
      await vi.waitFor(() => expect(loader.breakdown(tab, STATUS_PERIODS[2])?.status).toBe("ready"));
      loader.ensureLoaded(tab, STATUS_PERIODS[0]);
      await vi.waitFor(() => expect(loader.breakdown(tab, STATUS_PERIODS[0])?.status).toBe("ready"));

      const urls = fetchMock.mock.calls.map(([url]) => url as string);
      expect(urls.some((url) => url.includes("days=30&granularity=day&groupBy=agent"))).toBe(true);
      expect(urls.some((url) => url.includes("days=1&granularity=day&groupBy=agent"))).toBe(true);
    });

    it("records an error slice when a breakdown fails", async () => {
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({}, 500))) as never;
      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", () => {});

      loader.ensureLoaded(STATUS_TABS[1], DEFAULT_PERIOD);
      await vi.waitFor(() => expect(loader.breakdown(STATUS_TABS[1], DEFAULT_PERIOD)?.status).toBe("error"));
    });

    it("keeps a previously-loaded overview when a refresh fails", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW);
      loader.markOverviewRefreshing();
      loader.setOverview(new Error("boom"));

      expect(loader.overview).toEqual({ status: "ready", value: OVERVIEW });
      expect(loader.overviewRefreshing).toBe(false);
    });

    it("surfaces the error when there was nothing to fall back to", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {});
      loader.setOverview(new Error("boom"));
      expect(loader.overview).toEqual({ status: "error", message: "boom" });
    });

    it("does nothing for a tab that has no remote data", () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;
      const loader = new StatusLoader(RUNTIME, "u", () => {});

      loader.ensureLoaded(STATUS_TABS[0], DEFAULT_PERIOD);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(loader.breakdown(STATUS_TABS[0], DEFAULT_PERIOD)).toBeNull();
    });
  });

  describe("tab rendering", () => {
    it("ranks a breakdown, shows shares and totals", () => {
      const rows = renderBreakdownRows(
        [{ label: "@sql", credits: 25 }, { label: "@dust", credits: 75 }],
        "Agent",
      ).join("\n");

      expect(rows.indexOf("@dust")).toBeLessThan(rows.indexOf("@sql"));
      expect(rows).toContain("75%");
      expect(rows).toContain("25%");
      expect(rows).toContain("Total: 100.00 credits across 2 entries");
    });

    it("caps a long label so one row cannot set the column width", () => {
      const rows = renderBreakdownRows([{ label: "T".repeat(200), credits: 1 }], "Conversation");
      for (const line of rows) expect(line.length).toBeLessThan(90);
      expect(rows.join("\n")).toContain("…");
    });

    it("scales bars to the largest row, not to any ceiling", () => {
      const rows = renderBreakdownRows([{ label: "big", credits: 100 }, { label: "small", credits: 10 }], "N");
      const bars = rows.filter((line) => line.includes("█")).map((line) => (line.match(/█+/)?.[0] ?? "").length);
      expect(bars[0]).toBeGreaterThan(bars[1]);
    });

    it("shows a spinner while a tab loads and the message when it fails", () => {
      const tab = STATUS_TABS[1];
      expect(renderBreakdownTab(tab, DEFAULT_PERIOD, { status: "loading" }, 0).join("\n"))
        .toContain(`${spinnerFrame(0)} Loading…`);
      expect(renderBreakdownTab(tab, DEFAULT_PERIOD, { status: "error", message: "nope" }, 0).join("\n"))
        .toContain("nope");
    });

    it("uses the tab's own empty message", () => {
      const tab = STATUS_TABS[4];
      expect(renderBreakdownTab(tab, DEFAULT_PERIOD, { status: "ready", value: { entries: [] } }, 0).join("\n"))
        .toContain("No API-key usage");
    });

    it("labels the breakdown with the selected window", () => {
      const tab = STATUS_TABS[1];
      const slice = { status: "ready" as const, value: { entries: [{ label: "@dust", credits: 1 }] } };
      expect(renderBreakdownTab(tab, STATUS_PERIODS[0], slice, 0).join("\n")).toContain("Last 24h");
      expect(renderBreakdownTab(tab, STATUS_PERIODS[1], slice, 0).join("\n")).toContain("Last 7 days");
    });

    it("marks the overview as refreshing without hiding the figures", () => {
      const body = renderOverviewTab({ status: "ready", value: OVERVIEW }, true, 0).join("\n");
      expect(body).toContain("Acme");
      expect(body).toContain("refreshing…");
    });

    it("drops the static panel's own title, since the tab bar names it", () => {
      const body = renderOverviewTab({ status: "ready", value: OVERVIEW }, false, 0);
      expect(body.join("\n")).not.toContain("Dust  Status");
    });
  });

  describe("component", () => {
    const makePanel = (loader: StatusLoader, onRefresh = vi.fn()) => {
      const requestRender = vi.fn();
      const done = vi.fn();
      const panel = new DustStatusPanel(THEME, loader, requestRender, done, onRefresh, 28);
      return { panel, requestRender, done };
    };

    it("renders the tab bar and a footer hint", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW);
      const { panel } = makePanel(loader);
      const out = panel.render(100).join("\n");

      expect(out).toContain("Overview");
      expect(out).toContain("Agents");
      expect(out).toContain("API key");
      expect(out).toContain("←/→/tab to switch");
      expect(out).toContain("Esc to close");
      panel.dispose();
    });

    it("switches tabs with arrows and tab, and loads the newly shown tab", () => {
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(breakdownBody([["a", "@dust", 1]])))) as never;
      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", () => {}, undefined, OVERVIEW);
      const ensure = vi.spyOn(loader, "ensureLoaded");
      const { panel, requestRender } = makePanel(loader);

      panel.handleInput("\x1b[C"); // right
      expect(ensure).toHaveBeenCalledWith(STATUS_TABS[1], DEFAULT_PERIOD);
      expect(requestRender).toHaveBeenCalled();
      expect(panel.render(100)[0]).toContain("Agents");

      panel.handleInput("\x1b[D"); // left
      expect(panel.render(100).join("\n")).toContain("Overview");
      panel.dispose();
    });

    it("offers the window hint only where the window applies", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW);
      const { panel } = makePanel(loader);

      expect(panel.render(120).join("\n")).not.toContain("d day");
      panel.handleInput("\x1b[C");
      expect(panel.render(120).join("\n")).toContain("d day");
      panel.dispose();
    });

    it("ignores the window keys on tabs that do not use them", () => {
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(breakdownBody([["a", "@dust", 1]])))) as never;
      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", () => {}, undefined, OVERVIEW);
      const { panel, requestRender } = makePanel(loader);

      panel.handleInput("d");
      expect(requestRender).not.toHaveBeenCalled();
      panel.dispose();
    });

    it("changes the window on a breakdown tab", () => {
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(breakdownBody([["a", "@dust", 1]])))) as never;
      const loader = new StatusLoader(RUNTIME, "https://x/api/w/w1", () => {}, undefined, OVERVIEW);
      const ensure = vi.spyOn(loader, "ensureLoaded");
      const { panel } = makePanel(loader);

      panel.handleInput("\x1b[C");
      panel.handleInput("d");
      expect(ensure).toHaveBeenLastCalledWith(STATUS_TABS[1], STATUS_PERIODS[0]);
      panel.dispose();
    });

    it("closes on escape and stops its spinner", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW);
      const { panel, done } = makePanel(loader);

      panel.handleInput("\x1b");
      expect(done).toHaveBeenCalledWith(undefined);
      // A live interval would keep the panel repainting after it closed.
      expect((panel as unknown as { spinner: unknown }).spinner).toBeNull();
    });

    it("asks for a refresh on r", () => {
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, OVERVIEW);
      const onRefresh = vi.fn();
      const { panel } = makePanel(loader, onRefresh);

      panel.handleInput("r");
      expect(onRefresh).toHaveBeenCalledTimes(1);
      panel.dispose();
    });

    it("pages a long body and reports the visible range", () => {
      const long = { ...OVERVIEW, analytics: { granularity: "day", groups: Array.from({ length: 40 }, (_, i) => ({ label: `agent-${i}`, credits: 40 - i })) } };
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, long);
      const { panel } = makePanel(loader);

      const first = panel.render(100).join("\n");
      expect(first).toMatch(/1-\d+ of \d+/);

      panel.handleInput("\x1b[B"); // down
      expect(panel.render(100).join("\n")).toMatch(/2-\d+ of \d+/);
      panel.handleInput("\x1b[A"); // up
      expect(panel.render(100).join("\n")).toMatch(/1-\d+ of \d+/);
      panel.dispose();
    });

    it("never emits a line wider than the viewport", () => {
      const wide = { ...OVERVIEW, workspaceName: "W".repeat(200) };
      const loader = new StatusLoader(RUNTIME, "u", () => {}, undefined, wide);
      const { panel } = makePanel(loader);

      for (const line of panel.render(40)) {
        expect(line.replace(ANSI, "").length).toBeLessThanOrEqual(40);
      }
      panel.dispose();
    });
  });

  describe("sizing", () => {
    it("leaves room for the transcript above the panel", () => {
      // The panel renders in the editor's slot, so its height pushes the
      // transcript up — it must never claim the whole screen.
      expect(panelHeight(50)).toBeLessThan(50);
      expect(panelHeight(50)).toBe(26);
      expect(panelHeight(30)).toBe(22);
    });

    it("stays usable in a short terminal and when the size is unknown", () => {
      expect(panelHeight(12)).toBe(10);
      expect(panelHeight(0)).toBe(26);
      expect(panelHeight(-5)).toBe(26);
    });
  });

  describe("truncate", () => {
    it("leaves a short line alone", () => {
      expect(truncate("abc", 10)).toBe("abc");
    });

    it("cuts to the requested visible width", () => {
      expect(truncate("abcdefghij", 5)).toBe("abcd…");
    });

    it("keeps escape sequences without counting them as width", () => {
      const styled = "\x1b[31mabcdefghij\x1b[0m";
      const out = truncate(styled, 5);
      expect(out).toContain("\x1b[31m");
      expect(out.replace(ANSI, "")).toBe("abcd…");
    });
  });
});
