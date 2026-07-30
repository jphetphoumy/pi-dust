import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListPanelOptions, ListRow } from "../src/dust-pod-list-panel.js";
import * as podApi from "../src/dust-pod.js";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podUi from "../src/dust-pod-ui.js";
import { registerDustPodFsCommand, registerDustPodsCommand } from "../src/dust-podfs.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { getPodBinding, savePodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** The panel the command opened, so tests can drive its actions directly. */
interface OpenedPanel {
  options: Omit<ListPanelOptions, "height">;
  setRows: ReturnType<typeof vi.fn>;
  setBusy: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

describe("/podfs and /pods", () => {
  useTempAgentDir();

  let root: string;
  let runtime: DustSessionRuntime;
  let notices: Array<[string, string]>;
  let confirmAnswer: boolean;
  let opened: OpenedPanel | null;
  /** What openListPanel resolves with: rows, undefined (esc) or null (no panel). */
  let panelResult: ListRow[] | undefined | null;

  function ctx() {
    return {
      ui: {
        notify: (message: string, level: string) => { notices.push([message, level]); },
        confirm: async () => confirmAnswer,
      },
    };
  }

  function register(register: typeof registerDustPodFsCommand): Handler {
    let handler: Handler | undefined;
    register({ registerCommand: (_n: string, c: { handler: Handler }) => { handler = c.handler; } } as never, runtime);
    if (!handler) throw new Error("command did not register");
    return handler;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-dust-podfs-"));
    notices = [];
    confirmAnswer = true;
    opened = null;
    panelResult = undefined;

    runtime = new DustSessionRuntime();
    runtime.extensionContext = { cwd: root } as never;

    vi.spyOn(podRuntime, "podApiFor").mockReturnValue({
      baseUrl: "https://x/api/w/w1",
      getAuthHeaders: () => ({}),
    });
    vi.spyOn(podUi, "supportsPanels").mockReturnValue(true);
    vi.spyOn(podUi, "openListPanel").mockImplementation(async (_ctx, options, onPanel) => {
      const panel = {
        options,
        setRows: vi.fn(),
        setBusy: vi.fn(),
        close: vi.fn(),
      } satisfies OpenedPanel;
      opened = panel;
      onPanel?.(panel as never);
      return panelResult;
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function messages(): string[] {
    return notices.map(([message]) => message);
  }

  function action(key: string) {
    const found = opened?.options.actions?.find((candidate) => candidate.key === key);
    if (!found) throw new Error(`no action bound to ${key}`);
    return found;
  }

  function podFile(rel: string, sizeBytes = 10, lastModifiedMs = 1) {
    return { path: `pod-vlt_1/${rel}`, fileName: rel, isDirectory: false, sizeBytes, lastModifiedMs };
  }

  describe("/podfs", () => {
    beforeEach(() => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    });

    it("lists the pod's files, sorted, with their sizes", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("z.py", 2048),
        podFile("a.py", 512),
      ]);

      await register(registerDustPodFsCommand)("", ctx());

      expect(opened?.options.rows.map((row) => row.label)).toEqual(["a.py", "z.py"]);
      expect(opened?.options.rows[0].detail).toBe("512 B");
      expect(opened?.options.rows[1].detail).toBe("2.0 kB");
    });

    it("tells the user to ingest first when nothing is bound", async () => {
      const { forgetPodBinding } = await import("../src/dust-state.js");
      forgetPodBinding(root);

      await register(registerDustPodFsCommand)("", ctx());

      expect(messages()[0]).toContain("No pod bound");
      expect(opened).toBeNull();
    });

    it("pulls a file onto disk", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/util.py")]);
      vi.spyOn(podApi, "downloadPodFile").mockResolvedValue(Buffer.from("x = 1"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      // Parent directories are created, so a nested pod file can land anywhere.
      expect(readFileSync(join(root, "src/util.py"), "utf8")).toBe("x = 1");
    });

    it("reports a failed pull in the panel rather than throwing", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py")]);
      vi.spyOn(podApi, "downloadPodFile").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("Pull failed: HTTP 500");
    });

    it("deletes a file and forgets its watermark, so the next push cannot restore it", async () => {
      // A tracked path missing from the pod is treated as one to re-upload, so
      // leaving the watermark behind would undo the delete on the next turn.
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        seen: { "a.py": { podMs: 1, hash: "h" }, "b.py": { podMs: 1, hash: "h" } },
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py"), podFile("b.py")]);
      const del = vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(del).toHaveBeenCalledWith(expect.anything(), "vlt_1", "a.py");
      expect(Object.keys(getPodBinding(root)?.seen ?? {})).toEqual(["b.py"]);
    });

    it("keeps the watermark when the delete failed", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: { "a.py": { podMs: 1, hash: "h" } } });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py")]);
      vi.spyOn(podApi, "deletePodFile").mockRejectedValue(new Error("HTTP 403"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(Object.keys(getPodBinding(root)?.seen ?? {})).toEqual(["a.py"]);
      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("Delete failed");
    });

    it("refreshes the list after a delete", async () => {
      vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("a.py"), podFile("b.py")])
        .mockResolvedValueOnce([podFile("b.py")]);
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(opened?.setRows.mock.calls[0][0].map((row: ListRow) => row.label)).toEqual(["b.py"]);
    });

