import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import { POD_AGENTS_MD } from "./dust-pod-agents-md.js";
import { isPodPathSafe, MAX_INGEST_FILES, selectIngestableFiles } from "./dust-pod-files.js";
import { fingerprintSkill, isPodSkillPath } from "./dust-pod-skills.js";
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
  /** Skills the agent authored in the pod, installed into the project. */
  adopted: string[];
}

/** Called as each file finishes, for a progress indicator. */
export type SyncProgress = (done: number, total: number) => void;

export interface SyncOptions {
  push?: boolean;
  pull?: boolean;
  onProgress?: SyncProgress;
}

export function emptyReport(): SyncReport {
  return { pulled: [], pushed: [], conflicted: [], skipped: [], adopted: [] };
}

export function isEmptyReport(report: SyncReport): boolean {
  return report.pulled.length === 0
    && report.pushed.length === 0
    && report.conflicted.length === 0
    && report.skipped.length === 0
    && report.adopted.length === 0;
}

export function describeReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed.length > 0) parts.push(`↑ ${report.pushed.length} pushed`);
  if (report.pulled.length > 0) parts.push(`↓ ${report.pulled.length} pulled`);
  if (report.adopted.length > 0) parts.push(`+ ${report.adopted.length} skill adopted`);
  if (report.conflicted.length > 0) parts.push(`⚠ ${report.conflicted.length} conflicted`);
  if (report.skipped.length > 0) parts.push(`− ${report.skipped.length} skipped`);
  return parts.join(", ");
}

/**
 * Skills the agent wrote into the pod that this project should take on.
 *
 * The pod's `skills/` prefix is where `/dust-skills` puts our copies, so a
 * subtree there that we did not upload is one the agent authored. Pulled as an
 * ordinary file it would land at `<root>/skills/<name>/`, which pi does not
 * scan — the skill would sit on disk inert, and leave a stray `skills/`
 * directory in the project root.
 *
 * The guards matter because `skills/` is a plausible project directory too:
 *
 *  - it must carry a `SKILL.md`, or it is just files that happen to live there;
 *  - nothing in it may be tracked in `seen`, which would make it the user's own
 *    content that we ingested;
 *  - nothing in it may already exist locally, for the same reason.
 *
 * Getting this wrong would divert a user's source tree into their config
 * directory, so the bar for claiming a subtree is deliberately high.
 */
export function detectAdoptableSkills(
  rels: readonly string[],
  binding: DustPodBinding,
  root: string,
): Map<string, string[]> {
  const already = new Set(binding.skills ?? []);
  const grouped = new Map<string, string[]>();

  for (const rel of rels) {
    const match = /^skills\/([^/]+)\/(.+)$/.exec(rel);
    if (!match) continue;
    const [, name] = match;
    if (already.has(name as string)) continue;
    const group = grouped.get(name as string) ?? [];
    group.push(rel);
    grouped.set(name as string, group);
  }

  for (const [name, group] of [...grouped]) {
    const isSkill = group.includes(`skills/${name}/SKILL.md`);
    const untouched = group.every((rel) => !binding.seen[rel] && !existsSync(join(root, rel)));
    if (!isSkill || !untouched) grouped.delete(name);
  }

  return grouped;
}

/**
 * Where an adopted skill's file goes: the *project's* skill directory.
 *
 * `.pi/skills/` under the project root, never `~/.pi/agent/skills`. The skill
 * came out of one pod and belongs to the project bound to it — installing it
 * globally would leak it into every other project on the machine.
 */
export function adoptedSkillPath(rel: string): string {
  return join(".pi", rel);
}

/**
 * Fingerprints an adopted skill from the files just written.
 *
 * Recorded like any other synced skill, so the `[DustSkills]` section can say
 * `synced` for it — and report `stale` once the user edits it locally, which is
 * the normal next step after the agent hands one over.
 */
function fingerprintAdopted(root: string, name: string, rels: readonly string[]): string {
  const prefix = `skills/${name}/`;
  return fingerprintSkill({
    name,
    description: "",
    baseDir: join(root, ".pi", "skills", name),
    filePath: join(root, ".pi", "skills", name, "SKILL.md"),
    files: rels.map((rel) => rel.slice(prefix.length)).sort(),
    bytes: 0,
  });
}

/**
 * Files the extension put in the pod for the agent, not the user's content.
 *
 * These must never be pulled onto disk: AGENTS.md is a rendering of the system
 * prompt and `skills/<name>/` holds copies of the user's own skill files, so
 * writing either into the project would litter it with tooling that then looks
 * like something they wrote.
 *
 * Matched against the synced set rather than the bare `skills/` prefix, so a
 * project that genuinely has a `skills/` directory still syncs it.
 */
