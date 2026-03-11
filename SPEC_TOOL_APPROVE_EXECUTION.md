# Spec: Tool Approval via `tool_approve_execution` (Server-Side Flow)

## Status: Ready for implementation

---

## Goal

When a Dust agent wants to call a client-side MCP tool (bash, read, edit), pi shows
the user an allow/deny prompt **and** posts the decision back to the Dust API via
`POST /validate-action` — just as the Dust CLI does — so the agent resumes or is
cancelled server-side.

This replaces the current local-only `currentConfirmFn` confirmation path for
any tool that the Dust server flags with a `tool_approve_execution` SSE event
(i.e. tools whose `stake` is not `never_ask`).

---

## Background

### Current behaviour (broken UX)

Today, when the Dust server emits a `tool_approve_execution` SSE event, pi ignores
it (`// Ignore for now` in `streamEvents`). The Dust server is waiting for a
`validate-action` POST before the agent loop continues. Because pi never calls
that endpoint, the agent loop is **permanently blocked** — the agent never receives
the tool result, and the user sees no progress.

The current `currentConfirmFn` path fires from the **MCP SSE listener** when
`tools/call` arrives — that is a separate, client-side-only gate. The two flows
are parallel and each must work correctly together:

| Flow | Trigger | Purpose |
|---|---|---|
| `tool_approve_execution` SSE event | Agent SSE stream | Ask server "should I run this?" |
| `tools/call` MCP request | MCP SSE stream | Actually execute the tool on the client |

The `tool_approve_execution` event arrives **before** `tools/call`. Once approved
via `validate-action`, the Dust server releases the agent loop, which then emits
the `tools/call` MCP request to pi's MCP listener. If rejected, the agent is told
the tool was denied; no `tools/call` is ever sent.

### Dust CLI reference flow

```
Agent SSE stream:
  → tool_approve_execution { actionId, conversationId, messageId,
                              stake, inputs, metadata.toolName, ... }

CLI:
  1. Check stake: never_ask → auto-approve
  2. Check cache (low-stake): auto-approve if cached
  3. Show TUI prompt (Approve / [Approve and don't ask again] / Reject)
  4. POST {apiUrl}/api/v1/w/{wId}/assistant/conversations/{cId}/messages/{mId}/validate-action
     body: { actionId, approved: "approved" | "rejected" }

Server resumes agent loop → MCP SSE emits tools/call → client executes
```

---

## Problems Being Solved

### Problem 1 — Agent loop permanently blocked

Pi ignores `tool_approve_execution` events. The Dust server never receives a
`validate-action` POST, so the agent is stuck waiting for approval forever.

### Problem 2 — Redundant local-only confirm for already-approved tools

After the server-side `validate-action` flow approves a tool, the client-side
`currentConfirmFn` in `listenMcpRequests` would ask the user **again** when
`tools/call` arrives. This is a second, redundant prompt. The MCP listener's
`currentConfirmFn` gate should be bypassed or pre-answered for tools that were
already approved via `validate-action`.

---

## Design

### New exported (module-level) state

```ts
// Maps actionId → approval result, populated when validate-action is called.
// Read by listenMcpRequests to skip the redundant local confirm for tools
// that were already server-approved.
const preApprovedActions = new Map<string, boolean>();
```

Entries are added before posting `validate-action` and cleared after the
corresponding `tools/call` in `listenMcpRequests` consumes them (or on
`clearMcpState()`).

### Change 1 — Handle `tool_approve_execution` in `streamEvents`

In the `streamEvents` SSE loop, add a branch for `tool_approve_execution`:

```ts
} else if (event.type === "tool_approve_execution") {
  // 1. Ask the user (or auto-approve based on stake).
  const approved = await handleToolApproveExecution(event, baseUrl, authHeaders, signal);
  // 2. POST the decision to Dust.
  await postValidateAction(baseUrl, authHeaders, {
    conversationId: event.conversationId,
    messageId:      event.messageId,
    actionId:       event.actionId,
    approved:       approved ? "approved" : "rejected",
  });
  // 3. Cache approval so listenMcpRequests can skip the redundant local confirm.
  preApprovedActions.set(event.actionId, approved);
}
```

`streamEvents` must receive `baseUrl` and `authHeaders` (currently not passed).
Add those parameters and thread them through from `dustRealStream`.

### Change 2 — New `handleToolApproveExecution` function

```ts
async function handleToolApproveExecution(
  event: ToolApproveExecutionEvent,
  // baseUrl / authHeaders not needed here but stake logic might query caches later
): Promise<boolean> {
  if (event.stake === "never_ask") return true;

  // Show the pi allow/deny confirm prompt.
  const toolName   = event.metadata?.toolName ?? "tool";
  const inputLines = Object.entries(event.inputs ?? {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");

  return currentConfirmFn(
    `Dust agent wants to run: ${toolName}`,
    inputLines || "(no inputs)",
  );
}
```

