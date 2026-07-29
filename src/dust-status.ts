import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveMonthlyCeiling } from "./dust-ceiling.js";
import {
  creditsBaseUrl,
  fetchCreditTotals,
  fetchFairUseCredits,
  fetchMemberUsage,
  fetchTopConversations,
  fetchUsageAnalytics,
} from "./dust-credits.js";
import { debugLog } from "./dust-debug.js";
import { buildSessionContext, type DustSessionRuntime } from "./dust-runtime.js";
import { getStoredCredentials } from "./dust-state.js";
import { renderStatusPanel } from "./dust-status-render.js";
import type { DustAgent, DustModel, DustStatusData, PiRuntimeContext } from "./dust-types.js";

export const DUST_STATUS_ENTRY = "dust-status";

const NOT_LOGGED_IN = "Not logged in to Dust. Run /login first.";
const NO_WORKSPACE = "No Dust workspace selected. Run /workspace first.";

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
  const cred = getStoredCredentials();
  if (!cred?.access) return { error: NOT_LOGGED_IN };
  if (!cred.workspaceId) return { error: NO_WORKSPACE };

  const region = cred.region ?? "us-central1";
  const baseUrl = creditsBaseUrl(region, cred.workspaceId);
  // The command can run before any turn has wired the runtime up, so derive a
  // session controller from the command context when there is none yet.
  const session = runtime.sessionContext.getCredentials()
    ? runtime.sessionContext
    : buildSessionContext(ctx);
  const tracker = runtime.credits;

  const needsLiveRead = tracker.dirty || tracker.lastConsumedCredits === null;
  const [usage, fairUse, totals] = needsLiveRead
    ? await Promise.all([
        fetchMemberUsage(session, baseUrl, signal),
        fetchFairUseCredits(session, baseUrl, signal),
        // The period totals are the headline figures, so they follow the live
        // rule too — a user who just ran turns must see them move.
        fetchCreditTotals(session, baseUrl, signal),
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
    tracker.analytics = await fetchUsageAnalytics(session, baseUrl, signal);
  }
  if (tracker.topConversations === null) {
    tracker.topConversations = await fetchTopConversations(session, baseUrl, signal);
  }

  const workspace = cred.workspaces?.find((candidate) => candidate.sId === cred.workspaceId);

  return {
    workspaceName: workspace?.name ?? cred.workspaceId,
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
    description: "Show Dust credit usage for this session and the current billing period",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const result = await collectStatusData(runtime, runtimeCtx, (ctx as { signal?: AbortSignal }).signal)
        .catch((err): { error: string } => {
          debugLog("dust:status", "Status collection failed", { error: String(err) });
          return { error: "Could not read Dust credit usage. See the debug log for details." };
        });

      if ("error" in result) {
        runtimeCtx.ui?.notify?.(result.error, "warning");
        return;
      }

      const lines = renderStatusPanel(result);
      emit(pi, runtimeCtx, lines);
    },
  });
}

function emit(pi: ExtensionAPI, ctx: PiRuntimeContext, lines: string[]): void {
  try {
    pi.appendEntry(DUST_STATUS_ENTRY, { lines });
  } catch (err) {
    debugLog("dust:status", "appendEntry failed", { error: String(err) });
    ctx.ui?.notify?.(lines.join("\n"), "info");
  }
}