export function isPodOwnedPath(rel: string, binding: DustPodBinding): boolean {
  return rel === POD_AGENTS_MD || isPodSkillPath(rel, binding.skills ?? []);
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
 * How many uploads may be in flight at once.
 *
 * One upload is up to four round trips (delete, reserve, PUT, move), so a
 * sequential ingest of a scaffolded tree spends nearly all its wall clock
 * waiting on the network. The ceiling is deliberately low: Dust rate-limits the
 * reserve step to 40 per 60 seconds per workspace, so the gain from a wider
 * pool is small and the cost — burning the whole window in a burst, then
 * stalling on 429 backoff — is not.
 */
export const POD_UPLOAD_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * A worker is expected to record its own per-item failures and resolve; only a
 * genuinely fatal condition (a dead session) should throw. When one does, no
 * further items are started and the first error is re-thrown once the already
 * running workers have settled — cancelling them mid-flight would leave uploads
 * that may or may not have landed, which is exactly the ambiguity the watermark
 * bookkeeping cannot tolerate.
 */
async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;

  const drain = async (): Promise<void> => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index] as T, index);
      } catch (err) {
        failure ??= err;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  if (failure !== null) throw failure;
}

/** What one upload attempt concluded; `null` while it has not been attempted. */
type UploadOutcome =
  | { ok: true; rel: string; hash: string }
  | { ok: false; rel: string; reason: string }
  | null;

/**
 * Uploads `relPaths` concurrently, reporting outcomes in *input* order.
 *
 * Completion order under concurrency is arbitrary, so results are collected by
 * index and folded in afterwards. Reporting them as they land would make the
 * transcript and the tests non-deterministic for no benefit.
 *
 * Progress is counted when an upload settles, never when it is dispatched: a
 * counter incremented on dispatch would mean "this many started", racing the
 * footer to n/n while files were still in flight.
 */
async function uploadAll(
  api: PodApi,
  root: string,
  podId: string,
  relPaths: readonly string[],
  onProgress?: SyncProgress,
  progressBase = 0,
  progressTotal = relPaths.length,
): Promise<{ outcomes: UploadOutcome[]; fatal: unknown }> {
  const outcomes: UploadOutcome[] = new Array(relPaths.length).fill(null);
  let done = progressBase;
  const step = (): void => onProgress?.(++done, progressTotal);

  let fatal: unknown = null;
  try {
    await forEachConcurrently(relPaths, POD_UPLOAD_CONCURRENCY, async (rel, index) => {
      const local = readLocal(root, rel);
      if (!local) {
        step();
        return;
      }
      try {
        await uploadPodFile(api, podId, rel, local);
        outcomes[index] = { ok: true, rel, hash: hashOf(local) };
      } catch (err) {
        // A dead session is not a per-file problem and must not be swallowed as
        // one — every remaining file would "fail" too, for the same reason.
        if (err instanceof Error && err.message === SESSION_EXPIRED_MESSAGE) throw err;
        outcomes[index] = { ok: false, rel, reason: errorMessage(err) };
      }
      step();
    });
  } catch (err) {
    fatal = err;
  }

  return { outcomes, fatal };
}

/**
 * Folds upload outcomes into the report and the watermarks, in input order.
 *
 * Watermarks go in at `MAX_SAFE_INTEGER` and are settled from a fresh listing
 * by the caller. Only files that genuinely landed get one — a watermark for a
 * file that is not in the pod would make the next sync read it as
 * changed-on-both-sides and report a conflict that does not exist.
 */
function applyOutcomes(outcomes: readonly UploadOutcome[], binding: DustPodBinding, report: SyncReport): void {
  for (const outcome of outcomes) {
    if (outcome === null) continue;
    if (outcome.ok) {
      binding.seen[outcome.rel] = { podMs: Number.MAX_SAFE_INTEGER, hash: outcome.hash };
      report.pushed.push(outcome.rel);
    } else {
      report.skipped.push({ rel: outcome.rel, reason: outcome.reason });
    }
  }
}

