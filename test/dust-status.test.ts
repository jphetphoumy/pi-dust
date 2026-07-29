import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { registerDustSessionEvents } from "../src/dust-session-events.js";
import { collectStatusData } from "../src/dust-status.js";
import {
  currentBucket,
  formatBucketRange,
  formatCredits,
  formatDuration,
  renderGauge,
  renderStatusPanel,
} from "../src/dust-status-render.js";
import {
  DEFAULT_MONTHLY_CREDITS,
  MONTHLY_CREDITS_ENV,
  daysInMonth,
  proRatedCeiling,
  resolveMonthlyCeiling,
} from "../src/dust-ceiling.js";
import {
  parseCreditSeriesResponse,
  parseFairUseCreditsResponse,
  parseMyTopConversationsResponse,
  parseMyUsageAnalyticsResponse,
  parseMyUsageResponse,
} from "../src/dust-validation.js";
import type { DustStatusData } from "../src/dust-types.js";
import { makeCredentials, seedAuth, seedLoggedIn, seedState, useTempAgentDir } from "./helpers/dust-fixtures.js";

const FULL_MEMBER = {
  consumedAwuCredits: 4.61,
  consumedFromAllowanceAwuCredits: 4.61,
  consumedFromPoolAwuCredits: 0,
  memberUsageLimit: 20,
  seatBalanceAwu: 15.39,
  spendLimitAwuCredits: 100,
  spendLimitSource: "default",
  nextCreditResetAt: "2026-08-01T00:00:00.000Z",
  billingFrequency: "monthly",
  seatType: "paid",
  creditState: "ok",
  nearLimit: false,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** A `groupBy`-less total series, the shape Dust returns for the period gauges. */
function totalSeries(points: [number, number][]) {
  return {
    granularity: "day",
    groups: [{ groupKey: "total", name: "Total usage" }],
    points: points.map(([timestamp, credits]) => ({ timestamp, values: { total: credits } })),
  };
}

const JUL_2026 = Date.UTC(2026, 6, 1);

/** Routes each credit endpoint by URL, so call order never matters. */
function creditsFetchMock(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    // Dust keeps the numbers in the time series; a group row carries no credits.
    "analytics:agent": {
      granularity: "day",
      groups: [{ groupKey: "agent-1", name: "@dust" }],
      points: [{ timestamp: JUL_2026, values: { "agent-1": 18.4 } }],
    },
    "analytics:month": totalSeries([[Date.UTC(2026, 5, 1), 900], [JUL_2026, 1924.6]]),
    "analytics:week": totalSeries([[Date.UTC(2026, 6, 20), 498.3], [Date.UTC(2026, 6, 27), 279.4]]),
    "analytics:day": totalSeries([[Date.UTC(2026, 6, 28), 181.3], [Date.UTC(2026, 6, 29), 98.1]]),
    "credits/my-usage": { member: FULL_MEMBER },
    "credits/my-top-conversations": { conversations: [{ title: "Refactor MCP bridge", credits: 4.11 }] },
    "fair-use-credits": { fairUseAwuCreditsState: { limit: -1, timeframe: "month", count: 0 } },
    ...overrides,
  };

  return vi.fn((url: string) => {
    if (url.includes("my-usage-analytics")) {
      const key = url.includes("groupBy=agent")
        ? "analytics:agent"
        : `analytics:${new URL(url).searchParams.get("granularity")}`;
      return Promise.resolve(key in bodies ? jsonResponse(bodies[key]) : jsonResponse({}, 404));
    }
    const key = Object.keys(bodies).find((candidate) => url.includes(candidate));
    return Promise.resolve(key ? jsonResponse(bodies[key]) : jsonResponse({}, 404));
  });
}

const isBreakdownCall = ([url]: unknown[]) => (url as string).includes("groupBy=agent");
const isTotalsCall = ([url]: unknown[]) =>
  (url as string).includes("my-usage-analytics") && !(url as string).includes("groupBy=agent");

function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    modelRegistry: {},
    ui: { notify: vi.fn(), select: vi.fn() },
    model: { id: "agent-1", sId: "agent-1", name: "Helper", provider: "dust" },
    ...extra,
  };
}

