import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveMonthlyCeiling } from "./dust-ceiling.js";
import {
  creditsBaseUrl,
  fetchCreditTotals,
  fetchFairUseCredits,
  fetchMemberUsage,
  fetchTopConversations,
  fetchUsageBreakdown,
} from "./dust-credits.js";
import { debugLog } from "./dust-debug.js";
import { buildSessionContext, type DustSessionRuntime } from "./dust-runtime.js";
import { getStoredCredentials } from "./dust-state.js";
import { StatusLoader } from "./dust-status-loader.js";
import { DustStatusPanel, panelHeight } from "./dust-status-panel.js";
import { renderStatusPanel } from "./dust-status-render.js";
import type { DustAgent, DustCredentials, DustModel, DustStatusData, PiRuntimeContext } from "./dust-types.js";

export const DUST_STATUS_ENTRY = "dust-status";

const NOT_LOGGED_IN = "Not logged in to Dust. Run /login first.";
const NO_WORKSPACE = "No Dust workspace selected. Run /workspace first.";
/** Window the Overview tab's inline breakdowns cover. */
const OVERVIEW_BREAKDOWN_DAYS = 30;

/** Everything needed to talk to the credit API, resolved without any network call. */
export interface StatusTarget {
  cred: DustCredentials;
  workspaceId: string;
  region: string;
  baseUrl: string;
}

type CustomUi = <T>(
  factory: (
    tui: { requestRender: () => void; terminal?: { rows?: number } },
    theme: never,
    keybindings: unknown,
    done: (result: T) => void,
  ) => unknown,
  options?: unknown,
) => Promise<T>;

/**
 * Ensures `runtime.sessionContext` is wired before anything reads through it.
 *
 * The command can run before any turn has wired the runtime up (no
 * session_start yet), in which case `runtime.sessionContext` is still the
 * no-op default. Wire it from the command's own context in place — every
 * credit fetch below reads through `runtime`, so it needs a working
 * `sessionContext` on the same instance, not a free-floating one only this
 * call would see.
 */
function ensureSessionContext(runtime: DustSessionRuntime, ctx: PiRuntimeContext): void {
  if (!runtime.sessionContext.getCredentials()) {
    runtime.sessionContext = buildSessionContext(ctx);
  }
}

/**
 * Resolves the panel's target. Also ensures `runtime.sessionContext` is wired
 * (see `ensureSessionContext`). Idempotent and safe to call more than once
 * per command, which is what both callers below do.
 */
export function resolveStatusTarget(
  runtime: DustSessionRuntime,
  ctx: PiRuntimeContext,
): StatusTarget | { error: string } {
  ensureSessionContext(runtime, ctx);

  const cred = getStoredCredentials();
  if (!cred?.access) return { error: NOT_LOGGED_IN };
  if (!cred.workspaceId) return { error: NO_WORKSPACE };

  const region = cred.region ?? "us-central1";
  return {
    cred,
    workspaceId: cred.workspaceId,
    region,
    baseUrl: creditsBaseUrl(region, cred.workspaceId),
  };
}

/**
 * Assembles the panel's data.
 *
 * Live figures (seat balance, spend cap, reset date) are refetched whenever the
 * session has advanced since the last read — a user who just ran a few turns
 * must see those turns reflected, so caching them is only ever an optimisation
 * for a session that has not moved. The 30-day breakdowns are cached outright:
 * they are month-scale aggregates that cannot shift within one session.
 */
export async function collectStatusData(
  runtime: DustSessionRuntime,
  ctx: PiRuntimeContext,
  signal?: AbortSignal,
): Promise<DustStatusData | { error: string }> {
  const target = resolveStatusTarget(runtime, ctx);
  if ("error" in target) return target;

  const { cred, workspaceId, region, baseUrl } = target;
  const tracker = runtime.credits;

  const needsLiveRead = tracker.dirty || tracker.lastConsumedCredits === null;
  const [usage, fairUse, totals] = needsLiveRead
    ? await Promise.all([
        fetchMemberUsage(runtime, baseUrl, signal),
        fetchFairUseCredits(runtime, baseUrl, signal),
        // The period totals are the headline figures, so they follow the live
        // rule too — a user who just ran turns must see them move.
        fetchCreditTotals(runtime, baseUrl, signal),
      ])
    : [tracker.cachedUsage, tracker.cachedFairUse, tracker.cachedTotals];

  if (needsLiveRead) {
    tracker.cachedUsage = usage;
    tracker.cachedFairUse = fairUse;
    tracker.cachedTotals = totals;
  }

  const ceiling = resolveMonthlyCeiling(usage);

  const sessionCredits = needsLiveRead
    ? tracker.observeConsumedCredits(usage?.consumedAwuCredits ?? null)
    : tracker.sessionDelta();

  if (tracker.analytics === null) {
    tracker.analytics = await fetchUsageBreakdown(runtime, baseUrl, "agent", OVERVIEW_BREAKDOWN_DAYS, signal);
  }
  if (tracker.topConversations === null) {
    tracker.topConversations = await fetchTopConversations(runtime, baseUrl, signal);
  }

  const workspace = cred.workspaces?.find((candidate) => candidate.sId === workspaceId);

  const data: DustStatusData = {
    workspaceName: workspace?.name ?? workspaceId,
    region,
    agentName: agentLabel(ctx, cred.agents),
    durationMs: Date.now() - tracker.startedAt,
    messagesSent: tracker.messagesSent,
    sessionCredits,
    sessionBaselineAt: tracker.baselineAt,
    usage,
    fairUse,
    totals,
    monthlyCeiling: ceiling.credits,
    ceilingIsFallback: ceiling.isFallback,
    analytics: tracker.analytics,
    topConversations: tracker.topConversations,
  };

  // Kept so re-opening the panel can paint immediately; only ever shown again
  // while the session has not advanced past it.
  tracker.lastOverview = data;
  return data;
}