No "don't ask again" caching in this first iteration (out of scope).

### Change 3 — New `postValidateAction` function

```ts
async function postValidateAction(
  baseUrl: string,
  authHeaders: Record<string, string>,
  params: {
    conversationId: string;
    messageId:      string;
    actionId:       string;
    approved:       "approved" | "rejected";
  },
  signal?: AbortSignal,
): Promise<void> {
  const { conversationId, messageId, actionId, approved } = params;
  const res = await fetch(
    `${baseUrl}/assistant/conversations/${conversationId}/messages/${messageId}/validate-action`,
    {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ actionId, approved }),
      signal,
    },
  );
  if (!res.ok) {
    console.error(`[dust] validate-action failed: HTTP ${res.status}`);
  }
}
```

### Change 4 — Bypass redundant local confirm in `listenMcpRequests`

In `listenMcpRequests`, when `tools/call` arrives, check `preApprovedActions`
before calling `currentConfirmFn`:

```ts
} else if (request.method === "tools/call") {
  const toolName: string = request.params?.name ?? "";
  const toolArgs: Record<string, unknown> = request.params?.arguments ?? {};

  // Check if this tool was already approved via the server-side validate-action flow.
  // actionId is not available here — use a flag per tool name / per pending request.
  // Simplest approach: if ANY pre-approval is pending, consume it.
  let allowed: boolean;
  if (preApprovedActions.size > 0) {
    // Consume the oldest pending pre-approval (FIFO).
    const [firstKey, firstValue] = preApprovedActions.entries().next().value;
    preApprovedActions.delete(firstKey);
    allowed = firstValue;
  } else {
    // Fallback: no server-side approval received — ask locally.
    allowed = await currentConfirmFn(
      `Dust agent wants to run: ${toolName}`,
      buildConfirmMessage(toolName, toolArgs),
    );
  }
  ...
```

> **Note on FIFO:** Dust guarantees at most one outstanding `tools/call` per
> agent turn, so the FIFO approach is safe. If that assumption changes, the
> `tools/call` MCP request will need to carry the `actionId` — that would
> require a Dust API change, which is out of scope.

### New TypeScript types

```ts
interface ToolApproveExecutionEvent {
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
```

### `clearMcpState` cleanup

Add `preApprovedActions.clear()` to `clearMcpState()` so session resets don't
leak stale approvals.

---

## Expected fetch call ordering (per `streamSimple` invocation with tool approval)

```
#1  POST /mcp/register
#2  GET  /mcp/requests                   ← MCP SSE listener starts
#3  POST /assistant/conversations
#4  GET  /messages/{id}/events           ← agent SSE
#5      ↳ tool_approve_execution event received (inside #4 SSE body)
#6  [user sees confirm prompt]
#7  POST /messages/{id}/validate-action  ← new: approval/rejection sent to server
#8  GET  /messages/{id}/events           ← agent SSE reconnect (agent resumes/cancelled)
#9  POST /mcp/results                    ← tool result (if approved + tools/call arrives)
```

---

## Test coverage required

All new tests live in `dust-extension/dust.test.ts`. Target: **0 failing tests**.

### New tests

| # | Test description |
|---|---|
| 1 | `handles tool_approve_execution: calls confirmFn with tool name from event metadata` |
| 2 | `handles tool_approve_execution: calls confirmFn with formatted inputs` |
| 3 | `handles tool_approve_execution: POSTs validate-action with "approved" when confirm returns true` |
| 4 | `handles tool_approve_execution: POSTs validate-action with "rejected" when confirm returns false` |
| 5 | `handles tool_approve_execution: auto-approves without prompt when stake is "never_ask"` |
| 6 | `handles tool_approve_execution: validate-action uses correct conversationId and messageId` |
| 7 | `after server-side approval, tools/call is executed without a second confirmFn call` |
| 8 | `after server-side rejection, tools/call is denied without calling confirmFn` |
| 9 | `streams continuation agent response after tool_approve_execution + tools/call cycle` |

---

## Files

| File | Role |
|---|---|
| `dust-extension/dust.ts` | All implementation |
| `dust-extension/dust.test.ts` | All tests (vitest) |

Run tests:
```sh
cd /home/jphetphoumy/Documents/pi-agent/dust-extension
nix develop --command bash -c "npm run test"
```

Target: **all tests passing, 0 failing**.

---

## Out of Scope

- "Don't ask again" / approval caching (stake-level cache)
- `stake: "low"` vs `"high"` different prompt UI (same prompt for both in this iteration)
- `tool_personal_auth_required` mid-session OAuth re-auth
- Multiple simultaneous tool approvals in one turn
- Heartbeat failure handling
- Content fragments / file attachments
- Web UI approval flow (existing, separate system — pi approval must be the canonical path)
