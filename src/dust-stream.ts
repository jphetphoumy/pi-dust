import { SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
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
  throw new Error("No agent message found in conversation content");
}

interface StreamEventsOptions {
  baseUrl: string;
  conversationSId: string;
  agentMsgSId: string;
  authHeaders: Record<string, string>;
  signal: AbortSignal | undefined;
  stream: PiEventStream;
  model: DustModel;
  handleToolApproveExecution: (event: ToolApproveExecutionEvent) => Promise<boolean>;
  postValidateAction: (conversationId: string, messageId: string, actionId: string, approved: boolean) => Promise<void>;
  recordPreApproval: (actionId: string, approved: boolean) => void;
  resolveApprovalGate: () => void;
}

export async function streamEvents({
  baseUrl,
  conversationSId,
  agentMsgSId,
  authHeaders,
  signal,
  stream,
  model,
  handleToolApproveExecution,
  postValidateAction,
  recordPreApproval,
  resolveApprovalGate,
}: StreamEventsOptions): Promise<void> {
  const sseUrl = `${baseUrl}/assistant/conversations/${conversationSId}/messages/${agentMsgSId}/events`;
  let fullText = "";
  const partial = makeEmptyMessage(model);
  debugLog("dust:stream", "Opening SSE stream", { conversationSId, agentMsgSId, sseUrl });
  let reconnectAttempt = 0;

  reconnect: for (;;) {
    let res: Response;
    try {
      res = await fetch(sseUrl, {
        headers: {
          ...authHeaders,
          Accept: "text/event-stream",
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
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
                const action = isRecord(event) && isRecord(event.action) ? event.action : undefined;
                const toolName = getOptionalStringField(action ?? {}, "toolName")
                  ?? getOptionalStringField(action ?? {}, "functionCallName")
                  ?? "tool";
                const indicator = `\n[Tool: ${toolName}]\n`;
                fullText += indicator;
                if (partial.content.length === 0) {
                  partial.content.push({ type: "text", text: fullText });
                } else {
                  partial.content[0].text = fullText;
                }
                stream.push({ type: "text_delta", contentIndex: 0, delta: indicator, partial: { ...partial } });
                debugLog("dust:stream", "Forwarded tool indicator", { toolName });
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
              } else if (eventType === "agent_generation_cancelled") {
                resolveApprovalGate();
                const finalMessage = makeEmptyMessage(model);
                finalMessage.content = fullText ? [{ type: "text", text: fullText }] : [];
                finalMessage.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: finalMessage });
                stream.end();
                debugLog("dust:stream", "Stream cancelled", { fullText });
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
    } finally {
      reader.releaseLock();
    }

    if (shouldReconnect) continue reconnect;
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
