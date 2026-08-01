import { describe, expect, it, vi } from "vitest";
import type { ListRow } from "../src/dust-pod-list-panel.js";
import { openListPanel, supportsPanels } from "../src/dust-pod-ui.js";

const theme = { fg: (_color: string, text: string) => text };

/**
 * A stand-in for pi's `ctx.ui.custom`: builds the component, hands it the `done`
 * callback, and resolves with whatever the component passes back — which is
 * what the real host does when the panel closes.
 */
function ctxWithCustom(drive: (component: { handleInput?: (data: string) => void }) => void) {
  return {
    ui: {
      custom: <T>(
        factory: (
          tui: { requestRender: () => void; terminal?: { rows?: number } },
          th: unknown,
          keybindings: unknown,
          done: (value: T) => void,
        ) => { handleInput?: (data: string) => void },
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 30 } },
            theme,
            undefined,
            resolve as (value: T) => void,
          );
          drive(component);
        }),
    },
  } as never;
}

describe("pod panel surface", () => {
  it("reports a host that offers a custom-UI surface", () => {
    expect(supportsPanels(ctxWithCustom(() => {}))).toBe(true);
  });

  it("reports a host without one", () => {
    // Headless and RPC modes have no surface, and older pi builds may not
    // expose `custom` at all.
    expect(supportsPanels({ ui: {} } as never)).toBe(false);
    expect(supportsPanels({} as never)).toBe(false);
  });

  it("resolves with the rows the user ticked", async () => {
    const result = await openListPanel(
      ctxWithCustom((component) => {
        component.handleInput?.(" ");
        component.handleInput?.("\r");
      }),
      { title: "Pick", rows: [{ label: "a.py", value: "a.py" }], selectable: true },
    );

    expect((result as ListRow[]).map((row) => row.label)).toEqual(["a.py"]);
  });

  it("resolves undefined when the user escapes", async () => {
    const result = await openListPanel(
      ctxWithCustom((component) => component.handleInput?.("\x1b")),
      { title: "Pick", rows: [{ label: "a.py" }], selectable: true },
    );

    expect(result).toBeUndefined();
  });

  it("resolves null when there is no surface, which is not the same as a cancel", async () => {
    // Callers branch on this to fall back to a plain dialog; collapsing it into
    // undefined would silently turn "no panel" into "user said no".
    const result = await openListPanel({ ui: {} } as never, { title: "Pick", rows: [] });

    expect(result).toBeNull();
  });

  it("hands the panel back to the caller, so actions can drive it", async () => {
    const onPanel = vi.fn();

    await openListPanel(
      ctxWithCustom((component) => component.handleInput?.("\x1b")),
      { title: "Pick", rows: [{ label: "a.py" }] },
      onPanel,
    );

    expect(onPanel).toHaveBeenCalledTimes(1);
    expect(onPanel.mock.calls[0][0].setBusy).toBeInstanceOf(Function);
  });

  it("sizes the panel from the terminal it was given", async () => {
    // 30 rows leaves 22 for the panel, so a 40-row list has to scroll rather
    // than push the transcript off the screen.
    let rendered: string[] = [];

    await openListPanel(
      ctxWithCustom((component) => {
        rendered = (component as unknown as { render: (w: number) => string[] }).render(60);
        component.handleInput?.("\x1b");
      }),
      { title: "Pick", rows: Array.from({ length: 40 }, (_, i) => ({ label: `f${i}` })) },
    );

    expect(rendered.length).toBeLessThan(30);
    expect(rendered.join("\n")).toContain("of 40");
  });
});
