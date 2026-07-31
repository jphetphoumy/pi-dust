import { describe, expect, it } from "vitest";
import {
  buildPodTree,
  directoryPathsUnder,
  filePathsUnder,
  flattenPodTree,
  isDirectory,
  type PodTreeNode,
  selectionStateOf,
  toggleSelection,
} from "../src/dust-pod-tree.js";

function entry(path: string, bytes = 10): { path: string; bytes: number } {
  return { path, bytes };
}

/** Finds a node by its full path, so tests can name what they mean. */
function at(nodes: PodTreeNode[], path: string): PodTreeNode {
  const hit = tryFind(nodes, path);
  if (!hit) throw new Error(`no node at ${path}`);
  return hit;
}

function tryFind(nodes: PodTreeNode[], path: string): PodTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const hit = tryFind(node.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("pod file tree", () => {
  describe("buildPodTree", () => {
    it("folds flat pod paths into nested directories", () => {
      const tree = buildPodTree([entry("src/a.ts"), entry("src/lib/b.ts"), entry("README.md")]);

      expect(tree.map((node) => node.path)).toEqual(["src", "README.md"]);
      expect(at(tree, "src").children?.map((node) => node.path)).toEqual(["src/lib", "src/a.ts"]);
      expect(at(tree, "src/lib").children?.map((node) => node.path)).toEqual(["src/lib/b.ts"]);
    });

    it("puts directories before files and sorts each group by name", () => {
      const tree = buildPodTree([entry("z.ts"), entry("a.ts"), entry("zz/x.ts"), entry("aa/x.ts")]);

      expect(tree.map((node) => node.name)).toEqual(["aa", "zz", "a.ts", "z.ts"]);
    });

    it("rolls sizes and file counts up to every ancestor", () => {
      const tree = buildPodTree([entry("src/a.ts", 100), entry("src/lib/b.ts", 20), entry("src/lib/c.ts", 5)]);

      expect(at(tree, "src").bytes).toBe(125);
      expect(at(tree, "src").files).toBe(3);
      expect(at(tree, "src/lib").files).toBe(2);
      expect(at(tree, "src/a.ts").files).toBe(1);
    });

    it("marks only directories as directories", () => {
      const tree = buildPodTree([entry("src/a.ts")]);

      expect(isDirectory(at(tree, "src"))).toBe(true);
      expect(isDirectory(at(tree, "src/a.ts"))).toBe(false);
      // A file carries no `children` at all, rather than an empty list — the
      // panel decides whether a row is expandable from exactly that.
      expect(at(tree, "src/a.ts").children).toBeUndefined();
    });

    it("records the depth each row renders at", () => {
      const tree = buildPodTree([entry("a/b/c.ts")]);

      expect(at(tree, "a").depth).toBe(0);
      expect(at(tree, "a/b").depth).toBe(1);
      expect(at(tree, "a/b/c.ts").depth).toBe(2);
    });

    it("keeps the directory when a pod holds both a file and a folder at one path", () => {
      // Nothing server-side forbids it; two rows with the same path would make
      // the selection set ambiguous, so the directory wins.
      const tree = buildPodTree([entry("a", 7), entry("a/b.ts", 3)]);

      expect(tree).toHaveLength(1);
      expect(isDirectory(tree[0]!)).toBe(true);
      expect(tree[0]!.bytes).toBe(3);
    });

    it("ignores empty and slash-only paths", () => {
      expect(buildPodTree([entry(""), entry("/"), entry("//")])).toEqual([]);
    });

    it("tolerates leading and doubled slashes", () => {
      const tree = buildPodTree([entry("/src//a.ts")]);

      expect(at(tree, "src/a.ts").name).toBe("a.ts");
    });
  });

  describe("flattenPodTree", () => {
    const tree = buildPodTree([entry("src/a.ts"), entry("src/lib/b.ts"), entry("README.md")]);

    it("hides the contents of a collapsed directory", () => {
      expect(flattenPodTree(tree, new Set()).map((node) => node.path)).toEqual(["src", "README.md"]);
    });

    it("lists an expanded directory's children right below it", () => {
      expect(flattenPodTree(tree, new Set(["src"])).map((node) => node.path)).toEqual([
        "src",
        "src/lib",
        "src/a.ts",
        "README.md",
      ]);
    });

    it("only descends into a nested directory when it is expanded too", () => {
      expect(flattenPodTree(tree, new Set(["src", "src/lib"])).map((node) => node.path)).toEqual([
        "src",
        "src/lib",
        "src/lib/b.ts",
        "src/a.ts",
        "README.md",
      ]);
    });
  });

  describe("selection", () => {
    const tree = buildPodTree([entry("src/a.ts"), entry("src/lib/b.ts"), entry("README.md")]);

    it("lists every file under a directory, however deep", () => {
      expect(filePathsUnder(at(tree, "src"))).toEqual(["src/lib/b.ts", "src/a.ts"]);
      expect(filePathsUnder(at(tree, "README.md"))).toEqual(["README.md"]);
    });

    it("lists directory paths for reload() to prune expanded against", () => {
      expect(tree.flatMap(directoryPathsUnder)).toEqual(["src", "src/lib"]);
      expect(directoryPathsUnder(at(tree, "src"))).toEqual(["src", "src/lib"]);
      expect(directoryPathsUnder(at(tree, "README.md"))).toEqual([]);
    });

    it("ticks a whole subtree when a directory is toggled on", () => {
      const selected = new Set<string>();
      toggleSelection(at(tree, "src"), selected);

      expect([...selected].sort()).toEqual(["src/a.ts", "src/lib/b.ts"]);
      expect(selected.has("README.md")).toBe(false);
    });

    it("clears the subtree when a fully ticked directory is toggled again", () => {
      const selected = new Set(["src/a.ts", "src/lib/b.ts"]);
      toggleSelection(at(tree, "src"), selected);

      expect(selected.size).toBe(0);
    });

    it("completes a partly ticked directory rather than clearing it", () => {
      // Space on a folder reads as "I want this folder"; the file-by-file
      // de-selection inside it is the exception, not the intent.
      const selected = new Set(["src/a.ts"]);
      toggleSelection(at(tree, "src"), selected);

      expect([...selected].sort()).toEqual(["src/a.ts", "src/lib/b.ts"]);
    });

    it("reports a directory as partial when only some of it is ticked", () => {
      const selected = new Set(["src/a.ts"]);

      expect(selectionStateOf(at(tree, "src"), selected)).toBe("partial");
      expect(selectionStateOf(at(tree, "src/a.ts"), selected)).toBe("on");
      expect(selectionStateOf(at(tree, "src/lib"), selected)).toBe("off");
    });

    it("reports a directory as on once every file under it is ticked", () => {
      const selected = new Set(["src/a.ts", "src/lib/b.ts"]);

      expect(selectionStateOf(at(tree, "src"), selected)).toBe("on");
    });
  });
});
