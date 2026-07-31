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

/** Event names and an empty-block constructor for each `BlockKind`, so the three places that branch on it (open, delta, close) share one table instead of repeating the ternary. */
const BLOCK_SHAPES = {
  text: {
    start: "text_start" as const,
    delta: "text_delta" as const,
    end: "text_end" as const,
    make: (): PiTextBlock => ({ type: "text", text: "" }),
  },
  thinking: {
    start: "thinking_start" as const,
    delta: "thinking_delta" as const,
    end: "thinking_end" as const,
    make: (): PiThinkingBlock => ({ type: "thinking", thinking: "" }),
  },
};

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
   * would look like a second turn starting over the first.
   */
  start(): void;
  /** Appends to the open block of `kind`, opening one if it is not open yet. */
  append(kind: BlockKind, delta: string): void;
  /** Ends whichever block is open, so the next token starts a fresh one. */
  closeBlock(): void;
  /** The answer only, with the reasoning left out. */
  answerText(): string;
  /** Detached copy of the blocks written so far, for a terminal message. */
  snapshot(): PiContentBlock[];
}

function createStreamingMessage(stream: PiEventStream, model: DustModel): StreamingMessage {
  const partial = makeEmptyMessage(model);
  let openKind: BlockKind | null = null;
  let openIndex = -1;
  let openBlock: PiTextBlock | PiThinkingBlock | null = null;

  // pi keeps a reference to whatever `partial` it was last handed, so every
  // event gets its own copy of the blocks; sharing them would rewrite the
  // history of the turn in place as later tokens arrive.
  const detach = (): AssistantMessageLike => ({
    ...partial,
    content: partial.content.map((block) => ({ ...block })),
  });

  // pi's agent loop tracks open blocks by `text_end`/`thinking_end`, not by
  // `done` — a block left open at `done` may render as still in progress.
  function endOpenBlock(): void {
    if (openKind === null || !openBlock) return;
    const shape = BLOCK_SHAPES[openKind];
    const content = openKind === "text" ? (openBlock as PiTextBlock).text : (openBlock as PiThinkingBlock).thinking;
    stream.push({ type: shape.end, contentIndex: openIndex, content, partial: detach() });
    openKind = null;
    openIndex = -1;
    openBlock = null;
  }

  return {
    start() {
      stream.push({ type: "start", partial: detach() });
    },
    append(kind, delta) {
      // An empty batch (e.g. `text: ""`, or a non-string field) must not open
      // a block or push a delta — Dust does send these, and an empty block
      // would render as a stray, content-less bubble in the transcript.
      if (!delta) return;
      if (openKind !== kind) {
        endOpenBlock();
        const shape = BLOCK_SHAPES[kind];
        const block = shape.make();
        partial.content.push(block);
        openKind = kind;
        openIndex = partial.content.length - 1;
        openBlock = block;
        stream.push({ type: shape.start, contentIndex: openIndex, partial: detach() });
      }
      // `openBlock` was just pushed (or already matched `kind`), so it is
      // always the block this delta belongs to — holding the reference here
      // avoids re-discriminating `partial.content[openIndex]` by `.type`.
      if (openBlock!.type === "text") {
        openBlock!.text += delta;
      } else {
        openBlock!.thinking += delta;
      }
      const shape = BLOCK_SHAPES[kind];
      stream.push({ type: shape.delta, contentIndex: openIndex, delta, partial: detach() });
    },
    closeBlock() {
      endOpenBlock();
    },
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
  message.closeBlock();
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = message.snapshot();
  finalMessage.stopReason = "aborted";
  finalMessage.errorMessage = CANCELLED_MESSAGE;
  stream.push({ type: "error", reason: "aborted", error: finalMessage });
  stream.end();
  debugLog("dust:stream", "Stream aborted by user", { answerText: message.answerText() });
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

              if (eventType === "generation_tokens") {
                // Dust classifies each token batch: `tokens` is the answer,
                // `chain_of_thought` the reasoning behind it, and the two
                // delimiters are the markup Dust wraps the trace in — those
                // carry no content of their own, they just end the current
                // block so the next batch starts a new one.
                const classification = isRecord(event) ? event.classification : undefined;
                const delta = isRecord(event) && typeof event.text === "string" ? event.text : "";
                if (classification === "tokens") {
                  message.append("text", delta);
                  // Only true when a delta was actually pushed — `append` silently
                  // drops an empty batch, and a log line claiming forwarding that
                  // didn't happen sends anyone debugging a missing token the wrong way.
                  if (delta) debugLog("dust:stream", "Forwarded text delta", { delta });
                } else if (classification === "chain_of_thought") {
                  message.append("thinking", delta);
                  if (delta) debugLog("dust:stream", "Forwarded thinking delta", { delta });
                } else if (classification === "opening_delimiter" || classification === "closing_delimiter") {
                  message.closeBlock();
                } else {
                  // Covers a malformed frame (`classification` missing) and any new
                  // value Dust adds later. This is the single dispatch point for all
                  // agent output, so silently ignoring it would drop text from the
                  // transcript with nothing in the logs to show it happened.
                  debugLog("dust:stream", "Ignored generation_tokens classification", { classification });
                }
              } else if (eventType === "tool_params") {
                // Client-side tool calls render as their own transcript entry
                // (see dust-tool-render.ts), using pi's native renderers. Adding
                // a "[Tool: x]" line here as well would duplicate that, and it
                // would also land inside the assistant message text.
                const action = isRecord(event) && isRecord(event.action) ? event.action : undefined;
                const toolName = getOptionalStringField(action ?? {}, "toolName")
                  ?? getOptionalStringField(action ?? {}, "functionCallName")
                  ?? "tool";
                debugLog("dust:stream", "Tool params received", { toolName });
              } else if (eventType === "tool_approve_execution") {
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
                break outer;
              } else if (eventType === "agent_message_success") {
                resolveApprovalGate();
                message.closeBlock();
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = message.snapshot();
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                debugLog("dust:stream", "Stream completed successfully", { answerText: message.answerText() });
                return;
              } else if (eventType === "agent_message_gracefully_stopped") {
                // Terminal per the Dust SDK's terminalEventTypes; without this
                // the stream never completes and the turn hangs.
                resolveApprovalGate();
                message.closeBlock();
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = message.snapshot();
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                debugLog("dust:stream", "Stream gracefully stopped", { answerText: message.answerText() });
                return;
              } else if (eventType === "agent_generation_cancelled") {
                // Dust says the generation was cancelled — by our own cancel
                // request, or from the web UI or another client. Either way the
                // turn was stopped, not completed, so it must not render as a
                // clean finish, and the runtime has to hear about it: the local
                // abort signal never fired on this path.
                onCancelled();
                finishAborted(stream, model, message, resolveApprovalGate);
                return;
              } else if (eventType === "agent_error") {
                debugLog("dust:stream", "Received agent error event", event);
                throw new Error(getDustEventErrorMessage(event, "Agent error"));
              } else if (eventType === "user_message_error") {
                debugLog("dust:stream", "Received user message error event", event);
                throw new Error(getDustEventErrorMessage(event, "User message error"));
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

  resolveApprovalGate();
  message.closeBlock();
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = message.snapshot();
  finalMessage.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end();
  debugLog("dust:stream", "Stream ended after reconnect loop", { answerText: message.answerText() });
}
