import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_EXPIRED_MESSAGE } from "../src/dust-constants.js";
import { fingerprintSkillAt, type LocalSkill } from "../src/dust-pod-skills.js";
import type { PodApi } from "../src/dust-pod.js";
import * as podApi from "../src/dust-pod.js";
import {
  describeReport,
  ingestFiles,
  isEmptyReport,
  POD_UPLOAD_CONCURRENCY,
  syncPod,
} from "../src/dust-pod-sync.js";
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

  it("pushes a local file the pod has never seen, so an empty pod fills up", async () => {
    // Without this a pod created for an empty directory is a dead end: the
    // first file the user writes themselves would never reach the agent,
    // because `seen` has no entry for it and the pod has no entry either.
    const pod = makeFakePod({});
    writeLocal("brand-new.py", "print(1)");
    const bound = binding();

    const report = await syncPod(pod.api, root, bound, { push: true, pull: false });

    expect(report.pushed).toEqual(["brand-new.py"]);
    expect(pod.files.get("brand-new.py")?.content).toBe("print(1)");
    expect(bound.seen["brand-new.py"]).toBeDefined();
  });

  it("picks up a whole tree a scaffolder dropped in, not just loose files", async () => {
    // The workflow this exists for: the agent runs `ansible-galaxy role init
    // myrole` through bash, which writes eight files across six directories
    // none of which the pod has ever heard of. The post-bash push has to carry
    // the lot, or the agent's next `files__list` shows an empty pod and it
    // concludes the scaffolder failed.
    const pod = makeFakePod({ "playbook.yml": { content: "- hosts: all", ms: 100 } });
    const bound = binding({ "playbook.yml": { podMs: 100, hash: hash("- hosts: all") } });
    for (const rel of [
      "myrole/README.md",
      "myrole/defaults/main.yml",
      "myrole/handlers/main.yml",
      "myrole/meta/main.yml",
      "myrole/tasks/main.yml",
      "myrole/tests/inventory",
      "myrole/tests/test.yml",
      "myrole/vars/main.yml",
    ]) writeLocal(rel, `# ${rel}\n`);

    const report = await syncPod(pod.api, root, bound, { push: true, pull: false });

    expect(report.pushed).toEqual([
      "myrole/README.md",
      "myrole/defaults/main.yml",
      "myrole/handlers/main.yml",
      "myrole/meta/main.yml",
      "myrole/tasks/main.yml",
      "myrole/tests/inventory",
      "myrole/tests/test.yml",
      "myrole/vars/main.yml",
    ]);
    expect(pod.files.get("myrole/tasks/main.yml")?.content).toBe("# myrole/tasks/main.yml\n");
    // The file that was already in step is left alone — a scaffolder run must
    // not turn into a re-upload of the whole project.
    expect(pod.uploads).not.toContain("playbook.yml");
  });

  it("re-applies the ingest pathspecs, rather than sweeping up the whole tree", async () => {
    // `/ingest src` is a deliberate narrowing. Discovering new files must not
    // quietly widen it to everything the user left out.
    const pod = makeFakePod({});
    writeLocal("src/new.py", "x = 1");
    writeLocal("secret-notes.md", "not for upload");
    const bound: DustPodBinding = { podId: POD_ID, name: "proj", seen: {}, pathspecs: ["src"] };

    const report = await syncPod(pod.api, root, bound, { push: true, pull: false });

    expect(report.pushed).toEqual(["src/new.py"]);
    expect(pod.files.has("secret-notes.md")).toBe(false);
  });

  it("does not discover new local files during a pull-only sync", async () => {
    const pod = makeFakePod({});
    writeLocal("brand-new.py", "print(1)");

    const report = await syncPod(pod.api, root, binding(), { push: false, pull: true });

    expect(report.pushed).toEqual([]);
    expect(pod.uploads).toEqual([]);
  });

  it("records a discovered file the pod rejects instead of failing the sync", async () => {
    const pod = makeFakePod({});
    writeLocal("bad.py", "x");
    vi.mocked(podApi.uploadPodFile).mockRejectedValue(new Error("HTTP 400 — file_is_empty"));

    const report = await syncPod(pod.api, root, binding(), { push: true, pull: false });

    expect(report.pushed).toEqual([]);
    expect(report.skipped).toEqual([{ rel: "bad.py", reason: "HTTP 400 — file_is_empty" }]);
  });

  it("adopts the watermark instead of reporting a conflict when both sides hold the same bytes", async () => {
    // A partial ingest leaves files with no watermark at all, which otherwise
    // reads as changed-on-both-sides and jams every file in the project. If the
    // bytes agree there is nothing to reconcile.
    const pod = makeFakePod({ "main.py": { content: "same", ms: 200 } });
    writeLocal("main.py", "same");
    const bound = binding();

    const report = await syncPod(pod.api, root, bound);

    expect(isEmptyReport(report)).toBe(true);
    expect(bound.seen["main.py"]).toEqual({ podMs: 200, hash: hash("same") });
  });

  it("still reports a conflict when the two sides genuinely differ", async () => {
    const pod = makeFakePod({ "main.py": { content: "pod version", ms: 200 } });
    writeLocal("main.py", "local version");

    const report = await syncPod(pod.api, root, binding());

    expect(report.conflicted).toEqual(["main.py"]);
    expect(readLocal("main.py")).toBe("local version");
  });

  it("ingest records a rejected file and keeps going", async () => {
    // Dust refuses zero-byte uploads with 400 `file_is_empty`. Aborting the run
    // would leave the files already uploaded without watermarks, and a
    // watermark-less file reads as conflicted — so one rejected file would
    // report the whole project as conflicted on the next sync.
    const pod = makeFakePod({});
    writeLocal("a.py", "one");
    writeLocal("bad.py", "two");
    writeLocal("c.py", "three");
    vi.mocked(podApi.uploadPodFile).mockImplementation(async (_api, _podId, rel, content) => {
      if (rel === "bad.py") throw new Error("Pod upload failed for bad.py: HTTP 400 — file_is_empty");
      pod.files.set(rel, { content: content.toString(), ms: 10 });
    });
    const bound = binding();

    const report = await ingestFiles(pod.api, root, bound, ["a.py", "bad.py", "c.py"]);

    expect(report.pushed).toEqual(["a.py", "c.py"]);
    expect(report.skipped).toEqual([
      { rel: "bad.py", reason: "Pod upload failed for bad.py: HTTP 400 — file_is_empty" },
    ]);
    // The watermarks that did succeed must survive, or the next sync conflicts.
    expect(Object.keys(bound.seen)).toEqual(["a.py", "c.py"]);
    expect(getPodBinding(root)?.seen["c.py"]).toBeDefined();
  });

  it("ingest still aborts on a dead session rather than skipping every file", async () => {
    // Every remaining file would fail for the same reason, so recording them
    // one by one as skipped would bury the real cause.
    const pod = makeFakePod({});
    writeLocal("a.py", "one");
    writeLocal("b.py", "two");
    vi.mocked(podApi.uploadPodFile).mockRejectedValue(new Error(SESSION_EXPIRED_MESSAGE));

    await expect(ingestFiles(pod.api, root, binding(), ["a.py", "b.py"]))
      .rejects.toThrow(SESSION_EXPIRED_MESSAGE);
  });

  it("ingest skips a path that has disappeared between selection and upload", async () => {
    const pod = makeFakePod({});
    writeLocal("main.py", "a");

    const report = await ingestFiles(pod.api, root, binding(), ["main.py", "deleted.py"]);

    expect(report.pushed).toEqual(["main.py"]);
  });

  it("reports progress across both of sync's passes as one running count", () => {
    // The pod-entry loop and the discovery loop share a counter; restarting at
    // 1/n halfway through would read as the sync having begun again.
    const pod = makeFakePod({ "a.py": { content: "pod", ms: 200 } });
    writeLocal("a.py", "pod");
    writeLocal("b.py", "new");
    const steps: string[] = [];

    return syncPod(pod.api, root, binding(), {
      push: true,
      pull: true,
      onProgress: (done, total) => steps.push(`${done}/${total}`),
    }).then(() => {
      expect(steps).toEqual(["1/3", "2/3", "3/3"]);
    });
  });

  it("reports progress through an ingest", async () => {
    const pod = makeFakePod({});
    writeLocal("a.py", "one");
    writeLocal("b.py", "two");
    const steps: string[] = [];

    await ingestFiles(pod.api, root, binding(), ["a.py", "b.py"], (done, total) =>
      steps.push(`${done}/${total}`));

    expect(steps).toEqual(["1/2", "2/2"]);
  });

  /**
   * Makes each upload block until released, so a test can observe how many are
   * in flight at once rather than inferring concurrency from timing.
   */
  function gatedUploads() {
    const inFlight = { now: 0, peak: 0 };
    const release: Array<() => void> = [];
    vi.mocked(podApi.uploadPodFile).mockImplementation(async () => {
      inFlight.now++;
      inFlight.peak = Math.max(inFlight.peak, inFlight.now);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight.now--;
    });
    // Drain on a timer: every queued upload is freed as soon as it parks, so
    // the pool keeps refilling and the run completes.
    const timer = setInterval(() => release.splice(0).forEach((fn) => fn()), 0);
    return { inFlight, stop: () => clearInterval(timer) };
  }

  it("uploads several files at once instead of one at a time", async () => {
    // Each upload is up to four round trips (delete, reserve, PUT, move), so a
    // sequential ingest of a scaffolded tree spends nearly all its time idle on
    // the network.
    const pod = makeFakePod({});
    for (let i = 0; i < 12; i++) writeLocal(`f${i}.py`, `x${i}`);
    const gate = gatedUploads();

    try {
      await ingestFiles(pod.api, root, binding(), Array.from({ length: 12 }, (_, i) => `f${i}.py`));
    } finally {
      gate.stop();
    }

    expect(gate.inFlight.peak).toBeGreaterThan(1);
  });

  it("bounds how many uploads are in flight, so a big ingest cannot flood Dust", async () => {
    // Dust rate-limits the reserve step to 40/min per workspace. Unbounded
    // fan-out over a 500-file ingest would open 500 sockets and spend the whole
    // window instantly.
    const pod = makeFakePod({});
    for (let i = 0; i < 40; i++) writeLocal(`f${i}.py`, `x${i}`);
    const gate = gatedUploads();

    try {
      await ingestFiles(pod.api, root, binding(), Array.from({ length: 40 }, (_, i) => `f${i}.py`));
    } finally {
      gate.stop();
    }

    expect(gate.inFlight.peak).toBeLessThanOrEqual(POD_UPLOAD_CONCURRENCY);
  });

  it("counts progress on completion, not on dispatch", async () => {
    // Under concurrency a counter incremented at the top of the loop would mean
    // "this many started" — the footer would race to 12/12 while uploads were
    // still in flight, and the user would think a sync had finished when it had
    // not. Every reported `done` must be a file that is actually up.
    const pod = makeFakePod({});
    for (let i = 0; i < 6; i++) writeLocal(`f${i}.py`, `x${i}`);
    let landed = 0;
    const original = vi.mocked(podApi.uploadPodFile).getMockImplementation();
    vi.mocked(podApi.uploadPodFile).mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await original?.(...args);
      landed++;
    });
    const seen: Array<{ done: number; landed: number }> = [];

    await ingestFiles(
      pod.api,
      root,
      binding(),
      Array.from({ length: 6 }, (_, i) => `f${i}.py`),
      (done) => seen.push({ done, landed }),
    );

    expect(seen).toHaveLength(6);
    // `done` may never exceed the number of uploads that have actually landed.
    expect(seen.every((s) => s.done <= s.landed)).toBe(true);
    expect(seen.at(-1)?.done).toBe(6);
  });

  it("reports pushed files in a stable order however the uploads interleave", async () => {
    // Completion order under concurrency is arbitrary. Reporting in that order
    // would make the transcript and the tests non-deterministic for no gain.
    const pod = makeFakePod({});
    for (const rel of ["a.py", "b.py", "c.py", "d.py"]) writeLocal(rel, rel);
    // Reverse the completion order relative to the input order.
    const delays: Record<string, number> = { "a.py": 8, "b.py": 6, "c.py": 4, "d.py": 2 };
    const original = vi.mocked(podApi.uploadPodFile).getMockImplementation();
    vi.mocked(podApi.uploadPodFile).mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, delays[args[2]] ?? 0));
      return original?.(...args);
    });

    const report = await ingestFiles(pod.api, root, binding(), ["a.py", "b.py", "c.py", "d.py"]);

    expect(report.pushed).toEqual(["a.py", "b.py", "c.py", "d.py"]);
  });

  it("keeps watermarks consistent when a concurrent ingest hits an expired session", async () => {
    // The invariant a partial ingest has to preserve: a file with no watermark
    // that exists on both sides reads as changed-on-both-sides, so a bad abort
    // would make the next sync report the whole project as conflicted.
    // Whatever did upload must be recorded; whatever did not must not be.
    const pod = makeFakePod({});
    for (const rel of ["a.py", "b.py", "c.py", "d.py"]) writeLocal(rel, rel);
    const original = vi.mocked(podApi.uploadPodFile).getMockImplementation();
    vi.mocked(podApi.uploadPodFile).mockImplementation(async (...args) => {
      if (args[2] === "c.py") throw new Error(SESSION_EXPIRED_MESSAGE);
      return original?.(...args);
    });
    const bound = binding();

    await expect(ingestFiles(pod.api, root, bound, ["a.py", "b.py", "c.py", "d.py"]))
      .rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    // Every watermark recorded corresponds to a file that really is in the pod.
    for (const rel of Object.keys(bound.seen)) {
      expect(pod.files.has(rel)).toBe(true);
    }
    expect(bound.seen["c.py"]).toBeUndefined();
  });

  it("keeps the watermarks a sync's push had already earned when the session dies", async () => {
    // Same invariant as the ingest case, on the other upload path: the discovery
    // push aborts, but a file that reached the pod must keep its watermark —
    // and it has to be persisted, since the throw means no later pass will.
    const pod = makeFakePod({});
    for (const rel of ["a.py", "b.py", "c.py", "d.py"]) writeLocal(rel, rel);
    const original = vi.mocked(podApi.uploadPodFile).getMockImplementation();
    vi.mocked(podApi.uploadPodFile).mockImplementation(async (...args) => {
      if (args[2] === "d.py") throw new Error(SESSION_EXPIRED_MESSAGE);
      return original?.(...args);
    });
    const bound = binding();

    await expect(syncPod(pod.api, root, bound, { push: true, pull: false }))
      .rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    for (const rel of Object.keys(bound.seen)) {
      expect(pod.files.has(rel)).toBe(true);
    }
    expect(bound.seen["d.py"]).toBeUndefined();
    // Persisted, not just held in memory — the throw ends this sync.
    expect(Object.keys(getPodBinding(root)?.seen ?? {})).toEqual(Object.keys(bound.seen));
  });

  /**
   * A skill the agent wrote into the pod itself.
   *
   * The pod's `skills/` prefix is where `/dust-skills` puts our copies, so an
   * agent that creates a skill there produces a subtree we never uploaded. Left
   * alone it pulls down to `<root>/skills/<name>/`, which pi does not scan —
   * the skill lands on disk completely inert, and drops a stray `skills/`
   * directory in the project root on the way.
   */
  describe("adopting a skill the agent created", () => {
    it("lands it where pi looks for skills, not in the project root", async () => {
      const pod = makeFakePod({
        "skills/deploy-helper/SKILL.md": { content: "---\nname: deploy-helper\n---\nbody", ms: 500 },
        "skills/deploy-helper/ref.md": { content: "reference", ms: 500 },
      });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(readLocal(".pi/skills/deploy-helper/SKILL.md")).toContain("name: deploy-helper");
      expect(readLocal(".pi/skills/deploy-helper/ref.md")).toBe("reference");
      // Nothing in the project root.
      expect(existsSync(join(root, "skills"))).toBe(false);
      expect(report.adopted).toEqual(["deploy-helper"]);
    });

    it("registers it, so the agent is offered it and the banner lists it", async () => {
      // Adopting without recording would leave it discoverable by pi but absent
      // from AGENTS.md — the agent would have written a skill it cannot see.
      const pod = makeFakePod({
        "skills/deploy-helper/SKILL.md": { content: "---\nname: deploy-helper\n---\nbody", ms: 500 },
      });
      const bound = binding();

      await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(bound.skills).toEqual(["deploy-helper"]);
      expect(bound.skillFingerprints?.["deploy-helper"]).toEqual(expect.any(String));
      // The instructions list the synced skills, so they have to be rewritten.
      expect(bound.agentsMdHash).toBeUndefined();
    });

    it("adopts it once, then leaves it alone", async () => {
      // Once registered it is pod-owned like any other synced skill, so a later
      // sync must not pull it down a second time or report it again.
      const pod = makeFakePod({
        "skills/deploy-helper/SKILL.md": { content: "---\nname: deploy-helper\n---\nbody", ms: 500 },
      });
      const bound = binding();

      await syncPod(pod.api, root, bound, { push: false, pull: true });
      const second = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(second.adopted).toEqual([]);
      expect(second.pulled).toEqual([]);
    });

    it("leaves the project's own skills/ directory alone", async () => {
      // `skills/` is a plausible project directory. A file the user already
      // tracks there is theirs, and diverting it into .pi/ would move their
      // source tree out from under them.
      const pod = makeFakePod({ "skills/mine/SKILL.md": { content: "updated by agent", ms: 500 } });
      writeLocal("skills/mine/SKILL.md", "mine");
      const bound = binding({ "skills/mine/SKILL.md": { podMs: 100, hash: hash("mine") } });

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.adopted).toEqual([]);
      expect(readLocal("skills/mine/SKILL.md")).toBe("updated by agent");
      expect(existsSync(join(root, ".pi/skills/mine"))).toBe(false);
      expect(bound.skills ?? []).toEqual([]);
    });

    it("does not adopt an untracked file that merely sits under skills/", async () => {
      // Without a SKILL.md it is not a skill, and diverting it into .pi/ would
      // hide an ordinary project file from the user.
      const pod = makeFakePod({ "skills/notes/todo.md": { content: "just a note", ms: 500 } });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.adopted).toEqual([]);
      expect(readLocal("skills/notes/todo.md")).toBe("just a note");
    });

    it("does not re-adopt a skill the user already selected", async () => {
      const pod = makeFakePod({ "skills/chosen/SKILL.md": { content: "ours", ms: 500 } });
      const bound = binding();
      bound.skills = ["chosen"];

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.adopted).toEqual([]);
      expect(existsSync(join(root, ".pi/skills/chosen"))).toBe(false);
    });

    it("does not adopt during a push-only sync", async () => {
      // The pre-turn push must not write to the user's config directory.
      const pod = makeFakePod({ "skills/deploy-helper/SKILL.md": { content: "x", ms: 500 } });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: true, pull: false });

      expect(report.adopted).toEqual([]);
      expect(existsSync(join(root, ".pi/skills/deploy-helper"))).toBe(false);
    });
  });

  /**
   * A pod-side edit to a skill that was already synced via `/dust-skills` —
   * #54. Before the fix, every file under `skills/<name>/` for a name in
   * `binding.skills` was excluded from the pull outright, so the edit could
   * never reach disk. Now it routes back to the skill's real local directory,
   * through the same watermark/conflict handling as any other file.
   */
  describe("pod-side edits to a synced skill", () => {
    function writeSkillDir(baseDir: string, files: Record<string, string>): void {
      for (const [rel, content] of Object.entries(files)) {
        const path = join(baseDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }

    function localSkill(name: string, baseDir: string): LocalSkill {
      return { name, description: "", baseDir, filePath: join(baseDir, "SKILL.md"), files: [], bytes: 0 };
    }

    function skillsOption(...skills: LocalSkill[]): { resolveLocalSkills: () => LocalSkill[] } {
      return { resolveLocalSkills: () => skills };
    }

    it("names the write when a shared-home skill's baseDir sits outside the project", async () => {
      // Nothing else says where a synced skill's bytes landed — `pulled` is
      // only ever surfaced as a count — so a write reaching outside the
      // project would otherwise be invisible.
      const sharedDir = mkdtempSync(join(tmpdir(), "pi-dust-shared-"));
      try {
        const baseDir = join(sharedDir, "herdr");
        writeSkillDir(baseDir, { "SKILL.md": "old" });
        const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
        const bound: DustPodBinding = {
          ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
          skills: ["herdr"],
        };

        const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

        expect(report.skillWritesOutsideRoot).toEqual({
          "skills/herdr/SKILL.md": join(baseDir, "SKILL.md"),
        });
      } finally {
        rmSync(sharedDir, { recursive: true, force: true });
      }
    });

    it("does not name a pulled skill file's write when it lands inside the project", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
        skills: ["herdr"],
      };

      const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(report.skillWritesOutsideRoot ?? {}).toEqual({});
    });

    it("reaches the skill's real baseDir, not the literal pod path", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
        skills: ["herdr"],
      };

      const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(readFileSync(join(baseDir, "SKILL.md"), "utf8")).toBe("new");
      expect(report.pulled).toEqual(["skills/herdr/SKILL.md"]);
      expect(existsSync(join(root, "skills"))).toBe(false);
    });

    it("reaches an adopted skill's directory too, on a later pod-side edit", async () => {
      const baseDir = join(root, ".pi", "skills", "deploy-helper");
      writeSkillDir(baseDir, { "SKILL.md": "first version" });
      const pod = makeFakePod({ "skills/deploy-helper/SKILL.md": { content: "improved", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/deploy-helper/SKILL.md": { podMs: 100, hash: hash("first version") } }),
        skills: ["deploy-helper"],
      };

      const report = await syncPod(
        pod.api,
        root,
        bound,
        skillsOption(localSkill("deploy-helper", baseDir)),
      );

      expect(readFileSync(join(baseDir, "SKILL.md"), "utf8")).toBe("improved");
      expect(report.pulled).toEqual(["skills/deploy-helper/SKILL.md"]);
    });

    it("leaves both sides alone and reports a conflict, rather than overwriting either", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "local version" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "pod version", ms: 200 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("base") } }),
        skills: ["herdr"],
      };

      const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(report.conflicted).toEqual(["skills/herdr/SKILL.md"]);
      expect(report.pulled).toEqual([]);
      expect(readFileSync(join(baseDir, "SKILL.md"), "utf8")).toBe("local version");
      expect(pod.files.get("skills/herdr/SKILL.md")?.content).toBe("pod version");
    });

    it("converges the watermark silently when both sides already hold the same bytes", async () => {
      // The state every skill synced by `/dust-skills` starts in: no
      // watermark for its files at all.
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "same" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "same", ms: 200 } });
      const bound: DustPodBinding = { ...binding(), skills: ["herdr"] };

      const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(isEmptyReport(report)).toBe(true);
      expect(bound.seen["skills/herdr/SKILL.md"]).toEqual({ podMs: 200, hash: hash("same") });
    });

    it("refreshes the skill's fingerprint after a successful pull", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
        skills: ["herdr"],
        skillFingerprints: { herdr: "stale-digest" },
      };

      await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(bound.skillFingerprints?.herdr).toBe(fingerprintSkillAt(baseDir));
      expect(bound.skillFingerprints?.herdr).not.toBe("stale-digest");
    });

    it("leaves the fingerprint alone when the pull is a conflict, so staleness keeps reading true", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "local version" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "pod version", ms: 200 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("base") } }),
        skills: ["herdr"],
        skillFingerprints: { herdr: "original-digest" },
      };

      await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(bound.skillFingerprints?.herdr).toBe("original-digest");
    });

    it("reports once when a synced skill has no local directory to route to", async () => {
      const pod = makeFakePod({
        "skills/gone/SKILL.md": { content: "a", ms: 500 },
        "skills/gone/ref.md": { content: "b", ms: 500 },
      });
      const bound: DustPodBinding = { ...binding(), skills: ["gone"] };

      const report = await syncPod(pod.api, root, bound, skillsOption());

      // Reported once even though both of the skill's files moved — and
      // against a real pod path, not a directory prefix.
      expect(report.skipped).toEqual([
        { rel: "skills/gone/SKILL.md", reason: expect.stringContaining('"gone"') },
      ]);
      expect(report.pulled).toEqual([]);
      expect(existsSync(join(root, "skills"))).toBe(false);
    });

    it("does not report a missing skill whose pod copy has not moved", async () => {
      const pod = makeFakePod({ "skills/gone/SKILL.md": { content: "a", ms: 100 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/gone/SKILL.md": { podMs: 100, hash: hash("a") } }),
        skills: ["gone"],
      };

      const report = await syncPod(pod.api, root, bound, skillsOption());

      expect(isEmptyReport(report)).toBe(true);
    });

    it("never writes into a skill directory on a push-only sync", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
        skills: ["herdr"],
      };

      await syncPod(
        pod.api,
        root,
        bound,
        { push: true, pull: false, ...skillsOption(localSkill("herdr", baseDir)) },
      );

      expect(readFileSync(join(baseDir, "SKILL.md"), "utf8")).toBe("old");
      expect(pod.downloads).toEqual([]);
    });

    it("does not let a pod-supplied relative path escape the skill's own directory", async () => {
      // Crafted to pass the root-level check (it resolves to `root/evil.txt`,
      // which is inside `root`) while still climbing out of the deeper
      // `baseDir` — exactly the gap the ordinary `isPodPathSafe(root, rel)`
      // check cannot cover, since a shared-home skill's baseDir is
      // legitimately nested differently than the pod's `skills/<name>/`
      // prefix.
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({
        "skills/herdr/../../evil.txt": { content: "pwned", ms: 500 },
      });
      const bound: DustPodBinding = { ...binding(), skills: ["herdr"] };

      const report = await syncPod(pod.api, root, bound, skillsOption(localSkill("herdr", baseDir)));

      expect(report.pulled).toEqual([]);
      expect(existsSync(join(root, "evil.txt"))).toBe(false);
      expect(existsSync(join(root, ".agents", "evil.txt"))).toBe(false);
      expect(report.skipped.some((s) => /escapes/.test(s.reason))).toBe(true);
    });

    it("does not re-download once the watermark has caught up", async () => {
      const baseDir = join(root, ".agents", "skills", "herdr");
      writeSkillDir(baseDir, { "SKILL.md": "old" });
      const pod = makeFakePod({ "skills/herdr/SKILL.md": { content: "new", ms: 500 } });
      const bound: DustPodBinding = {
        ...binding({ "skills/herdr/SKILL.md": { podMs: 100, hash: hash("old") } }),
        skills: ["herdr"],
      };
      const option = skillsOption(localSkill("herdr", baseDir));

      await syncPod(pod.api, root, bound, option);
      const before = pod.downloads.length;
      const second = await syncPod(pod.api, root, bound, option);

      expect(isEmptyReport(second)).toBe(true);
      expect(pod.downloads.length).toBe(before);
    });

    it("still syncs the project's own skills/ directory normally when it holds no synced skill", async () => {
      const pod = makeFakePod({ "skills/other/notes.md": { content: "mine", ms: 500 } });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, skillsOption());

      expect(report.pulled).toEqual(["skills/other/notes.md"]);
      expect(readLocal("skills/other/notes.md")).toBe("mine");
    });

    it("never runs local-skill discovery when nothing in the pod needs it", async () => {
      const pod = makeFakePod({ "main.py": { content: "x", ms: 100 } });
      writeLocal("main.py", "x");
      const resolveLocalSkills = vi.fn(() => []);

      await syncPod(pod.api, root, binding(), { resolveLocalSkills });

      expect(resolveLocalSkills).not.toHaveBeenCalled();
    });
  });

  /**
   * A pod entry's path is whatever the agent wrote through the free tools —
   * untrusted input, in other words. A `../../.ssh/authorized_keys` style path
   * must never be joined onto the local root and written; there is no prompt
   * on the automatic post-turn pull for the user to catch it at.
   */
  describe("pod paths that would escape the project root", () => {
    it("skips a pulled entry whose path climbs above the project root", async () => {
      const pod = makeFakePod({ "../evil.txt": { content: "pwned", ms: 500 } });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.pulled).toEqual([]);
      expect(report.skipped).toEqual([
        { rel: "../evil.txt", reason: expect.stringContaining("escapes") },
      ]);
      expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    });

    it("never adopts a skill-shaped entry whose path escapes the root", async () => {
      // Same untrusted rel feeds adoptedSkillPath, so a traversal has to be
      // caught before it ever reaches that branch, not just the plain write.
      const pod = makeFakePod({
        "skills/foo/../../../evil.txt": { content: "pwned", ms: 500 },
      });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.adopted).toEqual([]);
      expect(report.pulled).toEqual([]);
      expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    });

    it("does not let an unsafe pod path block the rest of the sync", async () => {
      const pod = makeFakePod({
        "../evil.txt": { content: "pwned", ms: 500 },
        "main.py": { content: "fine", ms: 500 },
      });
      const bound = binding();

      const report = await syncPod(pod.api, root, bound, { push: false, pull: true });

      expect(report.pulled).toEqual(["main.py"]);
      expect(readLocal("main.py")).toBe("fine");
    });
  });

  /**
   * The pre-turn/post-bash push re-runs the same discovery `/ingest` uses, but
   * without `/ingest`'s guardrail: a bash command that scaffolds thousands of
   * files into a tracked directory would otherwise queue them all against
   * Dust's rate limit and stall the turn.
   */
  it("caps rediscovered files at the ingest limit instead of queuing everything", async () => {
    const pod = makeFakePod({});
    const total = 510;
    for (let i = 0; i < total; i++) writeLocal(`gen/f${i}.py`, `x${i}`);
    const bound = binding();

    const report = await syncPod(pod.api, root, bound, { push: true, pull: false });

    expect(report.pushed.length).toBe(500);
    expect(report.skipped.some((s) => /cap/i.test(s.reason))).toBe(true);
  });

  it("summarises a report in both directions", () => {
    expect(describeReport({ pushed: ["a"], pulled: ["b", "c"], conflicted: ["d"], skipped: [], adopted: [] }))
      .toBe("↑ 1 pushed, ↓ 2 pulled, ⚠ 1 conflicted");
    expect(describeReport({ pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [] })).toBe("");
  });
});
