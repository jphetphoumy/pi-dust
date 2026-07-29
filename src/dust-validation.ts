import type {
  AgentConfigurationsResponse,
  ConversationCreateResponse,
  ConversationFetchResponse,
  ConversationSummaryResponse,
  CreditBreakdownEntry,
  CreditBucket,
  CreditSeries,
  DeviceCodeResponse,
  DustAgent,
  FairUseCredits,
  FileUploadResponse,
  JsonObject,
  McpRegisterResponse,
  McpRequestLike,
  MemberUsage,
  MeResponse,
  PostMessageResponse,
  TokenResponse,
  ToolApproveExecutionEvent,
  TopConversations,
  UsageAnalytics,
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

export function parseConversationSummaryResponse(value: unknown): ConversationSummaryResponse {
  const data = parseJsonObject(value, "conversation summary response");
  const conversation = getRecordField(data, "conversation", "conversation summary response");
  return {
    conversation: {
      sId: getStringField(conversation, "sId", "conversation summary response"),
      title: getOptionalStringField(conversation, "title"),
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

export function parseFileUploadResponse(value: unknown): FileUploadResponse {
  const data = parseJsonObject(value, "file upload response");
  const file = getRecordField(data, "file", "file upload response");
  return {
    file: {
      sId: getStringField(file, "sId", "file upload response"),
      uploadUrl: getStringField(file, "uploadUrl", "file upload response"),
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

/**
 * Credit endpoints below are Dust's *private* API — the same routes the web app
 * calls, not the versioned `/api/v1` surface. They can change shape without a
 * deprecation, so nothing here throws: a missing or wrongly-typed field becomes
 * `null` and the corresponding row of `/status` is skipped.
 */
function optionalNumber(obj: JsonObject, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function optionalBoolean(obj: JsonObject, key: string): boolean | null {
  const value = obj[key];
  return typeof value === "boolean" ? value : null;
}

/** First key that carries a finite number, or null. Shields against renames. */
function firstNumber(obj: JsonObject, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = optionalNumber(obj, key);
    if (value !== null) return value;
  }
  return null;
}

/**
 * First key that carries a non-empty string, or null.
 *
 * Labels are user content — a conversation title is the first line(s) of a
 * prompt — so newlines and runs of whitespace are collapsed. Left alone, a
 * multi-line title would break a table row across several lines.
 */
function firstString(obj: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = optionalString(obj, key);
    if (value === null) continue;
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (collapsed !== "") return collapsed;
  }
  return null;
}

// `conversationId` is last so an untitled conversation still gets a row rather
// than being dropped: `my-top-conversations` returns `title: string | null`.
const LABEL_KEYS = ["name", "label", "title", "agentName", "groupKey", "key", "sId", "id", "conversationId"] as const;
// `totalCredits` is what `my-top-conversations` calls its amount; the grouped
// breakdowns carry no amount at all and are summed from the time series.
const CREDIT_KEYS = [
  "credits",
  "totalCredits",
  "awuCredits",
  "consumedAwuCredits",
  "creditsConsumed",
  "value",
  "total",
] as const;
/**
 * Dust returns `{ groupKey, name }` per group and keeps the numbers in the
 * time series, so `groupKey` is the join key that matters — a group row itself
 * carries no credits at all.
 */
const GROUP_KEY_KEYS = ["groupKey", "key", "id", "sId"] as const;

export function parseMyUsageResponse(value: unknown): MemberUsage | null {
  if (!isRecord(value)) return null;
  const member = value.member;
  if (!isRecord(member)) return null;

  return {
    consumedAwuCredits: optionalNumber(member, "consumedAwuCredits"),
    consumedFromAllowanceAwuCredits: optionalNumber(member, "consumedFromAllowanceAwuCredits"),
    consumedFromPoolAwuCredits: optionalNumber(member, "consumedFromPoolAwuCredits"),
    memberUsageLimit: optionalNumber(member, "memberUsageLimit"),
    seatBalanceAwu: optionalNumber(member, "seatBalanceAwu"),
    spendLimitAwuCredits: optionalNumber(member, "spendLimitAwuCredits"),
    spendLimitSource: optionalString(member, "spendLimitSource"),
    nextCreditResetAt: optionalString(member, "nextCreditResetAt"),
    billingFrequency: optionalString(member, "billingFrequency"),
    seatType: optionalString(member, "seatType"),
    creditState: optionalString(member, "creditState"),
    nearLimit: optionalBoolean(member, "nearLimit"),
  };
}

export function parseFairUseCreditsResponse(value: unknown): FairUseCredits | null {
  if (!isRecord(value)) return null;
  const state = value.fairUseAwuCreditsState;
  if (!isRecord(state)) return null;

  return {
    limit: optionalNumber(state, "limit"),
    timeframe: optionalString(state, "timeframe"),
    count: optionalNumber(state, "count"),
  };
}

/**
 * Sums a group's credits out of the time series when the group row itself
 * carries no total. Points are `{ …, values: { <groupKey>: n } }` or flat
 * `{ <groupKey>: n }`; anything else contributes nothing.
 */
function sumPointsForGroup(points: unknown[], groupKey: string | null): number | null {
  if (!groupKey) return null;
  let total = 0;
  let matched = false;

  for (const point of points) {
    if (!isRecord(point)) continue;
    const bucket = isRecord(point.values) ? point.values : point;
    const value = optionalNumber(bucket, groupKey);
    if (value !== null) {
      total += value;
      matched = true;
    }
  }

  return matched ? total : null;
}

function parseBreakdownEntry(value: unknown, points: unknown[]): CreditBreakdownEntry | null {
  if (!isRecord(value)) return null;
  const label = firstString(value, LABEL_KEYS);
  if (!label) return null;

  const credits = firstNumber(value, CREDIT_KEYS) ?? sumPointsForGroup(points, firstString(value, GROUP_KEY_KEYS));
  if (credits === null) return null;

  return { label, credits };
}

export function parseMyUsageAnalyticsResponse(value: unknown): UsageAnalytics | null {
  if (!isRecord(value)) return null;
  const rawGroups = Array.isArray(value.groups) ? value.groups : null;
  if (!rawGroups) return null;
  const points = Array.isArray(value.points) ? value.points : [];

  return {
    granularity: optionalString(value, "granularity"),
    groups: rawGroups
      .map((group) => parseBreakdownEntry(group, points))
      .filter((group): group is CreditBreakdownEntry => group !== null),
  };
}

/**
 * Reduces a total-series analytics response to one point per bucket.
 *
 * Requested without `groupBy`, Dust answers with a single `total` series and
 * `fillWindow: true`, so buckets are calendar-aligned (UTC) and empty ones are
 * still emitted. That makes the *last* point the current, in-progress period —
 * the number `/status` leads with.
 */
export function parseCreditSeriesResponse(value: unknown): CreditSeries | null {
  if (!isRecord(value)) return null;
  const rawPoints = Array.isArray(value.points) ? value.points : null;
  if (!rawPoints) return null;

  const granularity = optionalString(value, "granularity");
  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  // Without groupBy the series is keyed "total", but read the key back off the
  // response rather than assuming it.
  const seriesKey = rawGroups.length === 1 && isRecord(rawGroups[0])
    ? firstString(rawGroups[0], GROUP_KEY_KEYS) ?? "total"
    : "total";

  const buckets: CreditBucket[] = [];
  for (const point of rawPoints) {
    if (!isRecord(point)) continue;
    const startMs = optionalNumber(point, "timestamp");
    if (startMs === null) continue;

    const values = isRecord(point.values) ? point.values : point;
    // A grouped response reaching here would carry several series; summing
    // keeps the bucket total right either way.
    const credits = optionalNumber(values, seriesKey)
      ?? Object.values(values).reduce<number>(
        (sum, entry) => sum + (typeof entry === "number" && Number.isFinite(entry) ? entry : 0),
        0,
      );

    buckets.push({ startMs, credits });
  }

  if (buckets.length === 0) return null;
  buckets.sort((a, b) => a.startMs - b.startMs);
  return { granularity, buckets };
}

export function parseMyTopConversationsResponse(value: unknown): TopConversations | null {
  if (!isRecord(value)) return null;
  const rawConversations = Array.isArray(value.conversations) ? value.conversations : null;
  if (!rawConversations) return null;

  return {
    conversations: rawConversations
      .map((conversation) => parseBreakdownEntry(conversation, []))
      .filter((conversation): conversation is CreditBreakdownEntry => conversation !== null),
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
