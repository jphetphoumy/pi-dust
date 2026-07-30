import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as podApi from "../src/dust-pod.js";
import { registerDustIngestCommand } from "../src/dust-pod-command.js";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podSync from "../src/dust-pod-sync.js";
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

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
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

  it("uploads the git-tracked files and binds the pod to the working directory", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");
    git("add", "-A");

    const resolveOrCreate = vi.spyOn(podApi, "resolveOrCreatePod")
      .mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: ["main.py", "src/util.py"], pulled: [], conflicted: [] });

    await handler("", ctx());

    // The pod is named after the directory, so the mapping is obvious in the
    // Dust UI without the user having to remember an opaque id.
    expect(resolveOrCreate).toHaveBeenCalledWith(expect.anything(), root.split("/").pop());
    expect(ingest.mock.calls[0][3].sort()).toEqual(["main.py", "src/util.py"]);
    expect(getPodBinding(root)).toMatchObject({ podId: "vlt_1", name: "proj" });
    expect(messages()[0]).toContain("Ingested 2 files");
  });

  it("respects a pathspec so the user can upload part of the tree", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    write("src/util.py", "x = 1");
    git("add", "-A");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: ["src/util.py"], pulled: [], conflicted: [] });

    await handler("src", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["src/util.py"]);
  });

  it("includes untracked files that are not gitignored, and excludes ignored ones", async () => {
    git("init", "-q");
    write(".gitignore", "secret.env\n");
    write("main.py", "print(1)");
    write("secret.env", "TOKEN=1");
    git("add", ".gitignore");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [] });

    await handler("", ctx());

    const uploaded = ingest.mock.calls[0][3];
    expect(uploaded).toContain("main.py");
    expect(uploaded).not.toContain("secret.env");
  });

  it("skips files too large to be worth putting in an LLM's context", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    write("blob.bin", "x".repeat(300 * 1024));
    git("add", "-A");

    vi.spyOn(podApi, "resolveOrCreatePod").mockResolvedValue({ sId: "vlt_1", name: "proj" });
    const ingest = vi.spyOn(podSync, "ingestFiles")
      .mockResolvedValue({ pushed: [], pulled: [], conflicted: [] });

    await handler("", ctx());

    expect(ingest.mock.calls[0][3]).toEqual(["main.py"]);
  });

  it("uploads nothing when the user declines the confirmation", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    git("add", "-A");
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
    git("init", "-q");
    write("main.py", "print(1)");
    git("add", "-A");
    confirmAnswer = false;

    await handler("", ctx());

    expect(confirmCalls[0][0]).toContain("Upload 1 files");
    expect(confirmCalls[0][1]).toContain("main.py");
  });

  it("refuses a directory that is not a git repository rather than walking it", async () => {
    write("main.py", "print(1)");

    await handler("", ctx());

    expect(messages()[0]).toContain("needs a git repository");
    expect(getPodBinding(root)).toBeNull();
  });

  it("warns instead of uploading when a pathspec matches nothing", async () => {
    git("init", "-q");
    write("main.py", "print(1)");
    git("add", "-A");

    await handler("does-not-exist", ctx());

    expect(messages()[0]).toContain("No files matched");
  });

  it("refuses an ingest over the file-count limit", async () => {
    git("init", "-q");
    for (let i = 0; i < 501; i++) write(`f${i}.txt`, "x");
    git("add", "-A");

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
      .mockResolvedValue({ pushed: ["a.py"], pulled: ["b.py"], conflicted: ["c.py"] });

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
});
