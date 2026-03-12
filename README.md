**Dust Extension**
- A Pi extension that integrates the Dust.ai assistant platform (dust.tt) with the pi-coding-agent host. It registers a `dust` provider, implements OAuth login (WorkOS device flow), manages conversations, and exposes a small set of MCP tools (`bash`, `read`, `edit`) so Dust agents can interact with the local machine in a controlled way.

- **Quick Start**: register the provider via the extension API and use the extension's OAuth flow to sign in; the provider exposes Dust agents as models usable by pi.

- **Repository root files**: `dust.ts`, `dust.test.ts`, `SPEC_SKILLS.md`, `SPEC_TOOL_APPROVE_EXECUTION.md`, `SPEC_MCP_CONFIRM.md` — tests and implementation live together so you can iterate quickly.

- **Key features**: OAuth login (WorkOS device flow), agent listing per workspace, conversation lifecycle (create/post/fetch), SSE handling for incremental generation, MCP server registration and MCP request listener, local confirmation gating for tool execution.

- **MCP tools provided**: `bash` (run shell commands), `read` (read file contents with offset/limit), `edit` (replace an exact string in a file). Each tool returns structured content and an `isError` flag so the Dust server can surface results.

Overview
- The extension implements a Dust provider for the pi extension API. It exposes a `streamSimple` function compatible with pi's assistant streams and an `oauth` object that handles login, token refresh and model modification.

- The core implementation is in `dust.ts` — the file contains utilities for token handling, a re-entrant SSE reader for Dust events, an MCP server lifecycle (register, heartbeat, request listener), and the tool executors for `bash` / `read` / `edit`.

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

# run tests
npx vitest
```

- The test suite (`dust.test.ts`) contains extensive integration-style unit tests that mock `fetch` and SSE streams to verify provider registration, login, token refresh, conversation lifecycle, MCP registration and the approval flow.

Files to inspect
- `dust.ts`: main extension implementation and provider registration logic.
- `dust.test.ts`: complete unit/integration tests (Vitest) that document expected HTTP calls, headers and SSE behavior.
- `SPEC_*.md`: various specification notes used by the project.

Development notes
- The extension sends these headers to Dust API calls that interact with the workspace: `User-Agent: Dust CLI` and `X-Dust-CLI-Version: 0.4.4` (see `DUST_HEADERS` in `dust.ts`).
- Agent slugs are created with the `slugify` helper so model ids are stable and human-readable.
- MCP server state is kept per pi session and is re-registered when sessions switch or conversations are reset.

Security & privacy
- Tools that execute on the host are gated by a confirmation callback (`currentConfirmFn`) which the host wires to a UI confirm function during `session_switch`.
- The extension supports a server-side approval flow: Dust can send `tool_approve_execution` events; the extension posts the user's decision back to `/validate-action` and avoids a duplicate local prompt when Dust later sends the `tools/call` request.

Contributing
- Run the tests and add cases to `dust.test.ts` when changing behavior. Follow the existing testing style: mock `fetch` responses, use the SSE helpers in the test file, and ensure header/URL expectations remain explicit.

Contact / further work
- If you want new MCP tools, add them to `MCP_TOOLS` and implement an `execute*` helper (see `executeBash`, `executeRead`, `executeEdit`).
- For questions about behavior read the tests in `dust.test.ts` — they are intentionally thorough and explain the intended sequences of calls.
