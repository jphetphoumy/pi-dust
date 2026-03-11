# Spec: Dust Agent Chat via Pi

## Status: Planning

## Goal

Allow users to select a Dust agent as a model in pi via `/model` and chat with it
interactively. Usage must be classified as `origin: "cli"` (user usage, not programmatic).

---

## What Is Already Done

| Feature | Status |
|---|---|
| OAuth login (WorkOS device flow) | ✅ |
| Workspace selection at login | ✅ |
| Workspace switching (`/workspace`) | ✅ |
| Agents fetched at login, stored in credentials | ✅ |
| `modifyModels` — agents appear in `/model` | ✅ |
| `User-Agent: "Dust CLI"` + `X-Dust-CLI-Version` on all Dust API calls | ✅ |

---

## Milestone 1 — Mock Provider (Current)

Register `streamSimple` on the `dust` provider so selecting a Dust agent
in `/model` does not crash pi. The mock returns a single assistant message
explaining the feature is not yet implemented.

**Scope:**
- Add `api: "dust"` and `streamSimple` to `pi.registerProvider("dust", ...)`
- `streamSimple` yields one text delta: `"Dust agent chat is not yet implemented."`
- No network calls

**Tests:**
- `streamSimple` is registered on the provider
- Returns an async stream that yields at least one text event

---

## Milestone 2 — Real Provider

### Overview

`streamSimple` calls the Dust conversation API, maps SSE events to pi's
stream format, and correctly identifies the request as interactive CLI usage.

### Conversation Lifecycle

- **One conversation per pi session.** Created on the first message, reused for
  subsequent turns (add messages to the existing conversation).
- Conversation ID is stored in module-level state (not in credentials — it is
  session-ephemeral).
- On `/logout` or session end the stored conversation ID is discarded.

### HTTP Calls (all include `User-Agent: "Dust CLI"` + `X-Dust-CLI-Version`)

#### First message — create conversation
```
POST {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.1.0
Content-Type: application/json

{
  "message": {
    "content": "<user message>",
    "mentions": [{ "configurationId": "<agentSId>" }],
    "context": {
      "username":  "<from credentials or os username>",
      "timezone":  "<Intl.DateTimeFormat().resolvedOptions().timeZone>",
      "origin":    "cli"
    }
  },
  "visibility": "unlisted"
}
```

Response: `{ conversation, message }` — save `conversation.sId` for subsequent turns.

#### Subsequent messages — add to existing conversation
```
POST {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations/{conversationId}/messages
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.1.0
Content-Type: application/json

{
  "content": "<user message>",
  "mentions": [{ "configurationId": "<agentSId>" }],
  "context": {
    "username": "...",
    "timezone": "...",
    "origin":   "cli"
  }
}
```

Response: `UserMessageType` — use the returned `agentMessages[0].sId` to stream.

#### Stream agent response
```
GET {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations/{conversationId}/messages/{agentMessageId}/events
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.1.0
Accept: text/event-stream
```

### SSE Event → Pi Stream Mapping

| Dust SSE event | Pi action |
|---|---|
| `generation_tokens` where `classification === "tokens"` | Yield text delta |
| `generation_tokens` where `classification === "chain_of_thought"` | Discard (not shown) |
| `agent_message_success` | End stream (terminal) |
| `agent_error` | Throw error with `event.error.message` (terminal) |
| `agent_generation_cancelled` | End stream cleanly (terminal) |
| `user_message_error` | Throw error with `event.error.message` (terminal) |
| `tool_params` | Ignore for now (future: show tool name in working message) |
| `agent_action_success` | Ignore for now |
| `tool_approve_execution` | Ignore for now (future: prompt user via `ctx.ui.confirm`) |
| `tool_notification` | Ignore for now |
| `tool_error` | Ignore for now |

### User Context

| Field | Source |
|---|---|
| `username` | Stored from `/api/v1/me` response at login (add to credentials) |
| `timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` at runtime |
| `origin` | Always `"cli"` (interactive pi session) |
| `fullName` | Optional, from `/api/v1/me` if available |
| `email` | Optional, from `/api/v1/me` if available |

> `username` is not currently stored in credentials — login must be updated to
> save `meData.user.name` or `meData.user.email` for use here.

### Error Handling

- Token refresh is handled by the existing `refreshToken` oauth config.
- If the conversation API returns 401, surface a clear error:
  `"Dust session expired — run /logout then /login to re-authenticate."`
- If the agents API returns an empty list after workspace switch, notify the user.

### AbortSignal

`streamSimple` receives an `AbortSignal` via `options`. Forward it to all fetch
calls and the SSE stream so the agent stops generating when the user presses
Escape or switches model.

---

## Out of Scope (Future)

- `tool_approve_execution` — user approval flow for tool calls
- `tool_personal_auth_required` — OAuth re-auth mid-conversation
- Content fragments / file attachments
- Conversation history display (`/history` command)
- Workspace switch mid-session (resets conversation ID)
