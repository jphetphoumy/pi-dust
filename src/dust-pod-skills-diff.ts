import {
  fingerprintSkill,
  podSkillPathsFor,
  splitPodSkillPath,
  type LocalSkill,
  type PodWatermark,
} from "./dust-pod-skills.js";
import { toRelativePath, type PodFileEntry } from "./dust-pod.js";

/**
 * The two-way state of a skill, comparing disk against the pod.
 *
 * `[DustSkills]` (`dust-pod-skills-banner.ts`) only ever compares disk against
 * the digest recorded at sync time — it never contacts the pod, so a pod-side
 * edit or deletion is invisible to it. This is the honest version: it costs one
 * `listPodFiles` call (never a per-file download, which would reintroduce the
 * one-request-per-file cost `/dust-skills sync` already pays) and can tell the
 * two sides apart.
 *
 * - `synced` — both a local fingerprint and at least one pod watermark are on
 *   record, and neither side has moved since.
 * - `local-changed` / `pod-changed` / `both-changed` — one or both sides moved.
 *   `both-changed` is worth calling out on its own: the next `syncPod` treats
 *   that as a conflict and leaves both copies alone rather than picking a
 *   winner, so it is not just "changed twice", it is "nothing will happen
 *   automatically about this".
 * - `pod-only` — a skill-shaped subtree lives in the pod with nothing on disk
 *   to match it (e.g. deleted locally after being synced from another clone).
 * - `local-only` — a selected local skill with no files in the pod at all
 *   (e.g. the initial upload never landed, or everything was removed there).
 * - `missing` — recorded as synced but present on neither side.
 * - `unverified` — present on both sides but with no recorded baseline for at
 *   least one of them, so a comparison is not something we can actually vouch
 *   for either way.
 */
export type SkillDiffState =
  | "synced"
  | "local-changed"
  | "pod-changed"
  | "both-changed"
  | "pod-only"
  | "local-only"
  | "missing"
  | "unverified";

export interface SkillDiff {
  name: string;
  state: SkillDiffState;
  /** 0 when the skill has no local copy. */
  localFileCount: number;
  /** Live entries found under `skills/<name>/` in the pod listing. */
  podFileCount: number;
  /** Skill-relative paths added or modified in the pod since their watermark. */
  podChangedFiles: string[];
  /** Skill-relative paths that had a watermark but are gone from the pod. */
  podDeletedFiles: string[];
}

/** The parts of `DustPodBinding` this comparison reads. */
export interface SkillDiffBinding {
  skills?: string[];
  skillFingerprints?: Record<string, string>;
  seen: Record<string, PodWatermark>;
}

/**
 * Whether a pod subtree is actually a skill, not just files that happen to
 * live under `skills/<name>/`.
 *
 * Same bar `detectAdoptableSkills` uses in `dust-pod-sync.ts`: `skills/` is a
 * plausible project directory in its own right, so a bare `SKILL.md` check is
 * the difference between reporting a real skill and reporting someone's
 * unrelated project tree as `pod-only`.
 */
function isSkillShaped(name: string, podRels: readonly string[]): boolean {
  return podRels.includes(`${podSkillPathsFor(name)}SKILL.md`);
}

/**
 * Compares every selected or pod-resident skill against the pod's live
 * listing, one `listPodFiles` call already done by the caller.
 *
 * The universe of names compared is `binding.skills` union whatever
 * skill-shaped subtrees the pod holds — never every skill discovered on disk.
 * An unselected local skill has no relationship with this pod at all, and
 * listing it would just be noise (and, worse, could collide with an unrelated
 * project `skills/<name>/` directory of the same name).
 *
 * `fingerprint` is injected, like `buildDustSkillsBanner`'s own hook, so
 * hashing — which reads every file of every skill reaching the four-way
 * comparison below — is skippable in tests and never runs for a skill that is
 * `pod-only`, `local-only`, or `missing`.
 */
