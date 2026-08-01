import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as podApi from "../src/dust-pod.js";
import { registerDustIngestCommand } from "../src/dust-pod-command.js";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podSync from "../src/dust-pod-sync.js";
import * as podUi from "../src/dust-pod-ui.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { getPodBinding, savePodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

describe("/ingest command", () => {
  useTempAgentDir();

  let root: string;
  let runtime: DustSessionRuntime;
  let handler: Handler;
  let notices: Array<[string, string]>;
  let confirmAnswer: boolean;
  let confirmCalls: Array<[string, string]>;
  let pickerResult: Awaited<ReturnType<typeof podUi.openListPanel>>;
  let pickerOptions: Parameters<typeof podUi.openListPanel>[1] | null;

  function ctx() {
    return {
      ui: {
        notify: (message: string, level: string) => { notices.push([message, level]); },
        confirm: async (title: string, message: string) => {
          confirmCalls.push([title, message]);
          return confirmAnswer;
        },
      },
    };
  }

  function write(rel: string, content: string): void {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  /**
   * Runs git against the throwaway fixture repo at `root` — never the real
   * one this test file lives in.
   *
   * A plain `execFileSync("git", ...)` inherits `process.env`, which is safe
   * when the suite runs standalone but not when it runs as a descendant of
   * this repo's own pre-commit hook (`npm test` under `simple-git-hooks`):
   * git hook processes get `GIT_DIR`/`GIT_INDEX_FILE` set in their
   * environment, pointing at the enclosing repo, and child processes inherit
   * them. With `GIT_DIR` set but `GIT_WORK_TREE` unset, git falls back to
   * treating the *current directory* as the work tree — so `git add -A` here
   * would stage `root`'s handful of fixture files as the enclosing repo's
   * entire tree, staging a deletion for every real file not present in
   * `root`. Scrubbing the repo-locating `GIT_*` vars forces this `git` to
   * discover the repo from `cwd` alone, the same as running the suite
   * standalone.
   */
  function git(...args: string[]): void {
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) {
      delete env[key];
    }
    execFileSync("git", args, { cwd: root, stdio: "ignore", env });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-dust-ingest-"));
    notices = [];
    confirmCalls = [];
    confirmAnswer = true;

    runtime = new DustSessionRuntime();
    runtime.extensionContext = { cwd: root } as never;

    vi.spyOn(podRuntime, "podApiFor").mockReturnValue({
      baseUrl: "https://x/api/w/w1",
      getAuthHeaders: () => ({}),
    });
    // Default to no panel surface, so these tests exercise the dialog fallback.
    // The picker gets its own block below.
    pickerResult = null;
    pickerOptions = null;
    vi.spyOn(podUi, "openListPanel").mockImplementation(async (_ctx, options) => {
      pickerOptions = options;
      return pickerResult;
    });

    const registerCommand = vi.fn((_name: string, config: { handler: Handler }) => {
      handler = config.handler;
    });
    registerDustIngestCommand({ registerCommand } as never, runtime);
    expect(registerCommand).toHaveBeenCalledWith("ingest", expect.anything());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function messages(): string[] {
    return notices.map(([message]) => message);
  }

  it("uploads the directory files and binds the pod to the working directory", async () => {
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");

    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod")
      .mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: ["main.py", "src/util.py"], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    // The pod is named after the directory, so the mapping is obvious in the
    // Dust UI without the user having to remember an opaque id.
    expect(resolveOrCreate).toHaveBeenCalledWith(expect.anything(), root.split("/").pop());
    expect(ingest.mock.calls[0][3].sort()).toEqual(["main.py", "src/util.py"]);
    expect(getPodBinding(root)).toMatchObject({ podId: "vlt_1", name: "proj" });
    expect(messages()[0]).toContain("Ingested 2 files");
  });

  it("respects a pathspec so the user can upload part of the tree", async () => {
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: ["src/util.py"], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("src", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["src/util.py"]);
  });

  it("works in a directory that is not a git repository", async () => {
    // Git is an optional refinement, not a precondition: a scratch folder, an
    // unpacked tarball or any plain directory has to be ingestable.
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py", "src/util.py"]);
  });

  it("honours .gitignore when the directory happens to be a repo", async () => {
    git("init", "-q");
    write(".gitignore", "generated.py\n");
    write("main.py", "print(1)");
    write("generated.py", "# built");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    const uploaded = ingest.mock.calls[0][3];
    expect(uploaded).toContain("main.py");
    expect(uploaded).not.toContain("generated.py");
  });

  it("uploads a file that git has never seen, tracked or not", async () => {
    git("init", "-q");
    write("brand-new.py", "print(1)");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toContain("brand-new.py");
  });

  it("skips hidden files, so an unqualified /ingest cannot upload .env", async () => {
    write("main.py", "print(1)");
    write(".env", "TOKEN=hunter2");
    write(".config/creds.json", "{}");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it("skips dependency and build directories", async () => {
    write("main.py", "print(1)");
    write("node_modules/left-pad/index.js", "module.exports = 1");
    write("dist/bundle.js", "//");
    write("__pycache__/main.pyc", "x");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it("does not follow symlinks, which could cycle or escape the tree", async () => {
    write("main.py", "print(1)");
    symlinkSync(root, join(root, "loop"));

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it.each([
    ["src", ["src/deep/b.py", "src/util.py"]],
    ["src/util.py", ["src/util.py"]],
    ["*.py", ["main.py"]],
    ["src/*.py", ["src/util.py"]],
    ["**/*.py", ["main.py", "src/deep/b.py", "src/util.py"]],
  ])("selects with the pathspec %s, without needing git", async (spec, expected) => {
    // Pathspec matching is ours rather than git's, so it behaves identically
    // whether or not the directory is a repository.
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");
    write("src/deep/b.py", "y = 2");
    write("README.md", "# hi");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler(spec, ctx());

    expect(ingest.mock.calls[0][3]).toEqual(expected);
  });

  it("skips empty files, which the pod refuses outright", async () => {
    // Dust answers 400 `file_is_empty`, and `__init__.py` / `.gitkeep` make
    // that a routine case rather than an edge one.
    write("main.py", "print(1)");
    write("src/__init__.py", "");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it("names files the pod refused, since the agent will not see them", async () => {
    write("main.py", "print(1)");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    vi.spyOn(podSync, "ingestFiles").mockResolvedValue({
      pushed: ["main.py"],
      pulled: [],
      conflicted: [],
      skipped: [{ rel: "odd.bin", reason: "HTTP 400" }],
      adopted: [],
    });

    await handler("", ctx());

    expect(messages()[0]).toContain("Ingested 1 files");
    expect(notices[1]).toEqual(["Skipped odd.bin: HTTP 400", "warning"]);
  });

  it("skips files too large to be worth putting in an LLM's context", async () => {
    write("main.py", "print(1)");
    write("blob.bin", "x".repeat(300 * 1024));

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it("uploads nothing when the user declines the confirmation", async () => {
    write("main.py", "print(1)");
    confirmAnswer = false;

    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod");
    const ingest = vi.spyOn(podSync, "ingestFiles");

    await handler("", ctx());

    // The confirmation must precede pod creation: declining should not leave a
    // stray pod behind in the user's workspace.
    expect(resolveOrCreate).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(getPodBinding(root)).toBeNull();
  });

  it("names the file count and a preview in the confirmation", async () => {
    write("main.py", "print(1)");
    confirmAnswer = false;

    await handler("", ctx());

    expect(confirmCalls[0][0]).toContain("Upload 1 files");
    expect(confirmCalls[0][1]).toContain("main.py");
  });

  it("binds an empty directory to a pod, so a new project uses the free tools", async () => {
    // Refusing here was the bug: with no binding, pod mode never engages and
    // every file the agent creates goes through our billed write tool —
    // precisely the case where the free tools save the most.
    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod")
      .mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(confirmCalls[0][0]).toContain("Create empty Dust pod");
    expect(resolveOrCreate).toHaveBeenCalled();
    expect(ingest.mock.calls[0][3]).toEqual([]);
    expect(getPodBinding(root)).toMatchObject({ podId: "vlt_1", name: "proj" });
    expect(messages()[0]).toContain("Created empty pod");
  });

  it("binds a directory holding only skipped files", async () => {
    write(".env", "TOKEN=1");
    write("node_modules/x/index.js", "1");
    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(getPodBinding(root)).not.toBeNull();
  });

  it("creates no pod when the user declines the empty-pod confirmation", async () => {
    confirmAnswer = false;
    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod");

    await handler("", ctx());

    expect(resolveOrCreate).not.toHaveBeenCalled();
    expect(getPodBinding(root)).toBeNull();
  });

  it("still refuses a pathspec that matches nothing", async () => {
    // Different from an empty directory: the user named something specific, so
    // silently binding the whole directory is not what they asked for.
    write("main.py", "print(1)");
    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod");

    await handler("does-not-exist", ctx());

    expect(messages()[0]).toContain("No files matched");
    expect(resolveOrCreate).not.toHaveBeenCalled();
    expect(getPodBinding(root)).toBeNull();
  });

  it("records the pathspecs, so later pushes re-apply the same selection", async () => {
    write("src/util.py", "x = 1");
    write("other.py", "y = 2");
    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("src", ctx());

    expect(getPodBinding(root)?.pathspecs).toEqual(["src"]);
  });

  it("records no pathspecs for a whole-directory ingest", async () => {
    write("main.py", "print(1)");
    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

    await handler("", ctx());

    expect(getPodBinding(root)?.pathspecs).toBeUndefined();
  });

  it("warns instead of uploading when a pathspec matches nothing", async () => {
    write("main.py", "print(1)");

    await handler("does-not-exist", ctx());

    expect(messages()[0]).toContain("No files matched");
  });

  it("refuses an ingest over the file-count limit", async () => {
    for (let i = 0; i < 501; i++) write(`f${i}.txt`, "x");

    await handler("", ctx());

    expect(messages()[0]).toContain("over the 500 limit");
    expect(confirmCalls).toEqual([]);
  });

  it("reports the binding on /ingest status", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: { "a.py": { podMs: 1, hash: "h" } } });

    await handler("status", ctx());

    expect(messages()[0]).toContain('Pod "proj" (vlt_1) — 1 files tracked');
  });

  it("says so on /ingest status when nothing is bound", async () => {
    await handler("status", ctx());
    expect(messages()[0]).toContain("No pod bound");
  });

  it("reconciles both directions on /ingest sync and surfaces conflicts", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    vi.spyOn(podSync, "syncPod")
      .mockResolvedValue({ pushed: ["a.py"], pulled: ["b.py"], conflicted: ["c.py"], skipped: [], adopted: [] });

    await handler("sync", ctx());

    expect(messages()[0]).toBe("↑ 1 pushed, ↓ 1 pulled, ⚠ 1 conflicted");
    expect(notices[1]).toEqual([
      "Conflict (changed on both sides, left alone): c.py",
      "warning",
    ]);
  });

  it("archives the pod and drops the binding on /ingest clear", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    const archive = vi.spyOn(podApi, "archivePod").mockResolvedValue(undefined);

    await handler("clear", ctx());

    expect(archive).toHaveBeenCalledWith(expect.anything(), "vlt_1");
    expect(getPodBinding(root)).toBeNull();
  });

  it("keeps the binding on /ingest clear when the user declines", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    confirmAnswer = false;
    const archive = vi.spyOn(podApi, "archivePod");

    await handler("clear", ctx());

    expect(archive).not.toHaveBeenCalled();
    expect(getPodBinding(root)).not.toBeNull();
  });

  it("unbinds even when archiving fails, so a session is never stuck on an unwanted pod", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    vi.spyOn(podApi, "archivePod").mockRejectedValue(new Error("HTTP 500"));

    await handler("clear", ctx());

    expect(getPodBinding(root)).toBeNull();
    expect(messages()[0]).toContain("archive failed (unbinding anyway)");
  });

  it("reports a failed ingest rather than leaving the user guessing", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    git("add", "-A");
    vi.spyOn(podApi, "resolveOrCreatePod").mockRejectedValue(new Error("HTTP 500"));

    await handler("", ctx());

    expect(messages()[0]).toContain("Ingest failed: HTTP 500");
  });

  it("tells a logged-out user to log in instead of throwing", async () => {
    vi.spyOn(podRuntime, "podApiFor").mockImplementation(() => {
      throw new Error("Not logged in to Dust. Run /login first.");
    });

    await handler("status", ctx());

    expect(messages()[0]).toContain("Not logged in");
  });
  describe("file picker", () => {
    it("offers every candidate ticked, so one enter ingests the lot", async () => {
      // The reverse default would make ingesting a whole project a chore.
      write("main.py", "print(1)");
      write("src/util.py", "x = 1");
      pickerResult = [{ label: "main.py", value: "main.py", selected: true }];
      vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
      vi.spyOn(podSync, "ingestFiles")
        .mockResolvedValue({ pushed: ["main.py"], pulled: [], conflicted: [], skipped: [], adopted: [] });

      await handler("", ctx());

      expect(pickerOptions?.selectable).toBe(true);
      expect(pickerOptions?.rows.map((row) => row.label)).toEqual(["main.py", "src/util.py"]);
      expect(pickerOptions?.rows.every((row) => row.selected)).toBe(true);
    });

    it("uploads only what the user left ticked", async () => {
      write("main.py", "print(1)");
      write("src/util.py", "x = 1");
      pickerResult = [{ label: "src/util.py", value: "src/util.py", selected: true }];
      vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
      const ingest = vi.spyOn(podSync, "ingestFiles")
        .mockResolvedValue({ pushed: ["src/util.py"], pulled: [], conflicted: [], skipped: [], adopted: [] });

      await handler("", ctx());

      expect(ingest.mock.calls[0][3]).toEqual(["src/util.py"]);
    });

    it("creates no pod when the picker is cancelled", async () => {
      // Cancelling must not be read as "an empty selection", which would bind a
      // pod the user never asked for.
      write("main.py", "print(1)");
      pickerResult = undefined;
      const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod");

      await handler("", ctx());

      expect(resolveOrCreate).not.toHaveBeenCalled();
      expect(getPodBinding(root)).toBeNull();
    });

    it("binds an empty pod when everything was unticked", async () => {
      // Distinct from cancelling: the user confirmed, they just chose nothing.
      write("main.py", "print(1)");
      pickerResult = [];
      vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
      vi.spyOn(podSync, "ingestFiles")
        .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

      await handler("", ctx());

      expect(getPodBinding(root)).not.toBeNull();
    });

    it("skips the picker for an empty directory and confirms instead", async () => {
      // There is nothing to choose between, so a list would be an empty box.
      vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
      vi.spyOn(podSync, "ingestFiles")
        .mockResolvedValue({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] });

      await handler("", ctx());

      expect(pickerOptions).toBeNull();
      expect(confirmCalls[0][0]).toContain("Create empty Dust pod");
    });
  });
});
