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

- register the Dust provider
- keep track of current session state
- manage the current conversation id
- manage the MCP server lifecycle
- wire approval flow between Dust SSE and MCP tool execution

This file should stay focused on orchestration. Protocol parsing and side
effects belong in dedicated modules.

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

### `src/dust-tools.ts`

Local tool catalog and executors.

Provided tools:

- `bash`
- `read`
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
runtime state container inside `src/dust.ts`.

That container tracks:

- current conversation id
- current MCP server id
- MCP heartbeat timer
- MCP request listener abort controller
- approval state shared between Dust SSE and MCP execution

This runtime state is reset when sessions switch, credentials are invalidated,
or the extension needs to clear MCP state.

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
  dust-auth.ts
  dust-constants.ts
  dust-debug.ts
  dust-mcp.ts
  dust-stream.ts
  dust-tools.ts
  dust-types.ts
  dust-validation.ts

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
- workspace behavior
- debug logging and redaction
