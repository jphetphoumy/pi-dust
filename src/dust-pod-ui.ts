import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { debugLog } from "./dust-debug.js";
import {
  DustPodListPanel,
  type ListPanelOptions,
  type ListRow,
  listPanelHeight,
} from "./dust-pod-list-panel.js";
import type { PiRuntimeContext } from "./dust-types.js";

/**
 * pi's custom-UI surface. `ctx.ui.custom` swaps a component into the editor's
 * slot and resolves when the component calls `done`.
 */
type CustomUi = <T>(
  factory: (
    tui: { requestRender: () => void; terminal?: { rows?: number } },
    theme: Theme,
    keybindings: unknown,
    done: (value: T) => void,
  ) => Component,
) => Promise<T>;

function customUi(ctx: PiRuntimeContext): CustomUi | null {
  const custom = (ctx.ui as { custom?: CustomUi } | undefined)?.custom;
  return typeof custom === "function" ? custom : null;
}

/** True when the host can show a panel at all — headless and RPC modes cannot. */
export function supportsPanels(ctx: PiRuntimeContext): boolean {
  return customUi(ctx) !== null;
}

/**
 * Opens a list panel and resolves with the user's choice, or null when the host
 * has no surface to show it on.
 *
 * `null` is deliberately distinct from `undefined`: the latter is the user
 * pressing Esc, which callers must honour, while the former means "fall back to
 * a plain dialog". Collapsing the two would silently turn a cancelled panel into
 * a confirm-everything prompt.
 */
export async function openListPanel(
  ctx: PiRuntimeContext,
  options: Omit<ListPanelOptions, "height">,
  onPanel?: (panel: DustPodListPanel) => void,
): Promise<ListRow[] | undefined | null> {
  const custom = customUi(ctx);
  if (!custom) {
    debugLog("dust:pod", "No custom UI surface; falling back to a dialog");
    return null;
  }

  return custom<ListRow[] | undefined>((tui, theme, _keybindings, done) => {
    const panel = new DustPodListPanel(
      theme,
      { ...options, height: listPanelHeight(tui.terminal?.rows ?? 0) },
      () => tui.requestRender(),
      done,
    );
    onPanel?.(panel);
    return panel;
  });
}
