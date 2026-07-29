import { CANCELLED_MESSAGE, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type {
  AssistantMessageLike,
  DustModel,
  PiEventStream,
  PiStreamEvent,
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
  fullText: string,
  resolveApprovalGate: () => void,
): void {
  resolveApprovalGate();
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
  finalMessage.stopReason = "aborted";
  finalMessage.errorMessage = CANCELLED_MESSAGE;
  stream.push({ type: "error", reason: "aborted", error: finalMessage });
  stream.end();
  debugLog("dust:stream", "Stream aborted by user", { fullText });
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
  let fullText = "";
  const partial = makeEmptyMessage(model);
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
      finishAborted(stream, model, fullText, resolveApprovalGate);
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
        finishAborted(stream, model, fullText, resolveApprovalGate);
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
                if (isRecord(event) && event.classification === "tokens") {
                  const delta = typeof event.text === "string" ? event.text : "";
                  fullText += delta;
                  if (partial.content.length === 0) {
                    partial.content.push({ type: "text", text: fullText });
                  } else {
                    partial.content[0].text = fullText;
                  }
                  stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
                  debugLog("dust:stream", "Forwarded text delta", { delta });
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
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                debugLog("dust:stream", "Stream completed successfully", { fullText });
                return;
              } else if (eventType === "agent_message_gracefully_stopped") {
                // Terminal per the Dust SDK's terminalEventTypes; without this
                // the stream never completes and the turn hangs.
                resolveApprovalGate();
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                debugLog("dust:stream", "Stream gracefully stopped", { fullText });
                return;
              } else if (eventType === "agent_generation_cancelled") {
                // Dust says the generation was cancelled — by our own cancel
                // request, or from the web UI or another client. Either way the
                // turn was stopped, not completed, so it must not render as a
                // clean finish, and the runtime has to hear about it: the local
                // abort signal never fired on this path.
                onCancelled();
                finishAborted(stream, model, fullText, resolveApprovalGate);
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
        finishAborted(stream, model, fullText, resolveApprovalGate);
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
  const finalMessage = makeEmptyMessage(model);
  finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
  finalMessage.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end();
  debugLog("dust:stream", "Stream ended after reconnect loop", { fullText });
}
