import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import { getToolDefinition, type McpToolResult } from "./dust-tools.js";

export const DUST_TOOL_ENTRY = "dust-tool-call";

/** What a Dust-driven tool call needs in order to render like a native one. */
export interface DustToolEntryData {
  toolName: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  durationMs: number;
  cwd: string;
  /** Structured payload for tools whose renderer needs more than text. */
  details?: unknown;
}

function isEntryData(value: unknown): value is DustToolEntryData {
  return typeof value === "object" && value !== null && typeof (value as DustToolEntryData).toolName === "string";
}

/**
 * pi's tool row only needs `requestRender` from the TUI, and a persisted
 * transcript entry is static, so a no-op satisfies it.
 */
const STATIC_UI = { requestRender: () => { /* nothing to invalidate */ } };

export function registerDustToolRenderer(pi: ExtensionAPI): void {
  const register = (pi as unknown as {
    registerEntryRenderer?: (customType: string, renderer: (entry: unknown, opts: { expanded: boolean }, theme: unknown) => unknown) => void;
  }).registerEntryRenderer;

  if (typeof register !== "function") {
    debugLog("dust:render", "registerEntryRenderer unavailable; tool calls will not render natively");
    return;
  }

  register(DUST_TOOL_ENTRY, (entry, options) => {
    const data = (entry as { data?: unknown })?.data;
    if (!isEntryData(data)) {
      return new Text("");
    }

    try {
      // ToolExecutionComponent is the exact component pi builds for its own
      // tool calls: it owns the render context, the coloured shell selected by
      // `renderShell`, and the fallbacks when a tool defines no renderer.
      // Driving it directly means no part of pi's tool row is reimplemented.
      const component = new ToolExecutionComponent(
        data.toolName,
        `dust-${data.toolName}`,
        data.args,
        undefined,
        getToolDefinition(data.toolName, data.cwd) as never,
        STATIC_UI as never,
        data.cwd,
      );

      component.setArgsComplete();
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: data.text }],
        isError: data.isError,
        details: data.details,
      });
      component.setExpanded(options?.expanded ?? false);

      return component;
    } catch (err) {
      // A renderer mismatch must never take down the transcript.
      debugLog("dust:render", "tool row render failed", { error: String(err) });
      return new Text(`${data.toolName}: ${data.text}`);
    }
  });
}

/** Records a completed Dust tool call so it renders in pi's transcript. */
export function appendToolEntry(
  pi: ExtensionAPI,
  toolName: string,
  args: Record<string, unknown>,
  result: McpToolResult,
  durationMs: number,
  cwd: string,
): void {
  const data: DustToolEntryData = {
    toolName,
    args,
    text: result.content.map((block) => block.text).join("\n"),
    isError: result.isError,
    durationMs,
    cwd,
    details: result.details,
  };
  try {
    pi.appendEntry(DUST_TOOL_ENTRY, data as unknown as Record<string, unknown>);
  } catch (err) {
    debugLog("dust:render", "appendEntry failed", { error: String(err) });
  }
}
