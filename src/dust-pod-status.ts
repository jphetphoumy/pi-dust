import { isEmptyReport, type SyncReport } from "./dust-pod-sync.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { getPodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";

/** Our slot in pi's footer. One key per extension concern. */
const STATUS_KEY = "dust-pod";

/**
 * Compact form of a sync report for the footer, e.g. `↑1 ↓2 ⚠1`.
 *
 * Deliberately terser than `describeReport`: that one writes prose for a
 * notification line, this one shares a single row with the model, token count
 * and git branch.
 */
function compactReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed.length > 0) parts.push(`↑${report.pushed.length}`);
  if (report.pulled.length > 0) parts.push(`↓${report.pulled.length}`);
  if (report.conflicted.length > 0) parts.push(`⚠${report.conflicted.length}`);
  if (report.skipped.length > 0) parts.push(`−${report.skipped.length}`);
  return parts.join(" ");
}

export function podStatusText(podName: string, report?: SyncReport): string {
  return report && !isEmptyReport(report)
    ? `pod:${podName} ${compactReport(report)}`
    : `pod:${podName}`;
}

/**
 * The turn's syncs, added up.
 *
 * A turn runs several: a push before it, a pull before each bash call, a pull
 * after. Rendering only the latest would let a clean post-turn pull wipe the
 * counts from the push that started the turn — the footer would flash `↑1` and
 * then show nothing, which reads as "nothing happened". Totals are reset when
 * the next turn begins, so the row always describes the turn you just watched.
 */
let turnTotals: SyncReport | null = null;

export function beginPodStatusTurn(): void {
  turnTotals = null;
}

function accumulate(report: SyncReport): SyncReport {
  turnTotals = turnTotals === null ? report : {
    pushed: [...turnTotals.pushed, ...report.pushed],
    pulled: [...turnTotals.pulled, ...report.pulled],
    conflicted: [...turnTotals.conflicted, ...report.conflicted],
    skipped: [...turnTotals.skipped, ...report.skipped],
  };
  return turnTotals;
}

/**
 * Publishes the pod's state to pi's footer.
 *
 * Sync used to announce itself with `console.error`, which on a TUI means a
 * line printed over the transcript that scrolls away and is easy to miss. The
 * footer is the right home for it: pod mode is a persistent property of the
 * session, and the last sync's counts are exactly the kind of ambient
 * detail a status bar is for.
 *
 * A missing `setStatus` is normal, not an error — pi's non-interactive modes
 * supply a no-op context, and older builds may not expose it at all.
 */
export function refreshPodStatus(
  runtime: DustSessionRuntime,
  root: string,
  report?: SyncReport,
): void {
  const setStatus = (runtime.extensionContext as PiRuntimeContext | null)?.ui?.setStatus;
  if (!setStatus) return;

  const binding = getPodBinding(root);
  const totals = report ? accumulate(report) : turnTotals ?? undefined;
  setStatus(STATUS_KEY, binding ? podStatusText(binding.name, totals) : undefined);
}

/** Drops the footer entry, for `/ingest clear` and for logout. */
export function clearPodStatus(runtime: DustSessionRuntime): void {
  turnTotals = null;
  (runtime.extensionContext as PiRuntimeContext | null)?.ui?.setStatus?.(STATUS_KEY, undefined);
}
