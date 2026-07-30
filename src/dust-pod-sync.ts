import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import { selectIngestableFiles } from "./dust-pod-files.js";
import {
  downloadPodFile,
  listPodFiles,
  type PodApi,
  toRelativePath,
  uploadPodFile,
} from "./dust-pod.js";
import { type DustPodBinding, savePodBinding } from "./dust-state.js";
import { errorMessage } from "./dust-validation.js";

export interface SyncReport {
  /** Pod files written onto the local tree. */
  pulled: string[];
  /** Local files pushed up to the pod. */
  pushed: string[];
  /** Changed on both sides since the last sync; left untouched. */
  conflicted: string[];
  /** Files the pod would not accept, with the reason. */
  skipped: Array<{ rel: string; reason: string }>;
}

/** Called as each file finishes, for a progress indicator. */
export type SyncProgress = (done: number, total: number) => void;

export interface SyncOptions {
  push?: boolean;
  pull?: boolean;
  onProgress?: SyncProgress;
}

export function emptyReport(): SyncReport {
  return { pulled: [], pushed: [], conflicted: [], skipped: [] };
}

export function isEmptyReport(report: SyncReport): boolean {
  return report.pulled.length === 0
    && report.pushed.length === 0
    && report.conflicted.length === 0
    && report.skipped.length === 0;
}

export function describeReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed.length > 0) parts.push(`↑ ${report.pushed.length} pushed`);
  if (report.pulled.length > 0) parts.push(`↓ ${report.pulled.length} pulled`);
  if (report.conflicted.length > 0) parts.push(`⚠ ${report.conflicted.length} conflicted`);
  if (report.skipped.length > 0) parts.push(`− ${report.skipped.length} skipped`);
  return parts.join(", ");
}

function hashOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readLocal(root: string, rel: string): Buffer | null {
  const path = join(root, rel);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function writeLocal(root: string, rel: string, content: Buffer): void {
  const path = join(root, rel);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}

/**
 * Reconciles the pod against the local tree in both directions.
 *
 * Change detection is watermark-based rather than timestamp-based: a file
 * counts as pod-changed when the listing reports a newer `lastModifiedMs` than
 * the watermark, and local-changed when its content hashes differently from the
 * watermark. Comparing local mtimes against pod mtimes directly would be wrong
 * — the two clocks are unrelated, and writing a pulled file bumps the local
 * mtime past the pod's every time.
 *
 * When both sides moved, neither wins. Overwriting would silently destroy work,
 * and there is no merge available here, so the file is reported and skipped.
 */
export async function syncPod(
  api: PodApi,
  root: string,
  binding: DustPodBinding,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const push = options.push ?? true;
  const pull = options.pull ?? true;
  const report = emptyReport();
  const seen = { ...binding.seen };

  const entries = await listPodFiles(api, binding.podId);
  // Both loops feed one counter, so the indicator does not restart halfway.
  const discovered = push ? selectIngestableFiles(root, binding.pathspecs ?? []) : [];
  const total = entries.length + discovered.length;
  let done = 0;
  const step = (): void => options.onProgress?.(++done, total);

  for (const entry of entries) {
    step();
    const rel = toRelativePath(binding.podId, entry.path);
    const watermark = seen[rel];
    const local = readLocal(root, rel);
    const localHash = local ? hashOf(local) : null;

    const podChanged = !watermark || entry.lastModifiedMs > watermark.podMs;
    const localChanged = watermark ? localHash !== watermark.hash : local !== null;

    if (podChanged && localChanged) {
      // Both sides moved by the watermark's reckoning, but they may well have
      // moved to the same place — or the watermark may be missing entirely,
      // which is what a partial ingest leaves behind. Compare the bytes before
      // calling it a conflict, so identical copies simply re-establish the
      // watermark instead of jamming the file permanently.
      const content = await downloadPodFile(api, binding.podId, rel);
      const contentHash = hashOf(content);
      if (contentHash === localHash) {
        seen[rel] = { podMs: entry.lastModifiedMs, hash: contentHash };
        continue;
      }
      report.conflicted.push(rel);
      continue;
    }

    if (podChanged && pull) {
      const content = await downloadPodFile(api, binding.podId, rel);
      const contentHash = hashOf(content);
      // A pod write that produced identical bytes (the agent "fixing" something
      // to what it already was) is not a local change worth reporting.
      if (contentHash !== localHash) {
        writeLocal(root, rel, content);
        report.pulled.push(rel);
      }
      seen[rel] = { podMs: entry.lastModifiedMs, hash: contentHash };
      continue;
    }

    if (localChanged && push && local) {
      await uploadPodFile(api, binding.podId, rel, local);
      // The upload changes the pod's mtime, so the watermark has to come from a
      // fresh listing rather than the pre-upload entry — otherwise the next
      // sync would see our own push as an incoming pod change.
      seen[rel] = { podMs: Number.MAX_SAFE_INTEGER, hash: hashOf(local) };
      report.pushed.push(rel);
    }
  }

  if (push) {
    // Anything the pod does not have but the selection says it should: files we
    // already track that have vanished from the pod, and files the user has
    // created locally since the ingest. Re-running the same selection is what
    // makes a pod created for an empty directory usable — otherwise the first
    // file the user writes themselves would never reach the agent.
    const podPaths = new Set(entries.map((entry) => toRelativePath(binding.podId, entry.path)));
    const missing = new Set([...Object.keys(seen), ...discovered]);

    for (const rel of missing) {
      step();
      if (podPaths.has(rel)) continue;
      const local = readLocal(root, rel);
      if (!local) continue;
      try {
        await uploadPodFile(api, binding.podId, rel, local);
      } catch (err) {
        if (err instanceof Error && err.message === SESSION_EXPIRED_MESSAGE) throw err;
        report.skipped.push({ rel, reason: errorMessage(err) });
        continue;
      }
      seen[rel] = { podMs: Number.MAX_SAFE_INTEGER, hash: hashOf(local) };
      report.pushed.push(rel);
    }
  }

  if (report.pushed.length > 0) {
    // Settle the watermarks we set to MAX_SAFE_INTEGER above.
    for (const entry of await listPodFiles(api, binding.podId)) {
      const rel = toRelativePath(binding.podId, entry.path);
      if (seen[rel]) seen[rel] = { ...seen[rel], podMs: entry.lastModifiedMs };
    }
  }

  binding.seen = seen;
  savePodBinding(root, binding);
  debugLog("dust:pod", "Sync complete", {
    root,
    podId: binding.podId,
    ...report,
  });
  return report;
}

/**
 * First upload of a chosen file set; establishes the watermark for each.
 *
 * A file the pod refuses is recorded and skipped rather than aborting the run.
 * Letting one rejection throw would strand the whole ingest: the files already
 * uploaded would have no watermark, and a watermark-less file that exists on
 * both sides reads as changed-on-both-sides, so the next sync would report the
 * entire project as conflicted. A partial ingest has to leave consistent state.
 */
export async function ingestFiles(
  api: PodApi,
  root: string,
  binding: DustPodBinding,
  relPaths: string[],
  onProgress?: SyncProgress,
): Promise<SyncReport> {
  const report = emptyReport();
  let done = 0;
  for (const rel of relPaths) {
    onProgress?.(++done, relPaths.length);
    const local = readLocal(root, rel);
    if (!local) continue;
    try {
      await uploadPodFile(api, binding.podId, rel, local);
    } catch (err) {
      // A dead session is not a per-file problem and must not be swallowed as
      // one — every remaining file would "fail" too, for the same reason.
      if (err instanceof Error && err.message === SESSION_EXPIRED_MESSAGE) throw err;
      report.skipped.push({ rel, reason: errorMessage(err) });
      continue;
    }
    binding.seen[rel] = { podMs: Number.MAX_SAFE_INTEGER, hash: hashOf(local) };
    report.pushed.push(rel);
  }

  for (const entry of await listPodFiles(api, binding.podId)) {
    const rel = toRelativePath(binding.podId, entry.path);
    if (binding.seen[rel]) binding.seen[rel] = { ...binding.seen[rel], podMs: entry.lastModifiedMs };
  }

  savePodBinding(root, binding);
  return report;
}