export function diffSkills(args: {
  local: LocalSkill[];
  binding: SkillDiffBinding;
  podEntries: PodFileEntry[];
  podId: string;
  fingerprint?: (skill: LocalSkill) => string;
}): SkillDiff[] {
  const { local, binding, podEntries, podId, fingerprint = fingerprintSkill } = args;

  const localByName = new Map(local.map((skill) => [skill.name, skill]));
  const podRels = podEntries.map((entry) => toRelativePath(podId, entry.path));
  const podMsByRel = new Map(podRels.map((rel, i) => [rel, podEntries[i].lastModifiedMs]));

  const podNamesByGroup = new Map<string, string[]>();
  for (const rel of podRels) {
    const split = splitPodSkillPath(rel);
    if (!split) continue;
    const group = podNamesByGroup.get(split.name) ?? [];
    group.push(rel);
    podNamesByGroup.set(split.name, group);
  }
  const podSkillNames = [...podNamesByGroup.keys()].filter((name) =>
    isSkillShaped(name, podNamesByGroup.get(name) ?? []),
  );

  const names = new Set([...(binding.skills ?? []), ...podSkillNames]);

  const diffs: SkillDiff[] = [];
  for (const name of names) {
    const localSkill = localByName.get(name);
    const podRelsForSkill = podNamesByGroup.get(name) ?? [];
    const prefix = podSkillPathsFor(name);
    const watermarks = Object.entries(binding.seen).filter(([rel]) => rel.startsWith(prefix));

    // `missing` takes precedence over `pod-only`/`local-only`: a skill can
    // have stale watermarks (never pruned outside a real sync) with nothing
    // left on either side, and "pod-only, 0 files" would be self-contradictory.
    if (!localSkill && podRelsForSkill.length === 0) {
      diffs.push({
        name,
        state: "missing",
        localFileCount: 0,
        podFileCount: 0,
        podChangedFiles: [],
        podDeletedFiles: [],
      });
      continue;
    }

    if (!localSkill) {
      diffs.push({
        name,
        state: "pod-only",
        localFileCount: 0,
        podFileCount: podRelsForSkill.length,
        podChangedFiles: [],
        podDeletedFiles: [],
      });
      continue;
    }

    if (podRelsForSkill.length === 0 && watermarks.length === 0) {
      diffs.push({
        name,
        state: "local-only",
        localFileCount: localSkill.files.length,
        podFileCount: 0,
        podChangedFiles: [],
        podDeletedFiles: [],
      });
      continue;
    }

    const podKnown = watermarks.length > 0;

    // Without any recorded watermark there is nothing to compare the listing
    // against — reporting every file as "changed" would be a worse lie than
    // reporting nothing, so the pod side stays empty and `unverified` wins
    // below instead.
    const podChangedFiles = podKnown
      ? podRelsForSkill
          .filter((rel) => {
            const watermark = binding.seen[rel];
            return !watermark || (podMsByRel.get(rel) ?? 0) > watermark.podMs;
          })
          .map((rel) => rel.slice(prefix.length))
          .sort()
      : [];
    const podDeletedFiles = podKnown
      ? watermarks
          .filter(([rel]) => !podMsByRel.has(rel))
          .map(([rel]) => rel.slice(prefix.length))
          .sort()
      : [];

    const podChanged = podChangedFiles.length > 0 || podDeletedFiles.length > 0;

    const recorded = binding.skillFingerprints?.[name];
    const localKnown = recorded !== undefined;
    const localChanged = localKnown && recorded !== fingerprint(localSkill);

    let state: SkillDiffState;
    if (localChanged && podChanged) state = "both-changed";
    else if (localChanged) state = "local-changed";
    else if (podChanged) state = "pod-changed";
    else if (!localKnown || !podKnown) state = "unverified";
    else state = "synced";

    diffs.push({
      name,
      state,
      localFileCount: localSkill.files.length,
      podFileCount: podRelsForSkill.length,
      podChangedFiles,
      podDeletedFiles,
    });
  }

  return diffs.sort((a, b) => a.name.localeCompare(b.name));
}

function describeState(diff: SkillDiff): string {
  const { state, localFileCount, podFileCount, podChangedFiles, podDeletedFiles } = diff;
  switch (state) {
    case "synced":
      return `synced (${localFileCount} file${localFileCount === 1 ? "" : "s"})`;
    case "local-changed":
      return `local-changed (${localFileCount} file${localFileCount === 1 ? "" : "s"} on disk)`;
    case "pod-changed":
      return `pod-changed (${describePodChange(podChangedFiles, podDeletedFiles)})`;
    case "both-changed":
      return `both-changed (${localFileCount} file${localFileCount === 1 ? "" : "s"} on disk changed, ${describePodChange(podChangedFiles, podDeletedFiles)})`;
    case "pod-only":
      return `pod-only (${podFileCount} file${podFileCount === 1 ? "" : "s"}) — not on disk`;
    case "local-only":
      return `local-only (${localFileCount} file${localFileCount === 1 ? "" : "s"}) — nothing left in the pod`;
    case "missing":
      return "missing — recorded as synced, present neither on disk nor in the pod";
    case "unverified":
      return "unverified — synced before fingerprints were recorded";
  }
}

function describePodChange(changed: string[], deleted: string[]): string {
  const parts: string[] = [];
  if (changed.length > 0) parts.push(`${changed.length} changed`);
  if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
  return `${parts.join(", ")} in the pod`;
}

/**
 * Renders `diffSkills`' result as the single multi-line notice
 * `/dust-skills diff` shows, matching `[DustSkills]`'s own hint sentence where
 * the advice is the same so the two never read as contradicting each other.
 */
export function formatSkillDiff(diffs: SkillDiff[], podName: string): string {
  if (diffs.length === 0) {
    return "No skills are synced into this pod yet. Run /dust-skills to choose some.";
  }

  const lines = [`Skills in pod "${podName}":`, ...diffs.map((diff) => `  ${diff.name}: ${describeState(diff)}`)];

  // A pod-side deletion is not something `syncPod` ever repairs on its own:
  // its push side explicitly skips a synced skill's own paths, and there is
  // nothing to pull back for a file that no longer exists anywhere to
  // download from. Only an explicit `/dust-skills sync` re-uploads it, so a
  // deletion has to earn the same hint a local edit does — the other
  // pod-changed case (an addition or modification) genuinely is pulled down
  // by the ordinary background sync, and does not need re-uploading.
  const hasPodDeletion = diffs.some((diff) => diff.podDeletedFiles.length > 0);
  const needsSync = hasPodDeletion || diffs.some((diff) =>
    diff.state === "local-changed" || diff.state === "local-only" || diff.state === "unverified" || diff.state === "missing",
  );
  if (needsSync) lines.push("Run /dust-skills sync to bring the pod up to date.");

  const hasPulledChange = diffs.some((diff) => diff.podChangedFiles.length > 0);
  if (hasPulledChange) {
    lines.push("Pod-side edits are pulled by the next sync.");
  }

  const bothChanged = diffs.filter((diff) => diff.state === "both-changed").map((diff) => diff.name);
  if (bothChanged.length > 0) {
    lines.push(
      `Both sides moved for ${bothChanged.join(", ")} — the next sync reports that as a conflict rather than picking a winner.`,
    );
  }

  return lines.join("\n");
}
