import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PodApi } from "../src/dust-pod.js";
import * as podApi from "../src/dust-pod.js";
import { describeReport, ingestFiles, isEmptyReport, syncPod } from "../src/dust-pod-sync.js";
import type { DustPodBinding } from "../src/dust-state.js";
import { getPodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

const POD_ID = "vlt_1";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * An in-memory pod: path -> {content, mtime}. Lets the tests drive the three
 * cases sync has to tell apart (pod moved, local moved, both moved) without
 * standing up HTTP.
 */
function makeFakePod(initial: Record<string, { content: string; ms: number }> = {}) {
  const files = new Map(Object.entries(initial));
  const uploads: string[] = [];
  const downloads: string[] = [];

  const api = { baseUrl: "https://x/api/w/w1", getAuthHeaders: () => ({}) } satisfies PodApi;

  vi.spyOn(podApi, "listPodFiles").mockImplementation(async () =>
    [...files.entries()].map(([rel, file]) => ({
      path: `pod-${POD_ID}/${rel}`,
      fileName: rel.split("/").pop() ?? rel,
      isDirectory: false,
      sizeBytes: file.content.length,
      lastModifiedMs: file.ms,
    })));

  vi.spyOn(podApi, "downloadPodFile").mockImplementation(async (_api, _podId, rel) => {
    downloads.push(rel);
    const file = files.get(rel);
    if (!file) throw new Error(`missing ${rel}`);
    return Buffer.from(file.content);
  });

  vi.spyOn(podApi, "uploadPodFile").mockImplementation(async (_api, _podId, rel, content) => {
    uploads.push(rel);
    files.set(rel, { content: content.toString(), ms: (files.get(rel)?.ms ?? 0) + 1000 });
  });

  return { api, files, uploads, downloads };
}

describe("pod sync", () => {
  useTempAgentDir();

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-dust-sync-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeLocal(rel: string, content: string): void {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function readLocal(rel: string): string {
    return readFileSync(join(root, rel), "utf8");
  }

  function binding(seen: DustPodBinding["seen"] = {}): DustPodBinding {
    return { podId: POD_ID, name: "proj", seen };
  }

  it("writes a pod-side edit onto the local tree", async () => {
    const pod = makeFakePod({ "main.py": { content: "new", ms: 200 } });
    writeLocal("main.py", "old");

    const report = await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("old") } }));

    expect(readLocal("main.py")).toBe("new");
    expect(report.pulled).toEqual(["main.py"]);
    expect(report.pushed).toEqual([]);
  });

  it("uploads a local edit the pod has not seen", async () => {
    const pod = makeFakePod({ "main.py": { content: "old", ms: 100 } });
    writeLocal("main.py", "locally changed");

    const report = await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("old") } }));

    expect(report.pushed).toEqual(["main.py"]);
    expect(pod.files.get("main.py")?.content).toBe("locally changed");
    expect(readLocal("main.py")).toBe("locally changed");
  });

  it("leaves a file changed on both sides alone and reports it", async () => {
    // There is no merge available here, and overwriting either side silently
    // destroys work — so the only safe outcome is to touch neither.
    const pod = makeFakePod({ "main.py": { content: "pod version", ms: 200 } });
    writeLocal("main.py", "local version");

    const report = await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("base") } }));

    expect(report.conflicted).toEqual(["main.py"]);
    expect(report.pulled).toEqual([]);
    expect(report.pushed).toEqual([]);
    expect(readLocal("main.py")).toBe("local version");
    expect(pod.files.get("main.py")?.content).toBe("pod version");
  });

  it("does not report a pull when the pod write produced identical bytes", async () => {
    // The agent "fixing" a file to what it already was bumps the pod mtime
    // without changing anything. Reporting that as a pulled change would tell
    // the user their tree moved when it did not.
    const pod = makeFakePod({ "main.py": { content: "same", ms: 200 } });
    writeLocal("main.py", "same");

    const report = await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("same") } }));

    expect(isEmptyReport(report)).toBe(true);
  });

  it("creates a local file, and its parent directory, for a file new to the pod", async () => {
    const pod = makeFakePod({ "src/deep/new.py": { content: "fresh", ms: 10 } });

    const report = await syncPod(pod.api, root, binding());

    expect(report.pulled).toEqual(["src/deep/new.py"]);
    expect(readLocal("src/deep/new.py")).toBe("fresh");
  });

  it("re-pushes a tracked file that has vanished from the pod", async () => {
    const pod = makeFakePod({});
    writeLocal("main.py", "content");

    const report = await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("content") } }));

    expect(report.pushed).toEqual(["main.py"]);
    expect(pod.files.get("main.py")?.content).toBe("content");
  });

  it("skips a tracked file that is gone from both sides", async () => {
    const pod = makeFakePod({});

    const report = await syncPod(pod.api, root, binding({ "gone.py": { podMs: 100, hash: hash("x") } }));

    expect(isEmptyReport(report)).toBe(true);
  });

  it("settles the watermark after a push, so the next sync sees no incoming change", async () => {
    // A push bumps the pod's mtime. Recording the pre-upload mtime would make
    // the very next sync mistake our own upload for the agent's edit and pull
    // it straight back down.
    const pod = makeFakePod({ "main.py": { content: "old", ms: 100 } });
    writeLocal("main.py", "changed");
    const bound = binding({ "main.py": { podMs: 100, hash: hash("old") } });

    await syncPod(pod.api, root, bound);
    const second = await syncPod(pod.api, root, bound);

    expect(isEmptyReport(second)).toBe(true);
    expect(bound.seen["main.py"].podMs).toBe(pod.files.get("main.py")?.ms);
  });

  it("honours push:false so a post-turn pull cannot upload anything", async () => {
    const pod = makeFakePod({ "a.py": { content: "pod", ms: 200 } });
    writeLocal("a.py", "old");
    writeLocal("b.py", "local only");

    const report = await syncPod(
      pod.api,
      root,
      binding({
        "a.py": { podMs: 100, hash: hash("old") },
        "b.py": { podMs: 100, hash: hash("local only") },
      }),
      { push: false, pull: true },
    );

    expect(report.pushed).toEqual([]);
    expect(report.pulled).toEqual(["a.py"]);
    expect(pod.uploads).toEqual([]);
  });

  it("honours pull:false so a pre-turn push cannot overwrite local files", async () => {
    const pod = makeFakePod({ "a.py": { content: "pod version", ms: 200 } });
    writeLocal("a.py", "local");

    const report = await syncPod(
      pod.api,
      root,
      binding({ "a.py": { podMs: 100, hash: hash("local") } }),
      { push: true, pull: false },
    );

    expect(report.pulled).toEqual([]);
    expect(readLocal("a.py")).toBe("local");
    expect(pod.downloads).toEqual([]);
  });

  it("persists the watermark so a restarted session does not re-sync everything", async () => {
    const pod = makeFakePod({ "main.py": { content: "new", ms: 200 } });
    writeLocal("main.py", "old");

    await syncPod(pod.api, root, binding({ "main.py": { podMs: 100, hash: hash("old") } }));

    const stored = getPodBinding(root);
    expect(stored?.seen["main.py"]).toEqual({ podMs: 200, hash: hash("new") });
  });

  it("ingest uploads each chosen file and records a settled watermark", async () => {
    const pod = makeFakePod({});
    writeLocal("main.py", "a");
    writeLocal("src/util.py", "b");
    const bound = binding();

    const report = await ingestFiles(pod.api, root, bound, ["main.py", "src/util.py"]);

    expect(report.pushed).toEqual(["main.py", "src/util.py"]);
    expect(pod.uploads).toEqual(["main.py", "src/util.py"]);
    expect(bound.seen["main.py"].podMs).toBe(pod.files.get("main.py")?.ms);
    expect(bound.seen["src/util.py"].hash).toBe(hash("b"));
    expect(getPodBinding(root)?.seen["main.py"]).toBeDefined();
  });

  it("ingest skips a path that has disappeared between selection and upload", async () => {
    const pod = makeFakePod({});
    writeLocal("main.py", "a");

    const report = await ingestFiles(pod.api, root, binding(), ["main.py", "deleted.py"]);

    expect(report.pushed).toEqual(["main.py"]);
  });

  it("summarises a report in both directions", () => {
    expect(describeReport({ pushed: ["a"], pulled: ["b", "c"], conflicted: ["d"] }))
      .toBe("↑ 1 pushed, ↓ 2 pulled, ⚠ 1 conflicted");
    expect(describeReport({ pushed: [], pulled: [], conflicted: [] })).toBe("");
  });
});
