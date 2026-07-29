# Architecture

This document describes the current project structure and the role of each main
module.

## High-level flow

At runtime, the extension does four main things:

1. authenticates with Dust through WorkOS
2. exposes Dust agents as Pi models
3. manages conversation lifecycle and streaming
4. bridges Dust MCP calls to local tools with approval

## Main modules

### `src/dust.ts`

Main entrypoint and orchestration layer.

Responsibilities:

- bootstrap the Dust provider wiring
- register session lifecycle hooks
- register user-facing commands

This file should stay focused on orchestration. Protocol parsing and side
effects belong in dedicated modules.

### `src/dust-provider.ts`

Dust provider registration and model exposure.

Responsibilities:

- register the `dust` provider with Pi
- expose Dust agents as Pi models
- keep OAuth model mapping logic in one place

### `src/dust-stream-provider.ts`

Dust conversation execution and stream orchestration.

Responsibilities:

- refresh credentials before streaming when needed
- create or resume Dust conversations
- connect Dust SSE with the MCP approval flow
- translate failures into Pi stream errors
- upload `@`-mentioned files to the conversation instead of sending them inline

### `src/dust-attachments.ts`

Finds the files a user attached with `@`. pi produces two different forms, and
both land here:

- **the CLI inlines.** `pi @foo.ts "..."` prefixes the message with a
  `<file name="...">` marker per file: the whole body for a text file, an empty
  tag for an image whose bytes ride along as a separate `image` content block.
  Left as is, the text bodies are billed as prompt tokens on every later turn of
  the conversation and the images are dropped entirely, since only `text` blocks
  reach Dust.
- **the interactive editor does not.** Its `@` is a path autocomplete: it writes
  `@path` into the message as plain text and leaves reading it to the agent.
  Nothing has to be undone for these, but uploading still pays off — and for an
  image it is the difference between the model seeing it and the agent staring
  at a path it cannot open.

Responsibilities:

- recognise the inliner's markers, and only those — a text marker counts only
  when its body still matches the file on disk byte for byte, so a
  `<file name="...">` the user typed is never mistaken for an attachment
- pair image blocks with their markers, keeping pi's resized bytes
- recognise `@path` mentions that name a real file, resolved against the
  session's working directory, and read those from disk
- leave small text files alone, where an upload plus a `cat` round trip costs
  more than what it saves
- rewrite an attached file's marker into a pointer that keeps the local path,
  so edits still target the file on disk rather than the conversation snapshot.
  Rewriting is by position, so `@a.ts` never rewrites the `@a.ts` in `@a.ts.bak`

### `src/dust-files.ts`

Dust file upload and content fragment plumbing.

Responsibilities:

- create the file record, then upload its bytes to the pre-signed URL
- attach the file to the conversation as a content fragment, or hand it back
  for the conversation-create request when there is no conversation yet
- skip files already attached to the conversation, keyed by content hash
- never throw: attaching is an optimisation, and a file that cannot be
  uploaded is simply left inline rather than costing the user their turn

### `src/dust-state.ts`

Persistence, split across two files.

pi 0.81 removed `ModelRegistry.authStorage` from the extension API, so
`auth.json` became pi's private store. Ownership is now:

- **pi owns the OAuth token trio** (`access` / `refresh` / `expires`) in
  `auth.json`. It rotates them by calling the `oauth.refreshToken` hook that
  `dust-provider.ts` registers, and persists the result itself.
- **the extension owns Dust state** in `dust-state.json`: `workspaceId`,
  `workspaces`, `agents`, `region`, `username`, the per-session
  `conversations` map, and an `invalidated` flag.

Responsibilities:

- merge both halves into the `DustCredentials` view the rest of the code uses
- persist only the state half, never tokens
- carry over legacy installs that kept state inside the auth.json credential
- write state atomically (temp file + rename)

The `invalidated` flag replaces the old "zero the tokens" trick: the extension
can no longer blank pi's copy, so it records the dead session itself and masks
the tokens on read until the next successful login.

### `src/dust-runtime.ts`

In-memory runtime/session state container.

Responsibilities:

