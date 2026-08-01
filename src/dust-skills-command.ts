import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PodApi } from "./dust-pod.js";
import { podProgressReporter, refreshPodStatus } from "./dust-pod-status.js";
import { podApiFor } from "./dust-pod-runtime.js";
import {
  discoverLocalSkills,
  fingerprintSkill,
  type LocalSkill,
  MAX_SKILL_FILES,
  podSkillPathsFor,
  removeSkillsFromPod,
  syncSkillsToPod,
} from "./dust-pod-skills.js";
import { openListPanel } from "./dust-pod-ui.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { type DustPodBinding, getPodBinding, savePodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function skillDetail(skill: LocalSkill): string {
  return `${formatSize(skill.bytes)}, ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}`;
}

/** Digests for exactly `chosen`, so a de-selected skill leaves no stale claim. */
function fingerprintsFor(chosen: LocalSkill[]): Record<string, string> {
  return Object.fromEntries(chosen.map((skill) => [skill.name, fingerprintSkill(skill)]));
}

/**
 * `/dust-skills sync` — re-upload the skills already selected.
 *
 * The pod's copy of a skill is a snapshot taken when it was synced. Editing the
 * skill locally afterwards leaves that snapshot in place, and since the agent
 * reads the pod rather than the disk it goes on following the old version with
 * nothing to say so. This is the fix, and it deliberately skips the picker: the
 * selection is not what changed.
 *
 * A skill recorded as synced but no longer on disk is dropped rather than
 * carried: it cannot be re-uploaded, and leaving it in `skills` would keep
 * AGENTS.md pointing the agent at a directory the pod no longer has a source
 * for.
 */
async function resyncSelectedSkills(args: {
  api: PodApi;
  binding: DustPodBinding;
  root: string;
  available: LocalSkill[];
  runtime: DustSessionRuntime;
  notify: (message: string, level?: string) => void;
}): Promise<void> {
  const { api, binding, root, available, runtime, notify } = args;
  const selected = binding.skills ?? [];

  if (selected.length === 0) {
    notify("No skills are synced into this pod yet. Run /dust-skills to choose some.", "info");
    return;
  }

  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const chosen = selected.map((name) => byName.get(name)).filter((skill): skill is LocalSkill => skill !== undefined);
  const missing = selected.filter((name) => !byName.has(name));

  try {
    const result = await syncSkillsToPod(
      api,
      binding.podId,
      chosen,
      podProgressReporter(runtime, binding.name),
    );
    binding.skills = chosen.map((skill) => skill.name);
    binding.skillFingerprints = fingerprintsFor(chosen);
    // Seeds a watermark for every uploaded file. Without it, a pod-side edit
    // made before the next sync reads as changed-on-both-sides (no watermark,
    // local file present) and is reported as a conflict instead of pulled.
    binding.seen = { ...binding.seen, ...result.seen };
    // The pod's copies moved, so the instructions have to be rewritten — and
    // when a skill was dropped, the listing itself is now wrong.
    binding.agentsMdHash = undefined;
    savePodBinding(root, binding);
    refreshPodStatus(runtime, root);

    notify(
      `Re-synced ${chosen.length} skill${chosen.length === 1 ? "" : "s"} ` +
        `(${result.uploaded.length} files) into "${binding.name}".`,
      "info",
    );
    if (missing.length > 0) {
      notify(`Dropped ${missing.join(", ")} — no longer on disk.`, "warning");
    }
    for (const { rel, reason } of result.skipped) {
      notify(`Skipped ${rel}: ${reason}`, "warning");
    }
  } catch (err) {
    notify(`Skill re-sync failed: ${errorMessage(err)}`, "error");
  }
}

/**
 * `/dust-skills` — choose which of pi's skills to put in the pod.
 *
 * Selected skills are the only ones the pod's AGENTS.md offers, and the agent
 * reads them with the free `files__*` tools. Unselected skills are not offered
 * to the Dust agent at all, which is the trade: fewer prompt tokens and no
 * billed reads, in exchange for deciding up front what this project needs.
 *
 * The size and file count are on every row because a skill directory can be
 * megabytes — uploads are one request per file, so picking a large one is a
 * minutes-long operation the user should be able to see coming.
 *
 * `/dust-skills sync` re-uploads the current selection without the picker. Once
 * a skill is in the pod, editing it locally leaves the pod's copy behind — the
 * agent goes on reading the old version — and re-ticking the same boxes to fix
 * that is busywork. This is also what refreshes the fingerprints the
 * `[DustSkills]` section checks.
 */
