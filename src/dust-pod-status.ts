import { isEmptyReport, type SyncReport } from "./dust-pod-sync.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { getPodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";

/** Our slot in pi's footer. One key per extension concern. */
const STATUS_KEY = "dust-pod";

/**
 * Colour is written as raw SGR codes rather than through pi's `theme`.
 *
 * The theme singleton lives at `modes/interactive/theme/theme.js`, which the
 * package's export map does not expose — only `.` and `./rpc-entry` — so
 * importing it would break under Node's ESM resolution. Basic ANSI colours are
 * the portable alternative: they resolve against the user's own terminal
 * palette, so they stay legible on light and dark backgrounds alike.
 *
 * pi's footer measures width with `visibleWidth`, which strips escape
 * sequences, so colouring cannot upset its truncation.
 */
const SGR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
} as const;

/** Honours the NO_COLOR convention, and keeps assertions readable in tests. */
function colorsEnabled(): boolean {
  return !process.env.NO_COLOR;
}

function paint(color: keyof typeof SGR, text: string): string {
  return colorsEnabled() ? `${SGR[color]}${text}${SGR.reset}` : text;
}

/**
 * Compact form of a sync report for the footer, e.g. `↑1 ↓2 ⚠1`.
 *
 * Deliberately terser than `describeReport`: that one writes prose for a
 * notification line, this one shares a single row with the model, token count
 * and git branch.
 *
 * Colour encodes severity, not direction — the arrows already say which way a
 * file went, so what the colour has left to convey is whether anything needs
 * the user's attention. Green moved cleanly, yellow needs a decision, red did
 * not happen at all.
 */
function compactReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed.length > 0) parts.push(paint("green", `↑${report.pushed.length}`));
  if (report.pulled.length > 0) parts.push(paint("green", `↓${report.pulled.length}`));
  if (report.conflicted.length > 0) parts.push(paint("yellow", `⚠${report.conflicted.length}`));
  if (report.skipped.length > 0) parts.push(paint("red", `−${report.skipped.length}`));
  return parts.join(" ");
}

export function podStatusText(podName: string, report?: SyncReport): string {
  const label = paint("dim", `pod:${podName}`);
  return report && !isEmptyReport(report) ? `${label} ${compactReport(report)}` : label;
}

/**
 * In-progress form, e.g. `pod:proj ⟳ 3/12`.
 *
 * Uploads are sequential, one request per file, so ingesting a real project is
 * visibly slow. Without this the footer sat on its previous value and the
 * session looked wedged.
 */
export function podSyncingText(podName: string, done: number, total: number): string {
  const label = paint("dim", `pod:${podName}`);
  return `${label} ${paint("cyan", `⟳ ${done}/${total}`)}`;
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
    adopted: [...turnTotals.adopted, ...report.adopted],
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

/**
 * A progress reporter for one sync, or a no-op when there is nothing to show it
 * on. Handed to `syncPod`/`ingestFiles`, which call it as each file lands.
 */
export function podProgressReporter(
  runtime: DustSessionRuntime,
  podName: string,
): (done: number, total: number) => void {
  const setStatus = (runtime.extensionContext as PiRuntimeContext | null)?.ui?.setStatus;
  if (!setStatus) return () => {};
  return (done, total) => {
    // A single-file sync is over before the eye can read it; showing 1/1 just
    // makes the footer twitch.
    if (total > 1) setStatus(STATUS_KEY, podSyncingText(podName, done, total));
  };
}

/** Drops the footer entry, for `/ingest clear` and for logout. */
export function clearPodStatus(runtime: DustSessionRuntime): void {
  turnTotals = null;
  (runtime.extensionContext as PiRuntimeContext | null)?.ui?.setStatus?.(STATUS_KEY, undefined);
}
