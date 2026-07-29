import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { collectStatusData } from "../src/dust-status.js";
import { formatDuration, formatCredits, renderGauge, renderStatusPanel } from "../src/dust-status-render.js";
import {
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

/** Routes each credit endpoint by URL, so call order never matters. */
function creditsFetchMock(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    "credits/my-usage-analytics": { granularity: "day", groups: [{ name: "dust", credits: 18.4 }], points: [] },
    "credits/my-usage": { member: FULL_MEMBER },
    "credits/my-top-conversations": { conversations: [{ title: "Refactor MCP bridge", credits: 4.11 }] },
    "fair-use-credits": { fairUseAwuCreditsState: { limit: -1, timeframe: "month", count: 0 } },
    ...overrides,
  };

  return vi.fn((url: string) => {
    // my-usage-analytics also matches "credits/my-usage", so test longest first.
    const key = Object.keys(bodies).sort((a, b) => b.length - a.length).find((candidate) => url.includes(candidate));
    return Promise.resolve(key ? jsonResponse(bodies[key]) : jsonResponse({}, 404));
  });
}

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

      const analyticsCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("my-usage-analytics")).length;
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

      const analyticsCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("my-usage-analytics")).length;
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
      expect(renderGauge(40, 20, 10)).toBe("██████████ 100% used");
      expect(renderGauge(5, 20, 10).trimEnd()).toMatch(/^█{2}/);
      expect(renderGauge(5, 0, 10)).toContain("0% used");
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
