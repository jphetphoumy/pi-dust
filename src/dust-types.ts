import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

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
}

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
  /** Set on `image` blocks — pi's `ImageContent` carries base64 bytes here. */
  mimeType?: string;
  data?: string;
}

/** A file pi inlined into the user message that we upload to Dust instead. */
export interface PendingAttachment {
  /** Absolute local path, as written in the `<file name="...">` marker. */
  path: string;
  /** Basename sent to Dust as the file title. */
  fileName: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Content hash, used to skip re-uploading the same file in one conversation. */
  hash: string;
  /** The exact text — an inlined `<file>` block or an `@` mention — this replaces. */
  marker: string;
  /** Where `marker` sits in the message, so rewriting one never hits another. */
  start: number;
  end: number;
}

export interface ParsedUserMessage {
  text: string;
  attachments: PendingAttachment[];
}

/** A file uploaded to Dust and ready to be referenced by a content fragment. */
export interface AttachedFile {
  attachment: PendingAttachment;
  fileId: string;
  /**
   * True when the file was already uploaded and attached earlier in this
   * conversation, so it needs no new content fragment.
   */
  reused: boolean;
}

export interface DustContentFragment {
  title: string;
  fileId: string;
}

export interface FileUploadResponse {
  file: { sId: string; uploadUrl: string };
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

export interface AssistantMessageLike {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
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

export interface PiTextDeltaEvent {
  type: "text_delta";
  contentIndex: number;
  delta: string;
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

export type PiStreamEvent = PiTextDeltaEvent | PiDoneEvent | PiErrorEvent;

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