/** The Dust agent backing the current model, named the way Dust names it. */
function agentLabel(ctx: PiRuntimeContext, agents: DustAgent[] | undefined): string | null {
  const model = (ctx as { model?: DustModel }).model;
  if (!model) return null;
  if (model.provider && model.provider !== "dust") return null;

  const matched = agents?.find((agent) => agent.sId === model.sId || agent.sId === model.id);
  const name = matched?.name ?? model.name;
  if (!name) return null;
  return name.startsWith("@") ? name : `@${name}`;
}

function isEntryData(value: unknown): value is { lines: string[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { lines?: unknown }).lines);
}

/**
 * Registers `/status`.
 *
 * Read-only by design: it renders credit figures and nothing else — no approval
 * state, no prompts, no actions.
 */
export function registerDustStatusCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  const registerEntryRenderer = (pi as unknown as {
    registerEntryRenderer?: (customType: string, renderer: (entry: unknown) => unknown) => void;
  }).registerEntryRenderer;

  if (typeof registerEntryRenderer === "function") {
    registerEntryRenderer(DUST_STATUS_ENTRY, (entry) => {
      const data = (entry as { data?: unknown })?.data;
      return new Text(isEntryData(data) ? data.lines.join("\n") : "");
    });
  } else {
    debugLog("dust:status", "registerEntryRenderer unavailable; falling back to notify");
  }

  pi.registerCommand("status", {
    description: "Show Dust credit usage — session, month/week/day, and breakdowns by agent, type, source and API key",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const signal = (ctx as { signal?: AbortSignal }).signal;

      // Cheap, synchronous, no network: refuse before opening anything.
      const target = resolveStatusTarget(runtime, runtimeCtx);
      if ("error" in target) {
        runtimeCtx.ui?.notify?.(target.error, "warning");
        return;
      }

      const opened = await openStatusPanel(runtime, runtimeCtx, target.baseUrl, signal);
      if (opened) return;

      // No interactive UI (headless, RPC, or a pi without ui.custom): fall back
      // to the one-shot transcript panel.
      debugLog("dust:status", "Interactive panel unavailable; rendering static panel");
      const result = await collectStatusData(runtime, runtimeCtx, signal).catch((err): { error: string } => {
        debugLog("dust:status", "Status collection failed", { error: String(err) });
        return { error: "Could not read Dust credit usage. See the debug log for details." };
      });

      if ("error" in result) {
        runtimeCtx.ui?.notify?.(result.error, "warning");
        return;
      }
      emit(pi, runtimeCtx, renderStatusPanel(result));
    },
  });
}

/**
 * Opens the interactive panel, returning false when the host offers no custom-UI
 * surface to open it on.
 *
 * The panel is shown *before* any network call resolves. It starts from the
 * cached overview when the session has not advanced since that read — the
 * figures are current by definition then — and from a spinner when it has, so a
 * stale number is never presented as live.
 */
async function openStatusPanel(
  runtime: DustSessionRuntime,
  ctx: PiRuntimeContext,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const custom = (ctx.ui as { custom?: CustomUi } | undefined)?.custom;
  if (typeof custom !== "function") return false;

  const tracker = runtime.credits;
  let loader: StatusLoader | null = null;

  const refresh = () => {
    loader?.markOverviewRefreshing();
    void collectStatusData(runtime, ctx, signal)
      .then((result) => loader?.setOverview("error" in result ? new Error(result.error) : result))
      .catch((err) => loader?.setOverview(err instanceof Error ? err : new Error(String(err))));
  };

  await custom<undefined>((tui, theme, _keybindings, done) => {
    loader = new StatusLoader(
      runtime,
      baseUrl,
      () => tui.requestRender(),
      signal,
      tracker.dirty ? null : tracker.lastOverview,
    );
    // Nothing has happened since the cached overview was read, so it is still
    // current and no request is needed.
    if (loader.overview.status === "loading") refresh();

    // Not an overlay: pi swaps the component into the editor's slot, so the
    // panel renders inline above the prompt at full width and restores the
    // editor on close. A floating overlay left the transcript showing through
    // wherever a line was shorter than the overlay box.
    return new DustStatusPanel(
      theme,
      loader,
      () => tui.requestRender(),
      done,
      refresh,
      panelHeight(tui.terminal?.rows ?? 0),
    );
  });

  return true;
}

function emit(pi: ExtensionAPI, ctx: PiRuntimeContext, lines: string[]): void {
  try {
    pi.appendEntry(DUST_STATUS_ENTRY, { lines });
  } catch (err) {
    debugLog("dust:status", "appendEntry failed", { error: String(err) });
    ctx.ui?.notify?.(lines.join("\n"), "info");
  }
}
