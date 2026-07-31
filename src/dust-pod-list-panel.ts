import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncate } from "./dust-status-panel.js";

/** Rows reserved for the title, the rule, the scroll counter and the hint. */
const CHROME_HEIGHT = 6;
const MAX_PANEL_HEIGHT = 26;
const MIN_PANEL_HEIGHT = 10;

export function listPanelHeight(rows: number): number {
  if (!rows || rows <= 0) return MAX_PANEL_HEIGHT;
  return Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, rows - 8));
}

export interface ListRow {
  /** Primary text, e.g. a relative path or a pod name. */
  label: string;
  /** Dimmed trailing detail, e.g. a size or an id. */
  detail?: string;
  /** Ticked in select mode. Ignored otherwise. */
  selected?: boolean;
  /** Some but not all of this row's contents are ticked. Tree mode only. */
  partial?: boolean;
  /** Indent level. Tree mode only. */
  depth?: number;
  /** This row has contents to open, i.e. it is a directory. Tree mode only. */
  expandable?: boolean;
  /** Whether those contents are currently listed below it. Tree mode only. */
  expanded?: boolean;
  /** Free-form payload for the caller's action handlers. */
  value?: unknown;
}

/**
 * Hooks for a list whose rows come from a tree the caller owns.
 *
 * The panel cannot maintain the selection itself once rows nest: ticking a
 * directory has to tick files that a collapsed row is not even showing, and
 * those files must survive the row list being rebuilt on every expand. So in
 * tree mode the panel reports intent and the caller — which holds the tree and
 * the selected-path set — decides what it means and calls `setRows`.
 */
export interface ListTreeHooks {
  /** Space on a row: tick or untick it and everything under it. */
  toggleSelect: (row: ListRow) => void;
  /** `a`: tick everything, or clear it all when everything is already ticked. */
  toggleAll: () => void;
  /** →/← on a directory row. */
  setExpanded: (row: ListRow, expanded: boolean) => void;
}

/** A key the panel offers on the focused row, shown in the hint line. */
export interface ListAction {
  /** Single character the user presses. */
  key: string;
  /** Verb for the hint line, e.g. "delete". */
  label: string;
  /** Runs against the focused row. Returning rows replaces the list. */
  run: (row: ListRow, index: number) => void | Promise<void>;
}

export interface ListPanelOptions {
  title: string;
  rows: ListRow[];
  height: number;
  /** Space toggles rows and Enter resolves with the ticked ones. */
  selectable?: boolean;
  /**
   * Turns the list into a tree. Implies `selectable`, and hands selection and
   * expansion back to the caller — so Enter resolves with the *visible* ticked
   * rows only, and a tree caller should read its own selection set instead,
   * using the resolved value solely to tell Enter (an array) from Esc
   * (`undefined`).
   */
  tree?: ListTreeHooks;
  /** Tree mode's Enter hint, e.g. `enter pull 12`. Re-read on every render. */
  confirmHint?: () => string;
  actions?: ListAction[];
  /** Shown in place of the list when there is nothing to show. */
  emptyMessage?: string;
}

/**
 * A scrolling list panel: the shared body of `/ingest`'s file picker, `/podfs`
 * and `/pods`.
 *
 * One component rather than three because the three differ only in what a row
 * means and which keys act on it. Keeping them together is also what keeps the
 * keyboard model identical, which is the part a user actually has to learn.
 *
 * Two modes. `selectable` gives space-to-tick and resolves with the ticked rows,
 * for choosing what to upload. Otherwise rows are acted on where they sit, via
 * `actions`, for browsing and deleting.
 *
 * Mirrors `/status`: it renders in the editor's slot rather than as an overlay,
 * ↑/↓ move, Esc closes, and the hint line always states the available keys.
 */
export class DustPodListPanel implements Component {
  private rows: ListRow[];
  private focus = 0;
  private scroll = 0;
  private busy: string | null = null;

  constructor(
    private theme: Theme,
    private options: ListPanelOptions,
    private requestRender: () => void,
    /** Resolves the panel: the ticked rows in select mode, undefined on Esc. */
    private done: (result: ListRow[] | undefined) => void,
  ) {
    this.rows = options.rows.map((row) => ({ ...row }));
  }

  /** Replaces the list in place, for an action that changed the underlying data. */
  setRows(rows: ListRow[]): void {
    this.rows = rows.map((row) => ({ ...row }));
    this.focus = Math.min(this.focus, Math.max(0, this.rows.length - 1));
    this.requestRender();
  }

  invalidate(): void { /* nothing cached between renders */ }

  setBusy(message: string | null): void {
    this.busy = message;
    this.requestRender();
  }

  close(): void {
    this.done(undefined);
  }

