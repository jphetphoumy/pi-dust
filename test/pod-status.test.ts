import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginPodStatusTurn, clearPodStatus, podStatusText, refreshPodStatus } from "../src/dust-pod-status.js";
import type { SyncReport } from "../src/dust-pod-sync.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { savePodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return { pushed: [], pulled: [], conflicted: [], skipped: [], ...overrides };
}

describe("pod status bar", () => {
  useTempAgentDir();

  beforeEach(() => {
    // Turn totals are module state, so each test starts from a clean slate.
    beginPodStatusTurn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runtimeWithUi(setStatus?: (key: string, text: string | undefined) => void) {
    const runtime = new DustSessionRuntime();
    runtime.extensionContext = { ui: setStatus ? { setStatus } : {} } as never;
    return runtime;
  }

  it("shows the pod name alone when the last sync moved nothing", () => {
    expect(podStatusText("proj", report())).toBe("pod:proj");
    expect(podStatusText("proj")).toBe("pod:proj");
  });

  it("appends compact counts in each direction", () => {
    // Terser than the notification wording on purpose: this shares one row with
    // the model, token count and git branch.
    expect(podStatusText("proj", report({ pushed: ["a"], pulled: ["b", "c"] })))
      .toBe("pod:proj ↑1 ↓2");
    expect(podStatusText("proj", report({ conflicted: ["a"], skipped: [{ rel: "b", reason: "x" }] })))
      .toBe("pod:proj ⚠1 −1");
  });

  it("publishes under a stable key so it keeps its slot in the footer", () => {
    const setStatus = vi.fn();
    const runtime = runtimeWithUi(setStatus);
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    refreshPodStatus(runtime, "/work/proj", report({ pulled: ["a"] }));

    expect(setStatus).toHaveBeenCalledWith("dust-pod", "pod:proj ↓1");
  });

  it("adds up a turn's syncs, so a clean pull cannot erase the push that preceded it", () => {
    // A turn runs several syncs. Rendering only the latest made the footer
    // flash `↑1` and then go blank, which reads as "nothing happened".
    const setStatus = vi.fn();
    const runtime = runtimeWithUi(setStatus);
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    beginPodStatusTurn();
    refreshPodStatus(runtime, "/work/proj", report({ pushed: ["a"] }));
    refreshPodStatus(runtime, "/work/proj", report({ pulled: ["b", "c"] }));
    refreshPodStatus(runtime, "/work/proj", report());

    expect(setStatus.mock.calls.map((call) => call[1])).toEqual([
      "pod:proj ↑1",
      "pod:proj ↑1 ↓2",
      "pod:proj ↑1 ↓2",
    ]);
  });

  it("starts the totals over on the next turn", () => {
    const setStatus = vi.fn();
    const runtime = runtimeWithUi(setStatus);
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    beginPodStatusTurn();
    refreshPodStatus(runtime, "/work/proj", report({ pulled: ["a"] }));
    beginPodStatusTurn();
    refreshPodStatus(runtime, "/work/proj", report());

    expect(setStatus.mock.calls.at(-1)?.[1]).toBe("pod:proj");
  });

  it("keeps the turn's totals when refreshed without a report", () => {
    // Session start and similar callers pass no report; they should not blank
    // out counts the turn already earned.
    const setStatus = vi.fn();
    const runtime = runtimeWithUi(setStatus);
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    beginPodStatusTurn();
    refreshPodStatus(runtime, "/work/proj", report({ pulled: ["a"] }));
    refreshPodStatus(runtime, "/work/proj");

    expect(setStatus.mock.calls.at(-1)?.[1]).toBe("pod:proj ↓1");
  });

  it("clears the entry when the directory has no pod", () => {
    const setStatus = vi.fn();

    refreshPodStatus(runtimeWithUi(setStatus), "/work/unbound");

    expect(setStatus).toHaveBeenCalledWith("dust-pod", undefined);
  });

  it("clears the entry on request, for /ingest clear", () => {
    const setStatus = vi.fn();

    clearPodStatus(runtimeWithUi(setStatus));

    expect(setStatus).toHaveBeenCalledWith("dust-pod", undefined);
  });

  it("does nothing when the host exposes no setStatus", () => {
    // pi's non-interactive modes hand over a context without it; that is normal
    // rather than an error, and must not throw mid-sync.
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    expect(() => refreshPodStatus(runtimeWithUi(), "/work/proj")).not.toThrow();
    expect(() => clearPodStatus(runtimeWithUi())).not.toThrow();
  });
});