/** Replaces the provisional MAX_SAFE_INTEGER watermarks with the pod's real mtimes. */
async function settleWatermarks(api: PodApi, binding: DustPodBinding): Promise<void> {
  for (const entry of await listPodFiles(api, binding.podId)) {
    const rel = toRelativePath(binding.podId, entry.path);
    const seen = binding.seen[rel];
    if (seen) binding.seen[rel] = { ...seen, podMs: entry.lastModifiedMs };
  }
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
  //
  // Re-running the same selection every push has no cap of its own — unlike
  // `/ingest`, which refuses over MAX_INGEST_FILES outright — so a bash command
  // that scaffolds thousands of files into a tracked, non-ignored directory
  // would otherwise queue every one of them against Dust's 40/min rate limit on
  // the very next turn. Applying the same cap here bounds that, and the
  // overage is reported rather than silently dropped.
  const rediscovered = push ? selectIngestableFiles(root, binding.pathspecs ?? []) : [];
  const discovered = rediscovered.slice(0, MAX_INGEST_FILES);
  const cappedCount = rediscovered.length - discovered.length;
  const total = entries.length + discovered.length;
  let done = 0;
  const step = (): void => options.onProgress?.(++done, total);

  // Skills the agent wrote for itself. Only on a pull: a push has no business
  // writing into the project's config directory, and the post-turn pull is
  // where the agent's own output arrives anyway.
  const adoptable = pull
    ? detectAdoptableSkills(entries.map((entry) => toRelativePath(binding.podId, entry.path)), binding, root)
    : new Map<string, string[]>();
  const adoptedPaths = new Set([...adoptable.values()].flat());

  for (const entry of entries) {
    step();
    const rel = toRelativePath(binding.podId, entry.path);

    // `rel` is whatever the agent wrote through the pod's free tools — never
    // something we chose — so a `../../.ssh/authorized_keys` style path has to
    // be caught before it is joined onto `root` anywhere, including the
    // adopted-skill branch below. Skipping the one bad entry keeps the rest of
    // the sync intact rather than failing the whole run over it.
    if (!isPodPathSafe(root, rel)) {
      debugLog("dust:pod", "Skipping pod entry whose path escapes the project root", { root, rel });
      report.skipped.push({ rel, reason: "path escapes the project root" });
      continue;
    }

    // Ours, not theirs: neither pulled down nor treated as a conflict.
    if (isPodOwnedPath(rel, binding)) continue;

    // An adopted skill goes to `.pi/skills/…` rather than its literal pod path,
    // which is the whole point — `<root>/skills/` is not somewhere pi looks.
    if (adoptedPaths.has(rel)) {
      const content = await downloadPodFile(api, binding.podId, rel);
      writeLocal(root, adoptedSkillPath(rel), content);
      seen[rel] = { podMs: entry.lastModifiedMs, hash: hashOf(content) };
      continue;
    }
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

  if (adoptable.size > 0) {
    // Registering them is what makes the adoption complete. Without it pi would
    // discover the skill on disk while AGENTS.md kept omitting it — the agent
    // would have written a skill it cannot see — and the next sync would treat
    // the pod's copy as an untracked file all over again.
    const names = [...adoptable.keys()].sort();
    binding.skills = [...(binding.skills ?? []), ...names].sort();
    binding.skillFingerprints = {
      ...binding.skillFingerprints,
      ...Object.fromEntries(names.map((name) => [name, fingerprintAdopted(root, name, adoptable.get(name) ?? [])])),
    };
    // The instructions list the synced skills, so they are now out of date.
    binding.agentsMdHash = undefined;
    report.adopted.push(...names);
  }

  if (push) {
    if (cappedCount > 0) {
      // Silently truncating would leave the user wondering why a scaffolded
      // file never reached the agent; naming the cap here reuses the same
      // surfacing `skipped` already gets everywhere else (console.error on the
      // automatic paths, a notify on `/ingest sync`).
      report.skipped.push({
        rel: "*",
        reason:
          `${rediscovered.length} files matched, over the ${MAX_INGEST_FILES} cap — `
          + `${cappedCount} were not queued. Narrow with /ingest <pathspec>.`,
      });
    }

    // Anything the pod does not have but the selection says it should: files we
    // already track that have vanished from the pod, and files the user has
    // created locally since the ingest. Re-running the same selection is what
    // makes a pod created for an empty directory usable — otherwise the first
    // file the user writes themselves would never reach the agent.
    const podPaths = new Set(entries.map((entry) => toRelativePath(binding.podId, entry.path)));
    const missing = new Set([...Object.keys(seen), ...discovered]);

    // Paths the pod already holds do no work, so they are counted off straight
    // away; the rest are counted as their uploads land, inside `uploadAll`.
    const toUpload: string[] = [];
    for (const rel of missing) {
      if (podPaths.has(rel)) step();
      else toUpload.push(rel);
    }

    const { outcomes, fatal } = await uploadAll(
      api,
      root,
      binding.podId,
      toUpload,
      options.onProgress,
      done,
      total,
    );

    // The pushed set has to reach `seen` before any throw: those files are in
    // the pod, and a watermark-less file that exists on both sides reads as
    // changed-on-both-sides — so dropping them would report the whole tree as
    // conflicted on the next sync.
    const pushReport = emptyReport();
    const pushBinding = { ...binding, seen };
    applyOutcomes(outcomes, pushBinding, pushReport);
    report.pushed.push(...pushReport.pushed);
    report.skipped.push(...pushReport.skipped);

    if (fatal !== null) {
      binding.seen = seen;
      savePodBinding(root, binding);
      throw fatal;
    }
  }

  if (report.pushed.length > 0) {
    // Settle the watermarks set to MAX_SAFE_INTEGER above.
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
  const { outcomes, fatal } = await uploadAll(api, root, binding.podId, relPaths, onProgress);

  // Whatever landed is recorded either way. On a dead session the run still
  // has to abort — but the files already in the pod are in it, and dropping
  // their watermarks would leave exactly the inconsistent state this function
  // exists to avoid.
  applyOutcomes(outcomes, binding, report);

  if (fatal !== null) {
    // No settling listing: the same dead session would fail that too.
    savePodBinding(root, binding);
    throw fatal;
  }

  await settleWatermarks(api, binding);
  savePodBinding(root, binding);
  return report;
}
