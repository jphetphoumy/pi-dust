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
import {
  buildPodTree,
  directoryPathsUnder,
  filePathsUnder,
  flattenPodTree,
  isDirectory,
  type PodTreeNode,
  selectionStateOf,
  toggleSelection,
} from "./dust-pod-tree.js";
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

/** The outcome of pulling a set of pod files, so the caller can word the report. */
interface PullSummary {
  pulled: number;
  failures: string[];
}

/**
 * Writes pod files back to disk, one request each.
 *
 * Sequential on purpose: a folder pull can be hundreds of files and Dust's file
 * API is rate limited, so the slower loop is the one that finishes.
 */
async function pullPodPaths(
  api: PodApi,
  podId: string,
  root: string,
  paths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<PullSummary> {
  const summary: PullSummary = { pulled: 0, failures: [] };
  for (const [index, rel] of paths.entries()) {
    onProgress?.(index, paths.length);
    // `rel` is a pod-reported path, not one the user typed — a
    // `../../.ssh/authorized_keys` style entry must not be joined onto `root`
    // and written just because the user pressed enter.
    if (!isPodPathSafe(root, rel)) {
      summary.failures.push(`${rel}: escapes the project root`);
      continue;
    }
    try {
      const content = await downloadPodFile(api, podId, rel);
      const path = join(root, rel);
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      summary.pulled++;
    } catch (err) {
      summary.failures.push(`${rel}: ${errorMessage(err)}`);
    }
  }
  return summary;
}

function pullReport(summary: PullSummary, root: string): string {
  const head = `Pulled ${summary.pulled} file${summary.pulled === 1 ? "" : "s"} to ${root}`;
  if (summary.failures.length === 0) return `${head}.`;
  return `${head}; ${summary.failures.length} failed:\n  ${summary.failures.join("\n  ")}`;
}

/** One tree node as a panel row, with its tick derived from the selection set. */
function treeRow(node: PodTreeNode, expanded: ReadonlySet<string>, selected: ReadonlySet<string>): ListRow {
  const state = selectionStateOf(node, selected);
  const dir = isDirectory(node);
  return {
    label: dir ? `${node.name}/` : node.name,
    detail: dir
      ? `${node.files} file${node.files === 1 ? "" : "s"}, ${formatBytes(node.bytes)}`
      : formatBytes(node.bytes),
    selected: state === "on",
    partial: state === "partial",
    depth: node.depth,
    expandable: dir,
    expanded: dir && expanded.has(node.path),
    value: node,
  };
}

/**
 * `/podfs` — browse the bound pod's files as a tree, pull them back to disk, or
 * delete them.
 *
 * A tree rather than the flat listing it used to be: a pod mirrors a project and
 * a project is mostly directories, so pulling `src/` back meant pressing `p`
 * once per file with no way to say "this folder". Dust stores flat paths and has
 * no directory objects, so the folders are derived (`dust-pod-tree.ts`) and
 * every folder-level action is really the file paths underneath it.
 *
 * Nothing starts ticked. Space on a folder takes the whole folder, which is the
 * common case, but a pull overwrites whatever is at that path locally — so the
 * user says which files, rather than un-saying it.
 */
export function registerDustPodFsCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("podfs", {
    description: "Browse the Dust Pod's files — pull them back to disk, or delete them",
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

      const loadTree = async (): Promise<PodTreeNode[]> => {
        const files = await listPodFiles(api, binding.podId);
        return buildPodTree(
          files.map((file) => ({
            path: toRelativePath(binding.podId, file.path),
            bytes: file.sizeBytes,
          })),
        );
      };

      let tree: PodTreeNode[];
      try {
        tree = await loadTree();
      } catch (err) {
        notify(`Could not list pod files: ${errorMessage(err)}`, "error");
        return;
      }

      const allFiles = (): string[] => tree.flatMap((node) => filePathsUnder(node));

      if (!supportsPanels(runtimeCtx)) {
        const paths = allFiles();
        notify(
          paths.length === 0
            ? `Pod "${binding.name}" is empty.`
            : `Pod "${binding.name}":\n${paths.map((path) => `  ${path}`).join("\n")}`,
          "info",
        );
        return;
      }

      // Directories start open, so the panel opens on the same everything-listed
      // view it used to show and collapsing is the deliberate act.
      let expanded = new Set(directoryPathsUnder(tree));
      const selected = new Set<string>();

      let panel: DustPodListPanel | null = null;
      const toRows = (): ListRow[] =>
        flattenPodTree(tree, expanded).map((node) => treeRow(node, expanded, selected));
      const render = (): void => panel?.setRows(toRows());

      const reload = async (): Promise<void> => {
        const knownDirs = new Set(directoryPathsUnder(tree));
        tree = await loadTree();
        // Directories the user closed stay closed; ones that appeared since open
        // like they would have on a fresh panel. Anything gone drops out of both
        // sets rather than lingering as a claim about a path the pod no longer
        // has.
        expanded = new Set(
          directoryPathsUnder(tree).filter((path) => expanded.has(path) || !knownDirs.has(path)),
        );
        const live = new Set(allFiles());
        for (const path of [...selected]) {
          if (!live.has(path)) selected.delete(path);
        }
        render();
      };

      /** Reports an action's outcome, then hands the panel back to the user. */
      const flash = (message: string): void => {
        panel?.setBusy(message);
        setTimeout(() => panel?.setBusy(null), 1500);
      };

      const picked = await openListPanel(
        runtimeCtx,
        {
          title: `Pod "${binding.name}" files`,
          rows: toRows(),
          emptyMessage: "This pod holds no files yet.",
          tree: {
            toggleSelect: (row) => {
              toggleSelection(row.value as PodTreeNode, selected);
              render();
            },
            toggleAll: () => {
              const files = allFiles();
              const clearing = files.every((path) => selected.has(path));
              selected.clear();
              if (!clearing) for (const path of files) selected.add(path);
              render();
            },
            setExpanded: (row, open) => {
              const node = row.value as PodTreeNode;
              if (open) expanded.add(node.path);
              else expanded.delete(node.path);
              render();
            },
          },
          confirmHint: () => `enter pull ${selected.size}`,
          actions: [
            {
              key: "p",
              label: "pull this",
              run: async (row) => {
                const node = row.value as PodTreeNode;
                const paths = filePathsUnder(node);
                panel?.setBusy(`Pulling ${node.path}…`);
                const summary = await pullPodPaths(api, binding.podId, root, paths, (done, total) => {
                  if (total > 1) panel?.setBusy(`Pulling ${node.path}… ${done + 1}/${total}`);
                });
                flash(pullReport(summary, root));
              },
            },
            {
              key: "d",
              label: "delete",
              run: async (row) => {
                const node = row.value as PodTreeNode;
                const paths = filePathsUnder(node);
                // A folder delete is many deletions behind one keypress, so it
                // asks first — and the panel has to come down for the dialog to
                // be reachable, the same way /pods delete does.
                if (isDirectory(node)) {
                  panel?.close();
                  const confirmed = await runtimeCtx.ui?.confirm?.(
                    `Delete ${paths.length} file${paths.length === 1 ? "" : "s"} under ${node.path}/`,
                    `This removes them from pod "${binding.name}". Local files are untouched.`,
                  );
                  if (!confirmed) {
                    notify(`Kept ${node.path}/.`, "info");
                    return;
                  }
                  let deleted = 0;
                  for (const rel of paths) {
                    try {
                      await deletePodFile(api, binding.podId, rel);
                      forgetWatermark(root, rel);
                      deleted++;
                    } catch (err) {
                      notify(`Delete failed for ${rel}: ${errorMessage(err)}`, "error");
                    }
                  }
                  notify(`Deleted ${deleted} file${deleted === 1 ? "" : "s"} from ${node.path}/.`, "info");
                  return;
                }

                panel?.setBusy(`Deleting ${node.path}…`);
                try {
                  await deletePodFile(api, binding.podId, node.path);
                  // Drop the watermark too, or the next push restores it.
                  forgetWatermark(root, node.path);
                  await reload();
                  panel?.setBusy(null);
                } catch (err) {
                  flash(`Delete failed: ${errorMessage(err)}`);
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
                  flash(`Reload failed: ${errorMessage(err)}`);
                }
              },
            },
          ],
        },
        (created) => {
          panel = created;
        },
      );

      // In tree mode the panel resolves only to say how it closed; the ticked
      // paths live here, because a collapsed folder's files are not rows.
      if (picked !== undefined && picked !== null && selected.size > 0) {
        const summary = await pullPodPaths(api, binding.podId, root, [...selected]);
        notify(pullReport(summary, root), summary.failures.length > 0 ? "warning" : "info");
      }

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
