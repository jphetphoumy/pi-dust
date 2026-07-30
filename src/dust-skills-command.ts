import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PodApi } from "./dust-pod.js";
import { podProgressReporter, refreshPodStatus } from "./dust-pod-status.js";
import { podApiFor } from "./dust-pod-runtime.js";
import {
  discoverLocalSkills,
  type LocalSkill,
  MAX_SKILL_FILES,
  syncSkillsToPod,
} from "./dust-pod-skills.js";
import { openListPanel } from "./dust-pod-ui.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { getPodBinding, savePodBinding } from "./dust-state.js";
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
 */
export function registerDustSkillsCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("dust-skills", {
    description: "Choose which pi skills to sync into the Dust Pod, so the agent reads them for free",
    handler: async (_args, ctx) => {
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

      try {
        const result = await syncSkillsToPod(
          api,
          binding.podId,
          chosen,
          podProgressReporter(runtime, binding.name),
        );
        // Recorded so the next turn's AGENTS.md lists exactly these, and so the
        // picker reopens with them already ticked.
        binding.skills = chosen.map((skill) => skill.name);
        // The instructions have to be rewritten now the skill set has moved.
        binding.agentsMdHash = undefined;
        savePodBinding(root, binding);
        refreshPodStatus(runtime, root);

        notify(
          chosen.length === 0
            ? "No skills synced. The pod's agent will be offered none."
            : `Synced ${chosen.length} skill${chosen.length === 1 ? "" : "s"} (${result.uploaded.length} files) into "${binding.name}".`,
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