describe("dust /status", () => {
  useTempAgentDir();

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("command registration", () => {
    it("registers a 'status' command and an entry renderer for its panel", () => {
      const registerEntryRenderer = vi.fn();
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
          commands.set(name, config.handler)),
        registerEntryRenderer,
      } as never);

      expect(commands.has("status")).toBe(true);
      expect(registerEntryRenderer).toHaveBeenCalledWith("dust-status", expect.any(Function));
    });

    it("warns and issues no network call when not logged in", async () => {
      seedAuth(null);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;

      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry: vi.fn(),
      } as never);

      const ctx = makeCtx();
      await statusFn("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("warns and issues no network call when no workspace is selected", async () => {
      seedAuth({ type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 });
      seedState({});
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;

      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry: vi.fn(),
      } as never);

      await statusFn("", makeCtx());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("appends the rendered panel as a transcript entry", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;
      const appendEntry = vi.fn();

      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry,
      } as never);

      await statusFn("", makeCtx());

      expect(appendEntry).toHaveBeenCalledWith("dust-status", { lines: expect.any(Array) });
      const [, payload] = appendEntry.mock.calls[0] as [string, { lines: string[] }];
      expect(payload.lines.join("\n")).toContain("Acme Corp");
    });

    it("falls back to notify when the host cannot append entries", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;

      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry: vi.fn(() => { throw new Error("no transcript"); }),
      } as never);

      const ctx = makeCtx();
      await statusFn("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Acme Corp"), "info");
    });

    it("warns instead of throwing when collection fails outright", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as never;

      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry: vi.fn(),
      } as never);

      const ctx = makeCtx();
      await expect(statusFn("", ctx)).resolves.toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/credit usage/i), "warning");
    });
  });

  describe("collectStatusData", () => {
    it("targets the private credit API on the credential's region", async () => {
      seedLoggedIn(makeCredentials({ region: "europe-west1" }));
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(new DustSessionRuntime(), makeCtx());

      const urls = fetchMock.mock.calls.map(([url]) => url as string);
      expect(urls).toContain("https://eu.dust.tt/api/w/ws-1/credits/my-usage");
      expect(urls).toContain("https://eu.dust.tt/api/w/ws-1/fair-use-credits");
      expect(urls.some((url) => url.includes("my-usage-analytics?days=30"))).toBe(true);
      expect(urls).toContain("https://eu.dust.tt/api/w/ws-1/credits/my-top-conversations");
    });

    it("reports workspace, agent and session counters", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;
      const runtime = new DustSessionRuntime();
      runtime.credits.recordMessageSent();
      runtime.credits.recordMessageSent();

      const data = await collectStatusData(runtime, makeCtx()) as DustStatusData;

      expect(data.workspaceName).toBe("Acme Corp");
      expect(data.region).toBe("us-central1");
      expect(data.agentName).toBe("@Helper");
      expect(data.messagesSent).toBe(2);
      expect(data.usage?.consumedAwuCredits).toBe(4.61);
    });

    it("reports the session credit delta against the first reading", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();

      globalThis.fetch = creditsFetchMock() as never;
      const first = await collectStatusData(runtime, makeCtx()) as DustStatusData;
      expect(first.sessionCredits).toBe(0);

      runtime.credits.recordTurnCompleted();
      globalThis.fetch = creditsFetchMock({
        "credits/my-usage": { member: { ...FULL_MEMBER, consumedAwuCredits: 8.03 } },
      }) as never;
      const second = await collectStatusData(runtime, makeCtx()) as DustStatusData;

      expect(second.sessionCredits).toBeCloseTo(3.42, 2);
    });

    it("re-reads live figures after a turn instead of serving them from cache", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(runtime, makeCtx());
      const afterFirst = fetchMock.mock.calls.filter(([url]) => (url as string).endsWith("credits/my-usage")).length;

      runtime.credits.recordTurnCompleted();
      await collectStatusData(runtime, makeCtx());
      const afterSecond = fetchMock.mock.calls.filter(([url]) => (url as string).endsWith("credits/my-usage")).length;

      expect(afterFirst).toBe(1);
      expect(afterSecond).toBe(2);
    });

    it("serves live figures from memory only while the session has not advanced", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(runtime, makeCtx());
      const data = await collectStatusData(runtime, makeCtx()) as DustStatusData;

      const usageCalls = fetchMock.mock.calls.filter(([url]) => (url as string).endsWith("credits/my-usage")).length;
      expect(usageCalls).toBe(1);
      expect(data.usage?.consumedAwuCredits).toBe(4.61);
    });

    it("caches the 30-day breakdowns for the session", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(runtime, makeCtx());
      runtime.credits.recordTurnCompleted();
      await collectStatusData(runtime, makeCtx());

      const analyticsCalls = fetchMock.mock.calls.filter(isBreakdownCall).length;
      const conversationCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("my-top-conversations")).length;
      expect(analyticsCalls).toBe(1);
      expect(conversationCalls).toBe(1);
    });

    it("drops every cache when the credit tracker is reset", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(runtime, makeCtx());
      runtime.credits.reset();
      await collectStatusData(runtime, makeCtx());

      const analyticsCalls = fetchMock.mock.calls.filter(isBreakdownCall).length;
      expect(analyticsCalls).toBe(2);
      expect(runtime.credits.baselineAt).not.toBeNull();
    });

    it("refreshes the access token and retries once on 401", async () => {
      seedLoggedIn(makeCredentials());
      const fetchMock = vi.fn((url: string, _init?: { headers: Record<string, string> }) => {
        if (url.endsWith("credits/my-usage") && fetchMock.mock.calls.filter(([u]) => (u as string).endsWith("credits/my-usage")).length === 1) {
          return Promise.resolve(jsonResponse({}, 401));
        }
        if (url.endsWith("credits/my-usage")) return Promise.resolve(jsonResponse({ member: FULL_MEMBER }));
        return Promise.resolve(jsonResponse({}, 404));
      });
      globalThis.fetch = fetchMock as never;

      const runtime = new DustSessionRuntime();
      const ctx = makeCtx({
        modelRegistry: { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "fresh-token" } }) },
      });

      const data = await collectStatusData(runtime, ctx) as DustStatusData;

      expect(data.usage?.consumedAwuCredits).toBe(4.61);
      const authHeaders = fetchMock.mock.calls
        .filter(([url]) => (url as string).endsWith("credits/my-usage"))
        .map(([, init]) => init?.headers.Authorization);
      expect(authHeaders).toEqual(["Bearer tok", "Bearer fresh-token"]);
    });

    it("degrades to an empty panel when every endpoint fails", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({}, 500))) as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;

      expect(data.usage).toBeNull();
      expect(data.fairUse).toBeNull();
      expect(data.sessionCredits).toBeNull();
      expect(renderStatusPanel(data).join("\n")).toContain("unavailable");
    });

    it("does not label a non-Dust model as the session agent", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;

      const data = await collectStatusData(
        new DustSessionRuntime(),
        makeCtx({ model: { id: "gpt", name: "GPT", provider: "openai" } }),
      ) as DustStatusData;

      expect(data.agentName).toBeNull();
    });
  });

  describe("credit fetching", () => {
    it("falls back to a direct token refresh when the host cannot resolve auth", async () => {
      seedLoggedIn(makeCredentials());
      let usageCalls = 0;
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("workos")) {
          return Promise.resolve(jsonResponse({ access_token: "direct-token", refresh_token: "r2", expires_in: 3600 }));
        }
        if (url.endsWith("credits/my-usage")) {
          usageCalls++;
          return Promise.resolve(usageCalls === 1 ? jsonResponse({}, 401) : jsonResponse({ member: FULL_MEMBER }));
        }
        return Promise.resolve(jsonResponse({}, 404));
      });
      globalThis.fetch = fetchMock as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;

      expect(data.usage?.consumedAwuCredits).toBe(4.61);
      expect(usageCalls).toBe(2);
    });

    it("gives up quietly when the refresh itself is rejected", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = vi.fn((url: string) =>
        Promise.resolve(url.includes("workos") ? jsonResponse({}, 400) : jsonResponse({}, 401))) as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;
      expect(data.usage).toBeNull();
    });

    it("treats a non-JSON body as no data", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      })) as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;
      expect(data.usage).toBeNull();
      expect(data.analytics).toBeNull();
    });

    it("single-flights a 401 hit by several concurrent credit fetches into one refresh", async () => {
      // collectStatusData fires several credit endpoints concurrently (usage,
      // fair-use, and three analytics granularities via Promise.all). Without
      // a shared single-flight, each of their 401s would trigger its own
      // refresh attempt against the same rotating refresh token.
      seedLoggedIn(makeCredentials());
      const fetchMock = vi.fn((_url: string, init?: { headers: Record<string, string> }) =>
        Promise.resolve(
          init?.headers.Authorization === "Bearer fresh-token"
            ? jsonResponse({ member: FULL_MEMBER })
            : jsonResponse({}, 401),
        ));
      globalThis.fetch = fetchMock as never;

      const getProviderAuth = vi.fn().mockResolvedValue({ auth: { apiKey: "fresh-token" } });
      const runtime = new DustSessionRuntime();
      await collectStatusData(runtime, makeCtx({ modelRegistry: { getProviderAuth } }));

      expect(getProviderAuth).toHaveBeenCalledTimes(1);
      expect(runtime.currentAccessToken()).toBe("fresh-token");
    });

    it("makes no request at all when the stored access token is blank", async () => {
      seedAuth({ type: "oauth", access: "", refresh: "ref", expires: Date.now() + 3600_000 });
      seedState({ workspaceId: "ws-1", region: "us-central1" });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;

      const result = await collectStatusData(new DustSessionRuntime(), makeCtx());

      expect(result).toEqual({ error: expect.stringMatching(/log.?in/i) });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("interactive panel", () => {
    const THEME_STUB = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };

    interface PanelHandle {
      component?: { render: (width: number) => string[]; dispose?: () => void };
      close?: () => void;
    }

    type CustomFactory = (
      tui: { requestRender: () => void },
      theme: unknown,
      keys: unknown,
      done: (result: undefined) => void,
    ) => PanelHandle["component"];

    /**
     * Stands in for pi's `ui.custom`: builds the component synchronously and
     * keeps the `done` callback so a test can close the panel.
     */
    function customUiStub() {
      const built: PanelHandle = {};
      const custom = vi.fn((factory: never) => new Promise<undefined>((resolve) => {
        built.component = (factory as unknown as CustomFactory)(
          { requestRender: () => {} },
          THEME_STUB,
          {},
          resolve,
        );
        built.close = () => resolve(undefined);
      }));
      return { custom, built };
    }

    function registerStatus(appendEntry = vi.fn()) {
      let statusFn!: (args: string, ctx: unknown) => Promise<void>;
      dustExtension({
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          if (name === "status") statusFn = config.handler;
        }),
        appendEntry,
      } as never);
      return { statusFn, appendEntry };
    }

    it("opens the interactive panel instead of appending a static one", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;
      const { statusFn, appendEntry } = registerStatus();
      const { custom, built } = customUiStub();

      const running = statusFn("", makeCtx({ ui: { notify: vi.fn(), custom } }));
      await vi.waitFor(() => expect(built.component).toBeDefined());

      expect(custom).toHaveBeenCalledTimes(1);
      expect(built.component!.render(120).join("\n")).toContain("Overview");

      built.close!();
      await running;
      expect(appendEntry).not.toHaveBeenCalled();
      built.component!.dispose?.();
    });

    it("paints before the network settles, then fills in", async () => {
      seedLoggedIn(makeCredentials());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const bodies = creditsFetchMock();
      globalThis.fetch = vi.fn(async (url: string) => {
        await gate;
        return bodies(url);
      }) as never;

      const { statusFn } = registerStatus();
      const { custom, built } = customUiStub();
      const running = statusFn("", makeCtx({ ui: { notify: vi.fn(), custom } }));

      // The panel exists and renders while every request is still blocked.
      await vi.waitFor(() => expect(built.component).toBeDefined());
      expect(built.component!.render(120).join("\n")).toContain("Reading your Dust credit usage…");

      release();
      await vi.waitFor(() => expect(built.component!.render(120).join("\n")).toContain("Acme Corp"));

      built.close!();
      await running;
      built.component!.dispose?.();
    });

    it("falls back to the static panel when the host has no custom UI", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;
      const { statusFn, appendEntry } = registerStatus();

      await statusFn("", makeCtx({ ui: { notify: vi.fn() } }));
      expect(appendEntry).toHaveBeenCalledWith("dust-status", { lines: expect.any(Array) });
    });

    it("refuses before opening anything when not logged in", async () => {
      seedAuth(null);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as never;
      const { statusFn } = registerStatus();
      const { custom } = customUiStub();
      const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

      await statusFn("", ctx);

      expect(custom).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
    });

    it("reuses the cached overview when the session has not advanced", async () => {
      seedLoggedIn(makeCredentials());
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;
      const { statusFn } = registerStatus();

      const first = customUiStub();
      const running = statusFn("", makeCtx({ ui: { notify: vi.fn(), custom: first.custom } }));
      await vi.waitFor(() => expect(first.built.component!.render(120).join("\n")).toContain("Acme Corp"));
      first.built.close!();
      await running;
      first.built.component!.dispose?.();

      const callsAfterFirst = fetchMock.mock.calls.length;

      const second = customUiStub();
      const reopened = statusFn("", makeCtx({ ui: { notify: vi.fn(), custom: second.custom } }));
      await vi.waitFor(() => expect(second.built.component).toBeDefined());
      // Nothing happened in between, so the figures are still current and the
      // panel paints them without a single new request.
      expect(second.built.component!.render(120).join("\n")).toContain("Acme Corp");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

      second.built.close!();
      await reopened;
      second.built.component!.dispose?.();
    });

  });

  describe("session lifecycle", () => {
    /**
     * pi 0.65 folded `session_switch` into `session_start`, so every transition
     * — startup, /new, /resume, /fork — arrives on the one handler. The credit
     * tracker must be dropped there: its clock, message count and session
     * baseline all describe the session being left, and its cached breakdowns
     * may belong to another workspace entirely.
     */
    it("drops the credit tracker on every session_start", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({ agentConfigurations: [] }))) as never;

      const runtime = new DustSessionRuntime();
      let sessionStart!: (event: unknown, ctx: unknown) => Promise<void>;
      registerDustSessionEvents(
        { on: vi.fn((event: string, handler: never) => { if (event === "session_start") sessionStart = handler; }) } as never,
        runtime,
        () => {},
      );

      runtime.credits.recordMessageSent();
      runtime.credits.observeConsumedCredits(120);
      runtime.credits.analytics = { granularity: "day", groups: [{ label: "@dust", credits: 5 }] };

      await sessionStart({ reason: "resume" }, makeCtx());

      expect(runtime.credits.messagesSent).toBe(0);
      expect(runtime.credits.baselineCredits).toBeNull();
      expect(runtime.credits.analytics).toBeNull();
      expect(runtime.credits.lastOverview).toBeNull();
    });
  });

  describe("period totals", () => {
    it("requests month, week and day windows that fully cover the current period", async () => {
      seedLoggedIn(makeCredentials());
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(new DustSessionRuntime(), makeCtx());

      const totalsUrls = fetchMock.mock.calls.filter(isTotalsCall).map(([url]) => url as string);
      // 32 days always reaches the 1st of the month, 8 days the week's Monday,
      // so the last bucket of each series is a complete current period.
      expect(totalsUrls.some((url) => url.includes("days=32&granularity=month"))).toBe(true);
      expect(totalsUrls.some((url) => url.includes("days=8&granularity=week"))).toBe(true);
      expect(totalsUrls.some((url) => url.includes("days=7&granularity=day"))).toBe(true);
      // Totals must not be grouped, or Dust returns a breakdown instead.
      expect(totalsUrls.every((url) => !url.includes("groupBy"))).toBe(true);
    });

    it("takes the current period from the last bucket of each series", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock() as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;

      expect(currentBucket(data.totals.month)?.credits).toBe(1924.6);
      expect(currentBucket(data.totals.week)?.credits).toBe(279.4);
      expect(currentBucket(data.totals.day)?.credits).toBe(98.1);
    });

    it("refetches the period totals after a turn", async () => {
      seedLoggedIn(makeCredentials());
      const runtime = new DustSessionRuntime();
      const fetchMock = creditsFetchMock();
      globalThis.fetch = fetchMock as never;

      await collectStatusData(runtime, makeCtx());
      expect(fetchMock.mock.calls.filter(isTotalsCall).length).toBe(3);

      runtime.credits.recordTurnCompleted();
      await collectStatusData(runtime, makeCtx());
      expect(fetchMock.mock.calls.filter(isTotalsCall).length).toBe(6);
    });

    it("survives a period series that fails or comes back malformed", async () => {
      seedLoggedIn(makeCredentials());
      globalThis.fetch = creditsFetchMock({ "analytics:week": { granularity: "week" } }) as never;

      const data = await collectStatusData(new DustSessionRuntime(), makeCtx()) as DustStatusData;

      expect(data.totals.week).toBeNull();
      expect(currentBucket(data.totals.month)?.credits).toBe(1924.6);
    });

    it("parses a total series and orders buckets chronologically", () => {
      const parsed = parseCreditSeriesResponse({
        granularity: "month",
        groups: [{ groupKey: "total", name: "Total usage" }],
        points: [{ timestamp: 200, values: { total: 5 } }, { timestamp: 100, values: { total: 3 } }],
      });
      expect(parsed).toEqual({ granularity: "month", buckets: [{ startMs: 100, credits: 3 }, { startMs: 200, credits: 5 }] });
    });

    it("sums every series in a bucket when the response turns out to be grouped", () => {
      const parsed = parseCreditSeriesResponse({
        granularity: "day",
        groups: [{ groupKey: "user", name: "User" }, { groupKey: "programmatic", name: "Programmatic" }],
        points: [{ timestamp: 100, values: { user: 2, programmatic: 3 } }],
      });
      expect(parsed?.buckets).toEqual([{ startMs: 100, credits: 5 }]);
    });

    it("returns null when there are no usable points", () => {
      expect(parseCreditSeriesResponse({ granularity: "day", points: [] })).toBeNull();
      expect(parseCreditSeriesResponse({ granularity: "day" })).toBeNull();
      expect(parseCreditSeriesResponse({ points: [{ values: { total: 1 } }] })).toBeNull();
    });
  });

  describe("monthly ceiling", () => {
    const withEnv = async (value: string | undefined, fn: () => void) => {
      const previous = process.env[MONTHLY_CREDITS_ENV];
      if (value === undefined) delete process.env[MONTHLY_CREDITS_ENV];
      else process.env[MONTHLY_CREDITS_ENV] = value;
      try { fn(); } finally {
        if (previous === undefined) delete process.env[MONTHLY_CREDITS_ENV];
        else process.env[MONTHLY_CREDITS_ENV] = previous;
      }
    };

    it("prefers the seat allocation Dust reports", async () => {
      await withEnv(undefined, () => {
        expect(resolveMonthlyCeiling(FULL_MEMBER)).toEqual({ credits: 20, isFallback: false });
      });
    });

    it("falls back to the spend cap when there is no seat allocation", async () => {
      await withEnv(undefined, () => {
        expect(resolveMonthlyCeiling({ ...FULL_MEMBER, memberUsageLimit: null }))
          .toEqual({ credits: 100, isFallback: false });
      });
    });

    it("falls back to 8000 for a pool-based seat with no cap", async () => {
      await withEnv(undefined, () => {
        expect(resolveMonthlyCeiling({ ...FULL_MEMBER, memberUsageLimit: null, spendLimitAwuCredits: null }))
          .toEqual({ credits: DEFAULT_MONTHLY_CREDITS, isFallback: true });
        expect(resolveMonthlyCeiling(null)).toEqual({ credits: 8000, isFallback: true });
      });
    });

    it("lets configuration override everything Dust reports", async () => {
      await withEnv("12000", () => {
        expect(resolveMonthlyCeiling(FULL_MEMBER)).toEqual({ credits: 12000, isFallback: false });
      });
    });

    it("ignores a non-numeric or non-positive override", async () => {
      await withEnv("nonsense", () => {
        expect(resolveMonthlyCeiling(FULL_MEMBER).credits).toBe(20);
      });
      await withEnv("0", () => {
        expect(resolveMonthlyCeiling(FULL_MEMBER).credits).toBe(20);
      });
    });

    it("pro-rates against the real length of the current month", () => {
      const july = new Date(Date.UTC(2026, 6, 29));
      expect(daysInMonth(july)).toBe(31);
      expect(proRatedCeiling(8000, 7, july)).toBeCloseTo(1806.45, 2);
      expect(proRatedCeiling(8000, 1, july)).toBeCloseTo(258.06, 2);

      const february = new Date(Date.UTC(2026, 1, 10));
      expect(daysInMonth(february)).toBe(28);
      expect(proRatedCeiling(8000, 1, february)).toBeCloseTo(285.71, 2);
    });
  });

  describe("validation", () => {
    it("parses a full member usage payload", () => {
      expect(parseMyUsageResponse({ member: FULL_MEMBER })).toMatchObject({
        consumedAwuCredits: 4.61,
        memberUsageLimit: 20,
        spendLimitSource: "default",
      });
    });

    it("nulls fields of the wrong type rather than throwing", () => {
      const parsed = parseMyUsageResponse({
        member: { consumedAwuCredits: "4.61", memberUsageLimit: 20, nearLimit: "yes" },
      });
      expect(parsed?.consumedAwuCredits).toBeNull();
      expect(parsed?.memberUsageLimit).toBe(20);
      expect(parsed?.nearLimit).toBeNull();
    });

    it("returns null for a missing or non-object member", () => {
      expect(parseMyUsageResponse({ member: null })).toBeNull();
      expect(parseMyUsageResponse("nope")).toBeNull();
      expect(parseMyUsageResponse({})).toBeNull();
    });

    it("parses fair-use credits, keeping the unlimited sentinel", () => {
      expect(parseFairUseCreditsResponse({ fairUseAwuCreditsState: { limit: -1, timeframe: "month", count: 3 } }))
        .toEqual({ limit: -1, timeframe: "month", count: 3 });
      expect(parseFairUseCreditsResponse({})).toBeNull();
    });

    it("parses analytics groups and skips entries with no usable credits", () => {
      const parsed = parseMyUsageAnalyticsResponse({
        granularity: "day",
        groups: [{ name: "dust", credits: 18.4 }, { name: "broken" }, "junk"],
        points: [],
      });
      expect(parsed).toEqual({ granularity: "day", groups: [{ label: "dust", credits: 18.4 }] });
    });

    it("sums a group's credits from the time series when the group carries no total", () => {
      const parsed = parseMyUsageAnalyticsResponse({
        groups: [{ key: "sql", label: "@sql" }],
        points: [{ date: "d1", values: { sql: 2 } }, { date: "d2", values: { sql: 4.02 } }],
      });
      expect(parsed?.groups).toEqual([{ label: "@sql", credits: 6.02 }]);
    });

    it("returns null when analytics has no groups array", () => {
      expect(parseMyUsageAnalyticsResponse({ granularity: "day" })).toBeNull();
      expect(parseMyUsageAnalyticsResponse(null)).toBeNull();
    });

    it("parses top conversations", () => {
      expect(parseMyTopConversationsResponse({ conversations: [{ title: "Debug OAuth refresh", credits: 2.8 }] }))
        .toEqual({ conversations: [{ label: "Debug OAuth refresh", credits: 2.8 }] });
      expect(parseMyTopConversationsResponse({})).toBeNull();
    });

    it("parses the real top-conversations row shape", () => {
      // Dust returns { conversationId, title, totalCredits } — the amount is
      // named `totalCredits` here and nowhere else.
      expect(parseMyTopConversationsResponse({
        conversations: [{ conversationId: "c1", title: "Refactor MCP bridge", totalCredits: 411.2 }],
      })).toEqual({ conversations: [{ label: "Refactor MCP bridge", credits: 411.2 }] });
    });

    it("collapses newlines in a title so it cannot break a table row", () => {
      // Titles are the opening lines of a prompt, so they can be multi-line.
      expect(parseMyTopConversationsResponse({
        conversations: [{ conversationId: "c1", title: "# HANDOFF\n\n   ## step one", totalCredits: 5 }],
      })).toEqual({ conversations: [{ label: "# HANDOFF ## step one", credits: 5 }] });
    });

    it("falls back to the conversation id when a conversation has no title", () => {
      // `title` is `string | null`; dropping those rows would silently lose usage.
      expect(parseMyTopConversationsResponse({
        conversations: [{ conversationId: "c-abc", title: null, totalCredits: 12 }],
      })).toEqual({ conversations: [{ label: "c-abc", credits: 12 }] });
    });
  });

  describe("rendering", () => {
    const base: DustStatusData = {
      workspaceName: "Acme",
      region: "us-central1",
      agentName: "@dust",
      durationMs: 724_000,
      messagesSent: 8,
      sessionCredits: 3.42,
      sessionBaselineAt: Date.parse("2026-07-29T12:00:00.000Z"),
      usage: FULL_MEMBER,
      fairUse: null,
      totals: { month: null, week: null, day: null },
      monthlyCeiling: 8000,
      ceilingIsFallback: true,
      analytics: { granularity: "day", groups: [{ label: "@dust", credits: 18.4 }, { label: "@sql", credits: 6.02 }] },
      topConversations: { conversations: [{ label: "Refactor MCP bridge", credits: 4.11 }] },
    };

    it("formats credits to two decimals and durations as wall clock", () => {
      expect(formatCredits(4.6099)).toBe("4.61");
      expect(formatDuration(724_000)).toBe("12m 04s");
      expect(formatDuration(3_725_000)).toBe("1h 02m");
      expect(formatDuration(-5)).toBe("0m 00s");
    });

    it("draws a proportional gauge, clamped at both ends", () => {
      expect(renderGauge(0, 20, 10)).toBe(`${" ".repeat(10)}   0% used`);
      expect(renderGauge(20, 20, 10)).toBe("██████████ 100% used");
      // The bar clamps; the percentage does not — see the overage test below.
      expect(renderGauge(40, 20, 10)).toBe("██████████ 200% used");
      expect(renderGauge(5, 20, 10).trimEnd()).toMatch(/^█{2}/);
      expect(renderGauge(5, 0, 10)).toContain("0% used");
    });

    it("reports overage past 100% even though the bar is full", () => {
      // A pace target can be exceeded several times over; pegging the number at
      // 100% would hide by how much.
      expect(renderGauge(40, 20, 10)).toContain("200% used");
      expect(renderGauge(1376, 258.06, 10, "of pace")).toContain("533% of pace");
      expect(renderGauge(40, 20, 10).split(" ")[0]).toBe("█".repeat(10));
    });

    it("renders the seat gauge, spend cap, pool and both breakdowns", () => {
      const panel = renderStatusPanel(base).join("\n");

      expect(panel).toContain("Workspace:            Acme (us-central1)");
      expect(panel).toContain("Agent:                @dust");
      expect(panel).toContain("Messages:             8 sent");
      expect(panel).toContain("Seat credits");
      expect(panel).toContain("4.61 / 20.00 credits · resets");
      expect(panel).toContain("Spend cap (monthly)");
      expect(panel).toContain("4.61 / 100.00 credits");
      expect(panel).toContain("Overflow used:        0.00 credits");
      expect(panel).toContain("Top agents");
      expect(panel).toContain("@sql");
      expect(panel).toContain("Top conversations");
      expect(panel).toContain("Refactor MCP bridge");
    });

    const NOW = new Date(Date.UTC(2026, 6, 29, 15, 0, 0));
    const withPeriods: DustStatusData = {
      ...base,
      monthlyCeiling: 8000,
      ceilingIsFallback: false,
      totals: {
        month: { granularity: "month", buckets: [{ startMs: Date.UTC(2026, 6, 1), credits: 1924.6 }] },
        week: { granularity: "week", buckets: [{ startMs: Date.UTC(2026, 6, 27), credits: 279.4 }] },
        day: { granularity: "day", buckets: [{ startMs: Date.UTC(2026, 6, 29), credits: 98.1 }] },
      },
    };

    it("renders month, week and day gauges with pro-rated pace targets", () => {
      const panel = renderStatusPanel(withPeriods, NOW).join("\n");

      expect(panel).toContain("Credits this month");
      expect(panel).toContain("1,924.60 / 8,000.00 credits · resets");
      expect(panel).toContain("24% used");

      // July has 31 days: 8000 * 7 / 31 and 8000 / 31.
      expect(panel).toContain("This week (pace vs 1,806.45)");
      expect(panel).toContain("279.40 credits · Jul 27 - 29");
      expect(panel).toContain("Today (pace vs 258.06)");
      expect(panel).toContain("98.10 credits · Jul 29");
    });

    it("drops the seat gauge when it would just repeat the month ceiling", () => {
      const panel = renderStatusPanel({
        ...withPeriods,
        monthlyCeiling: 20,
        usage: { ...FULL_MEMBER, memberUsageLimit: 20 },
      }, NOW).join("\n");

      expect(panel).toContain("Credits this month");
      expect(panel).not.toContain("Seat credits");
    });

    it("drops the seat section entirely when Dust reports no allowance", () => {
      const panel = renderStatusPanel({
        ...withPeriods,
        usage: { ...FULL_MEMBER, memberUsageLimit: null, spendLimitAwuCredits: null, spendLimitSource: "none" },
      }, NOW).join("\n");

      expect(panel).toContain("Credits this month");
      expect(panel).not.toContain("Seat credits");
      expect(panel).not.toContain("not set");
    });

    it("keeps the fair-use section even alongside the month gauge", () => {
      const panel = renderStatusPanel({
        ...withPeriods,
        usage: { ...FULL_MEMBER, memberUsageLimit: null },
        fairUse: { limit: -1, timeframe: "month", count: 4.61 },
      }, NOW).join("\n");

      expect(panel).toContain("Fair-use credits");
      expect(panel).toContain("unlimited");
    });

    it("keeps the seat gauge when the ceiling came from somewhere else", () => {
      const panel = renderStatusPanel(withPeriods, NOW).join("\n");
      expect(panel).toContain("Seat credits");
      expect(panel).toContain("4.61 / 20.00 credits");
    });

    it("flags a ceiling Dust did not report", () => {
      const panel = renderStatusPanel({ ...withPeriods, ceilingIsFallback: true }, NOW).join("\n");
      expect(panel).toContain("Credits this month (ceiling not reported by Dust)");
    });

    it("clamps the current bucket's label to today rather than the calendar period", () => {
      // The week bucket starts Mon Jul 27; the calendar week runs to Aug 2, but
      // only Jul 27-29 has happened.
      expect(formatBucketRange(Date.UTC(2026, 6, 27), "week", NOW)).toBe("Jul 27 - 29");
      expect(formatBucketRange(Date.UTC(2026, 6, 1), "month", NOW)).toBe("Jul 1 - 29");
      expect(formatBucketRange(Date.UTC(2026, 6, 29), "day", NOW)).toBe("Jul 29");
      // A bucket whose first day is today collapses to a single date.
      expect(formatBucketRange(Date.UTC(2026, 6, 29), "week", NOW)).toBe("Jul 29");
    });

    it("labels a completed bucket that spans two months", () => {
      expect(formatBucketRange(Date.UTC(2026, 5, 29), "week", NOW)).toBe("Jun 29 - Jul 5");
    });

    it("reads the current period off the end of a series", () => {
      expect(currentBucket(withPeriods.totals.month)?.credits).toBe(1924.6);
      expect(currentBucket(null)).toBeNull();
      expect(currentBucket({ granularity: "day", buckets: [] })).toBeNull();
    });

    it("formats four-digit credit figures with thousands separators", () => {
      expect(formatCredits(8000)).toBe("8,000.00");
      expect(formatCredits(1924.6)).toBe("1,924.60");
    });

    it("labels the session figure approximate", () => {
      expect(renderStatusPanel(base).join("\n")).toMatch(/Credits \(session\):\s+~3\.42\s+\(approximate/);
    });

    it("renders an unlimited fair-use plan without a gauge or a -1", () => {
      const panel = renderStatusPanel({
        ...base,
        usage: { ...FULL_MEMBER, memberUsageLimit: null, spendLimitAwuCredits: null, spendLimitSource: "none" },
        fairUse: { limit: -1, timeframe: "month", count: 4.61 },
      }).join("\n");

      expect(panel).toContain("Fair-use credits");
      expect(panel).toContain("Limit:                unlimited");
      expect(panel).not.toContain("-1");
      expect(panel).not.toContain("█");
      expect(panel).not.toContain("Spend cap");
    });

    it("renders a bounded fair-use plan with a gauge", () => {
      const panel = renderStatusPanel({
        ...base,
        usage: { ...FULL_MEMBER, memberUsageLimit: null },
        fairUse: { limit: 50, timeframe: "month", count: 25 },
      }).join("\n");

      expect(panel).toContain("Fair-use credits · per month");
      expect(panel).toContain("25.00 / 50.00 credits");
      expect(panel).toContain("50% used");
    });

    it("omits sections it has no data for", () => {
      const panel = renderStatusPanel({
        ...base,
        sessionCredits: null,
        usage: null,
        fairUse: null,
        analytics: null,
        topConversations: null,
      }).join("\n");

      expect(panel).toContain("Credits (session):    unavailable");
      expect(panel).not.toContain("Seat credits");
      expect(panel).not.toContain("Top agents");
      expect(panel).toContain("Credit figures are unavailable right now.");
    });

    it("skips the reset line when the timestamp is unparseable", () => {
      const panel = renderStatusPanel({
        ...base,
        usage: { ...FULL_MEMBER, nextCreditResetAt: "not-a-date" },
      }).join("\n");

      expect(panel).toContain("4.61 / 20.00 credits");
      expect(panel).not.toContain("resets");
    });
  });
});
