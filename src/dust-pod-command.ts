import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, resolve } from "node:path";
import { debugLog } from "./dust-debug.js";
import { archivePod, type PodApi, resolveOrCreatePod } from "./dust-pod.js";
import { describeReport, ingestFiles, isEmptyReport, syncPod } from "./dust-pod-sync.js";
import { podApiFor } from "./dust-pod-runtime.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { forgetPodBinding, getPodBinding, savePodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

/** Keeps a stray `/ingest` in a home directory from uploading a life's work. */
const MAX_INGEST_FILES = 500;
/** Pod files are read by an LLM; anything this large is a binary or a build artefact. */
const MAX_INGEST_BYTES = 256 * 1024;

/**
 * Candidate files for ingestion, as relative paths.
 *
 * `git ls-files` does the work where it can: it is gitignore-aware for free,
 * skips the index's own junk, and applies any pathspecs the user passed without
 * us implementing glob matching. `--others --exclude-standard` includes files
 * that are new but not ignored, so a freshly written file is offered too.
 */
function candidateFiles(root: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
      // stderr is swallowed: outside a repository git writes "fatal: not a git
      // repository" straight to the terminal, on top of the TUI, before we get
      // a chance to turn it into a notification.
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\0").filter((line) => line.length > 0);
  } catch (err) {
    debugLog("dust:pod", "git ls-files unavailable, refusing to walk the tree", {
      root,
      error: errorMessage(err),
    });
    return [];
  }
}

function withinSizeLimit(root: string, rel: string): boolean {
  try {
    const stat = statSync(resolve(root, rel));
    return stat.isFile() && stat.size <= MAX_INGEST_BYTES;
  } catch {
    return false;
  }
}

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
        notify(`Pod "${binding.name}" archived and unbound.`, "info");
        return;
      }

      // Bare `/ingest [pathspec…]`: pick files, resolve the pod, upload.
      const pathspecs = subcommand ? argv : [];
      const candidates = candidateFiles(root, pathspecs).filter((rel) => withinSizeLimit(root, rel));

      if (candidates.length === 0) {
        notify(
          pathspecs.length > 0
            ? `No files matched ${pathspecs.join(" ")} (or all were too large / ignored).`
            : `No files to ingest in ${root}. /ingest needs a git repository.`,
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
      const confirmed = await runtimeCtx.ui?.confirm?.(
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
        savePodBinding(root, binding);

        const report = await ingestFiles(api, root, binding, candidates);
        notify(`Ingested ${report.pushed.length} files into pod "${pod.name}".`, "info");
      } catch (err) {
        notify(`Ingest failed: ${errorMessage(err)}`, "error");
      }
    },
  });
}
