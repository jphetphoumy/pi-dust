import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import type { PiRuntimeContext } from "./dust-types.js";

/** Footer slot showing the current approval mode. */
const STATUS_KEY = "dust-approval";

/**
 * Claude Code binds auto-accept to shift+tab, but pi reserves that for
 * `app.thinking.cycle` and refuses extension shortcuts that collide with a
 * built-in ("conflicts with built-in shortcut. Skipping."). shift+ctrl+a is
 * free and follows pi's own shift+ctrl+* pattern.
 *
 * To actually get shift+tab, remap the built-in in ~/.pi/agent/keybindings.json
 * ("app.thinking.cycle" to something else) and set PI_DUST_APPROVAL_SHORTCUT.
 */
const DEFAULT_TOGGLE_SHORTCUT = "shift+ctrl+a";
const SHORTCUT_ENV = "PI_DUST_APPROVAL_SHORTCUT";

function describe(autoApprove: boolean): string {
  return autoApprove ? "dust: auto-approve" : "dust: approve each tool";
}

function showStatus(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const ui = (ctx ?? runtime.extensionContext)?.ui as
    | { setStatus?: (key: string, text: string) => void }
    | undefined;
  ui?.setStatus?.(STATUS_KEY, describe(runtime.autoApprove));
}

function setMode(runtime: DustSessionRuntime, autoApprove: boolean, ctx?: PiRuntimeContext): void {
  runtime.autoApprove = autoApprove;
  debugLog("dust:approval", "Approval mode changed", { autoApprove });
  showStatus(runtime, ctx);

  const ui = (ctx ?? runtime.extensionContext)?.ui as
    | { notify?: (message: string, level: string) => void }
    | undefined;
  ui?.notify?.(
    autoApprove
      ? "Auto-approve on — Dust tool calls run without asking."
      : "Auto-approve off — every Dust tool call asks first.",
    autoApprove ? "warning" : "info",
  );
}

/**
 * Registers the auto-approve toggle.
 *
 * The flag is read by the confirm wrapper in dust-runtime, so it covers both
 * approval points: Dust's server-side `tool_approve_execution` gate and the
 * local `tools/call` gate.
 */
export function registerDustApprovalMode(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("auto", {
    description: "Toggle auto-approval of Dust tool calls (no confirmation prompts)",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      const next = requested === "on" ? true : requested === "off" ? false : !runtime.autoApprove;
      setMode(runtime, next, ctx as PiRuntimeContext);
    },
  });

  const registerShortcut = (pi as unknown as {
    registerShortcut?: (shortcut: string, options: { description: string; handler: (ctx: unknown) => unknown }) => void;
  }).registerShortcut;

  if (typeof registerShortcut === "function") {
    const shortcut = process.env[SHORTCUT_ENV]?.trim() || DEFAULT_TOGGLE_SHORTCUT;
    registerShortcut(shortcut, {
      description: "Toggle Dust auto-approve",
      handler: (ctx) => setMode(runtime, !runtime.autoApprove, ctx as PiRuntimeContext),
    });
    debugLog("dust:approval", "Registered approval shortcut", { shortcut });
  } else {
    debugLog("dust:approval", "registerShortcut unavailable; use /auto");
  }
}

/** Re-applies the footer indicator after a session starts or switches. */
export function refreshApprovalStatus(runtime: DustSessionRuntime, ctx: PiRuntimeContext): void {
  showStatus(runtime, ctx);
}
