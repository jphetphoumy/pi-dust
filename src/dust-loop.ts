import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./dust-debug.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import type { DustLoopMode, DustLoopState, ExtensionAPIWithEvents, LoopRequest, PiRuntimeContext } from "./dust-types.js";

/** Footer slot showing the active loop's cadence and progress. */
const STATUS_KEY = "dust-loop";

/** Below this, an interval loop would hammer the agent faster than a turn can realistically finish. */
const MIN_INTERVAL_MS = 30_000;
/** Above this, `/loop` isn't really "recurring" anymore — the user wants a one-off scheduled prompt instead. */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Gap between a self-paced iteration settling and the next one firing.
 *
 * Not cosmetic: it (a) moves the next send out of the `agent_settled` handler's
 * own call stack, so we never re-enter the agent while it is still settling,
 * (b) gives a human a window to type `/loop off` between iterations, and
 * (c) stops a hot spin if the agent errors out instantly on every turn.
 */
const SELF_PACED_COOLDOWN_MS = 5_000;

/**
 * Self-paced mode has no fixed cadence to rate-limit it, so — unlike interval
 * mode, which the user has already throttled by choosing an interval — it gets
 * a hard iteration cap instead of running until an explicit `/loop off`.
 */
const SELF_PACED_MAX_ITERATIONS = 20;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h)$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** Parses a token like `30s`, `5m`, `1h` into milliseconds, or null if it isn't a duration. */
export function parseDuration(token: string): number | null {
  const match = DURATION_PATTERN.exec(token.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  const ms = Number.parseFloat(amount) * UNIT_MS[unit.toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Parses `/loop`'s argument string into a request.
 *
 * Grammar: the first whitespace-delimited token is treated as an interval
 * only if it fully matches a duration pattern; otherwise the whole string is
 * the payload. `off`/`stop`/`status` are reserved only when they are the
 * *entire* argument, so `/loop stop the deploy` loops that prompt rather than
 * being misread as a stop request. `--` forces payload interpretation, so a
 * payload that happens to start with a reserved word (`/loop -- off the
 * lights`) still loops instead of stopping.
 */
export function parseLoopArgs(raw: string): LoopRequest {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "status") return { kind: "status" };
  if (trimmed === "off" || trimmed === "stop") return { kind: "stop" };

  const rest = trimmed.startsWith("--") ? trimmed.slice(2).trim() : trimmed;
  if (rest === "") return { kind: "error", message: "Usage: /loop <interval> <prompt|/command>, or /loop <prompt|/command> to self-pace." };

  const firstSpace = rest.indexOf(" ");
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const durationMs = trimmed.startsWith("--") ? null : parseDuration(firstToken);

  const mode: DustLoopMode = durationMs === null ? "selfPaced" : "interval";
  const payload = (durationMs === null ? rest : rest.slice(firstSpace + 1)).trim();

  if (payload === "") {
    return { kind: "error", message: "Usage: /loop <interval> <prompt|/command>, or /loop <prompt|/command> to self-pace." };
  }
  if (payload === "/loop" || payload.startsWith("/loop ")) {
    return { kind: "error", message: "/loop cannot loop itself." };
  }

  if (durationMs === null) {
    return { kind: "start", mode, payload, intervalMs: null, clamped: false };
  }

  if (durationMs > MAX_INTERVAL_MS) {
    return { kind: "error", message: "Loop interval must be at most 24h." };
  }

  const clamped = durationMs < MIN_INTERVAL_MS;
  return { kind: "start", mode, payload, intervalMs: clamped ? MIN_INTERVAL_MS : durationMs, clamped };
}

function ui(runtime: DustSessionRuntime, ctx?: PiRuntimeContext) {
  return (ctx ?? runtime.extensionContext)?.ui as
    | { notify?: (message: string, level: string) => void; setStatus?: (key: string, text: string | undefined) => void }
    | undefined;
}

function notify(runtime: DustSessionRuntime, message: string, level: string, ctx?: PiRuntimeContext): void {
  ui(runtime, ctx)?.notify?.(message, level);
}

function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

function describeLoop(loop: DustLoopState): string {
  const progress = loop.maxIterations !== null ? `#${loop.iterations}/${loop.maxIterations}` : `#${loop.iterations}`;
  const waiting = loop.skipped > 0 ? ", waiting" : "";
  const cadence = loop.mode === "interval" ? `every ${formatInterval(loop.intervalMs as number)}` : "self-paced";
  return `${STATUS_KEY}: ${cadence} (${progress}${waiting})`;
}

function showStatus(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const handle = ui(runtime, ctx);
  handle?.setStatus?.(STATUS_KEY, runtime.loop ? describeLoop(runtime.loop) : undefined);
}

/** Prefers the host's own idle check; falls back to our own turn tracking when it isn't wired up. */
function agentIsIdle(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): boolean {
  const isIdle = (ctx ?? runtime.extensionContext)?.isIdle;
  return typeof isIdle === "function" ? isIdle() : runtime.activeTurn === null;
}

/**
 * Cancels the active loop, if any.
 *
 * `reason` distinguishes a user-initiated stop (notified) from session
 * teardown (silent — the user didn't ask, and a session that's ending has no
 * one left to read the notification).
 */
export function stopDustLoop(runtime: DustSessionRuntime, ctx?: PiRuntimeContext, reason: "user" | "session" = "user"): void {
  const had = runtime.loop !== null;
  runtime.clearLoopState();
  showStatus(runtime, ctx);
  if (had && reason === "user") {
    notify(runtime, "Loop stopped.", "info", ctx);
  }
  if (had) {
    debugLog("dust:loop", "Loop stopped", { reason });
  }
}

function sendPayload(runtime: DustSessionRuntime, payload: string): void {
  const pi = runtime.pi as (ExtensionAPI & { sendUserMessage?: ExtensionAPI["sendUserMessage"] }) | null;
  pi?.sendUserMessage?.(payload);
}

/** Runs one iteration if the agent is idle, otherwise records a skip. Stops the loop once a self-paced cap is hit. */
function runIteration(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const loop = runtime.loop;
  if (!loop || !runtime.pi) return;

  if (!agentIsIdle(runtime, ctx)) {
    loop.skipped++;
    showStatus(runtime, ctx);
    debugLog("dust:loop", "Skipped tick — agent busy", { iterations: loop.iterations, skipped: loop.skipped });
    return;
  }

  sendPayload(runtime, loop.payload);
  loop.iterations++;
  showStatus(runtime, ctx);
  debugLog("dust:loop", "Sent iteration", { mode: loop.mode, iterations: loop.iterations });

  if (loop.maxIterations !== null && loop.iterations >= loop.maxIterations) {
    notify(runtime, `Loop reached its ${loop.maxIterations}-iteration limit and stopped.`, "warning", ctx);
    stopDustLoop(runtime, ctx, "session");
  }
}

/**
 * Fires on `agent_settled`. A no-op unless a self-paced loop is active — it
 * arms (replacing any pending) cooldown timer that runs the next iteration.
 */
export function handleAgentSettled(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  if (!runtime.loop || runtime.loop.mode !== "selfPaced") return;
  if (runtime.loopCooldownTimer) clearTimeout(runtime.loopCooldownTimer);
  runtime.loopCooldownTimer = setTimeout(() => {
    runtime.loopCooldownTimer = null;
    runIteration(runtime, ctx);
  }, SELF_PACED_COOLDOWN_MS);
}

function startLoop(
  runtime: DustSessionRuntime,
  request: Extract<LoopRequest, { kind: "start" }>,
  ctx: PiRuntimeContext,
): void {
  const replacing = runtime.loop !== null;
  runtime.clearLoopState();

  runtime.loop = {
    mode: request.mode,
    payload: request.payload,
    intervalMs: request.intervalMs,
    iterations: 0,
    skipped: 0,
    maxIterations: request.mode === "selfPaced" ? SELF_PACED_MAX_ITERATIONS : null,
    startedAt: Date.now(),
  };

  if (request.mode === "interval") {
    runtime.loopTimer = setInterval(() => runIteration(runtime, ctx), request.intervalMs as number);
  }

  if (replacing) {
    notify(runtime, "Replacing the running loop.", "info", ctx);
  }
  if (request.clamped) {
    notify(runtime, `Interval below the ${formatInterval(MIN_INTERVAL_MS)} floor — clamped up.`, "warning", ctx);
  }
  notify(
    runtime,
    request.mode === "interval"
      ? `Loop started — every ${formatInterval(request.intervalMs as number)}. Use /loop off to stop.`
      : `Loop started — self-paced, up to ${SELF_PACED_MAX_ITERATIONS} iterations. Use /loop off to stop.`,
    "info",
    ctx,
  );
  debugLog("dust:loop", "Loop started", { mode: request.mode, intervalMs: request.intervalMs });

  showStatus(runtime, ctx);
  // First iteration fires immediately, same as the user typing the command by hand.
  runIteration(runtime, ctx);
}

export function registerDustLoopCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("loop", {
    description: "Re-run a prompt or command on an interval (/loop 5m /cmd) or self-paced (/loop /cmd); /loop off to stop",
    handler: async (args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const request = parseLoopArgs(args);

      switch (request.kind) {
        case "status": {
          const message = runtime.loop ? describeLoop(runtime.loop) : "No loop running.";
          notify(runtime, message, "info", runtimeCtx);
          return;
        }
        case "stop":
          stopDustLoop(runtime, runtimeCtx, "user");
          return;
        case "error":
          notify(runtime, request.message, "warning", runtimeCtx);
          return;
        case "start":
          startLoop(runtime, request, runtimeCtx);
          return;
      }
    },
  });

  const piWithEvents = pi as ExtensionAPIWithEvents;
  if (typeof piWithEvents.on === "function") {
    const registerEvent = piWithEvents.on as (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;
    registerEvent("agent_settled", (_event, ctx) => handleAgentSettled(runtime, ctx));
    registerEvent("session_shutdown", (_event, ctx) => stopDustLoop(runtime, ctx, "session"));
  } else {
    debugLog("dust:loop", "Extension event API unavailable; /loop off is the only way to stop a loop");
  }
}
