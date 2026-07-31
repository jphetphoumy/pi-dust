import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListPanelOptions, ListRow } from "../src/dust-pod-list-panel.js";
import * as podApi from "../src/dust-pod.js";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podUi from "../src/dust-pod-ui.js";
import { registerDustPodFsCommand, registerDustPodsCommand } from "../src/dust-podfs.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import * as dustState from "../src/dust-state.js";
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
  /** Runs against the live panel options before it resolves. */
  let interact: ((options: Omit<ListPanelOptions, "height">) => void | Promise<void>) | null;

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
    interact = null;

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
      // Stands in for the user driving the panel before it closes — the tree's
      // selection only exists while it is open.
      await interact?.(options);
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

    it("opens on the top level only, with folders closed", async () => {
      // A pod mirrors a whole project; expanding it all would be a wall of
      // files to scroll before the shape the user is picking from is visible.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/a.py", 100),
        podFile("src/lib/b.py", 20),
        podFile("README.md", 5),
      ]);

      await register(registerDustPodFsCommand)("", ctx());

      expect(opened?.options.rows.map((row) => row.label)).toEqual(["src/", "README.md"]);
      // Counts and sizes roll up from every descendant, so a closed folder
      // still says how much pulling it would cost.
      expect(opened?.options.rows[0].detail).toBe("2 files, 120 B");
      expect(opened?.options.rows[0].expandable).toBe(true);
      expect(opened?.options.rows[0].expanded).toBe(false);
      expect(opened?.options.rows[1].expandable).toBe(false);
    });

    it("reveals a folder's contents when it is opened", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/lib/b.py", 20),
        podFile("z.py"),
      ]);
      let after: ListRow[] = [];
      interact = (options) => {
        options.tree!.setExpanded(options.rows[0], true);
        after = opened!.setRows.mock.calls.at(-1)![0] as ListRow[];
      };

      await register(registerDustPodFsCommand)("", ctx());

      // Only one level: the nested folder appears, still closed.
      expect(after.map((row) => row.label)).toEqual(["src/", "lib/", "z.py"]);
      expect(after[0].expanded).toBe(true);
      expect(after[1].expanded).toBe(false);
      expect(after[1].depth).toBe(1);
      expect(after[1].detail).toBe("1 file, 20 B");
    });

    it("pulls a whole folder from one keypress", async () => {
      // The point of the tree: `p` on `src/` used to be impossible — a folder
      // was not a row, so each file had to be pulled on its own.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/a.py"),
        podFile("src/lib/b.py"),
        podFile("other.py"),
      ]);
      vi.spyOn(podApi, "downloadPodFile").mockResolvedValue(Buffer.from("x = 1"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      expect(readFileSync(join(root, "src/a.py"), "utf8")).toBe("x = 1");
      expect(readFileSync(join(root, "src/lib/b.py"), "utf8")).toBe("x = 1");
      expect(existsSync(join(root, "other.py"))).toBe(false);
    });

    it("pulls everything ticked when the panel is confirmed", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/a.py"),
        podFile("src/lib/b.py"),
        podFile("z.py"),
      ]);
      vi.spyOn(podApi, "downloadPodFile").mockResolvedValue(Buffer.from("x = 1"));
      panelResult = [];
      interact = (options) => {
        // Tick `src/` while it is closed, then open it and untick the one file
        // inside that is not wanted — the tick has to survive the rebuild.
        options.tree!.toggleSelect(options.rows[0]);
        options.tree!.setExpanded(options.rows[0], true);
        // Rows are now src/, lib/, src/a.py, z.py.
        const rows = opened!.setRows.mock.calls.at(-1)![0] as ListRow[];
        options.tree!.toggleSelect(rows[2]);
      };

      await register(registerDustPodFsCommand)("", ctx());

      expect(readFileSync(join(root, "src/lib/b.py"), "utf8")).toBe("x = 1");
      expect(existsSync(join(root, "src/a.py"))).toBe(false);
      expect(existsSync(join(root, "z.py"))).toBe(false);
      expect(messages().join(" ")).toContain("Pulled 1 file");
    });

    it("marks a folder as partly selected once a file under it is unticked", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py"), podFile("src/b.py")]);
      let rows: ListRow[] = [];
      interact = (options) => {
        options.tree!.toggleSelect(options.rows[0]);
        options.tree!.setExpanded(options.rows[0], true);
        rows = opened!.setRows.mock.calls.at(-1)![0] as ListRow[];
        expect(rows[0].selected).toBe(true);
        options.tree!.toggleSelect(rows[1]);
        rows = opened!.setRows.mock.calls.at(-1)![0] as ListRow[];
      };

      await register(registerDustPodFsCommand)("", ctx());

      expect(rows[0].selected).toBe(false);
      expect(rows[0].partial).toBe(true);
    });

    it("pulls nothing when the panel was escaped, however much was ticked", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py")]);
      const download = vi.spyOn(podApi, "downloadPodFile");
      panelResult = undefined;
      interact = (options) => options.tree!.toggleAll();

      await register(registerDustPodFsCommand)("", ctx());

      expect(download).not.toHaveBeenCalled();
    });

    it("refuses to pull a ticked pod path that would escape the project root", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("../evil.txt")]);
      const download = vi.spyOn(podApi, "downloadPodFile");
      panelResult = [];
      interact = (options) => options.tree!.toggleAll();

      await register(registerDustPodFsCommand)("", ctx());

      expect(download).not.toHaveBeenCalled();
      expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
      expect(messages().join(" ")).toContain("escapes the project root");
    });

    it("deletes a folder's files behind a confirmation", async () => {
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        seen: { "src/a.py": { podMs: 1, hash: "h" }, "z.py": { podMs: 1, hash: "h" } },
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/a.py"),
        podFile("src/lib/b.py"),
        podFile("z.py"),
      ]);
      const del = vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(del.mock.calls.map((call) => call[2]).sort()).toEqual(["src/a.py", "src/lib/b.py"]);
      // The watermarks go too, or the next push would restore what was deleted.
      expect(Object.keys(getPodBinding(root)?.seen ?? {})).toEqual(["z.py"]);
    });

    it("drops a folder's watermarks in a single state save, not one per file", async () => {
      // Per-file saves mean a full read-modify-write of dust-state.json per
      // file, which a folder delete can do hundreds of times over.
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        seen: {
          "src/a.py": { podMs: 1, hash: "h" },
          "src/lib/b.py": { podMs: 1, hash: "h" },
          "z.py": { podMs: 1, hash: "h" },
        },
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        podFile("src/a.py"),
        podFile("src/lib/b.py"),
        podFile("z.py"),
      ]);
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);
      const save = vi.spyOn(dustState, "savePodBinding");

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(save).toHaveBeenCalledTimes(1);
      expect(Object.keys(getPodBinding(root)?.seen ?? {})).toEqual(["z.py"]);
    });

    it("keeps a folder when the confirmation is declined", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py")]);
      const del = vi.spyOn(podApi, "deletePodFile");
      confirmAnswer = false;

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(del).not.toHaveBeenCalled();
      expect(messages().join(" ")).toContain("Kept src/");
    });

    it("reopens the picker — and keeps the ticked selection — when a folder delete is declined", async () => {
      // Closing the panel to show the confirm dialog resolves openListPanel
      // with `undefined`, the same value Esc produces. Without the fix that
      // reads as the user cancelling and the ticked files are thrown away.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py"), podFile("z.py")]);
      const del = vi.spyOn(podApi, "deletePodFile");
      confirmAnswer = false;
      let calls = 0;
      interact = async (options) => {
        calls++;
        if (calls > 1) return;
        options.tree!.toggleSelect(options.rows[1]); // tick z.py
        await options.actions!.find((candidate) => candidate.key === "d")!.run(options.rows[0], 0);
      };

      await register(registerDustPodFsCommand)("", ctx());

      expect(del).not.toHaveBeenCalled();
      expect(calls).toBe(2);
      const rows = opened?.options.rows ?? [];
      expect(rows.find((row) => row.label === "z.py")?.selected).toBe(true);
    });

    it("reopens the picker and keeps the ticked selection when the post-delete refresh fails", async () => {
      // The folder delete itself succeeded — the files are gone from the pod —
      // but the listing call that refreshes the tree afterwards can still
      // reject. Without the fix that unhandled rejection propagates out of the
      // `/podfs` handler: the picker never reopens and the ticked selection is
      // thrown away, even though the delete the loop exists to protect went
      // through.
      vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("src/a.py"), podFile("z.py")])
        .mockRejectedValueOnce(new Error("HTTP 500"));
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);
      let calls = 0;
      interact = async (options) => {
        calls++;
        if (calls > 1) return;
        options.tree!.toggleSelect(options.rows[1]); // tick z.py
        await options.actions!.find((candidate) => candidate.key === "d")!.run(options.rows[0], 0);
      };

      await register(registerDustPodFsCommand)("", ctx());

      expect(calls).toBe(2);
      const rows = opened?.options.rows ?? [];
      expect(rows.find((row) => row.label === "z.py")?.selected).toBe(true);
      expect(messages().join(" ")).toContain("Could not refresh pod files");
    });

    it("reports the watermark save failing without undoing the notice that files were deleted", async () => {
      // The files are already gone from the pod at this point — only the
      // state-file save that clears their watermarks fails (read-only FS, full
      // disk, ...). Without the fix this used to surface as a generic "could
      // not refresh" message, with the "Deleted N files" notice never firing
      // at all because it sat after the failing save.
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        seen: { "src/a.py": { podMs: 1, hash: "h" } },
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py")]);
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);
      vi.spyOn(dustState, "savePodBinding").mockImplementation(() => {
        throw new Error("EROFS: read-only file system");
      });

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      expect(messages().join(" ")).toContain("Deleted 1 file");
      const errorNotice = notices.find(([, level]) => level === "error");
      expect(errorNotice?.[0]).toContain("could not clear its sync watermarks");
      expect(errorNotice?.[0]).toContain("re-uploaded on the next turn");
    });

    it("still refreshes the listing when the watermark save failed", async () => {
      // The save failing says nothing about whether the pod can be listed
      // again. Skipping the refresh left the reopened picker showing files
      // that were already gone, until the user pressed `r`.
      // The watermark has to exist, or `forgetWatermarks` has nothing to save
      // and never reaches the throwing call at all.
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        seen: { "src/a.py": { podMs: 1, hash: "h" } },
      });
      const list = vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("src/a.py"), podFile("z.py")])
        .mockResolvedValue([podFile("z.py")]);
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);
      vi.spyOn(dustState, "savePodBinding").mockImplementation(() => {
        throw new Error("EROFS: read-only file system");
      });

      await register(registerDustPodFsCommand)("", ctx());
      await action("d").run(opened!.options.rows[0], 0);

      // The second listing is the refresh; without it the picker would reopen
      // still showing the deleted folder.
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("reports 0 deleted, not a false 'Deleted' notice, when the confirm dialog itself rejects", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py")]);
      const del = vi.spyOn(podApi, "deletePodFile");
      const ctxWithFailingConfirm = () => ({
        ui: {
          notify: (message: string, level: string) => { notices.push([message, level]); },
          confirm: async () => {
            throw new Error("dialog surface unavailable");
          },
        },
      });

      await register(registerDustPodFsCommand)("", ctxWithFailingConfirm());
      await action("d").run(opened!.options.rows[0], 0);

      expect(del).not.toHaveBeenCalled();
      expect(messages().join(" ")).not.toContain("Deleted");
      expect(messages().join(" ")).toContain("Could not confirm deleting src/");
    });

    it("keeps the picker reopening even when the confirm dialog rejects", async () => {
      // The dialogPending promise must never reject, whatever step inside it
      // throws — otherwise the reopen loop breaks and the ticked selection is
      // lost along with an unhandled rejection.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py"), podFile("z.py")]);
      let calls = 0;
      const ctxWithFailingConfirm = () => ({
        ui: {
          notify: (message: string, level: string) => { notices.push([message, level]); },
          confirm: async () => {
            throw new Error("dialog surface unavailable");
          },
        },
      });
      interact = async (options) => {
        calls++;
        if (calls > 1) return;
        options.tree!.toggleSelect(options.rows[1]); // tick z.py
        await options.actions!.find((candidate) => candidate.key === "d")!.run(options.rows[0], 0);
      };

      await register(registerDustPodFsCommand)("", ctxWithFailingConfirm());

      expect(calls).toBe(2);
      const rows = opened?.options.rows ?? [];
      expect(rows.find((row) => row.label === "z.py")?.selected).toBe(true);
    });

    it("keeps the focus near a deleted folder when the picker reopens", async () => {
      vi.spyOn(podApi, "listPodFiles")
        .mockResolvedValueOnce([podFile("a/x.py"), podFile("b/y.py"), podFile("c/z.py")])
        .mockResolvedValueOnce([podFile("a/x.py"), podFile("c/z.py")]);
      vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);
      let calls = 0;
      let secondOptions: Omit<ListPanelOptions, "height"> | null = null;
      interact = async (options) => {
        calls++;
        if (calls > 1) {
          secondOptions = options;
          return;
        }
        // The user was focused on b/, which the delete removes entirely.
        await options.actions!.find((candidate) => candidate.key === "d")!.run(options.rows[1], 1);
      };

      await register(registerDustPodFsCommand)("", ctx());

      expect(calls).toBe(2);
      const rows = secondOptions!.rows;
      const idx = secondOptions!.initialFocus?.(rows);
      // b/ is gone; the nearest surviving row is what now sits where it did.
      expect(rows[idx as number]?.label).toBe("c/");
    });

    it("notifies the full failure list for a folder pull, not just the busy line's first failure", async () => {
      // Each file used to be pulled on its own, so every failure was seen. A
      // folder pull's busy line shows only the first and is wiped after
      // 1500ms — the rest must not be silently dropped.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("src/a.py"), podFile("src/b.py")]);
      vi.spyOn(podApi, "downloadPodFile")
        .mockRejectedValueOnce(new Error("HTTP 500"))
        .mockRejectedValueOnce(new Error("HTTP 403"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      const warning = notices.find(([, level]) => level === "warning");
      expect(warning?.[0]).toContain("src/a.py: HTTP 500");
      expect(warning?.[0]).toContain("src/b.py: HTTP 403");
    });

    it("passes a multi-line API error straight through to the panel's setBusy", async () => {
      // A raw response body — pretty-printed JSON or an HTML error page — can
      // carry newlines straight through `errorMessage`. Collapsing that
      // whitespace is now `DustPodListPanel.setBusy`'s job (see
      // "collapses a newline in the busy message" in pod-list-panel.test.ts),
      // not this handler's — the mocked panel here does not sanitise, so this
      // only confirms the message still reaches `setBusy` on failure.
      const messy = new Error('HTTP 500 — {\n  "error": "boom"\n}');
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py"), podFile("b.py")]);
      vi.spyOn(podApi, "downloadPodFile").mockRejectedValue(messy);
      vi.spyOn(podApi, "deletePodFile").mockRejectedValue(messy);

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);
      await action("d").run(opened!.options.rows[1], 1);

      const busyStrings = (opened?.setBusy.mock.calls.map((call) => call[0]) ?? []).filter(
        (msg): msg is string => msg !== null,
      );
      expect(busyStrings.some((msg) => msg.includes("boom"))).toBe(true);
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

    it("refuses to pull a pod path that would escape the project root", async () => {
      // The pod listing is untrusted input — the agent's own writes — so a
      // `../../.ssh/authorized_keys` style entry must not be joined onto
      // `root` just because the user pressed `p`.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("../evil.txt")]);
      const download = vi.spyOn(podApi, "downloadPodFile");

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      expect(download).not.toHaveBeenCalled();
      expect(opened?.setBusy.mock.calls.map((call) => call[0]).join(" ")).toContain("escapes the project root");
      expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    });

    it("reports a failed pull in the panel rather than throwing", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py")]);
      vi.spyOn(podApi, "downloadPodFile").mockRejectedValue(new Error("HTTP 500"));

      await register(registerDustPodFsCommand)("", ctx());
      await action("p").run(opened!.options.rows[0], 0);

      const busy = opened?.setBusy.mock.calls.map((call) => call[0]).join(" ");
      expect(busy).toContain("Pulled 0, 1 failed — a.py: HTTP 500");
      expect(busy).not.toContain("\n");
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
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([podFile("a.py", 1536)]);

      await register(registerDustPodFsCommand)("", ctx());

      // The per-file size, same as the panel's detail column, so the flat
      // fallback still says how big a file is before someone pulls it.
      expect(messages()[0]).toContain("a.py");
      expect(messages()[0]).toContain("1.5 kB");
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
