import { describe, expect, it, vi } from "vitest";
import {
  DustPodListPanel,
  type ListAction,
  listPanelHeight,
  type ListRow,
} from "../src/dust-pod-list-panel.js";

/** A theme stub that returns text unchanged, so assertions read plainly. */
const theme = { fg: (_color: string, text: string) => text } as never;

function makePanel(options: {
  rows?: ListRow[];
  selectable?: boolean;
  actions?: ListAction[];
  height?: number;
  emptyMessage?: string;
} = {}) {
  const done = vi.fn();
  const requestRender = vi.fn();
  const panel = new DustPodListPanel(
    theme,
    {
      title: "Files",
      rows: options.rows ?? [{ label: "a.py" }, { label: "b.py" }, { label: "c.py" }],
      height: options.height ?? 12,
      selectable: options.selectable,
      actions: options.actions,
      emptyMessage: options.emptyMessage,
    },
    requestRender,
    done,
  );
  return { panel, done, requestRender };
}

/** The panel renders styled lines; this pulls out the rows for assertions. */
function rowsOf(panel: DustPodListPanel): string[] {
  return panel
    .render(60)
    .filter((line) => line.includes("›") || /^ {4}(\[|\w)/.test(line))
    .map((line) => line.trimEnd());
}

describe("pod list panel", () => {
  it("caps its height so the transcript stays visible above it", () => {
    expect(listPanelHeight(0)).toBe(26);
    expect(listPanelHeight(20)).toBe(12);
    expect(listPanelHeight(4)).toBe(10);
    expect(listPanelHeight(200)).toBe(26);
  });

  it("points at the focused row and moves with the arrows", () => {
    const { panel } = makePanel();

    expect(rowsOf(panel)[0]).toContain("› a.py");

    panel.handleInput("\x1b[B");
    expect(rowsOf(panel)[1]).toContain("› b.py");

    panel.handleInput("\x1b[A");
    expect(rowsOf(panel)[0]).toContain("› a.py");
  });

  it("does not walk off either end of the list", () => {
    const { panel } = makePanel();

    panel.handleInput("\x1b[A");
    expect(rowsOf(panel)[0]).toContain("› a.py");

    for (let i = 0; i < 10; i++) panel.handleInput("\x1b[B");
    expect(rowsOf(panel)[2]).toContain("› c.py");
  });

  it("resolves with undefined on escape, so callers can tell cancel from empty", () => {
    const { panel, done } = makePanel({ selectable: true });

    panel.handleInput("\x1b");

    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("ticks rows with space and resolves with only those", () => {
    const { panel, done } = makePanel({ selectable: true });

    panel.handleInput(" ");
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.handleInput(" ");
    panel.handleInput("\r");

    expect(done.mock.calls[0][0].map((row: ListRow) => row.label)).toEqual(["a.py", "c.py"]);
  });

  it("shows tick state per row", () => {
    const { panel } = makePanel({
      selectable: true,
      rows: [{ label: "a.py", selected: true }, { label: "b.py" }],
    });

    const rendered = rowsOf(panel);
    expect(rendered[0]).toContain("[x] a.py");
    expect(rendered[1]).toContain("[ ] b.py");
  });

  it("selects all with `a`, then clears with a second press", () => {
    // Toggling against "already all ticked" makes one key do both jobs, which
    // is what the hint promises.
    const { panel, done } = makePanel({ selectable: true });

    panel.handleInput("a");
    expect(rowsOf(panel).every((line) => line.includes("[x]"))).toBe(true);

    panel.handleInput("a");
    expect(rowsOf(panel).every((line) => line.includes("[ ]"))).toBe(true);

    panel.handleInput("\r");
    expect(done).toHaveBeenCalledWith([]);
  });

  it("counts the ticked rows in the hint, so enter is never a surprise", () => {
    const { panel } = makePanel({ selectable: true });

    panel.handleInput(" ");

    expect(panel.render(80).at(-1)).toContain("enter upload 1");
  });

  it("runs an action against the focused row", () => {
    const run = vi.fn();
    const { panel } = makePanel({ actions: [{ key: "d", label: "delete", run }] });

    panel.handleInput("\x1b[B");
    panel.handleInput("d");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].label).toBe("b.py");
    expect(run.mock.calls[0][1]).toBe(1);
  });

  it("ignores a key no action claims", () => {
    const run = vi.fn();
    const { panel } = makePanel({ actions: [{ key: "d", label: "delete", run }] });

    panel.handleInput("z");

    expect(run).not.toHaveBeenCalled();
  });

  it("lists every available key in the hint", () => {
    const { panel } = makePanel({
      actions: [
        { key: "p", label: "pull", run: vi.fn() },
        { key: "d", label: "delete", run: vi.fn() },
      ],
    });

    const hint = panel.render(120).at(-1) ?? "";
    expect(hint).toContain("p pull");
    expect(hint).toContain("d delete");
    expect(hint).toContain("esc close");
  });

  it("swallows keys while an action is in flight", () => {
    // Otherwise a second delete would act on a row index about to shift under
    // the user as the list reloads.
    const run = vi.fn();
    const { panel } = makePanel({ actions: [{ key: "d", label: "delete", run }] });

    panel.setBusy("Deleting…");
    panel.handleInput("d");
    panel.handleInput("\x1b");

    expect(run).not.toHaveBeenCalled();
  });

  it("shows the busy message in place of the hint", () => {
    const { panel } = makePanel();

    panel.setBusy("Pulling a.py…");

    expect(panel.render(80).at(-1)).toContain("Pulling a.py…");
  });

  it("replaces the list after an action, keeping the focus in range", () => {
    const { panel } = makePanel();

    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.setRows([{ label: "only.py" }]);

    expect(rowsOf(panel)[0]).toContain("› only.py");
  });

  it("explains itself when there is nothing to list", () => {
    const { panel } = makePanel({ rows: [], emptyMessage: "This pod holds no files yet." });

    expect(panel.render(60).join("\n")).toContain("This pod holds no files yet.");
  });

  it("scrolls to keep the focused row visible and says where it is", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ label: `f${i}.py` }));
    const { panel } = makePanel({ rows, height: 12 });

    for (let i = 0; i < 20; i++) panel.handleInput("\x1b[B");
    const rendered = panel.render(60);

    expect(rendered.join("\n")).toContain("› f20.py");
    expect(rendered.join("\n")).toContain("of 30");
  });

  it("never emits a line wider than the viewport", () => {
    const rows = [{ label: "a-very-long-".repeat(20), detail: "1.2 kB" }];
    const { panel } = makePanel({ rows });

    for (const line of panel.render(40)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("closes on request, for an action that needs a dialog instead", () => {
    const { panel, done } = makePanel();

    panel.close();

    expect(done).toHaveBeenCalledWith(undefined);
  });
});
