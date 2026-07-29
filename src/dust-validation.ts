import type {
  AgentConfigurationsResponse,
  ConversationCreateResponse,
  ConversationFetchResponse,
  DeviceCodeResponse,
  DustAgent,
  JsonObject,
  McpRegisterResponse,
  McpRequestLike,
  MeResponse,
  PostMessageResponse,
  TokenResponse,
  ToolApproveExecutionEvent,
  Workspace,
} from "./dust-types.js";

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStringField(obj: JsonObject, key: string, context: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${context} is missing expected string field '${key}'`);
  }
  return value;
}

export function getOptionalStringField(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export function getNumberField(obj: JsonObject, key: string, context: string): number {
  const value = obj[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${context} is missing expected number field '${key}'`);
  }
  return value;
}

export function getFlexibleNumberField(obj: JsonObject, key: string, _context: string): number | null {
  const value = obj[key];
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function decodeJwtPayload(token: string): JsonObject | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function getExpiresInFromAccessToken(data: JsonObject): number | null {
  const accessToken = getOptionalStringField(data, "access_token");
  if (!accessToken) return null;

  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const exp = getFlexibleNumberField(payload, "exp", "access token payload");
  if (exp === null) return null;

  return Math.max(0, Math.floor(exp - Date.now() / 1000));
}

export function getRecordField(obj: JsonObject, key: string, context: string): JsonObject {
  const value = obj[key];
  if (!isRecord(value)) {
    throw new Error(`${context} is missing expected object field '${key}'`);
  }
  return value;
}

export function getArrayField(obj: JsonObject, key: string, context: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new Error(`${context} is missing expected array field '${key}'`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseJsonObject(value: unknown, context: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

export function parseWorkspace(value: unknown, index: number): Workspace {
  const workspace = parseJsonObject(value, `workspace[${index}]`);
  return {
    sId: getStringField(workspace, "sId", `workspace[${index}]`),
    name: getStringField(workspace, "name", `workspace[${index}]`),
    role: getStringField(workspace, "role", `workspace[${index}]`),
  };
}

export function parseDustAgent(value: unknown, index: number): DustAgent {
  const agent = parseJsonObject(value, `agentConfigurations[${index}]`);
  return {
    sId: getStringField(agent, "sId", `agentConfigurations[${index}]`),
    name: getStringField(agent, "name", `agentConfigurations[${index}]`),
    description: typeof agent.description === "string" ? agent.description : "",
  };
}

export function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  const data = parseJsonObject(value, "device code response");
  return {
    device_code: getStringField(data, "device_code", "device code response"),
    user_code: getStringField(data, "user_code", "device code response"),
    verification_uri: getStringField(data, "verification_uri", "device code response"),
    verification_uri_complete: getStringField(data, "verification_uri_complete", "device code response"),
    expires_in: getNumberField(data, "expires_in", "device code response"),
    interval: getNumberField(data, "interval", "device code response"),
  };
}

export function parseTokenResponse(value: unknown, context: string): TokenResponse {
  const data = parseJsonObject(value, context);
  const access_token = getStringField(data, "access_token", context);
  const refresh_token = getStringField(data, "refresh_token", context);
  const expiresIn = getFlexibleNumberField(data, "expires_in", context);
  if (expiresIn !== null) {
    return {
      access_token,
      refresh_token,
      expires_in: expiresIn,
    };
  }

  const expiresAt = getOptionalStringField(data, "expires_at");
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isNaN(expiresAtMs)) {
      const expiresInSeconds = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      return {
        access_token,
        refresh_token,
        expires_in: expiresInSeconds,
      };
    }
  }

  const jwtExpiresIn = getExpiresInFromAccessToken(data);
  if (jwtExpiresIn !== null) {
    return {
      access_token,
      refresh_token,
      expires_in: jwtExpiresIn,
    };
  }

  return {
    access_token,
    refresh_token,
    expires_in: getNumberField(data, "expires_in", context),
  };
}

export function parseMeResponse(value: unknown): MeResponse {
  const data = parseJsonObject(value, "/api/v1/me response");
  const user = getRecordField(data, "user", "/api/v1/me response");
  const workspaces = getArrayField(user, "workspaces", "/api/v1/me response").map(parseWorkspace);
  return {
    user: {
      workspaces,
      username: getStringField(user, "username", "/api/v1/me response"),
    },
  };
}

export function parseAgentConfigurationsResponse(value: unknown): AgentConfigurationsResponse {
  const data = parseJsonObject(value, "agent configurations response");
  const agentConfigurations = getArrayField(data, "agentConfigurations", "agent configurations response")
    .map(parseDustAgent);
  return { agentConfigurations };
}

export function parseMcpRegisterResponse(value: unknown): McpRegisterResponse {
  const data = parseJsonObject(value, "MCP register response");
  return {
    serverId: getStringField(data, "serverId", "MCP register response"),
    expiresAt: getStringField(data, "expiresAt", "MCP register response"),
  };
}

export function parseConversationCreateResponse(value: unknown): ConversationCreateResponse {
  const data = parseJsonObject(value, "conversation create response");
  const conversation = getRecordField(data, "conversation", "conversation create response");
  const message = getRecordField(data, "message", "conversation create response");
  return {
    conversation: {
      sId: getStringField(conversation, "sId", "conversation create response"),
      content: getArrayField(conversation, "content", "conversation create response"),
    },
    message: {
      sId: getStringField(message, "sId", "conversation create response"),
    },
  };
}

export function parseConversationFetchResponse(value: unknown): ConversationFetchResponse {
  const data = parseJsonObject(value, "conversation fetch response");
  const conversation = getRecordField(data, "conversation", "conversation fetch response");
  return {
    conversation: {
      sId: getStringField(conversation, "sId", "conversation fetch response"),
      content: getArrayField(conversation, "content", "conversation fetch response"),
    },
  };
}

export function parsePostMessageResponse(value: unknown): PostMessageResponse {
  const data = parseJsonObject(value, "post message response");
  const message = getRecordField(data, "message", "post message response");
  return {
    message: {
      sId: getStringField(message, "sId", "post message response"),
    },
  };
}

export function unwrapEnvelope(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

/**
 * Extracts the agent message an MCP request belongs to.
 *
 * Dust builds client-side request ids as
 * `mcp_req_{conversationId}_{messageId}_{uuid}_{originalRequestId}` (see
 * `makeClientSideMCPRequestIdForMessageAndConversation` in front). That is the
 * only per-request marker of which turn asked for a tool call, and telling
 * turns apart matters because cancelling is asynchronous on Dust's side: a
 * cancelled loop can still emit a tool call after the next turn has started.
 *
 * Returns null for ids that do not match, so an unknown shape falls back to the
 * coarser current-turn check rather than being trusted.
 */
export function agentMessageIdFromMcpRequestId(requestId: unknown): string | null {
  if (typeof requestId !== "string") {
    return null;
  }
  const match = /^mcp_req_([^_]+)_([^_]+)_([a-f0-9-]+)_(\d+)$/.exec(requestId);
  return match ? match[2] : null;
}

export function parseMcpRequest(value: unknown): McpRequestLike | null {
  const request = unwrapEnvelope(value);
  if (!isRecord(request) || typeof request.method !== "string") {
    return null;
  }
  return {
    id: request.id,
    method: request.method,
    params: isRecord(request.params) ? request.params : undefined,
  };
}

export function parseToolApproveExecutionEvent(value: unknown): ToolApproveExecutionEvent {
  const event = parseJsonObject(value, "tool_approve_execution event");
  const metadata = isRecord(event.metadata) ? event.metadata : undefined;
  const inputs = isRecord(event.inputs) ? event.inputs : undefined;
  return {
    type: "tool_approve_execution",
    actionId: getStringField(event, "actionId", "tool_approve_execution event"),
    conversationId: getStringField(event, "conversationId", "tool_approve_execution event"),
    messageId: getStringField(event, "messageId", "tool_approve_execution event"),
    stake: ["low", "medium", "high", "never_ask"].includes(String(event.stake ?? ""))
      ? (event.stake as ToolApproveExecutionEvent["stake"])
      : undefined,
    inputs,
    metadata: metadata
      ? {
          toolName: getOptionalStringField(metadata, "toolName"),
          agentName: getOptionalStringField(metadata, "agentName"),
          mcpServerName: getOptionalStringField(metadata, "mcpServerName"),
        }
      : undefined,
  };
}

export function getDustEventType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}

export function getDustEventErrorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const error = value.error;
  if (!isRecord(error) || typeof error.message !== "string") return fallback;
  return error.message;
}
