import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessageEvent as PiAiAssistantMessageEvent,
  OAuthCredentials,
  TextContent as PiAiTextContent,
  ThinkingContent as PiAiThinkingContent,
} from "@earendil-works/pi-ai";

export type Workspace = { sId: string; name: string; role: string };
export type DustAgent = { sId: string; name: string; description: string };

export type JsonObject = Record<string, unknown>;
export type McpToolArgs = Record<string, unknown>;
export type WorkspaceSelector = (title: string, options: string[], opts: object) => Promise<string | undefined>;

export interface DustCredentials extends OAuthCredentials {
  type?: "oauth";
  workspaceId?: string;
  workspaces?: Workspace[];
  agents?: DustAgent[];
  region?: string;
  username?: string;
  conversations?: Record<string, string>;
}

export interface SessionManagerLike {
  getSessionFile?: () => string | undefined;
  getEntries?: () => unknown[];
  /** Transcript header. `parentSession` is set on forked and branched sessions. */
  getHeader?: () => { parentSession?: string } | null;
}

/** Why pi started a session. Mirrors pi's `SessionStartEvent["reason"]`. */
export type DustSessionReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * pi 0.65 removed the post-transition `session_switch` / `session_fork` events;
 * `session_start` now carries the reason and the file we came from instead.
 */
export interface DustSessionStartEvent {
  reason?: DustSessionReason;
  previousSessionFile?: string;
}

export interface UiLike {
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string, level: string) => void;
  select?: WorkspaceSelector;
  /**
   * Writes an extension's entry in pi's footer. Keyed so several extensions can
   * share the row; passing `undefined` removes ours.
   */
  setStatus?: (key: string, text: string | undefined) => void;
}

/** How a `/loop` iteration's payload is re-sent: a fixed cadence, or back-to-back once the agent settles. */
export type DustLoopMode = "interval" | "selfPaced";

/**
 * In-memory state for an active `/loop`. Session-scoped: never persisted, and
 * always cleared on session switch/shutdown (see `DustSessionRuntime.clearLoopState`).
 */
export interface DustLoopState {
  mode: DustLoopMode;
  /**
   * Text re-sent via `pi.sendUserMessage` each iteration. Always sent as a
   * plain prompt — pi's `sendUserMessage` never dispatches pi slash commands,
   * even when this starts with `/` (see dust-loop.ts's `startLoop`).
   */
  payload: string;
  /** Null for self-paced loops, which have no fixed cadence. */
  intervalMs: number | null;
  iterations: number;
  /** Total ticks skipped over the loop's lifetime, because the agent was still busy. */
  skipped: number;
  /** Whether the *most recent* tick was skipped — drives the footer's "waiting" flag, unlike the lifetime `skipped` counter. */
  waitingOnBusyAgent: boolean;
  /**
   * Self-paced only: true right after this loop sends its own payload, until
   * the matching `agent_settled` is consumed. Lets `handleAgentSettled` in
   * dust-loop.ts tell "the turn we just started" apart from an unrelated
   * turn the user ran while the loop was idle between iterations — settle
   * events are ignored unless this is true, so a stray user turn never
   * burns one of the loop's iterations.
   */
  expectingSettle: boolean;
  /** Self-paced loops auto-stop after this many iterations; interval loops run unbounded. */
  maxIterations: number | null;
  startedAt: number;
}

/** Parsed `/loop` invocation, before it is turned into a `DustLoopState` or an early return. */
export type LoopRequest =
  | { kind: "status" }
  | { kind: "stop" }
  | {
      kind: "start";
      mode: DustLoopMode;
      payload: string;
      intervalMs: number | null;
      /** True when the requested interval was below the floor and got clamped up. */
      clamped: boolean;
    }
  | { kind: "error"; message: string };

/**
 * pi 0.81 removed `ModelRegistry.authStorage`. What remains that we care about
 * is `getProviderAuth`, which resolves a provider's current API key and, for
 * OAuth providers, drives pi's refresh-and-persist path.
 */
