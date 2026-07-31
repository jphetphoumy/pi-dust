import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPodPathSafe } from "./dust-pod-files.js";
import {
  archivePod,
  deletePod,
  deletePodFile,
  downloadPodFile,
  listPodFiles,
  listPods,
  type PodApi,
  type PodRef,
  toRelativePath,
  unarchivePod,
} from "./dust-pod.js";
import type { DustPodListPanel, ListRow } from "./dust-pod-list-panel.js";
import { clearPodStatus, refreshPodStatus } from "./dust-pod-status.js";
import { podApiFor } from "./dust-pod-runtime.js";
import { openListPanel, supportsPanels } from "./dust-pod-ui.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { forgetPodBinding, getPodBinding, savePodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rootOf(runtime: DustSessionRuntime): string {
  return (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
}

/**
 * Forgets a file's sync watermark.
 *
 * Deleting a pod file without this leaves an entry in `seen`, and the pre-turn
 * push treats a tracked path missing from the pod as one to re-upload — so the
 * file the user just deleted would come straight back on the next turn.
 */
function forgetWatermark(root: string, rel: string): void {
  const binding = getPodBinding(root);
  if (!binding?.seen[rel]) return;
  delete binding.seen[rel];
  savePodBinding(root, binding);
}

/** `/podfs` — browse the bound pod's files, pull them down, or delete them. */
export function registerDustPodFsCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("podfs", {
    description: "Browse the Dust Pod's files — pull one back to disk, or delete it",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const notify = (message: string, level = "info"): void =>
        runtimeCtx.ui?.notify?.(message, level);
      const root = rootOf(runtime);

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

      const toRows = async (): Promise<ListRow[]> => {
        const files = await listPodFiles(api, binding.podId);
        return files
          .map((file) => ({
            label: toRelativePath(binding.podId, file.path),
            detail: formatBytes(file.sizeBytes),
            value: toRelativePath(binding.podId, file.path),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
      };

      let rows: ListRow[];
      try {
        rows = await toRows();
      } catch (err) {
        notify(`Could not list pod files: ${errorMessage(err)}`, "error");
        return;
      }

      if (!supportsPanels(runtimeCtx)) {
        notify(
          rows.length === 0
            ? `Pod "${binding.name}" is empty.`
            : `Pod "${binding.name}":\n${rows.map((row) => `  ${row.label}  ${row.detail}`).join("\n")}`,
          "info",
        );
        return;
      }

      let panel: DustPodListPanel | null = null;
      const reload = async (): Promise<void> => {
        panel?.setRows(await toRows());
      };

      await openListPanel(
        runtimeCtx,
        {
          title: `Pod "${binding.name}" files`,
          rows,
          emptyMessage: "This pod holds no files yet.",
          actions: [
            {
              key: "p",
              label: "pull",
              run: async (row) => {
                const rel = String(row.value);
                // `rel` is a pod-reported path, not one the user typed — a
                // `../../.ssh/authorized_keys` style entry must not be joined
                // onto `root` and written just because the user pressed `p`.
                if (!isPodPathSafe(root, rel)) {
                  panel?.setBusy(`Pull failed: ${rel} escapes the project root`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                  return;
                }
                panel?.setBusy(`Pulling ${rel}…`);
                try {
                  const content = await downloadPodFile(api, binding.podId, rel);
                  const path = join(root, rel);
                  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
                  writeFileSync(path, content);
                  panel?.setBusy(`Pulled ${rel} to ${root}`);
                } catch (err) {
                  panel?.setBusy(`Pull failed: ${errorMessage(err)}`);
                }
                setTimeout(() => panel?.setBusy(null), 1500);
              },
            },
            {
              key: "d",
              label: "delete",
              run: async (row) => {
                const rel = String(row.value);
                panel?.setBusy(`Deleting ${rel}…`);
                try {
                  await deletePodFile(api, binding.podId, rel);
                  // Drop the watermark too, or the next push restores it.
                  forgetWatermark(root, rel);
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  panel?.setBusy(`Delete failed: ${errorMessage(err)}`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                }
              },
            },
            {
              key: "r",
              label: "reload",
              run: async () => {
                panel?.setBusy("Reloading…");
                try {
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  panel?.setBusy(`Reload failed: ${errorMessage(err)}`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                }
              },
            },
          ],
        },
        (created) => {
          panel = created;
        },
      );

      refreshPodStatus(runtime, root);
    },
  });
}

function podRow(pod: PodRef, boundPodId: string | undefined): ListRow {
  const marks: string[] = [];
  if (pod.sId === boundPodId) marks.push("bound");
  if (pod.archivedAt != null) marks.push("archived");
  return {
    label: pod.name,
    detail: marks.length > 0 ? `${pod.sId}  (${marks.join(", ")})` : pod.sId,
    value: pod,
  };
}

/**
 * `/pods` — the workspace's pods, with the destructive operations behind a
 * confirmation.
 *
 * Separate from `/podfs` because the two lists answer different questions: one
 * is "what is in this project's pod", the other "what pods do I have". Folding
 * them into one panel would mean a row meaning two different things depending
 * on a mode the user has to keep track of.
 */
export function registerDustPodsCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("pods", {
    description: "Manage Dust Pods — archive, restore, or delete them",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const notify = (message: string, level = "info"): void =>
        runtimeCtx.ui?.notify?.(message, level);
      const root = rootOf(runtime);

      let api: PodApi;
      try {
        api = podApiFor(runtime);
      } catch (err) {
        notify(errorMessage(err), "warning");
        return;
      }

      const toRows = async (): Promise<ListRow[]> => {
        const bound = getPodBinding(root)?.podId;
        return (await listPods(api))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((pod) => podRow(pod, bound));
      };

      let rows: ListRow[];
      try {
        rows = await toRows();
      } catch (err) {
        notify(`Could not list pods: ${errorMessage(err)}`, "error");
        return;
      }

      if (!supportsPanels(runtimeCtx)) {
        notify(
          rows.length === 0
            ? "No pods in this workspace."
            : `Pods:\n${rows.map((row) => `  ${row.label}  ${row.detail}`).join("\n")}`,
          "info",
        );
        return;
      }

      let panel: DustPodListPanel | null = null;
      const reload = async (): Promise<void> => {
        panel?.setRows(await toRows());
      };

      /** Unbinds this project if the pod it points at has just gone. */
      const unbindIfBound = (pod: PodRef): void => {
        if (getPodBinding(root)?.podId !== pod.sId) return;
        forgetPodBinding(root);
        clearPodStatus(runtime);
      };

      await openListPanel(
        runtimeCtx,
        {
          title: "Dust pods",
          rows,
          emptyMessage: "No pods in this workspace yet.",
          actions: [
            {
              key: "a",
              label: "archive",
              run: async (row) => {
                const pod = row.value as PodRef;
                panel?.setBusy(`Archiving ${pod.name}…`);
                try {
                  await archivePod(api, pod.sId);
                  unbindIfBound(pod);
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  panel?.setBusy(`Archive failed: ${errorMessage(err)}`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                }
              },
            },
            {
              key: "u",
              label: "restore",
              run: async (row) => {
                const pod = row.value as PodRef;
                panel?.setBusy(`Restoring ${pod.name}…`);
                try {
                  await unarchivePod(api, pod.sId);
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  panel?.setBusy(`Restore failed: ${errorMessage(err)}`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                }
              },
            },
            {
              key: "d",
              label: "delete",
              run: async (row) => {
                const pod = row.value as PodRef;
                // Deleting launches Dust's scrub workflow, so there is no undo.
                // The panel has to come down for the dialog to be reachable.
                panel?.close();
                const confirmed = await runtimeCtx.ui?.confirm?.(
                  `Delete pod "${pod.name}" permanently`,
                  `This removes the pod and every file in it from your Dust workspace.\n` +
                    "It cannot be undone — /pods can only restore *archived* pods.\n\n" +
                    "Local files are untouched.",
                );
                if (!confirmed) {
                  notify(`Kept pod "${pod.name}".`, "info");
                  return;
                }
                try {
                  await deletePod(api, pod.sId);
                  unbindIfBound(pod);
                  notify(`Deleted pod "${pod.name}".`, "info");
                } catch (err) {
                  notify(`Delete failed: ${errorMessage(err)}`, "error");
                }
              },
            },
            {
              key: "r",
              label: "reload",
              run: async () => {
                panel?.setBusy("Reloading…");
                try {
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  panel?.setBusy(`Reload failed: ${errorMessage(err)}`);
                  setTimeout(() => panel?.setBusy(null), 1500);
                }
              },
            },
          ],
        },
        (created) => {
          panel = created;
        },
      );

      refreshPodStatus(runtime, root);
    },
  });
}
