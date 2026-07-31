/**
 * The pod's flat file listing, folded into a directory tree.
 *
 * Dust stores pod files under flat canonical paths — there are no directory
 * objects, only `src/dust-pod.ts` style keys. The picker still has to behave
 * like a file browser, so the tree is derived here rather than fetched, and
 * every operation that a user thinks of as "the folder" (select it, pull it,
 * delete it) is really an operation on the file paths underneath.
 *
 * Kept free of any TUI or API import so the folding, sorting and selection
 * rules can be tested on their own.
 */

export interface PodTreeEntry {
  /** Pod-relative path, e.g. `src/dust-pod.ts`. */
  path: string;
  bytes: number;
}

export interface PodTreeNode {
  /** Pod-relative path. Directories carry no trailing slash. */
  path: string;
  /** Last segment, which is what the panel shows. */
  name: string;
  /** Nesting level, 0 at the root. Drives the panel's indent. */
  depth: number;
  /** Present on directories only — a file has no `children`, not an empty one. */
  children?: PodTreeNode[];
  /** Own size for a file; the sum of every descendant for a directory. */
  bytes: number;
  /** 1 for a file; the number of descendant files for a directory. */
  files: number;
}

/** Whether a node is ticked, untouched, or holds a mix of both. */
export type SelectionState = "on" | "off" | "partial";

export function isDirectory(node: PodTreeNode): boolean {
  return node.children !== undefined;
}

interface Draft {
  name: string;
  path: string;
  bytes: number;
  /** Null until the path turns out to have something below it. */
  children: Map<string, Draft> | null;
}

/** Directories first, then case-insensitive by name — the usual browser order. */
function byKindThenName(a: PodTreeNode, b: PodTreeNode): number {
  const aDir = isDirectory(a);
  const bDir = isDirectory(b);
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function finish(drafts: Draft[], depth: number): PodTreeNode[] {
  return drafts
    .map((draft): PodTreeNode => {
      if (draft.children === null) {
        return { path: draft.path, name: draft.name, depth, bytes: draft.bytes, files: 1 };
      }
      const children = finish([...draft.children.values()], depth + 1);
      return {
        path: draft.path,
        name: draft.name,
        depth,
        children,
        bytes: children.reduce((sum, child) => sum + child.bytes, 0),
        files: children.reduce((sum, child) => sum + child.files, 0),
      };
    })
    .sort(byKindThenName);
}

/**
 * Folds a flat listing into a tree.
 *
 * A pod can technically hold both `a` and `a/b` — nothing on the server side
 * forbids it. The directory wins, because a node that is both would have to
 * render as two rows with the same path and the selection set could not tell
 * them apart; the shadowed file is simply not offered.
 */
export function buildPodTree(entries: PodTreeEntry[]): PodTreeNode[] {
  const roots = new Map<string, Draft>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let level = roots;
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      prefix = prefix === "" ? name : `${prefix}/${name}`;
      const isLeaf = i === segments.length - 1;

      let draft = level.get(name);
      if (draft === undefined) {
        draft = { name, path: prefix, bytes: 0, children: isLeaf ? null : new Map() };
        level.set(name, draft);
      }

      if (isLeaf) {
        // Only a node that is still a file takes the size; a directory keeps
        // the sum of its children.
        if (draft.children === null) draft.bytes = entry.bytes;
      } else {
        draft.children ??= new Map();
        level = draft.children;
      }
    }
  }

  return finish([...roots.values()], 0);
}

/** Every file path at or below `node`, which is what an operation acts on. */
export function filePathsUnder(node: PodTreeNode): string[] {
  if (node.children === undefined) return [node.path];
  return node.children.flatMap((child) => filePathsUnder(child));
}

/** Directory paths at or below `node` — the set an expand-all has to cover. */
export function directoryPathsUnder(nodes: PodTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.children === undefined ? [] : [node.path, ...directoryPathsUnder(node.children)],
  );
}

/**
 * The visible rows, in display order: a collapsed directory contributes itself
 * and nothing below it.
 */
export function flattenPodTree(nodes: PodTreeNode[], expanded: ReadonlySet<string>): PodTreeNode[] {
  const rows: PodTreeNode[] = [];
  for (const node of nodes) {
    rows.push(node);
    if (node.children !== undefined && expanded.has(node.path)) {
      rows.push(...flattenPodTree(node.children, expanded));
    }
  }
  return rows;
}

export function selectionStateOf(node: PodTreeNode, selected: ReadonlySet<string>): SelectionState {
  const paths = filePathsUnder(node);
  if (paths.length === 0) return "off";
  const ticked = paths.filter((path) => selected.has(path)).length;
  if (ticked === 0) return "off";
  return ticked === paths.length ? "on" : "partial";
}

/**
 * Ticks or unticks a whole subtree.
 *
 * A partially ticked directory becomes fully ticked rather than empty: pressing
 * space on a folder reads as "I want this folder", and the file-by-file
 * de-selection the user did inside it is the exception they can redo.
 */
export function toggleSelection(node: PodTreeNode, selected: Set<string>): void {
  const paths = filePathsUnder(node);
  const clearing = selectionStateOf(node, selected) === "on";
  for (const path of paths) {
    if (clearing) selected.delete(path);
    else selected.add(path);
  }
}
