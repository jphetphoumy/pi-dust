# Spec: MCP Tool Call Confirm + Multi-Turn Reconnect

## Status: Implemented

---

## Goal

When a Dust agent calls a client-side MCP tool (bash, read, edit), pi shows the
user an allow/deny confirmation prompt before executing. The agent's final text
reply (which arrives after the tool result is posted) is streamed back to the
user. Both behaviours must work without blocking each other.

---

## Background

Dust's client-side MCP protocol lets the agent invoke tools on the user's machine.
The flow over the wire:

```
1. POST /mcp/register          → { serverId, expiresAt }
2. GET  /mcp/requests?serverId  → persistent SSE stream of JSON-RPC requests
3. Agent sends: initialize → notifications/initialized → tools/list → tools/call
4. Client responds via POST /mcp/results for each request
5. POST /mcp/heartbeat every 5 min to keep the server registered
```

The `clientSideMCPServerIds: [serverId]` must be included in every conversation
message context so the agent knows it can call tools.

### Multi-turn SSE behaviour

After a `tools/call` request arrives, the Dust agent SSE stream for that turn
closes **without** sending `agent_message_success`. The agent's continuation
response (text + `agent_message_success`) arrives in a **new connection** to the
same SSE endpoint, after the client has posted the tool result.

---

## Problems Being Solved

### Problem 1 — Original deadlock

The old `listenMcpRequests` loop called `await currentConfirmFn(...)` inline
inside the SSE reader loop. This blocked the loop from reading further SSE data
(and from posting the result) while waiting for user input, causing a deadlock
with the agent stream.

### Problem 2 — Multi-turn stream termination

`streamEvents()` received `done: true` on the agent SSE and synthesized a `done`
event, closing the pi stream before the agent's continuation reply was sent.

---

## Design

### `McpListenerHandle` interface

```ts
interface McpListenerHandle {
  /** Resolves when the most-recently-started tools/call POST completes. */
  waitForPendingToolResult(): Promise<void>;
}
```

Returned by `listenMcpRequests`. Used by `streamEvents` to know when to reconnect.

### Fix 1 — Fire-and-forget `tools/call` handling

When `tools/call` arrives in the MCP SSE reader:

1. Create a new `pendingToolResult` promise with a captured resolver.
2. Launch a **detached** async IIFE: `confirm → execute → POST /mcp/results → resolveToolResult()`.
3. The SSE reader loop continues immediately (not blocked on user input).
4. `McpListenerHandle.waitForPendingToolResult()` returns the current `pendingToolResult`.

### Fix 2 — `streamEvents` reconnect loop

`streamEvents` wraps its SSE read in a `for (;;)` loop:

- If the SSE closes and `agent_message_success` was NOT received AND an `mcpHandle`
  is provided: call `await mcpHandle.waitForPendingToolResult()` then `continue`
  (reconnect to the same SSE URL).
- If no `mcpHandle`, or `agentDone` is true: break and synthesize a `done` event.

### Fix 3 — Deterministic fetch ordering in `listenMcpRequests`

**Root cause of test failures:** `listenMcpRequests` (when the reconnect loop ran
as a fully detached IIFE) would start its first `fetch(/mcp/requests)` as a
microtask. Meanwhile `dustRealStream` proceeded synchronously to `createConversation`,
consuming the wrong fetch mock slot.

**Fix:** `listenMcpRequests` performs the **first** `fetch(/mcp/requests)` call
directly in its own `async` body (before returning). This guarantees the MCP SSE
connection is established before the caller proceeds to `createConversation`.

The reconnect loop (for subsequent turns) runs as a detached IIFE, but only after
the first response has been handed off to `processResponse`.

**Additionally:** the reconnect loop does `await pendingToolResult` at the top of
each iteration (before fetching the next connection). This prevents a race where
the loop reconnects before the tool result POST has completed, which would consume
the wrong fetch mock slot.

### Module-level state changes

```ts
let mcpListenerHandle: McpListenerHandle | null = null;
```

- Set in `dustRealStream` after `await listenMcpRequests(...)`.
- Nulled in `clearMcpState()`.
- Passed to both `streamEvents` call sites.

---

## Expected fetch call ordering (per streamSimple invocation)

```
#1  POST /mcp/register
#2  GET  /mcp/requests          ← consumed by listenMcpRequests before returning
#3  POST /mcp/results           ← fire-and-forget (confirm → execute → POST)
#4  POST /assistant/conversations  (or /messages for subsequent turns)
#5  GET  /messages/{id}/events  ← first agent SSE (may close without success)
#6  GET  /messages/{id}/events  ← reconnect after tool result posted
```

For tests where the MCP SSE stream never closes (`makePendingSseStream`), mocks
#3 and above shift accordingly (no tool call, no reconnect).

---

## Test coverage required (108 tests total, 4 new)

| Test | Description |
|---|---|
| `calls the confirm function with title containing the tool name` | `currentConfirmFn` called with correct title |
| `calls the confirm function with message containing the command` | `currentConfirmFn` called with correct message body |
| `posts MCP result when confirm returns true` | result POSTed with `isError: false` |
| `posts MCP result with isError=true when confirm returns false` | result POSTed with denial message |
| `MCP result is posted even while agent SSE stream is still processing` | fire-and-forget: result posted even with async confirm |
| `after tool call completes, streams the continuation agent response` | text_delta from reconnect SSE arrives in pi stream |
| `re-connects to the same agent message SSE endpoint after tool call` | both SSE calls use identical URL |
| `terminates cleanly with done event after multi-turn MCP exchange` | pi stream ends with `{ type: "done" }` |

---

## Files

| File | Role |
|---|---|
| `dust-extension/dust.ts` | All implementation |
| `dust-extension/dust.test.ts` | All tests (vitest) |

Run tests:
```
cd /home/jphetphoumy/Documents/pi-agent/dust-extension
nix develop --command bash -c "npm run test"
```

Target: **108 tests, 0 failing**.

---

## Out of Scope

- `initialize` / `notifications/initialized` / `tools/list` confirm prompts (no user decision needed)
- Multiple simultaneous tool calls in one turn
- MCP reconnect on network error (only tool-call-driven reconnect is in scope)
- Heartbeat failure handling
- `tool_personal_auth_required` mid-session OAuth re-auth