    it("falls back to a notification when the host has no panel surface", async () => {
      vi.spyOn(podUi, "supportsPanels").mockReturnValue(false);
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py", 100)]);

      await register(registerDustPodFsCommand)("", ctx());

      expect(messages()[0]).toContain("a.py");
      expect(opened).toBeNull();
    });

    it("reloads on demand", async () => {
      vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("a.py")])
        .mockResolvedValueOnce([podFile("a.py"), podFile("b.py")]);

      await register(registerDustPodFsCommand)("", ctx());
      await action("r").run(opened!.options.rows[0], 0);

      expect(opened?.setRows.mock.calls[0][0].map((row: ListRow) => row.label)).toEqual(["a.py", "b.py"]);
    });

    it("reports a failed reload in the panel", async () => {
      vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("a.py")])
        .mockRejectedValueOnce(new Error("HTTP 500"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("r").run(opened!.options.rows[0], 0);

      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("Reload failed");
    });

    it("reports a listing failure instead of opening an empty panel", async () => {
      vi.spyOn(podApi, "listPodFiles").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodFsCommand)("", ctx());

      expect(messages()[0]).toContain("Could not list pod files: HTTP 500");
      expect(opened).toBeNull();
    });
  });

  describe("/pods", () => {
    function pod(name: string, sId: string, archivedAt: number | null = null) {
      return { name, sId, archivedAt };
    }

    it("lists pods, marking the bound and archived ones", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([
        pod("other", "vlt_2", 123),
        pod("proj", "vlt_1"),
      ]);

      await register(registerDustPodsCommand)("", ctx());

      const rows = opened?.options.rows ?? [];
      expect(rows.map((row) => row.label)).toEqual(["other", "proj"]);
      expect(rows[0].detail).toContain("archived");
      expect(rows[1].detail).toContain("bound");
    });

    it("archives a pod and unbinds it when it was this project's", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);
      const archive = vi.spyOn(podApi, "archivePod").mockResolvedValue(undefined);

      await register(registerDustPodsCommand)("", ctx());
      await action("a").run(opened!.options.rows[0], 0);

      expect(archive).toHaveBeenCalledWith(expect.anything(), "vlt_1");
      expect(getPodBinding(root)).toBeNull();
    });

    it("leaves another project's binding alone when archiving", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("other", "vlt_2")]);
      vi.spyOn(podApi, "archivePod").mockResolvedValue(undefined);

      await register(registerDustPodsCommand)("", ctx());
      await action("a").run(opened!.options.rows[0], 0);

      expect(getPodBinding(root)?.podId).toBe("vlt_1");
    });

    it("restores an archived pod", async () => {
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1", 123)]);
      const unarchive = vi.spyOn(podApi, "unarchivePod").mockResolvedValue(undefined);

      await register(registerDustPodsCommand)("", ctx());
      await action("u").run(opened!.options.rows[0], 0);

      expect(unarchive).toHaveBeenCalledWith(expect.anything(), "vlt_1");
    });

    it("confirms before deleting, since Dust scrubs the pod and there is no undo", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);
      const del = vi.spyOn(podApi, "deletePod").mockResolvedValue(undefined);

      await register(registerDustPodsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      // The panel comes down first, or the dialog would be unreachable beneath it.
      expect(opened?.close).toHaveBeenCalled();
      expect(del).toHaveBeenCalledWith(expect.anything(), "vlt_1");
      expect(getPodBinding(root)).toBeNull();
    });

    it("deletes nothing when the confirmation is declined", async () => {
      confirmAnswer = false;
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);
      const del = vi.spyOn(podApi, "deletePod");

      await register(registerDustPodsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(del).not.toHaveBeenCalled();
      expect(getPodBinding(root)?.podId).toBe("vlt_1");
      expect(messages()[0]).toContain('Kept pod "proj"');
    });

    it("reports a failed delete and keeps the binding", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);
      vi.spyOn(podApi, "deletePod").mockRejectedValue(new Error("HTTP 403"));

      await register(registerDustPodsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(messages()[0]).toContain("Delete failed: HTTP 403");
      expect(getPodBinding(root)?.podId).toBe("vlt_1");
    });

    it("reloads on demand", async () => {
      vi.spyOn(podApi, "listPods")
        .mockResolvedValueOnce([pod("proj", "vlt_1")])
        .mockResolvedValueOnce([pod("proj", "vlt_1"), pod("other", "vlt_2")]);

      await register(registerDustPodsCommand)("", ctx());
      await action("r").run(opened!.options.rows[0], 0);

      expect(opened?.setRows.mock.calls[0][0].map((row: ListRow) => row.label)).toEqual(["other", "proj"]);
    });

    it("reports a failed archive in the panel", async () => {
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);
      vi.spyOn(podApi, "archivePod").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodsCommand)("", ctx());
      await action("a").run(opened!.options.rows[0], 0);

      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("Archive failed");
    });

    it("reports a failed restore in the panel", async () => {
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1", 1)]);
      vi.spyOn(podApi, "unarchivePod").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodsCommand)("", ctx());
      await action("u").run(opened!.options.rows[0], 0);

      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("Restore failed");
    });

    it("refuses when the session is logged out", async () => {
      vi.spyOn(podRuntime, "podApiFor").mockImplementation(() => {
        throw new Error("Not logged in to Dust. Run /login first.");
      });

      await register(registerDustPodsCommand)("", ctx());

      expect(messages()[0]).toContain("Not logged in");
    });

    it("reports a listing failure instead of opening an empty panel", async () => {
      vi.spyOn(podApi, "listPods").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodsCommand)("", ctx());

      expect(messages()[0]).toContain("Could not list pods: HTTP 500");
      expect(opened).toBeNull();
    });

    it("falls back to a notification when the host has no panel surface", async () => {
      vi.spyOn(podUi, "supportsPanels").mockReturnValue(false);
      vi.spyOn(podApi, "listPods").mockResolvedValue([pod("proj", "vlt_1")]);

      await register(registerDustPodsCommand)("", ctx());

      expect(messages()[0]).toContain("proj");
      expect(opened).toBeNull();
    });

    it("says so when the workspace has no pods", async () => {
      vi.spyOn(podUi, "supportsPanels").mockReturnValue(false);
      vi.spyOn(podApi, "listPods").mockResolvedValue([]);

      await register(registerDustPodsCommand)("", ctx());

      expect(messages()[0]).toContain("No pods in this workspace");
    });
  });
});
