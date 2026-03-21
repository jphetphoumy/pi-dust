[![CI](https://github.com/jphetphoumy/pi-dust/actions/workflows/ci.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/ci.yml)
[![Coverage](https://github.com/jphetphoumy/pi-dust/actions/workflows/coverage.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/coverage.yml)
[![Release](https://github.com/jphetphoumy/pi-dust/actions/workflows/release.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/jphetphoumy/pi-dust?display_name=tag)](https://github.com/jphetphoumy/pi-dust/releases)

**Dust Extension**
- A Pi extension that integrates the Dust.ai assistant platform (dust.tt) with the pi-coding-agent host. It registers a `dust` provider, implements OAuth login (WorkOS device flow), manages conversations, and exposes a small set of MCP tools (`bash`, `read`, `edit`) so Dust agents can interact with the local machine in a controlled way.

- **Quick Start**: register the provider via the extension API and use the extension's OAuth flow to sign in; the provider exposes Dust agents as models usable by pi.

- **Repository layout**: source lives under `src/`, tests under `test/`, and specs/docs remain at the repository root (`README.md`, `SPEC_TOOL_APPROVE_EXECUTION.md`, `SPEC_MCP_CONFIRM.md`).

- **Key features**: OAuth login (WorkOS device flow), agent listing per workspace, conversation lifecycle (create/post/fetch), SSE handling for incremental generation, MCP server registration and MCP request listener, local confirmation gating for tool execution.

- **MCP tools provided**: `bash` (run shell commands), `read` (read file contents with offset/limit), `edit` (replace an exact string in a file). Each tool returns structured content and an `isError` flag so the Dust server can surface results.

Overview
- The extension implements a Dust provider for the pi extension API. It exposes a `streamSimple` function compatible with pi's assistant streams and an `oauth` object that handles login, token refresh and model modification.

- `dust.ts` is now the session/runtime entrypoint. Auth, MCP, streaming, tool execution, validation and shared types are split into dedicated modules to keep the orchestration layer smaller and easier to maintain.

How it works
- On login the extension runs a WorkOS device-code flow, fetches available workspaces, asks the user to pick one and then fetches agent configurations for that workspace.
- Agents are mapped into provider `models` (slugified `id`, original `name`, `sId` preserved) so they appear in the model registry.
- When a user message is sent the extension: registers an MCP server (once per conversation session), posts the user message (creating a conversation if needed), then listens to Dust's SSE events to stream generation deltas and handle `tool_approve_execution` events.
- `tool_approve_execution` events trigger an on-device confirmation (or auto-approve for `never_ask`) and are also validated back to Dust with `/validate-action`. The MCP request listener receives `tools/call` and executes or denies the tool based on local or server-side approval.

Getting started (dev)
- Install dev tools (node, pnpm/npm/yarn) and run tests with Vitest. Example:
```bash
# install deps (if package.json exists in your workspace)
# npm install

# typecheck
npm run typecheck

# lint
npm run lint

# run tests
npm test

# run coverage
npm run coverage

# generate changelog
npm run changelog

# lint commit message from the last hook input
npm run commitlint -- .git/COMMIT_EDITMSG

# full local quality gate
npm run check

# full pre-push gate
npm run prepush
```

- The test suite is split by domain under `test/**/*.test.ts` and uses shared fixtures under `test/helpers/`. It verifies provider registration, login, token refresh, conversation lifecycle, MCP registration, approval flow, malformed SSE handling, chunked stream parsing and debug-log redaction. Current baseline: `124` passing tests.

Files to inspect
- `src/dust.ts`: entrypoint that wires runtime state, pi session lifecycle and the provider registration.
- `src/dust-auth.ts`: WorkOS device flow, token refresh, workspace/agent fetch helpers and Dust URL utilities.
- `src/dust-mcp.ts`: MCP register/heartbeat/listener logic.
- `src/dust-stream.ts`: Pi event stream implementation plus Dust SSE parsing/reconnect logic.
- `src/dust-tools.ts`: local MCP tool definitions and executors.
- `src/dust-types.ts` / `src/dust-validation.ts`: shared contracts and runtime payload validation helpers.
- `test/*.test.ts`: split unit/integration suites grouped by domain.
- `test/helpers/dust-fixtures.ts`: shared test fixtures for OAuth, SSE and stream setup.
- `SPEC_*.md`: various specification notes used by the project.

Development notes
- The extension sends these headers to Dust API calls that interact with the workspace: `User-Agent: Dust CLI` and `X-Dust-CLI-Version: 0.4.4` (see `DUST_HEADERS` in `dust-constants.ts`).
- Agent slugs are created with the `slugify` helper so model ids are stable and human-readable.
- MCP server state is kept per pi session and is re-registered when sessions switch or conversations are reset.
- For verbose local development, start `pi` with `--verbose`. If needed, `PI_DUST_DEBUG=1` remains available as a fallback. The extension will emit redacted debug traces to stderr for login, token refresh, conversation create/post/fetch, SSE events, MCP register/requests/results and workspace switching.
- Debug logs are also persisted to a default temp file automatically: `/tmp/pi-dust.log` on Linux. Set `PI_DUST_LOG_FILE` to override that path. Sensitive fields like `Authorization`, `access_token` and `refresh_token` are redacted before logging.
- Example:
```bash
pi --verbose
tail -f /tmp/pi-dust.log

PI_DUST_LOG_FILE=/path/to/custom-pi-dust.log pi --verbose
tail -f /path/to/custom-pi-dust.log
```

Security & privacy
- Tools that execute on the host are gated by a confirmation callback (`currentConfirmFn`) which the host wires to a UI confirm function during `session_switch`.
- The extension supports a server-side approval flow: Dust can send `tool_approve_execution` events; the extension posts the user's decision back to `/validate-action` and avoids a duplicate local prompt when Dust later sends the `tools/call` request.

Contributing
- Run the tests and add cases to the relevant file under `test/` when changing behavior. Follow the existing testing style: mock `fetch` responses, reuse fixtures from `test/helpers/dust-fixtures.ts`, and keep header/URL expectations explicit.
- Local git hooks are enforced with `simple-git-hooks`: `pre-commit` runs `npm run precommit`, `pre-push` runs `npm run prepush`, and `commit-msg` validates Conventional Commits through `commitlint`.
- Commit messages should follow Conventional Commits, for example: `feat(auth): refresh token before stream start` or `fix(ci): pass GitHub token to git-cliff`.
- The project now exposes a stronger quality gate locally and in CI: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run coverage`. GitHub Actions runs the standard gate from `.github/workflows/ci.yml`, while the local `pre-push` hook adds coverage before code leaves the workstation.

Contact / further work
- If you want new MCP tools, add them to `MCP_TOOLS` in `dust-tools.ts` and implement the corresponding executor there.
- For questions about behavior read the domain-focused tests under `test/` — they are intentionally thorough and explain the intended sequences of calls.