- store the current conversation id
- store MCP lifecycle objects
- manage approval-gate coordination
- bind session-specific persistence and UI callbacks
- hold a freshly refreshed access token (with its own expiry) as the single
  source every auth-header builder in `dust-stream-provider.ts`, and
  `dust-credits.ts`'s `fetchCreditsJson`, read through, since a direct token
  refresh has nowhere else to persist to
- single-flight concurrent refresh attempts, so the event stream, the MCP
  listener, the MCP heartbeat and `/status` credit fetches (`dust-credits.ts`)
  hitting a 401 in the same window share one refresh instead of racing the
  rotating refresh token

### `src/dust-session-events.ts`

Pi session lifecycle integration.

Responsibilities:

- react to `session_start` and `session_switch`
- restore persisted conversation ids
- refresh agents and credentials for the active session

### `src/dust-workspace.ts`

Workspace command registration.

Responsibilities:

- expose the `/workspace` command
- prompt the user for workspace switching
- persist the selected workspace in extension state
- drop the cached credit figures, which belong to the workspace being left

### `src/dust-status.ts`

`/status` command registration.

Responsibilities:

- expose the read-only `/status` panel, interactive where the host supports it
- open it inline via `ui.custom` *without* `overlay`, so pi swaps it into the
  editor's slot: full width, above the prompt, editor restored on close
- resolve the credit API target synchronously, so a not-logged-in run opens nothing
- assemble session counters and the credit endpoints into one payload
- decide what is refetched live and what is served from the session cache
- fall back to a one-shot transcript panel when there is no custom-UI surface

### `src/dust-status-tabs.ts`

Tab and window definitions for the interactive panel.

Responsibilities:

- define the tabs: Overview plus one per Dust analytics dimension
- define the `d`/`w`/`m` windows and the per-tab cache keys

There is no "by model" tab: Dust meters credits (AWU) per message, and its
analytics dimensions are `usage_type | agent | user | origin | api_key` only.
There is no "by user" tab either — `my-usage-analytics` is already scoped to you.

### `src/dust-status-loader.ts`

Async state behind the panel.

Responsibilities:

- hold each tab as a loading/ready/error slice
- fetch a tab the first time it is opened, once per tab and window
- notify the component so it can repaint as data lands

### `src/dust-status-panel.ts`

The interactive credit panel component.

Responsibilities:

- draw the tab bar (active tab as a filled chip), scroll indicator and footer hints
- size itself from the terminal height, leaving the transcript visible above
- handle ←/→/tab, ↑/↓, PgUp/PgDn, `d`/`w`/`m`, `r` and Esc
- animate a spinner only while something is pending
- truncate styled lines so the panel never reflows mid-gauge

### `src/dust-status-tab-render.ts`

Per-tab bodies.

Responsibilities:

- rank a breakdown, show shares and bars scaled to the largest row
- render the loading, error and empty states

### `src/dust-status-render.ts`

Credit panel layout.

Responsibilities:

- draw the ASCII bar gauges
- format credits, wall-clock durations and reset dates
- omit sections whose data is missing or unusable

### `src/dust-credits.ts`

Private credit API client.

Responsibilities:

- resolve the `/api/w/:wId` base URL for the credential's region
- fetch seat usage, fair-use allowance, the 30-day breakdown and top conversations
- fetch the month/week/day credit totals as `groupBy`-less time series
- on 401, delegate to the shared `runtime.refreshAccessToken()` single-flight
  and retry once, rather than refreshing the token itself

Period windows are sized so the *last* bucket of each series is a complete
current period: Dust buckets on a `calendar_interval` over a trailing
`[now - (days-1), now]` window, so 32 days always spans the 1st of the month and
8 days always spans the current week's Monday.

### `src/dust-ceiling.ts`

Monthly credit ceiling resolution.

Responsibilities:

- resolve the ceiling the gauges fill against: `PI_DUST_MONTHLY_CREDITS`, then
  the seat allocation, then the per-user spend cap, then a default of 8000
- pro-rate that ceiling onto a week or a day, using the real length of the
  current month

