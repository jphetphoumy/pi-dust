import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./dust-debug.js";
import {
  downloadPodFile,
  listPodFiles,
  type PodApi,
  toRelativePath,
  uploadPodFile,
} from "./dust-pod.js";
import { type DustPodBinding, savePodBinding } from "./dust-state.js";

export interface SyncReport {
  /** Pod files written onto the local tree. */
  pulled: string[];
  /** Local files pushed up to the pod. */
  pushed: string[];
  /** Changed on both sides since the last sync; left untouched. */
  conflicted: string[];
}

export function emptyReport(): SyncReport {
  return { pulled: [], pushed: [], conflicted: [] };
}

export function isEmptyReport(report: SyncReport): boolean {
  return report.pulled.length === 0 && report.pushed.length === 0 && report.conflicted.length === 0;
}

export function describeReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed.length > 0) parts.push(`↑ ${report.pushed.length} pushed`);
  if (report.pulled.length > 0) parts.push(`↓ ${report.pulled.length} pulled`);
  if (report.conflicted.length > 0) parts.push(`⚠ ${report.conflicted.length} conflicted`);
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
  options: { push?: boolean; pull?: boolean } = {},
): Promise<SyncReport> {
  const push = options.push ?? true;
  const pull = options.pull ?? true;
  const report = emptyReport();
  const seen = { ...binding.seen };

  const entries = await listPodFiles(api, binding.podId);
  for (const entry of entries) {
    const rel = toRelativePath(binding.podId, entry.path);
    const watermark = seen[rel];
    const local = readLocal(root, rel);
    const localHash = local ? hashOf(local) : null;

    const podChanged = !watermark || entry.lastModifiedMs > watermark.podMs;
    const localChanged = watermark ? localHash !== watermark.hash : local !== null;

    if (podChanged && localChanged) {
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
    // Files we know about that have vanished from the pod listing (or were
    // never uploaded) get re-pushed, so a local addition inside an ingested
    // tree reaches the agent without a second /ingest.
    const podPaths = new Set(entries.map((entry) => toRelativePath(binding.podId, entry.path)));
    for (const rel of Object.keys(seen)) {
      if (podPaths.has(rel)) continue;
      const local = readLocal(root, rel);
      if (!local) continue;
      await uploadPodFile(api, binding.podId, rel, local);
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

/** First upload of a chosen file set; establishes the watermark for each. */
export async function ingestFiles(
  api: PodApi,
  root: string,
  binding: DustPodBinding,
  relPaths: string[],
): Promise<SyncReport> {
  const report = emptyReport();
  for (const rel of relPaths) {
    const local = readLocal(root, rel);
    if (!local) continue;
    await uploadPodFile(api, binding.podId, rel, local);
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