export interface ModelRegistryLike {
  getProviderAuth?: (providerId: string) => Promise<{
    auth?: { apiKey?: string; headers?: Record<string, string> };
    source?: string;
  }>;
}

export interface PiRuntimeContext {
  modelRegistry?: ModelRegistryLike;
  sessionManager?: SessionManagerLike;
  ui?: UiLike;
  /** Whether the agent is idle (not streaming). Always present on pi's real ExtensionContext. */
  isIdle?: () => boolean;
}

export type ExtensionAPIWithEvents = ExtensionAPI & {
  on: (event: string, handler: (event: unknown, ctx: PiRuntimeContext) => unknown) => void;
};

export interface DustModel {
  id?: string;
  sId?: string;
  name?: string;
  provider?: string;
  api?: string;
}

export interface MessageContentBlock {
  type?: string;
  text?: string;
}

export interface ChatMessageLike {
  role?: string;
  content?: string | MessageContentBlock[];
}

export interface StreamContextLike {
  systemPrompt?: string;
  messages?: ChatMessageLike[];
}

export interface StreamOptionsLike {
  signal?: AbortSignal;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface MeResponse {
  user: {
    workspaces: Workspace[];
    username: string;
  };
}

export interface AgentConfigurationsResponse {
  agentConfigurations: DustAgent[];
}

export interface ConversationCreateResponse {
  conversation: {
    sId: string;
    content: unknown[];
  };
  message: {
    sId: string;
  };
}

/**
 * What a reattach check needs: enough to prove the conversation is still there
 * and to name it in the UI. Deliberately does not require `content`, so the
 * check survives a conversation whose messages are paginated away.
 */
export interface ConversationSummaryResponse {
  conversation: {
    sId: string;
    title?: string;
  };
}

export interface ConversationFetchResponse {
  conversation: {
    sId: string;
    content: unknown[];
  };
}

export interface PostMessageResponse {
  message: {
    sId: string;
  };
  /** Agent messages created by the same POST, when returned by the API. */
  agentMessages?: unknown[];
}

export interface McpRegisterResponse {
  serverId: string;
  expiresAt: string;
}

export interface ToolApproveExecutionEvent {
  type: "tool_approve_execution";
  actionId: string;
  conversationId: string;
  messageId: string;
  stake?: "low" | "medium" | "high" | "never_ask";
  inputs?: Record<string, unknown>;
  metadata?: {
    toolName?: string;
    agentName?: string;
    mcpServerName?: string;
  };
}

export interface McpRequestLike {
  id?: unknown;
  method: string;
  params?: JsonObject;
}

/** pi's `TextContent`: the answer the user reads. */
export interface PiTextBlock {
  type: "text";
  text: string;
  /**
   * pi's `TextContent` carries this for providers that sign their output;
   * Dust gives us no signature, so it is always absent here. Optional for
   * the same reason as `PiThinkingBlock.thinkingSignature`.
   */
  textSignature?: string;
}

/**
 * pi's `ThinkingContent`: the agent's reasoning trace. pi renders these blocks
 * dimmed and italic (or collapsed behind a label, per the user's setting), and
 * keeps them out of the answer — which is why the Dust `chain_of_thought`
 * stream lands here rather than being concatenated into a text block.
 */
export interface PiThinkingBlock {
  type: "thinking";
  thinking: string;
  /**
   * pi's `ThinkingContent` carries this for providers that return signed
   * reasoning; Dust gives us no signature, so it is always absent here.
   * Declared optional rather than omitted so a block pi persists and later
   * replays into a signature-checking provider isn't rejected for a field
   * that was simply never populated.
   */
  thinkingSignature?: string;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock;

export interface AssistantMessageLike {
  role: "assistant";
  /**
   * Thinking blocks are never part of the answer — consumers must filter on
   * `type === "text"` (see `extractMessageText` in dust-stream-provider.ts).
   * Reading `content` itself as the answer pulls the reasoning trace in.
   */
  content: PiContentBlock[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

/**
 * Opens the streaming message. pi's agent loop drops every partial update until
 * it has seen this event (it has no message to apply them to), so a stream that
 * never emits it only renders once, at `done`.
 */
export interface PiStartEvent {
  type: "start";
  partial: AssistantMessageLike;
}

export interface PiTextStartEvent {
  type: "text_start";
  contentIndex: number;
  partial: AssistantMessageLike;
}

export interface PiTextDeltaEvent {
  type: "text_delta";
  contentIndex: number;
  delta: string;
  partial: AssistantMessageLike;
}

/**
 * Closes a `text` block. Emitting a matching end event for every opened
 * block is what pi-ai's own `AssistantMessageEvent` streams (`start`, then
 * partial updates) all do — see the `_PiStreamEventShapeChecks` block below,
 * which checks this and every other event here against pi-ai's real types
 * at compile time rather than by hand.
 */
export interface PiTextEndEvent {
  type: "text_end";
  contentIndex: number;
  content: string;
  partial: AssistantMessageLike;
}

export interface PiThinkingStartEvent {
  type: "thinking_start";
  contentIndex: number;
  partial: AssistantMessageLike;
}

export interface PiThinkingDeltaEvent {
  type: "thinking_delta";
  contentIndex: number;
  delta: string;
  partial: AssistantMessageLike;
}

/** Closes a `thinking` block — the `thinking_end` counterpart of `PiTextEndEvent`; see its doc comment for how the shape was verified. */
export interface PiThinkingEndEvent {
  type: "thinking_end";
  contentIndex: number;
  content: string;
  partial: AssistantMessageLike;
}

export interface PiDoneEvent {
  type: "done";
  reason: "stop";
  message: AssistantMessageLike;
}

export interface PiErrorEvent {
  type: "error";
  /** pi renders "aborted" as a cancelled turn rather than a failure. */
  reason: "error" | "aborted";
  error: AssistantMessageLike;
}

export type PiStreamEvent =
  | PiStartEvent
  | PiTextStartEvent
  | PiTextDeltaEvent
  | PiTextEndEvent
  | PiThinkingStartEvent
  | PiThinkingDeltaEvent
  | PiThinkingEndEvent
  | PiDoneEvent
  | PiErrorEvent;

/**
 * Compile-time check, not hand-verification: `@earendil-works/pi-ai` is a
 * direct dependency (package.json) whose `dist/index.d.ts` re-exports
 * `types.ts`, so its real `AssistantMessageEvent`/`TextContent`/
 * `ThinkingContent` types are importable and checkable here, not just
 * readable. A pi-ai upgrade that renames a field or drops a variant these
 * types rely on fails `make typecheck` at the assignment below instead of
 * drifting unnoticed.
 *
 * `AssistantMessageLike` is intentionally looser than pi-ai's real
 * `AssistantMessage` (`stopReason` etc. are plain `string`, not pi's
 * `StopReason` union — this file predates depending on pi-ai's message
 * shape directly), so checking whole `PiStreamEvent` members against whole
 * `AssistantMessageEvent` members fails on that unrelated looseness. Each
 * event is checked instead with its message-carrying field (`partial` /
 * `message` / `error`) omitted, which is the part this file actually
 * hand-models.
 */
type OmitMessageField<T> = Omit<T, "partial" | "message" | "error">;
type PiAiEventVariant<Type extends PiAiAssistantMessageEvent["type"]> = Extract<PiAiAssistantMessageEvent, { type: Type }>;
type AssertAssignable<T extends U, U> = T;
type _PiStreamEventShapeChecks = [
  AssertAssignable<PiContentBlock, PiAiTextContent | PiAiThinkingContent>,
  AssertAssignable<OmitMessageField<PiStartEvent>, OmitMessageField<PiAiEventVariant<"start">>>,
  AssertAssignable<OmitMessageField<PiTextStartEvent>, OmitMessageField<PiAiEventVariant<"text_start">>>,
  AssertAssignable<OmitMessageField<PiTextDeltaEvent>, OmitMessageField<PiAiEventVariant<"text_delta">>>,
  AssertAssignable<OmitMessageField<PiTextEndEvent>, OmitMessageField<PiAiEventVariant<"text_end">>>,
  AssertAssignable<OmitMessageField<PiThinkingStartEvent>, OmitMessageField<PiAiEventVariant<"thinking_start">>>,
  AssertAssignable<OmitMessageField<PiThinkingDeltaEvent>, OmitMessageField<PiAiEventVariant<"thinking_delta">>>,
  AssertAssignable<OmitMessageField<PiThinkingEndEvent>, OmitMessageField<PiAiEventVariant<"thinking_end">>>,
  AssertAssignable<OmitMessageField<PiDoneEvent>, OmitMessageField<PiAiEventVariant<"done">>>,
  AssertAssignable<OmitMessageField<PiErrorEvent>, OmitMessageField<PiAiEventVariant<"error">>>,
];

export interface PiEventStream {
  push(event: PiStreamEvent): void;
  end(): void;
  result(): Promise<AssistantMessageLike>;
  [Symbol.asyncIterator](): AsyncIterator<PiStreamEvent>;
}

/**
 * Per-member credit usage, from `GET /api/w/:wId/credits/my-usage`.
 *
 * This is a private (session-authenticated) Dust endpoint, so every field is
 * optional at runtime: a shape change upstream must blank a row of the panel,
 * not throw.
 */
export interface MemberUsage {
  consumedAwuCredits: number | null;
  consumedFromAllowanceAwuCredits: number | null;
  consumedFromPoolAwuCredits: number | null;
  memberUsageLimit: number | null;
  seatBalanceAwu: number | null;
  spendLimitAwuCredits: number | null;
  spendLimitSource: string | null;
  nextCreditResetAt: string | null;
  billingFrequency: string | null;
  seatType: string | null;
  creditState: string | null;
  nearLimit: boolean | null;
}

/** Fair-use allowance for free plans, where `my-usage` reports no seat allocation. */
export interface FairUseCredits {
  /** -1 means unlimited. */
  limit: number | null;
  timeframe: string | null;
  count: number | null;
}

export interface CreditBreakdownEntry {
  label: string;
  credits: number;
}

/** Analytics dimensions Dust can group credit usage by. */
export type CreditGroupBy = "usage_type" | "agent" | "origin" | "api_key";

export interface UsageAnalytics {
  granularity: string | null;
  groups: CreditBreakdownEntry[];
}

/** One calendar-aligned (UTC) bucket of the credit time series. */
export interface CreditBucket {
  startMs: number;
  credits: number;
}

export interface CreditSeries {
  granularity: string | null;
  buckets: CreditBucket[];
}

/**
 * The three period totals `/status` leads with. Each is the last bucket of its
 * own series, so it is the current, in-progress calendar period.
 */
export interface CreditTotals {
  month: CreditSeries | null;
  week: CreditSeries | null;
  day: CreditSeries | null;
}

export interface TopConversations {
  conversations: CreditBreakdownEntry[];
}

/** Everything `/status` renders, assembled from up to four endpoints. */
export interface DustStatusData {
  workspaceName: string;
  region: string;
  agentName: string | null;
  durationMs: number;
  messagesSent: number;
  sessionCredits: number | null;
  sessionBaselineAt: number | null;
  usage: MemberUsage | null;
  fairUse: FairUseCredits | null;
  totals: CreditTotals;
  /** Monthly credit ceiling the gauges are drawn against. */
  monthlyCeiling: number;
  /** True when the ceiling is the configured fallback, not one Dust reported. */
  ceilingIsFallback: boolean;
  analytics: UsageAnalytics | null;
  topConversations: TopConversations | null;
}

export interface LoginCallbacks {
  onAuth: (params: { url: string; instructions: string }) => void;
  onProgress?: (message: string) => void;
  onPrompt: (params: { message: string; placeholder?: string }) => Promise<string>;
  signal?: AbortSignal;
}
