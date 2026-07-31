import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPodStatusTurn,
  clearPodStatus,
  podProgressReporter,
  podStatusText,
  podSyncingText,
  refreshPodStatus,
} from "../src/dust-pod-status.js";
import type { SyncReport } from "../src/dust-pod-sync.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { savePodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return { pushed: [], pulled: [], conflicted: [], skipped: [], adopted: [], ...overrides };
}

function runtimeWithUi(setStatus?: (key: string, text: string | undefined) => void) {
  const runtime = new DustSessionRuntime();
  runtime.extensionContext = { ui: setStatus ? { setStatus } : {} } as never;
  return runtime;
}

/** Pins NO_COLOR for a suite, so assertions can read the text itself. */
function useNoColor(): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  });
}

describe("pod status bar", () => {
  useTempAgentDir();
  useNoColor();

  beforeEach(() => {
    // Turn totals are module state, so each test starts from a clean slate.
    beginPodStatusTurn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the pod name alone when the last sync moved nothing", () => {
    expect(podStatusText("proj", report())).toBe("pod:proj");
    expect(podStatusText("proj")).toBe("pod:proj");
  });

  it("appends compact counts in each direction", () => {
    // Terser than the notification wording on purpose: this shares one row with
    // the model, token count and git branch.
    expect(podStatusText("proj", report({ pushed: ["a"], pulled: ["b", "c"] })))
      .toBe("pod:proj ↑1 ↓2");
    expect(podStatusText("proj", report({ conflicted: ["a"], skipped: [{ rel: "b", reason: "x" }], adopted: [] })))
      .toBe("pod:proj ⚠1 −1");
  });

  it("shows progress while a sync is running", () => {
    expect(podSyncingText("proj", 3, 12)).toBe("pod:proj ⟳ 3/12");
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

describe("pod status progress reporter", () => {
  useTempAgentDir();
  useNoColor();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports each step of a multi-file sync", () => {
    const setStatus = vi.fn();
    const report = podProgressReporter(runtimeWithUi(setStatus), "proj");

    report(1, 3);
    report(2, 3);
    report(3, 3);

    expect(setStatus.mock.calls.map((call) => call[1])).toEqual([
      "pod:proj ⟳ 1/3",
      "pod:proj ⟳ 2/3",
      "pod:proj ⟳ 3/3",
    ]);
  });

  it("stays quiet for a single-file sync, which is over before it can be read", () => {
    const setStatus = vi.fn();

    podProgressReporter(runtimeWithUi(setStatus), "proj")(1, 1);

    expect(setStatus).not.toHaveBeenCalled();
  });

  it("is a no-op when the host exposes no setStatus", () => {
    expect(() => podProgressReporter(runtimeWithUi(), "proj")(1, 5)).not.toThrow();
  });
});

describe("pod status colours", () => {
  useTempAgentDir();

  const ESC = "\x1b";

  beforeEach(() => {
    delete process.env.NO_COLOR;
    beginPodStatusTurn();
  });

  it("colours by severity rather than direction", () => {
    // The arrows already say which way a file moved; what colour has left to
    // convey is whether the user needs to do something about it.
    const text = podStatusText("proj", {
      pushed: ["a"],
      pulled: ["b"],
      conflicted: ["c"],
      skipped: [{ rel: "d", reason: "x" }],
      adopted: [],
    });

    expect(text).toContain(`${ESC}[32m↑1${ESC}[0m`);
    expect(text).toContain(`${ESC}[32m↓1${ESC}[0m`);
    expect(text).toContain(`${ESC}[33m⚠1${ESC}[0m`);
    expect(text).toContain(`${ESC}[31m−1${ESC}[0m`);
  });

  it("dims the pod label so the counts read as the news", () => {
    expect(podStatusText("proj")).toBe(`${ESC}[2mpod:proj${ESC}[0m`);
  });

  it("marks an in-progress sync distinctly from a finished one", () => {
    expect(podSyncingText("proj", 1, 4)).toContain(`${ESC}[36m⟳ 1/4${ESC}[0m`);
  });

  it("emits no escape codes when NO_COLOR is set", () => {
    // Honouring the convention keeps the footer readable when piped or in a
    // terminal without colour support.
    process.env.NO_COLOR = "1";
    try {
      expect(podStatusText("proj", { pushed: ["a"], pulled: [], conflicted: [], skipped: [], adopted: [] }))
        .not.toContain(ESC);
      expect(podSyncingText("proj", 1, 4)).not.toContain(ESC);
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});