### `src/dust-auth.ts`

Authentication and workspace discovery.

Responsibilities:

- WorkOS device flow
- token refresh
- workspace selection support
- agent retrieval
- region-aware Dust API base URL resolution
- stable model slug generation

### `src/dust-stream.ts`

Dust SSE parsing and Pi stream emission.

Responsibilities:

- create Pi-compatible event streams
- parse chunked SSE payloads
- reconnect when a tool call interrupts the current agent stream
- find the correct assistant message id in conversation payloads

### `src/dust-mcp.ts`

Client-side MCP server integration.

Responsibilities:

- register the temporary MCP server with Dust
- keep it alive with heartbeats
- listen for MCP requests
- post MCP results back to Dust
- on a 401 (SSE connect or heartbeat), delegate to the shared refresh and
  retry once before treating the session as dead
- recognize a lost registration (403/404) as distinct from a dead session, and
  signal it so the runtime clears state for `dust-stream-provider.ts` to
  re-register on the next turn instead of running toolless

### `src/dust-tools.ts`

Local tool catalog and executors.

Provided tools:

- `bash`
- `read`
- `write` (create or overwrite — `edit` is substitution-only and cannot create)
- `edit`

The module also formats the confirmation message shown to the user before a
tool runs.

### `src/dust-validation.ts`

Runtime validation for external payloads.

Responsibilities:

- parse Dust API responses
- parse WorkOS token payloads
- guard against malformed or incomplete responses
- centralize validation errors instead of spreading ad hoc checks

### `src/dust-debug.ts`

Debug logging and redaction.

Responsibilities:

- enable verbose logging through `--verbose` or `PI_DUST_DEBUG`
- redact tokens and authorization headers
- write logs to stderr and to a local file

### `src/dust-types.ts`

Shared TypeScript contracts used across the codebase.

### `src/dust-constants.ts`

Project-wide constants such as Dust headers and auth constants.

## Session state

The extension keeps lightweight runtime state in memory through a dedicated
runtime state container in `src/dust-runtime.ts`.

That container tracks:

- current conversation id
- current MCP server id
- MCP heartbeat timer
- MCP request listener abort controller
- approval state shared between Dust SSE and MCP execution
- a freshly refreshed access token (with expiry), read ahead of persisted
  storage by every auth-header builder, including `dust-credits.ts`'s
  `fetchCreditsJson`
- an in-flight refresh promise, shared so concurrent 401s from the event
  stream, the MCP listener, the MCP heartbeat and `/status` credit fetches
  single-flight

This runtime state is reset when sessions switch, credentials are invalidated,
or the extension needs to clear MCP state — which also happens when the MCP
server's registration is lost server-side, so the next turn re-registers
instead of advertising a server nothing is listening behind.

## Approval model

Tool execution is protected by two coordinated flows:

1. `tool_approve_execution` from the Dust event stream
2. `tools/call` from the MCP request stream

The extension validates the user decision server-side and avoids asking twice
once the action has already been approved.

## Repository layout

```text
src/
  dust.ts
  dust-attachments.ts
  dust-auth.ts
  dust-ceiling.ts
  dust-constants.ts
  dust-credits.ts
  dust-debug.ts
  dust-files.ts
  dust-mcp.ts
  dust-provider.ts
  dust-runtime.ts
  dust-session-events.ts
  dust-state.ts
  dust-status.ts
  dust-status-loader.ts
  dust-status-panel.ts
  dust-status-render.ts
  dust-status-tab-render.ts
  dust-status-tabs.ts
  dust-stream.ts
  dust-stream-provider.ts
  dust-tools.ts
  dust-types.ts
  dust-validation.ts
  dust-workspace.ts

test/
  *.test.ts
  helpers/
```

## Testing strategy

The project uses domain-focused tests rather than one large file.

Current suites cover:

- OAuth and token handling
- provider registration
- session behavior
- MCP registration and request handling
- stream parsing and reconnection
- tool approval flow
- `@file` parsing, upload and conversation attachment
- workspace behavior
- credit status panel: fetching, caching, tabs and rendering
- debug logging and redaction
