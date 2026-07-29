# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`pi-dust` is a Pi extension that integrates the [Dust](https://dust.tt) platform with the Pi coding agent runtime. It enables Pi users to authenticate via OAuth (WorkOS device flow), discover Dust agents, and interact with them as Pi models — including streaming responses and bridging Dust MCP tool calls to local tools (bash, read, edit) with an approval flow.

## Commands

```bash
make check        # Full quality gate: typecheck + lint + test
make prepush      # Extended gate: typecheck + lint + coverage (run before pushing)
make test         # Run Vitest test suite once
make test-watch   # Run Vitest in watch mode
make coverage     # Generate coverage reports
make lint         # Run ESLint
make typecheck    # TypeScript type checking
make setup-dev    # First-time setup: install deps + git hooks
make changelog    # Generate/update CHANGELOG.md
```

Run a single test file:
```bash
npx vitest run test/dust-auth.test.ts
```

## Architecture

The project is organized as 22 TypeScript modules in `src/`, each with a single responsibility:

| Module | Role |
|--------|------|
| `dust.ts` | Main entrypoint — wires all modules together |
| `dust-provider.ts` | Registers Dust agents as Pi models |
| `dust-stream-provider.ts` | Conversation execution and stream orchestration |
| `dust-runtime.ts` | In-memory session state (conversation ID, MCP server ID, heartbeats) |
| `dust-session-events.ts` | Hooks into Pi session lifecycle events |
| `dust-workspace.ts` | `/workspace` command registration |
| `dust-status.ts` | `/status` credit panel command |
| `dust-status-render.ts` | ASCII layout for the credit panel |
| `dust-credits.ts` | Private credit API client (usage, fair-use, period totals, breakdowns) |
| `dust-ceiling.ts` | Monthly credit ceiling resolution and pro-rating |
| `dust-auth.ts` | OAuth token flow, token refresh, workspace discovery, agent retrieval |
| `dust-stream.ts` | Parses Dust SSE events and emits Pi stream chunks |
| `dust-mcp.ts` | Client-side MCP server integration |
| `dust-tools.ts` | Local tool catalog (bash, read, edit) with user approval |
| `dust-validation.ts` | Runtime validation of external API payloads |
| `dust-debug.ts` | Debug logging with token/credential redaction |
| `dust-types.ts` | Shared TypeScript type contracts (excluded from test coverage) |
| `dust-constants.ts` | Project-wide constants (auth headers, endpoints) |
| `dust-bootstrap.ts` | Bootstrap credential loading on startup |

**Key data flows:**
- **Auth:** `dust-auth.ts` handles OAuth device flow → token storage → workspace/agent discovery
- **Conversation:** `dust-stream-provider.ts` coordinates Dust event stream + MCP request stream with dual approval logic
- **Tool approval:** `dust-tools.ts` intercepts MCP tool calls and gates them on local user approval
- **State:** `dust-runtime.ts` holds ephemeral session state; reset on session switch or credential invalidation

## Tech Stack

- **Language:** TypeScript 5.9 (strict, ES2023, NodeNext modules, ESM)
- **Runtime:** Node.js >=22.19.0 (required by `pi-ai` / `pi-coding-agent`)
- **Framework:** `@mariozechner/pi-ai` + `@mariozechner/pi-coding-agent`
- **Tests:** Vitest 3 with v8 coverage
- **Linting:** ESLint 9 with TypeScript plugin
- **Commits:** Conventional Commits (commitlint) — enforced by git hooks
- **CI:** GitHub Actions (nodes 20/22/24, smoke test, release readiness check)

## Conventions

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by `commitlint`
- `make prepush` must pass before pushing (runs full coverage gate)
- Test files live in `test/` and mirror the `src/` module structure
- `dust-types.ts` is intentionally excluded from coverage metrics
