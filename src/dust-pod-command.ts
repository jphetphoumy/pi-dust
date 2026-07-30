import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { archivePod, type PodApi, resolveOrCreatePod } from "./dust-pod.js";
import { MAX_INGEST_FILES, selectIngestableFiles } from "./dust-pod-files.js";
import { clearPodStatus, refreshPodStatus } from "./dust-pod-status.js";
import { describeReport, ingestFiles, isEmptyReport, syncPod } from "./dust-pod-sync.js";
import { podApiFor } from "./dust-pod-runtime.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { forgetPodBinding, getPodBinding, savePodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

function podNameFor(root: string): string {
  return basename(root);
}

export function registerDustIngestCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("ingest", {
    description: "Upload files to a Dust Pod so the agent edits them with free tools",
    handler: async (args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const notify = (message: string, level = "info"): void =>
        runtimeCtx.ui?.notify?.(message, level);
      const root = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
      const argv = String(args ?? "").trim().split(/\s+/).filter((arg) => arg.length > 0);
      const subcommand = argv[0];

      let api: PodApi;
      try {
        api = podApiFor(runtime);
      } catch (err) {
        notify(errorMessage(err), "warning");
        return;
      }

      if (subcommand === "status") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}. Run /ingest to create one.`, "info");
          return;
        }
        notify(
          `Pod "${binding.name}" (${binding.podId}) — ${Object.keys(binding.seen).length} files tracked.`,
          "info",
        );
        return;
      }

      if (subcommand === "sync") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}. Run /ingest first.`, "warning");
          return;
        }
        try {
          const report = await syncPod(api, root, binding);
          refreshPodStatus(runtime, root, report);
          notify(isEmptyReport(report) ? "Pod already in sync." : describeReport(report), "info");
          for (const rel of report.conflicted) {
            notify(`Conflict (changed on both sides, left alone): ${rel}`, "warning");
          }
        } catch (err) {
          notify(`Pod sync failed: ${errorMessage(err)}`, "error");
        }
        return;
      }

      if (subcommand === "clear") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}.`, "info");
          return;
        }
        const confirmed = await runtimeCtx.ui?.confirm?.(
          "Archive Dust pod",
          `Archive pod "${binding.name}" and stop routing files through it?\n` +
            "Local files are untouched. The pod can be restored from the Dust UI.",
        );
        if (!confirmed) return;
        try {
          await archivePod(api, binding.podId);
        } catch (err) {
          // The binding still goes, or the session would stay pointed at a pod
          // the user has asked to be rid of.
          notify(`Pod archive failed (unbinding anyway): ${errorMessage(err)}`, "warning");
        }
        forgetPodBinding(root);
        clearPodStatus(runtime);
        notify(`Pod "${binding.name}" archived and unbound.`, "info");
        return;
      }

      // Bare `/ingest [pathspec…]`: pick files, resolve the pod, upload.
      const pathspecs = subcommand ? argv : [];
      const candidates = selectIngestableFiles(root, pathspecs);

      // An empty directory still gets a pod. Nothing is uploaded, but the
      // binding is what turns pod mode on, and without it a new project would
      // fall back to our billed write tool for every file the agent creates —
      // exactly the case where the free tools are worth the most. A pathspec
      // that matches nothing is different: the user named something specific,
      // and silently binding the whole directory would not be what they asked
      // for.
      if (candidates.length === 0 && pathspecs.length > 0) {
        notify(
          `No files matched ${pathspecs.join(" ")} (or all were too large / ignored).`,
          "warning",
        );
        return;
      }
      if (candidates.length > MAX_INGEST_FILES) {
        notify(
          `${candidates.length} files matched, over the ${MAX_INGEST_FILES} limit. ` +
            "Narrow it, e.g. /ingest src test.",
          "warning",
        );
        return;
      }

      const preview = candidates.slice(0, 20).join("\n");
      const more = candidates.length > 20 ? `\n… and ${candidates.length - 20} more` : "";
      const confirmed = candidates.length === 0
        ? await runtimeCtx.ui?.confirm?.(
            `Create empty Dust pod "${podNameFor(root)}"`,
            `${root} has nothing to upload yet.\n\nCreating the pod now lets the agent write new ` +
              "files with its free tools instead of the billed local ones; they are synced down " +
              "to this directory as it goes.",
          )
        : await runtimeCtx.ui?.confirm?.(
            `Upload ${candidates.length} files to Dust pod "${podNameFor(root)}"`,
            `${preview}${more}\n\nThese files are copied to your Dust workspace so the agent can ` +
              "read and edit them with its free tools.",
          );
      if (!confirmed) return;

      try {
        const pod = await resolveOrCreatePod(api, podNameFor(root));
        const binding = getPodBinding(root) ?? { podId: pod.sId, name: pod.name, seen: {} };
        // A pod resolved by name may differ from the one recorded earlier (the
        // old one archived, say), so the binding always takes the live ids.
        binding.podId = pod.sId;
        binding.name = pod.name;
        binding.pathspecs = pathspecs.length > 0 ? pathspecs : undefined;
        savePodBinding(root, binding);

        const report = await ingestFiles(api, root, binding, candidates);
        refreshPodStatus(runtime, root, report);
        notify(
          candidates.length === 0
            ? `Created empty pod "${pod.name}". New files the agent writes will sync here.`
            : `Ingested ${report.pushed.length} files into pod "${pod.name}".`,
          "info",
        );
        // A file the pod refused is not a failed ingest, but the user has to
        // know it is not there — the agent will not see it.
        for (const { rel, reason } of report.skipped) {
          notify(`Skipped ${rel}: ${reason}`, "warning");
        }
      } catch (err) {
        notify(`Ingest failed: ${errorMessage(err)}`, "error");
      }
    },
  });
}
