# Spec: Dust Agent Chat via Pi

## Status: Milestone 2 Complete

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
| `username` stored from `/api/v1/me` at login | ✅ |
| Real `streamSimple` — creates conversation, streams SSE | ✅ |
| Subsequent messages reuse existing conversation | ✅ |
| SSE event → pi stream mapping | ✅ |

---

## Milestone 1 — Mock Provider (Done)

Registered `streamSimple` on the `dust` provider so selecting a Dust agent
in `/model` does not crash pi. (Superseded by Milestone 2.)

---

## Milestone 2 — Real Provider (Complete)

### Design Decisions

| Decision | Choice |
|---|---|
| Credential access in `streamSimple` | `model.authStorage` field (set at `buildDustProviderConfig` time, `{ get, set }`) |
| Conversation state | Module-level `let currentConversationId: string \| null` — reset on `dustExtension()` call and on `buildDustProviderConfig()` call |
| Username in credentials | `meData.user.username` (dedicated field on Dust `UserType`, matches dust-cli) |

### Overview

`streamSimple` calls the Dust conversation API, maps SSE events to pi's
stream format, and correctly identifies the request as interactive CLI usage.

### Conversation Lifecycle

- **One conversation per pi session.** Created on the first message, reused for
  subsequent turns (add messages to the existing conversation).
- Conversation ID is stored in module-level `currentConversationId` (not in credentials — it is
  session-ephemeral).
- On workspace switch or session re-register, `buildDustProviderConfig` resets `currentConversationId = null`.
- On extension load (`dustExtension()`), `currentConversationId` is reset.

### HTTP Calls (all include `User-Agent: "Dust CLI"` + `X-Dust-CLI-Version`)

#### First message — create conversation
```
POST {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.4.4
Content-Type: application/json

{
  "visibility": "unlisted",
  "message": {
    "content": "<user message>",
    "mentions": [{ "configurationId": "<agentSId>" }],
    "context": {
      "username":  "<from credentials, stored at login from /api/v1/me>",
      "timezone":  "<Intl.DateTimeFormat().resolvedOptions().timeZone>",
      "origin":    "cli"
    }
  }
}
```

Response: `{ conversation: { sId, content }, message: { sId } }` — save `conversation.sId` to
`currentConversationId`. Agent message sId is found in `conversation.content`.

#### Subsequent messages — add to existing conversation
```
POST {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations/{conversationId}/messages
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.4.4
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

Response: `{ message: { sId } }` — use `message.sId` as `userMessageSId`.

Then fetch the conversation to find the agent message sId:
```
GET {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations/{conversationId}
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.4.4
```

Response: `{ conversation: { sId, content } }` — find `agent_message` in content
where `parentMessageId === userMessageSId`.

#### Stream agent response
```
GET {apiUrl}/api/v1/w/{workspaceId}/assistant/conversations/{conversationId}/messages/{agentMessageId}/events
Authorization: Bearer {access_token}
User-Agent: Dust CLI
X-Dust-CLI-Version: 0.4.4
Accept: text/event-stream
```

### SSE Event → Pi Stream Mapping

The stream opens with `{ type: "start", partial }`: pi's agent loop drops every
partial update until that event has established the streaming message, so
without it the whole turn only renders once, at `done`. `start` is emitted
exactly once per turn, before the reconnect loop below — not once per SSE
connection. `streamEvents` reconnects on every tool call and again whenever
Dust closes the window at its 60s server-side cap, and a `start` repeated on
one of those reconnects would look like a second turn beginning and reset
whatever pi had already rendered.

| Dust SSE event | Pi action |
|---|---|
| `generation_tokens` where `classification === "tokens"` | Append to the open `text` block; yields `text_start` when the block opens, then a `text_delta` per batch, then `text_end` when the block closes. A batch with empty text yields nothing at all |
| `generation_tokens` where `classification === "chain_of_thought"` | Append to the open `thinking` block; yields `thinking_start`/`thinking_delta`/`thinking_end` the same way, so the reasoning streams live and stays out of the answer text. A batch with empty text yields nothing at all |
| `generation_tokens` where `classification` is `opening_delimiter` / `closing_delimiter` | Close the open block, emitting its `text_end`/`thinking_end` (the delimiter markup itself is not content) |
| `generation_tokens` with any other/missing `classification` | Logged and ignored; the open block is left open, unaffected |
| `agent_message_success` | Close any open block, then yield `{ type: "done", reason: "stop" }` and return |
| `agent_message_gracefully_stopped` | Terminal per the Dust SDK's `terminalEventTypes`; same as `agent_message_success` — without this the stream never completes and the turn hangs |
| `agent_error` | Close any open block, then throw `event.error.message` (terminal) — the outer catch in `dust-stream-provider.ts` turns this into `{ type: "error", reason: "error" }`, but with a fresh empty message, not the accumulated content |
| `agent_generation_cancelled` | End the turn via `finishAborted`: yield `{ type: "error", reason: "aborted" }` carrying `stopReason: "aborted"`, the reasoning and answer accumulated so far, and the cancellation message — not a clean `done` |
| `user_message_error` | Close any open block, then throw `event.error.message` (terminal) — same caveat as `agent_error` |
| `tool_params` | Ignore for now |
| `agent_action_success` | Ignore for now |
| `tool_approve_execution` | Ignore for now |
| `tool_notification` | Ignore for now |
| `tool_error` | Ignore for now |

### User Context

| Field | Source |
|---|---|
| `username` | Stored from `/api/v1/me` `user.username` field at login |
| `timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` at runtime |
| `origin` | Always `"cli"` (interactive pi session) |

### Error Handling

- Token refresh is handled by the existing `refreshToken` oauth config.
- If any conversation/stream API call returns 401, surface:
  `"Dust session expired — run /logout then /login to re-authenticate."`

### AbortSignal

`streamSimple` receives an `AbortSignal` via `options.signal`. It is forwarded to all
fetch calls (`createConversation`, `postUserMessage`, `getConversation`, and the SSE stream).

---

## Out of Scope (Future)

- `tool_approve_execution` — user approval flow for tool calls
- `tool_personal_auth_required` — OAuth re-auth mid-conversation
- Content fragments / file attachments
- Conversation history display (`/history` command)
- Workspace switch mid-session (resets conversation ID)

