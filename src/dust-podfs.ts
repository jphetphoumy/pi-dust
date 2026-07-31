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
  fileEntriesUnder,
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
  forgetWatermarks(root, [rel]);
}

/**
 * Forgets several files' sync watermarks in one state-file save.
 *
 * A folder delete can touch hundreds of paths; calling `forgetWatermark` per
 * file would be a full read-modify-write of dust-state.json each time.
 */
function forgetWatermarks(root: string, rels: readonly string[]): void {
  const binding = getPodBinding(root);
  if (!binding) return;
  let changed = false;
  for (const rel of rels) {
    if (!binding.seen[rel]) continue;
    delete binding.seen[rel];
    changed = true;
  }
  if (changed) savePodBinding(root, binding);
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

/**
 * Reports a pull's outcome.
 *
 * `oneLine` keeps `panel.setBusy()`'s single row short — the first failure
 * plus a count of the rest, rather than every one. The full per-file report is
 * for the `notify` path used once the panel has closed, where multiple lines
 * are fine.
 */
function pullReport(summary: PullSummary, root: string, oneLine: boolean): string {
  const head = `Pulled ${summary.pulled} file${summary.pulled === 1 ? "" : "s"} to ${root}`;
  if (summary.failures.length === 0) return `${head}.`;
  if (oneLine) {
    const first = summary.failures[0];
    const rest = summary.failures.length > 1 ? ` (+${summary.failures.length - 1} more)` : "";
    return `Pulled ${summary.pulled}, ${summary.failures.length} failed — ${first}${rest}`;
  }
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
        const files = tree.flatMap((node) => fileEntriesUnder(node));
        notify(
          files.length === 0
            ? `Pod "${binding.name}" is empty.`
            : `Pod "${binding.name}":\n${files.map(({ path, bytes }) => `  ${path}  ${formatBytes(bytes)}`).join("\n")}`,
          "info",
        );
        return;
      }

      // Directories start closed. A pod mirrors a whole project, so opening
      // everything is a wall of files to scroll before the top-level shape is
      // even visible — and the top-level shape is what the user is picking from.
      let expanded = new Set<string>();
      const selected = new Set<string>();

      let panel: DustPodListPanel | null = null;
      const toRows = (): ListRow[] =>
        flattenPodTree(tree, expanded).map((node) => treeRow(node, expanded, selected));
      const render = (): void => panel?.setRows(toRows());

      const refreshTree = async (): Promise<void> => {
        tree = await loadTree();
        // Directories the user opened stay open; a directory the pod no longer
        // has drops out rather than lingering as a claim about a missing path.
        expanded = new Set(directoryPathsUnder(tree).filter((path) => expanded.has(path)));
        const live = new Set(allFiles());
        for (const path of [...selected]) {
          if (!live.has(path)) selected.delete(path);
        }
      };

      const reload = async (): Promise<void> => {
        await refreshTree();
        render();
      };

      // Whitespace collapsing (including a pulled-through API error body's
      // newlines) lives in `DustPodListPanel.setBusy` itself now, so every
      // caller — this one and `/pods` below — gets it for free.
      const setBusy = (message: string | null): void => panel?.setBusy(message);

      /** Reports an action's outcome, then hands the panel back to the user. */
      const flash = (message: string): void => {
        setBusy(message);
        setTimeout(() => setBusy(null), 1500);
      };

      // A directory delete has to bring the panel down for the confirm dialog
      // to be reachable, which resolves `openListPanel` with `undefined` — the
      // same value Esc produces. Left alone, that reads as the user cancelling
      // and throws away whatever they had ticked. `dialogPending` is how the
      // directory-delete branch tells this loop "I closed it, wait for the
      // dialog, then put the picker back" instead of "the user is done".
      let dialogPending: Promise<void> | null = null;
      let picked: ListRow[] | undefined | null;
      // Set right before a directory delete closes the panel, so the reopened
      // picker can land back near where the user was instead of at the top.
      // Consumed (and cleared) by the very next `openListPanel` call.
      let pendingFocus: { path: string; index: number } | null = null;
      // A dialog round trip only ever follows a real keypress, so this is a
      // backstop against a runaway loop, not a limit anyone should hit.
      const maxReopens = 1000;
      const focusNear = (target: { path: string; index: number }) => (rows: ListRow[]): number => {
        const exact = rows.findIndex((row) => (row.value as PodTreeNode).path === target.path);
        return exact >= 0 ? exact : Math.min(target.index, rows.length - 1);
      };
      for (let attempt = 0; attempt < maxReopens; attempt++) {
        dialogPending = null;
        const focusOn = pendingFocus;
        pendingFocus = null;
        picked = await openListPanel(
          runtimeCtx,
          {
            title: `Pod "${binding.name}" files`,
            rows: toRows(),
            emptyMessage: "This pod holds no files yet.",
            initialFocus: focusOn ? focusNear(focusOn) : undefined,
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
                  setBusy(`Pulling ${node.path}…`);
                  const summary = await pullPodPaths(api, binding.podId, root, paths, (done, total) => {
                    if (total > 1) setBusy(`Pulling ${node.path}… ${done + 1}/${total}`);
                  });
                  flash(pullReport(summary, root, true));
                  // The busy line only ever shows the first failure; the rest
                  // would otherwise be silently dropped once it clears — unlike
                  // the Enter path, which notifies the full report already.
                  if (summary.failures.length > 0) {
                    notify(pullReport(summary, root, false), "warning");
                  }
                },
              },
              {
                key: "d",
                label: "delete",
                run: async (row, index) => {
                  const node = row.value as PodTreeNode;
                  const paths = filePathsUnder(node);
                  // A folder delete is many deletions behind one keypress, so it
                  // asks first — and the panel has to come down for the dialog to
                  // be reachable, the same way /pods delete does.
                  if (isDirectory(node)) {
                    pendingFocus = { path: node.path, index };
                    panel?.close();
                    // The panel is down for the dialog, not because the user is
                    // done — the loop around this call awaits this promise, then
                    // reopens the picker so `selected` (untouched by any of this)
                    // is not silently thrown away. This must never reject: it is
                    // awaited both here (un-caught, since `run` is dispatched as
                    // `void action.run(...)`) and by the reopen loop below — a
                    // rejection either would surface as an unhandled rejection or
                    // an uncaught throw out of the whole `/podfs` handler, with
                    // the picker never reopening and the ticked selection lost.
                    // So each stage that can throw gets its own catch, worded for
                    // what actually failed rather than folding everything into
                    // "could not refresh".
                    dialogPending = (async () => {
                      let confirmed: boolean | undefined;
                      try {
                        confirmed = await runtimeCtx.ui?.confirm?.(
                          `Delete ${paths.length} file${paths.length === 1 ? "" : "s"} under ${node.path}/`,
                          `This removes them from pod "${binding.name}". Local files are untouched.`,
                        );
                      } catch (err) {
                        notify(`Could not confirm deleting ${node.path}/: ${errorMessage(err)}`, "error");
                        return;
                      }
                      if (!confirmed) {
                        notify(`Kept ${node.path}/.`, "info");
                        return;
                      }
                      const deletedPaths: string[] = [];
                      for (const rel of paths) {
                        try {
                          await deletePodFile(api, binding.podId, rel);
                          deletedPaths.push(rel);
                        } catch (err) {
                          notify(`Delete failed for ${rel}: ${errorMessage(err)}`, "error");
                        }
                      }
                      // The notice reflects what really left the pod, so it must
                      // fire before anything below — the watermark save or the
                      // tree refresh — gets a chance to fail.
                      if (deletedPaths.length > 0) {
                        notify(
                          `Deleted ${deletedPaths.length} file${deletedPaths.length === 1 ? "" : "s"} from ${node.path}/.`,
                          "info",
                        );
                      }
                      try {
                        // One save for the whole folder — per-file would mean a
                        // full rewrite of dust-state.json per file.
                        forgetWatermarks(root, deletedPaths);
                      } catch (err) {
                        // The files are already gone from the pod; only the
                        // watermark save failed. Say so precisely — leaving the
                        // watermark behind means the pre-turn push may re-upload
                        // these files on the next turn, undoing the delete.
                        notify(
                          `Deleted ${node.path}/ but could not clear its sync watermarks: ${errorMessage(err)}. These files may be re-uploaded on the next turn.`,
                          "error",
                        );
                        // Deliberately falls through to the refresh: the save
                        // failing says nothing about whether the listing can be
                        // re-fetched, and skipping it would leave the reopened
                        // picker showing files that are already gone.
                      }
                      try {
                        await refreshTree();
                      } catch (err) {
                        notify(`Could not refresh pod files after deleting ${node.path}/: ${errorMessage(err)}`, "error");
                      }
                    })();
                    await dialogPending;
                    return;
                  }

                  setBusy(`Deleting ${node.path}…`);
                  try {
                    await deletePodFile(api, binding.podId, node.path);
                    // Drop the watermark too, or the next push restores it.
                    forgetWatermark(root, node.path);
                    await reload();
                    setBusy(null);
                  } catch (err) {
                    flash(`Delete failed: ${errorMessage(err)}`);
                  }
                },
              },
              {
                key: "r",
                label: "reload",
                run: async () => {
                  setBusy("Reloading…");
                  try {
                    await reload();
                    setBusy(null);
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

        if (!dialogPending) break;
        await dialogPending;
      }

      // In tree mode the panel resolves only to say how it closed; the ticked
      // paths live here, because a collapsed folder's files are not rows.
      if (picked !== undefined && picked !== null && selected.size > 0) {
        const summary = await pullPodPaths(api, binding.podId, root, [...selected]);
        notify(pullReport(summary, root, false), summary.failures.length > 0 ? "warning" : "info");
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
