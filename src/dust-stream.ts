import { CANCELLED_MESSAGE, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type {
  AssistantMessageLike,
  DustModel,
  PiContentBlock,
  PiEventStream,
  PiStreamEvent,
  PiTextBlock,
  PiThinkingBlock,
  ToolApproveExecutionEvent,
} from "./dust-types.js";
import {
  getDustEventErrorMessage,
  getDustEventType,
  getOptionalStringField,
  getStringField,
  isRecord,
  parseToolApproveExecutionEvent,
  unwrapEnvelope,
} from "./dust-validation.js";

const INITIAL_STREAM_RETRY_DELAY_MS = 1_000;
const MAX_STREAM_RETRY_DELAY_MS = 30_000;
const MAX_IDLE_RECONNECTS = 3;
const NO_AGENT_MESSAGE_ERROR = "No agent message found in conversation content";

function streamRetryDelay(attempt: number): number {
  return Math.min(INITIAL_STREAM_RETRY_DELAY_MS * 2 ** attempt, MAX_STREAM_RETRY_DELAY_MS);
}

async function waitForStreamRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function makeEmptyMessage(model: DustModel): AssistantMessageLike {
  return {
    role: "assistant",
    content: [],
    api: model.api ?? "dust",
    provider: model.provider ?? "dust",
    model: model.id ?? "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Which kind of pi content block a token batch grows. */
type BlockKind = PiContentBlock["type"];

/**
 * Event names and an empty-block constructor for each `BlockKind`, so the
 * three places that branch on it (open, delta, close) share one table
 * instead of repeating the ternary. `satisfies` keeps this checked against
 * `BlockKind`: a third block kind would fail here, at the table, rather than
 * as a missing case at a `BLOCK_SHAPES[kind]` use site.
 */
const BLOCK_SHAPES = {
  text: {
    start: "text_start",
    delta: "text_delta",
    end: "text_end",
    make: (): PiTextBlock => ({ type: "text", text: "" }),
  },
  thinking: {
    start: "thinking_start",
    delta: "thinking_delta",
    end: "thinking_end",
    make: (): PiThinkingBlock => ({ type: "thinking", thinking: "" }),
  },
} as const satisfies Record<BlockKind, { start: string; delta: string; end: string; make: () => PiContentBlock }>;

/**
 * The assistant message as it is being written, block by block.
 *
 * Dust streams the reasoning trace and the answer over the same
 * `generation_tokens` event, told apart by `classification`. The two must not
 * be concatenated: pi renders `thinking` blocks dimmed and separate from the
 * reply, and only the `text` blocks make up the answer — which is what later
 * turns quote back to Dust (see `extractMessageText` in dust-stream-provider).
 */
interface StreamingMessage {
  /**
   * Opens the turn: pushes `start` with this message's own (empty) partial.
   * Must be called exactly once, before the reconnect loop — pi's agent loop
   * drops every partial update until it sees this, so calling it again mid-turn
   * would look like a second turn starting over the first. Enforced here, not
   * just by the caller: a second call is a no-op.
   */
  start(): void;
  /** Appends to the open block of `kind`, opening one if it is not open yet. */
  append(kind: BlockKind, delta: string): void;
  /**
   * Ends whichever block is open, so the next token starts a fresh one. Every
   * exit from a turn must call this before its terminal event: pi-ai's own
   * `AssistantMessageEvent` doc says a stream should emit `start` then
   * partial updates before terminating, and every provider adapter closes
   * what it opens, so an unclosed block is a stream that doesn't hold up its
   * end of that contract — not, as an earlier version of this comment
   * claimed, something pi's renderer visibly gets stuck on. Checked against
   * `pi-agent-core`'s `agent-loop.js`: it handles every `*_start`/`*_delta`/
   * `*_end` case identically (replace `partialMessage`, re-emit) and keeps no
   * per-block open/closed state of its own.
   */
  endBlock(): void;
  /** The answer only, with the reasoning left out. */
  answerText(): string;
  /** Detached copy of the blocks written so far, for a terminal message. */
  snapshot(): PiContentBlock[];
}

function appendDelta(message: StreamingMessage, kind: BlockKind, delta: string): void {
  message.append(kind, delta);
  // Only logged when a delta was actually pushed — `append` silently drops an
  // empty batch, and a line claiming forwarding that didn't happen sends
  // anyone debugging a missing token the wrong way.
  if (delta) debugLog("dust:stream", `Forwarded ${kind} delta`, { delta });
}

/**
 * What each Dust `generation_tokens` classification does to the message.
 *
 * `tokens` is the answer and `chain_of_thought` the reasoning behind it; the
 * two delimiters are the markup Dust wraps the trace in, so they carry no
 * content of their own and only end the current block. A table rather than a
 * chain of string comparisons: every entry has the same shape, so adding a
 * classification is one row, and the lookup miss below is the single place
 * that has to describe "we don't know this one".
 */
const CLASSIFICATION_ACTIONS: Partial<Record<string, (message: StreamingMessage, delta: string) => void>> = {
  tokens: (message, delta) => appendDelta(message, "text", delta),
  chain_of_thought: (message, delta) => appendDelta(message, "thinking", delta),
  opening_delimiter: (message) => message.endBlock(),
  closing_delimiter: (message) => message.endBlock(),
};

function createStreamingMessage(stream: PiEventStream, model: DustModel): StreamingMessage {
  const partial = makeEmptyMessage(model);
  let started = false;
  // `index` and `block` are set and cleared together as one unit, so a
  // future edit can't update one and forget the other the way three
  // separate `let`s invited.
  let open: { index: number; block: PiTextBlock | PiThinkingBlock } | null = null;

  // pi keeps a reference to whatever `partial` it was last handed, so every
  // event gets its own copy of the blocks; sharing them would rewrite the
  // history of the turn in place as later tokens arrive.
  const detach = (): AssistantMessageLike => ({
    ...partial,
    content: partial.content.map((block) => ({ ...block })),
  });

  function endBlock(): void {
    if (!open) return;
    const { index, block } = open;
    const shape = BLOCK_SHAPES[block.type];
    const content = block.type === "text" ? block.text : block.thinking;
    stream.push({ type: shape.end, contentIndex: index, content, partial: detach() });
    open = null;
  }

  return {
    start() {
      if (started) {
        debugLog("dust:stream", "start() called again mid-turn — ignoring the repeat", {});
        return;
      }
      started = true;
      stream.push({ type: "start", partial: detach() });
    },
    append(kind, delta) {
      // An empty batch (e.g. `text: ""`, or a non-string field) must not open
      // a block or push a delta — Dust does send these, and an empty block
      // would render as a stray, content-less bubble in the transcript.
      if (!delta) return;
      const shape = BLOCK_SHAPES[kind];
      if (!open || open.block.type !== kind) {
        endBlock();
        const block = shape.make();
        partial.content.push(block);
        open = { index: partial.content.length - 1, block };
        stream.push({ type: shape.start, contentIndex: open.index, partial: detach() });
      }
      if (open.block.type === "text") {
        open.block.text += delta;
      } else {
        open.block.thinking += delta;
      }
      stream.push({ type: shape.delta, contentIndex: open.index, delta, partial: detach() });
    },
    endBlock,
    answerText() {
      return partial.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    },
    snapshot() {
      return detach().content;
    },
  };
}

/**
 * Ends the turn as cancelled, keeping whatever the agent had already written.
 *
 * pi renders `aborted` as an interrupted turn rather than a failure, so the
 * transcript shows the partial answer instead of an "operation was aborted"
 * error.
 */
function finishAborted(
  stream: PiEventStream,
  model: DustModel,
  message: StreamingMessage,
  resolveApprovalGate: () => void,
): void {
  resolveApprovalGate();
  message.endBlock();
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = message.snapshot();
  finalMessage.stopReason = "aborted";
  finalMessage.errorMessage = CANCELLED_MESSAGE;
  stream.push({ type: "error", reason: "aborted", error: finalMessage });
  stream.end();
  debugLog("dust:stream", "Stream aborted by user", { answerText: message.answerText() });
}

/**
 * Ends the turn as a clean stop: closes whatever block is open, then pushes
 * `done` with the finished message. `agent_message_success`,
 * `agent_message_gracefully_stopped` and the reconnect loop falling through
 * without ever seeing a terminal event all end this way — sharing one
 * function keeps that five-step sequence from drifting out of sync the way
 * the throw paths (`agent_error` / `user_message_error`, further down) once
 * did by skipping the `endBlock()` step.
 */
function finishStopped(
  stream: PiEventStream,
  model: DustModel,
  message: StreamingMessage,
  resolveApprovalGate: () => void,
  logLabel: string,
): void {
  resolveApprovalGate();
  message.endBlock();
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = message.snapshot();
  finalMessage.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end();
  debugLog("dust:stream", logLabel, { answerText: message.answerText() });
}

export function createEventStream(): PiEventStream {
  const queue: PiStreamEvent[] = [];
  const waiters: Array<(result: IteratorResult<PiStreamEvent>) => void> = [];
  let done = false;
  let resolveResult!: (value: AssistantMessageLike) => void;
  const resultPromise = new Promise<AssistantMessageLike>((resolve) => { resolveResult = resolve; });

  return {
    push(event: PiStreamEvent) {
      if (done) return;
      if (event.type === "done") {
        done = true;
        resolveResult(event.message);
      } else if (event.type === "error") {
        done = true;
        resolveResult(event.error);
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end() {
      if (!done) done = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<PiStreamEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<PiStreamEvent>>((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<PiStreamEvent>> {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export function findAgentMessageSId(content: unknown[], userMessageSId: string): string {
  for (const versions of content) {
    if (!Array.isArray(versions) || versions.length === 0) continue;
    const latest = versions[versions.length - 1];
    if (!isRecord(latest)) continue;
    if (latest.type === "agent_message" && latest.parentMessageId === userMessageSId) {
      return getStringField(latest, "sId", "agent message");
    }
  }
  throw new Error(NO_AGENT_MESSAGE_ERROR);
}

/** True when the conversation had no agent message for that user message yet. */
export function isMissingAgentMessageError(error: unknown): boolean {
  return error instanceof Error && error.message === NO_AGENT_MESSAGE_ERROR;
}

interface StreamEventsOptions {
  baseUrl: string;
  conversationSId: string;
  agentMsgSId: string;
  getAuthHeaders: () => Record<string, string>;
  /** Attempts a token refresh after a 401. Returns true if a retry is worthwhile. */
  refreshAuth: () => Promise<boolean>;
  signal: AbortSignal | undefined;
  stream: PiEventStream;
  model: DustModel;
  handleToolApproveExecution: (event: ToolApproveExecutionEvent) => Promise<boolean>;
  postValidateAction: (conversationId: string, messageId: string, actionId: string, approved: boolean) => Promise<void>;
  recordPreApproval: (actionId: string, approved: boolean) => void;
  resolveApprovalGate: () => void;
  /**
   * Dust reported the generation as cancelled. This is the one way a turn ends
   * cancelled without the local abort signal firing, so the runtime has to be
   * told separately or it would still treat late tool calls as live.
   */
  onCancelled: () => void;
}

export async function streamEvents({
  baseUrl,
  conversationSId,
  agentMsgSId,
  getAuthHeaders,
  refreshAuth,
  signal,
  stream,
  model,
  handleToolApproveExecution,
  postValidateAction,
  recordPreApproval,
  resolveApprovalGate,
  onCancelled,
}: StreamEventsOptions): Promise<void> {
  const baseSseUrl = `${baseUrl}/assistant/conversations/${conversationSId}/messages/${agentMsgSId}/events`;
  const message = createStreamingMessage(stream, model);
  // pi's agent loop ignores every partial update until a `start` event has
  // opened the streaming message, so without this nothing renders before the
  // turn ends — the whole answer lands at once. Emitted exactly once, before
  // the reconnect loop below: every reconnect (each tool call, and Dust's 60s
  // window cap) resumes the same turn and must not repeat it.
  message.start();
  debugLog("dust:stream", "Opening SSE stream", { conversationSId, agentMsgSId, sseUrl: baseSseUrl });
  let reconnectAttempt = 0;

  // Dust replays this stream from the very beginning unless a cursor is given
  // (the backend reads history from `lastEventId || "0-0"`). Every tool call
  // forces a reconnect here, so without the cursor each reconnect re-delivers
  // all prior generation_tokens — the text accumulates a second copy of the
  // whole message — and re-delivers the tool_approve_execution event, which
  // reconnects again. That is a non-terminating loop with a stuck tool.
  let lastEventId: string | null = null;

  // A window that delivered events means the agent is still working, so the
  // close is Dust's 60s cap rather than the end of the turn.
  let sawAnyEvent = false;
  let idleReconnects = 0;
  let refreshedAfterUnauthorized = false;

  reconnect: for (;;) {
    if (signal?.aborted) {
      finishAborted(stream, model, message, resolveApprovalGate);
      return;
    }

    const sseUrl = lastEventId
      ? `${baseSseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`
      : baseSseUrl;

    let res: Response;
    try {
      res = await fetch(sseUrl, {
        headers: {
          ...getAuthHeaders(),
          Accept: "text/event-stream",
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        finishAborted(stream, model, message, resolveApprovalGate);
        return;
      }
      const delayMs = streamRetryDelay(reconnectAttempt);
      debugLog("dust:stream", "SSE request threw, retrying", {
        sseUrl,
        delayMs,
        attempt: reconnectAttempt + 1,
        error: String(error),
      });
      await waitForStreamRetry(delayMs, signal);
      reconnectAttempt += 1;
      continue reconnect;
    }

    if (!res.ok) {
      debugLog("dust:stream", "SSE request failed", { status: res.status, sseUrl });
      if (res.status === 401) {
        // Dust access tokens last about 15 minutes, far less than a long turn,
        // so a 401 here usually means the token aged out mid-stream rather than
        // that the session is dead. Refresh once and resume; only give up if the
        // refresh itself fails, since declaring the session expired forces the
        // user to log in again.
        if (!refreshedAfterUnauthorized && await refreshAuth()) {
          refreshedAfterUnauthorized = true;
          debugLog("dust:stream", "Refreshed token after 401, resuming stream");
          continue reconnect;
        }
        throw new Error(SESSION_EXPIRED_MESSAGE);
      }
      if (res.status >= 500 || res.status === 429) {
        const delayMs = streamRetryDelay(reconnectAttempt);
        debugLog("dust:stream", "Transient SSE failure, retrying", {
          status: res.status,
          sseUrl,
          delayMs,
          attempt: reconnectAttempt + 1,
        });
        await waitForStreamRetry(delayMs, signal);
        reconnectAttempt += 1;
        continue reconnect;
      }
      throw new Error(`Failed to stream events: HTTP ${res.status}`);
    }
    if (!res.body) {
      debugLog("dust:stream", "SSE response had no body", { sseUrl });
      throw new Error("SSE response has no body");
    }

    reconnectAttempt = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let shouldReconnect = false;

    try {
      outer: for (;;) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json) continue;

              let parsed: unknown;
              try {
                parsed = JSON.parse(json);
              } catch {
                continue;
              }

              // Cursor lives on the envelope, alongside the event payload.
              if (isRecord(parsed) && typeof parsed.eventId === "string") {
                lastEventId = parsed.eventId;
              }
              sawAnyEvent = true;
              refreshedAfterUnauthorized = false;

              const event = unwrapEnvelope(parsed);
              const eventType = getDustEventType(event);
              if (!eventType) continue;
              debugLog("dust:stream", "Received SSE event", { eventType, event });

              // A `switch` rather than a chain of `else if`s: these branches are
              // not variations on one operation but the turn's protocol states,
              // and each ends the turn a different way (fall through, reconnect,
              // return, throw). The `default` is the point of it — before, an
              // event type we don't handle fell off the end of the chain and was
              // dropped without a trace.
              switch (eventType) {
                case "generation_tokens": {
                  const classification = isRecord(event) && typeof event.classification === "string"
                    ? event.classification
                    : "";
                  const delta = isRecord(event) && typeof event.text === "string" ? event.text : "";
                  const applyClassification = CLASSIFICATION_ACTIONS[classification];
                  if (applyClassification) {
                    applyClassification(message, delta);
                  } else {
                    // Covers a malformed frame (`classification` missing) and any
                    // new value Dust adds later. This is the single dispatch point
                    // for all agent output, so silently ignoring it would drop text
                    // from the transcript with nothing in the logs to show it.
                    debugLog("dust:stream", "Ignored generation_tokens classification", { classification });
                  }
                  break;
                }
                case "tool_params": {
                  // Client-side tool calls render as their own transcript entry
                  // (see dust-tool-render.ts), using pi's native renderers. Adding
                  // a "[Tool: x]" line here as well would duplicate that, and it
                  // would also land inside the assistant message text.
                  const action = isRecord(event) && isRecord(event.action) ? event.action : undefined;
                  const toolName = getOptionalStringField(action ?? {}, "toolName")
                    ?? getOptionalStringField(action ?? {}, "functionCallName")
                    ?? "tool";
                  debugLog("dust:stream", "Tool params received", { toolName });
                  break;
                }
                case "tool_approve_execution": {
                  const approveEvent = parseToolApproveExecutionEvent(event);
                  debugLog("dust:stream", "Handling tool approval request", approveEvent);
                  const approved = await handleToolApproveExecution(approveEvent);
                  await postValidateAction(
                    approveEvent.conversationId,
                    approveEvent.messageId,
                    approveEvent.actionId,
                    approved,
                  );
                  recordPreApproval(approveEvent.actionId, approved);
                  resolveApprovalGate();
                  shouldReconnect = true;
                  debugLog("dust:stream", "Tool approval resolved", { approved, actionId: approveEvent.actionId });
                  // Labelled, so it leaves the read loop and not just this switch.
                  break outer;
                }
                case "agent_message_success":
                  finishStopped(stream, model, message, resolveApprovalGate, "Stream completed successfully");
                  return;
                case "agent_message_gracefully_stopped":
                  // Terminal per the Dust SDK's terminalEventTypes; without this
                  // the stream never completes and the turn hangs.
                  finishStopped(stream, model, message, resolveApprovalGate, "Stream gracefully stopped");
                  return;
                case "agent_generation_cancelled":
                  // Dust says the generation was cancelled — by our own cancel
                  // request, or from the web UI or another client. Either way the
                  // turn was stopped, not completed, so it must not render as a
                  // clean finish, and the runtime has to hear about it: the local
                  // abort signal never fired on this path.
                  onCancelled();
                  finishAborted(stream, model, message, resolveApprovalGate);
                  return;
                case "agent_error":
                  debugLog("dust:stream", "Received agent error event", event);
                  // Every other terminal exit closes whatever block is open
                  // before it stops pushing to the stream (see `endBlock` on
                  // `StreamingMessage` for why); this must too, for the same
                  // reason.
                  message.endBlock();
                  throw new Error(getDustEventErrorMessage(event, "Agent error"));
                case "user_message_error":
                  debugLog("dust:stream", "Received user message error event", event);
                  message.endBlock();
                  throw new Error(getDustEventErrorMessage(event, "User message error"));
                default:
                  // Dust sends more than this handles (`agent_action_success`,
                  // `tool_notification`, `tool_error` — see docs/specs/dust-chat.md)
                  // and can add more. Ignoring them is correct; doing it silently
                  // is what left the last two gaps invisible.
                  debugLog("dust:stream", "Ignored event type", { eventType });
              }
            }
          }
        }
        if (done) break;
      }
    } catch (error) {
      // Cancelling the turn aborts the in-flight read; end as cancelled rather
      // than letting the AbortError surface as a stream failure.
      if (signal?.aborted) {
        finishAborted(stream, model, message, resolveApprovalGate);
        return;
      }
      // A read failure (network drop, decode error) can leave a block open
      // exactly like the agent_error/user_message_error throws above — same
      // reasoning, same fix.
      message.endBlock();
      throw error;
    } finally {
      reader.releaseLock();
    }

    if (shouldReconnect) continue reconnect;

    // Reaching here means the stream closed without a terminal event. Dust caps
    // each agent event stream at 60s server-side ("Do not loop forever, we will
    // timeout ... to avoid blocking the load balancer") and writes `data: done`,
    // expecting the client to resume from lastEventId. Treating that close as
    // completion truncated every turn longer than a minute mid-work, reporting
    // stopReason "stop" while the agent was still going.
    if (sawAnyEvent) {
      idleReconnects = 0;
      sawAnyEvent = false;
      debugLog("dust:stream", "Stream window closed, resuming", { lastEventId });
      continue reconnect;
    }

    // Nothing arrived in this window either; give up after a few quiet rounds so
    // a genuinely dead stream cannot spin forever.
    idleReconnects += 1;
    if (idleReconnects < MAX_IDLE_RECONNECTS) {
      debugLog("dust:stream", "Quiet stream window, retrying", { idleReconnects, lastEventId });
      await waitForStreamRetry(streamRetryDelay(idleReconnects - 1), signal);
      continue reconnect;
    }

    debugLog("dust:stream", "Stream ended without a terminal event", { idleReconnects, lastEventId });
    break reconnect;
  }

  finishStopped(stream, model, message, resolveApprovalGate, "Stream ended after reconnect loop");
}