export function registerDustSkillsCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("dust-skills", {
    description: "Choose which pi skills to sync into the Dust Pod (`sync` re-uploads the current set)",
    handler: async (args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const notify = (message: string, level = "info"): void =>
        runtimeCtx.ui?.notify?.(message, level);
      const root = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();

      const binding = getPodBinding(root);
      if (!binding) {
        notify(`No pod bound to ${root}. Run /ingest first.`, "warning");
        return;
      }

      let api: PodApi;
      try {
        api = podApiFor(runtime);
      } catch (err) {
        notify(errorMessage(err), "warning");
        return;
      }

      const available = discoverLocalSkills(root);

      if (args.trim().toLowerCase() === "sync") {
        await resyncSelectedSkills({ api, binding, root, available, runtime, notify });
        return;
      }

      if (available.length === 0) {
        notify("No pi skills found to sync.", "info");
        return;
      }

      const alreadySynced = new Set(binding.skills ?? []);
      const picked = await openListPanel(runtimeCtx, {
        title: `Sync skills into pod "${binding.name}"`,
        rows: available.map((skill) => ({
          label: skill.name,
          detail: skillDetail(skill),
          selected: alreadySynced.has(skill.name),
          value: skill.name,
        })),
        selectable: true,
      });

      if (picked === null) {
        notify("Choosing skills needs an interactive terminal.", "warning");
        return;
      }
      if (picked === undefined) return;

      const chosenNames = new Set(picked.map((row) => String(row.value)));
      const chosen = available.filter((skill) => chosenNames.has(skill.name));
      const fileCount = chosen.reduce((sum, skill) => sum + skill.files.length, 0);
      if (fileCount > MAX_SKILL_FILES) {
        notify(
          `That selection is ${fileCount} files, over the ${MAX_SKILL_FILES} limit — ` +
            "uploads are one request each. Pick fewer skills.",
          "warning",
        );
        return;
      }

      // `skills/` is a plausible project directory, so a skill whose name
      // collides with one the user already tracks there would have its files
      // overwritten by ours — and then excluded from syncing back down.
      //
      // Kept to watermarks with a real file on disk at that path: a
      // currently-synced skill's own watermarks under `skills/<name>/` route
      // back to that skill's real local directory instead (see
      // `syncSyncedSkillEntry` in dust-pod-sync.ts), so nothing exists at the
      // literal pod path — re-picking a skill the user already selected must
      // not trip a false "you already have files there" warning. Filtering by
      // name alone would also excuse a genuine collision with a project
      // `skills/<name>/` directory that happens to share a synced skill's
      // name, which is exactly the case this check exists to catch.
      const tracked = Object.keys(binding.seen).filter((rel) => existsSync(join(root, rel)));
      const collisions = chosen
        .map((skill) => skill.name)
        .filter((name) => tracked.some((rel) => rel.startsWith(podSkillPathsFor(name))));
      if (collisions.length > 0) {
        notify(
          `Your project already has files under skills/${collisions[0]}/. ` +
            "Syncing that skill would overwrite them — rename one of the two.",
          "warning",
        );
        return;
      }

      try {
        // De-selected skills are deleted, not merely dropped from the listing,
        // or their files would sit in the pod for good.
        const dropped = (binding.skills ?? []).filter((name) => !chosenNames.has(name));
        const removed = await removeSkillsFromPod(api, binding.podId, dropped);

        const result = await syncSkillsToPod(
          api,
          binding.podId,
          chosen,
          podProgressReporter(runtime, binding.name),
        );
        // Recorded so the next turn's AGENTS.md lists exactly these, and so the
        // picker reopens with them already ticked.
        binding.skills = chosen.map((skill) => skill.name);
        // Built fresh from `chosen`, never merged into the previous map: a
        // de-selected skill's files are deleted from the pod, so keeping its
        // digest would claim a skill is synced when it is gone.
        binding.skillFingerprints = fingerprintsFor(chosen);
        // Seeds a watermark for every uploaded file — see the note on
        // `syncSkillsToPod` — and drops a de-selected skill's own watermarks,
        // since `removeSkillsFromPod` just deleted those files from the pod.
        binding.seen = Object.fromEntries(
          Object.entries({ ...binding.seen, ...result.seen })
            .filter(([rel]) => !dropped.some((name) => rel.startsWith(podSkillPathsFor(name)))),
        );
        // The instructions have to be rewritten now the skill set has moved.
        binding.agentsMdHash = undefined;
        savePodBinding(root, binding);
        refreshPodStatus(runtime, root);

        const removedNote = removed.length > 0
          ? ` Removed ${removed.length} file${removed.length === 1 ? "" : "s"} from ${dropped.length} de-selected.`
          : "";
        notify(
          (chosen.length === 0
            ? "No skills synced. The pod's agent will be offered none."
            : `Synced ${chosen.length} skill${chosen.length === 1 ? "" : "s"} (${result.uploaded.length} files) into "${binding.name}".`) + removedNote,
          "info",
        );
        for (const { rel, reason } of result.skipped) {
          notify(`Skipped ${rel}: ${reason}`, "warning");
        }
      } catch (err) {
        notify(`Skill sync failed: ${errorMessage(err)}`, "error");
      }
    },
  });
}
