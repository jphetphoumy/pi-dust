# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`pi-dust` is a Pi extension that integrates the [Dust](https://dust.tt) platform with the Pi coding agent runtime. It enables Pi users to authenticate via OAuth (WorkOS device flow), discover Dust agents, and interact with them as Pi models — including streaming responses and bridging Dust MCP tool calls to Pi's own local tools (bash, read, write, edit, grep, find, ls) with a user approval flow.

## Commands

This repo has no Makefile — it uses [`just`](https://github.com/casey/just) (see `justfile`). Every recipe wraps an npm script of the same name.

```bash
just check       # Full quality gate: typecheck + lint + test
just prepush      # Extended pre-push gate: typecheck + lint (no coverage)
just test         # Run Vitest test suite once
just test-watch   # Run Vitest in watch mode
just coverage     # Generate coverage reports
just lint         # Run ESLint
just typecheck    # TypeScript type checking
just setup-dev    # First-time setup: install deps + git hooks
just changelog    # Generate/update CHANGELOG.md
just commitlint   # Lint the current commit message (.git/COMMIT_EDITMSG)
just clean        # Remove coverage/ and RELEASE_NOTES.md
```

Run a single test file (no `just` shortcut for this):
```bash
npx vitest run test/oauth.test.ts
```

## Architecture

The project is organized as 18 TypeScript modules in `src/`, each with a single responsibility:

| Module | Role |
|--------|------|
| `dust.ts` | Main entrypoint — wires all modules together |
| `dust-provider.ts` | Registers Dust agents as Pi models |
| `dust-stream-provider.ts` | Conversation execution and stream orchestration |
| `dust-runtime.ts` | In-memory session state (conversation ID, MCP server ID, heartbeats, approval-gate coordination) |
| `dust-session-events.ts` | Hooks into Pi session lifecycle events (`session_start`, `session_switch`) |
| `dust-workspace.ts` | `/workspace` command registration |
| `dust-auth.ts` | OAuth device flow, token refresh, workspace discovery, agent retrieval |
| `dust-stream.ts` | Parses Dust SSE events and emits Pi stream chunks |
| `dust-mcp.ts` | Client-side MCP server integration (register, heartbeat, listen, post results) |
| `dust-tools.ts` | Wraps Pi's own built-in tool factories (bash, read, write, edit, grep, find, ls) as the MCP tool catalogue Dust can call |
| `dust-tool-render.ts` | Renders Dust-driven tool calls in Pi's transcript via Pi's native `ToolExecutionComponent` |
| `dust-approval.ts` | `/auto` command and shortcut to toggle auto-approval of Dust tool calls; drives the footer status indicator |
| `dust-state.ts` | Persists extension-owned Dust state (`dust-state.json`) — workspace/agents/conversations/invalidated flag — separately from pi's own OAuth token store (`auth.json`) |
| `dust-validation.ts` | Runtime validation of external API payloads |
| `dust-debug.ts` | Debug logging with token/credential redaction |
| `dust-types.ts` | Shared TypeScript type contracts (excluded from test coverage) |
| `dust-constants.ts` | Project-wide constants (auth headers, endpoints) |
| `dust-bootstrap.ts` | Bootstrap credential loading at extension-load time, including one-time legacy state migration |

**Key data flows:**
- **Auth:** `dust-auth.ts` handles OAuth device flow → token storage → workspace/agent discovery
- **Conversation:** `dust-stream-provider.ts` coordinates Dust event stream + MCP request stream with dual approval logic
- **Tool approval:** `dust-tools.ts` intercepts MCP tool calls and gates them on local user approval (toggled via `dust-approval.ts`)
- **State:** `dust-runtime.ts` holds ephemeral in-memory session state; `dust-state.ts` holds the persisted half. Both are reset/re-read on session switch or credential invalidation

## Tech Stack

- **Language:** TypeScript, strict, ES2023 target, NodeNext modules, ESM. Type-checking (`tsc`) runs on TypeScript 7 via the `@typescript/native` package; `typescript-eslint` 8.x doesn't yet support TS 7, so ESLint resolves the `typescript` package aliased to the `@typescript/typescript6` compat shim instead. Both are wired through `just typecheck` / `just lint`.
- **Runtime:** Node.js >=22.19.0 (required by `pi-ai` / `pi-coding-agent`)
- **Framework:** `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`
- **Tests:** Vitest 4 with v8 coverage
- **Linting:** ESLint 10 with the TypeScript plugin
- **Commits:** Conventional Commits (commitlint) — enforced by git hooks
- **CI:** GitHub Actions (`ci.yml` runs lint + typecheck on Node 22, and tests on a Node 22/24 matrix, plus a package smoke test and a release-readiness check)

## Conventions

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by `commitlint`
- `just prepush` (typecheck + lint) must pass before pushing; it is wired as the `pre-push` git hook. `just check` (typecheck + lint + test) is the `pre-commit` hook.
- Test files live in `test/` and are grouped by domain (e.g. `oauth.test.ts`, `session.test.ts`, `tools.test.ts`), not a 1:1 mirror of `src/` filenames
- `dust-types.ts` is intentionally excluded from coverage metrics
