# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`pi-dust` is a Pi extension that integrates the [Dust](https://dust.tt) platform with the Pi coding agent runtime. It enables Pi users to authenticate via OAuth (WorkOS device flow), discover Dust agents, and interact with them as Pi models — including streaming responses and bridging Dust MCP tool calls to local tools (bash, read, edit) with an approval flow.

## Commands

This repo uses [`just`](https://github.com/casey/just) as its task runner (no Makefile):

```bash
just check        # Full quality gate: typecheck + lint + test
just prepush      # Extended gate: typecheck + lint + coverage (run before pushing)
just test         # Run Vitest test suite once
just test-watch   # Run Vitest in watch mode
just coverage     # Generate coverage reports
just lint         # Run ESLint
just typecheck    # TypeScript type checking
just setup-dev    # First-time setup: install deps + git hooks
just changelog    # Generate/update CHANGELOG.md
```

Feature worktree harness (requires `just`, `herdr`, `claude`, `hunk` on `PATH`, run from inside a herdr pane):

```bash
just feature <name>  # New worktree + branch + herdr workspace (claude in auto mode + a live hunk diff tab)
just delete <name>   # Tear down that worktree, branch, and herdr workspace
```

Run a single test file:
```bash
npx vitest run test/dust-auth.test.ts
```

## Architecture

The project is organized as 27 TypeScript modules in `src/`, each with a single responsibility:

| Module | Role |
|--------|------|
| `dust.ts` | Main entrypoint — wires all modules together |
| `dust-provider.ts` | Registers Dust agents as Pi models |
| `dust-stream-provider.ts` | Conversation execution and stream orchestration |
| `dust-runtime.ts` | In-memory session state (conversation ID, MCP server ID, heartbeats) |
| `dust-session-events.ts` | Hooks into Pi session lifecycle events |
| `dust-conversation.ts` | Decides and verifies which Dust conversation a session continues |
| `dust-state.ts` | Extension-owned state file (`dust-state.json`) |
| `dust-approval.ts` | Tool approval mode registration |
| `dust-loop.ts` | `/loop` command — recurring or self-paced re-sending of a prompt |
| `dust-tool-render.ts` | Renders Dust-driven tool calls in Pi's transcript |
| `dust-workspace.ts` | `/workspace` command registration |
| `dust-status.ts` | `/status` command; opens the interactive panel |
| `dust-status-tabs.ts` | Tab and window definitions |
| `dust-status-loader.ts` | Per-tab async loading state |
| `dust-status-panel.ts` | Interactive tabbed TUI component |
| `dust-status-render.ts` | ASCII layout for the Overview body |
| `dust-status-tab-render.ts` | Layout for the breakdown tabs |
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
- **Resume:** every session transition (startup, `/new`, `/resume`, `/fork`) arrives as one `session_start` carrying a `reason`; `dust-conversation.ts` maps the session file — or, for a fork, its parent — back to a Dust conversation and checks it still exists before reattaching

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
- `just prepush` must pass before pushing (runs full coverage gate)
- Test files live in `test/` and mirror the `src/` module structure
- `dust-types.ts` is intentionally excluded from coverage metrics
