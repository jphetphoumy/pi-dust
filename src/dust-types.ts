import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

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

export interface AuthStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface SessionManagerLike {
  getSessionFile?: () => string | undefined;
  getEntries?: () => unknown[];
}

export interface UiLike {
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string, level: string) => void;
  select?: WorkspaceSelector;
}

export interface PiRuntimeContext {
  modelRegistry: {
    authStorage: AuthStorage;
  };
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
}

export interface ChatMessageLike {
  role?: string;
  content?: string | MessageContentBlock[];
}

export interface StreamContextLike {
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
  reason: "error";
  error: AssistantMessageLike;
}

export type PiStreamEvent = PiTextDeltaEvent | PiDoneEvent | PiErrorEvent;

export interface PiEventStream {
  push(event: PiStreamEvent): void;
  end(): void;
  result(): Promise<AssistantMessageLike>;
  [Symbol.asyncIterator](): AsyncIterator<PiStreamEvent>;
}

export interface LoginCallbacks {
  onAuth: (params: { url: string; instructions: string }) => void;
  onProgress?: (message: string) => void;
  onPrompt: (params: { message: string; placeholder?: string }) => Promise<string>;
  signal?: AbortSignal;
}
