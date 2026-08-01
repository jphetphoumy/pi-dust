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
/** Splits `rest` into its first whitespace-delimited token and the remainder, tolerating tabs/newlines, not just spaces. */
const FIRST_TOKEN_PATTERN = /^(\S+)(?:\s+([\s\S]*))?$/;
const LOOP_SELF_REFERENCE_PATTERN = /^\/loop(\s|$)/i;

/** Parses a token like `30s`, `5m`, `1h` into milliseconds, or null if it isn't a valid duration. */
export function parseDuration(token: string): number | null {
  const match = DURATION_PATTERN.exec(token.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  const ms = Number.parseFloat(amount) * UNIT_MS[unit.toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const USAGE_MESSAGE = "Usage: /loop <interval> <prompt|/command>, or /loop <prompt|/command> to self-pace.";

/**
 * Parses `/loop`'s argument string into a request.
 *
 * Grammar: the first whitespace-delimited token is treated as an interval
 * only if it fully matches a duration pattern; a token that merely *looks*
 * like a duration attempt (`0s`, digits followed by letters) but fails to
 * parse is reported as an error rather than silently becoming the payload.
 * Otherwise the whole string is the payload. `off`/`stop`/`status` (any case)
 * are reserved only when they are the *entire* argument, so `/loop stop the
 * deploy` loops that prompt rather than being misread as a stop request.
 * A leading `-- ` forces payload interpretation, so a payload that happens to
 * start with a reserved word (`/loop -- off the lights`) still loops instead
 * of stopping.
 */
export function parseLoopArgs(raw: string): LoopRequest {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || lower === "status") return { kind: "status" };
  if (lower === "off" || lower === "stop") return { kind: "stop" };

  const forcePayload = trimmed === "--" || trimmed.startsWith("-- ");
  const rest = forcePayload ? trimmed.slice(2).trim() : trimmed;
  if (rest === "") return { kind: "error", message: USAGE_MESSAGE };

  const tokenMatch = FIRST_TOKEN_PATTERN.exec(rest);
  const firstToken = tokenMatch ? tokenMatch[1] : rest;
  const remainder = (tokenMatch?.[2] ?? "").trim();

  let mode: DustLoopMode;
  let payload: string;
  let intervalMs: number | null;

  if (forcePayload) {
    mode = "selfPaced";
    payload = rest;
    intervalMs = null;
  } else {
    const durationMs = parseDuration(firstToken);
    // A token that matches the duration *shape* (digits + s/m/h) but fails to
    // parse — the only way that happens is a non-positive amount like `0s` —
    // is a near-miss worth an error, not a token that just happens to start
    // the payload (e.g. `10x`, which doesn't match the shape at all).
    if (durationMs === null && DURATION_PATTERN.test(firstToken)) {
      return { kind: "error", message: "Invalid loop interval — use digits followed by s/m/h (e.g. 30s, 5m, 1h)." };
    }
    if (durationMs === null) {
      mode = "selfPaced";
      payload = rest;
      intervalMs = null;
    } else {
      mode = "interval";
      payload = remainder;
      intervalMs = durationMs;
    }
  }

  if (payload === "") {
    return { kind: "error", message: USAGE_MESSAGE };
  }
  if (LOOP_SELF_REFERENCE_PATTERN.test(payload)) {
    return { kind: "error", message: "/loop cannot loop itself." };
  }

  if (mode === "selfPaced") {
    return { kind: "start", mode, payload, intervalMs: null, clamped: false };
  }

  if ((intervalMs as number) > MAX_INTERVAL_MS) {
    return { kind: "error", message: "Loop interval must be at most 24h." };
  }

  const clamped = (intervalMs as number) < MIN_INTERVAL_MS;
  return { kind: "start", mode, payload, intervalMs: clamped ? MIN_INTERVAL_MS : intervalMs, clamped };
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

/** Short form for the footer slot. `waiting` reflects only the most recent tick, not lifetime skip count. */
function describeLoopFooter(loop: DustLoopState): string {
  const progress = loop.maxIterations !== null ? `#${loop.iterations}/${loop.maxIterations}` : `#${loop.iterations}`;
  const waiting = loop.waitingOnBusyAgent ? ", waiting" : "";
  const cadence = loop.mode === "interval" ? `every ${formatInterval(loop.intervalMs as number)}` : "self-paced";
  return `${STATUS_KEY}: ${cadence} (${progress}${waiting})`;
}

/** Human-readable form for `/loop status` toasts — distinct from the terse footer text. */
function describeLoopMessage(loop: DustLoopState): string {
  const cadence = loop.mode === "interval" ? `every ${formatInterval(loop.intervalMs as number)}` : "self-paced";
  const progress = loop.maxIterations !== null ? `${loop.iterations} of ${loop.maxIterations} iterations` : `${loop.iterations} iterations so far`;
  const waiting = loop.waitingOnBusyAgent ? " — waiting for the agent to go idle" : "";
  return `Looping ${cadence} (${progress})${waiting}.`;
}

function showStatus(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const handle = ui(runtime, ctx);
  handle?.setStatus?.(STATUS_KEY, runtime.loop ? describeLoopFooter(runtime.loop) : undefined);
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

/** Arms (replacing any pending) the cooldown timer that retries a self-paced iteration. */
function armSelfPacedRetry(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  if (runtime.loopCooldownTimer) clearTimeout(runtime.loopCooldownTimer);
  runtime.loopCooldownTimer = setTimeout(() => {
    runtime.loopCooldownTimer = null;
    runIteration(runtime, ctx);
  }, SELF_PACED_COOLDOWN_MS);
}

/**
 * Runs one iteration if the agent is idle, otherwise records a skip and — for
 * self-paced loops — schedules its own retry directly, rather than waiting on
 * whatever turn is currently occupying the agent to settle (that turn isn't
 * ours; piggybacking on its `agent_settled` is exactly the stray-event
 * hijack `expectingSettle` exists to prevent).
 *
 * Wrapped in try/catch: this runs from bare `setInterval`/`setTimeout`
 * callbacks, and `pi.sendUserMessage` can throw (e.g. mid-turn without a
 * `deliverAs`) — an uncaught throw here would otherwise crash the process,
 * the same reason `dust-mcp.ts`'s heartbeat wraps its timer body.
 */
function runIteration(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const loop = runtime.loop;
  if (!loop || !runtime.pi) return;

  try {
    if (!agentIsIdle(runtime, ctx)) {
      loop.skipped++;
      loop.waitingOnBusyAgent = true;
      showStatus(runtime, ctx);
      debugLog("dust:loop", "Skipped tick — agent busy", { iterations: loop.iterations, skipped: loop.skipped });
      if (loop.mode === "selfPaced") armSelfPacedRetry(runtime, ctx);
      return;
    }

    sendPayload(runtime, loop.payload);
    loop.iterations++;
    loop.waitingOnBusyAgent = false;
    if (loop.mode === "selfPaced") loop.expectingSettle = true;
    showStatus(runtime, ctx);
    debugLog("dust:loop", "Sent iteration", { mode: loop.mode, iterations: loop.iterations });

    if (loop.maxIterations !== null && loop.iterations >= loop.maxIterations) {
      notify(runtime, `Loop reached its ${loop.maxIterations}-iteration limit and stopped.`, "warning", ctx);
      stopDustLoop(runtime, ctx, "session");
    }
  } catch (err) {
    debugLog("dust:loop", "Iteration failed", { error: String(err) });
  }
}

/**
 * Fires on `agent_settled`. A no-op unless a self-paced loop is active and
 * `expectingSettle` — set only right after this loop's own send — is true;
 * an unrelated turn the user ran between iterations settles with the flag
 * false and is ignored, so it can't burn one of the loop's iterations.
 */
export function handleAgentSettled(runtime: DustSessionRuntime, ctx?: PiRuntimeContext): void {
  const loop = runtime.loop;
  if (!loop || loop.mode !== "selfPaced" || !loop.expectingSettle) return;
  loop.expectingSettle = false;
  armSelfPacedRetry(runtime, ctx);
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
    waitingOnBusyAgent: false,
    expectingSettle: false,
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
          const message = runtime.loop ? describeLoopMessage(runtime.loop) : "No loop running.";
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

  // `session_shutdown` is pi's session-lifecycle event, so that half of loop
  // cleanup is wired from dust-session-events.ts (the module that owns every
  // other lifecycle hook) instead of here — see registerDustSessionEvents.
  const piWithEvents = pi as ExtensionAPIWithEvents;
  if (typeof piWithEvents.on === "function") {
    const registerEvent = piWithEvents.on as (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;
    registerEvent("agent_settled", (_event, ctx) => handleAgentSettled(runtime, ctx));
  } else {
    debugLog("dust:loop", "Extension event API unavailable; /loop off is the only way to stop a loop");
  }
}