  handleInput(data: string): void {
    // An action is in flight; swallow keys rather than queue work against a
    // list that is about to change under the user.
    if (this.busy !== null) return;

    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "up")) {
      this.focus = Math.max(0, this.focus - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.focus = Math.min(this.rows.length - 1, this.focus + 1);
      this.requestRender();
      return;
    }

    const tree = this.options.tree;
    if (tree) {
      const row = this.rows[this.focus];
      if (matchesKey(data, "right")) {
        if (row?.expandable && !row.expanded) tree.setExpanded(row, true);
        return;
      }
      if (matchesKey(data, "left")) {
        // Collapse where there is something to collapse, otherwise step out to
        // the parent — the same two meanings ← has in every other file tree.
        if (row?.expandable && row.expanded) tree.setExpanded(row, false);
        else this.focusParentOf(this.focus);
        return;
      }
    }

    if (this.options.selectable || tree) {
      if (data === " ") {
        const row = this.rows[this.focus];
        if (!row) return;
        if (tree) tree.toggleSelect(row);
        else {
          row.selected = !row.selected;
          this.requestRender();
        }
        return;
      }
      if (data === "a") {
        if (tree) {
          tree.toggleAll();
          return;
        }
        // Toggle against "everything already ticked", so `a` reads as
        // select-all first and clear-all once nothing is left to add.
        const target = !this.rows.every((row) => row.selected);
        for (const row of this.rows) row.selected = target;
        this.requestRender();
        return;
      }
      if (matchesKey(data, "return")) {
        this.done(this.rows.filter((row) => row.selected));
        return;
      }
    }

    const action = this.options.actions?.find((candidate) => candidate.key === data);
    const row = this.rows[this.focus];
    if (action && row) {
      void action.run(row, this.focus);
    }
  }

  /** Moves the cursor to the nearest row above that is one level shallower. */
  private focusParentOf(index: number): void {
    const depth = this.rows[index]?.depth ?? 0;
    if (depth === 0) return;
    for (let i = index - 1; i >= 0; i--) {
      if ((this.rows[i]?.depth ?? 0) < depth) {
        this.focus = i;
        break;
      }
    }
    this.requestRender();
  }

  private renderRow(row: ListRow, index: number, width: number): string {
    const th = this.theme;
    const focused = index === this.focus;
    const ticked = this.options.selectable || this.options.tree
      ? row.partial
        ? "[~] "
        : row.selected
          ? "[x] "
          : "[ ] "
      : "";
    // A fixed-width twisty, so file names still line up under their directory.
    const twisty = this.options.tree ? (row.expandable ? (row.expanded ? "▾ " : "▸ ") : "  ") : "";
    const indent = "  ".repeat(row.depth ?? 0);
    const pointer = focused ? "› " : "  ";
    const detail = row.detail ? ` ${th.fg("dim", row.detail)}` : "";
    const label = focused ? th.fg("accent", row.label) : row.label;
    return truncate(`  ${pointer}${ticked}${indent}${twisty}${label}${detail}`, width);
  }

  render(width: number): string[] {
    const th = this.theme;
    const bodyHeight = this.options.height > 0
      ? Math.max(1, this.options.height - CHROME_HEIGHT)
      : this.rows.length;

    // Keep the focused row inside the window.
    if (this.focus < this.scroll) this.scroll = this.focus;
    if (this.focus >= this.scroll + bodyHeight) this.scroll = this.focus - bodyHeight + 1;
    const maxScroll = Math.max(0, this.rows.length - bodyHeight);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));

    const body = this.rows.length === 0
      ? [`  ${th.fg("dim", this.options.emptyMessage ?? "Nothing to show.")}`]
      : this.rows
          .slice(this.scroll, this.scroll + bodyHeight)
          .map((row, offset) => this.renderRow(row, this.scroll + offset, width));

    const lines = [
      `  ${th.fg("accent", this.options.title)}`,
      th.fg("borderMuted", `  ${"─".repeat(Math.max(0, width - 4))}`),
      ...body,
    ];

    if (maxScroll > 0) {
      const shown = Math.min(bodyHeight, this.rows.length - this.scroll);
      lines.push("", `  ${th.fg("dim", `${this.scroll + 1}-${this.scroll + shown} of ${this.rows.length}`)}`);
    }

    lines.push("", `  ${this.busy !== null ? th.fg("warning", this.busy) : this.renderHint()}`);
    return lines.map((line) => (visibleWidth(line) > width ? truncate(line, width) : line));
  }

  private renderHint(): string {
    const th = this.theme;
    const parts: string[] = ["↑/↓ move"];
    if (this.options.tree) {
      // The ticked count cannot be read off the rows here — a collapsed
      // directory hides ticked files — so the caller states it.
      parts.push("→/← open/close", "space toggle", "a all/none", this.options.confirmHint?.() ?? "enter confirm");
    } else if (this.options.selectable) {
      const ticked = this.rows.filter((row) => row.selected).length;
      parts.push("space toggle", "a all/none", `enter upload ${ticked}`);
    }
    for (const action of this.options.actions ?? []) {
      parts.push(`${action.key} ${action.label}`);
    }
    parts.push("esc close");
    return th.fg("dim", parts.join("  ·  "));
  }
}
