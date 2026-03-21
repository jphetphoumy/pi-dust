# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-21

### 🚀 Features

- Implement tool_approve_execution server-side approval flow - ([74daebe](https://github.com/jphetphoumy/pi-dust/commit/74daebe553da199dee1fd83a632c0bdf7e0a6662))
- Show allow/deny confirm prompt before MCP tool execution - ([8f0b422](https://github.com/jphetphoumy/pi-dust/commit/8f0b422f4df9d3f292ecd1aba376c134a54c36a9))
- Implement MCP tool bridge (bash, read, edit) for Dust agent - ([8245350](https://github.com/jphetphoumy/pi-dust/commit/8245350cfe8386aaea36605d487b97e705bccd00))
- Implement real streamSimple using PiEventStream (push-based, not generator) - ([b997ca9](https://github.com/jphetphoumy/pi-dust/commit/b997ca9fe866822988b242e1a6fc72c2006daa32))
- Fetch fresh agents on session_start to include user-created agents - ([986f00a](https://github.com/jphetphoumy/pi-dust/commit/986f00aa4f71faaa5f2ed9161148e1cd9dfaa488))

### 🐛 Bug Fixes

- *(runtime)* Add exponential retry backoff - ([e4d7f26](https://github.com/jphetphoumy/pi-dust/commit/e4d7f264722296c56ce83dd73600087581f50a44))
- *(security)* Harden local file tools - ([b61f729](https://github.com/jphetphoumy/pi-dust/commit/b61f729144b1a845e1b8a504b82beab18ff6695b))
- *(startup)* Restore Dust models before session init - ([617d49a](https://github.com/jphetphoumy/pi-dust/commit/617d49a5523c31a635eb516544ef81c1e2d21840))
- Handle MCP initialize handshake so agent discovers tools - ([bf3fb9d](https://github.com/jphetphoumy/pi-dust/commit/bf3fb9d2ca7ce87b25a60d4c851e27e111a27075))
- Reconnect MCP requests SSE listener in a loop so agent sees tools across turns - ([b66e59e](https://github.com/jphetphoumy/pi-dust/commit/b66e59eb61b652574e09709919a14424377f06ae))
- Pass clientSideMCPServerIds in message context so Dust agent sees our tools - ([3ef01ac](https://github.com/jphetphoumy/pi-dust/commit/3ef01acc9591810f2687c1e1710fed66ea8ef5e7))
- Proactively refresh expired token before each dustRealStream call - ([9adeb61](https://github.com/jphetphoumy/pi-dust/commit/9adeb61b1ab15d0d0bbf99a01b966fee6abbdc78))
- Use dynamic session context so resume persists to the right session file - ([671796d](https://github.com/jphetphoumy/pi-dust/commit/671796d562780b3377ab51b1dfe55275ef2dbc98))
- Preserve Dust conversation across session resume - ([8a88cb5](https://github.com/jphetphoumy/pi-dust/commit/8a88cb5d1896faf9d2e1b954fb0f0ed1c54e00af))
- Reset Dust conversation on session_switch (/new) - ([d742636](https://github.com/jphetphoumy/pi-dust/commit/d7426365edbfdc303249e25912d8468a3011e432))
- Close over cred in streamSimple; extract userText from content block arrays - ([954717c](https://github.com/jphetphoumy/pi-dust/commit/954717c95bd47ef5cfb9dee48c37a7f23542ac2b))

### 💼 Other

- Match dust-cli exactly: omit Dust CLI headers from /me call

The dust-cli SDK's me() method only sends Authorization + Content-Type,
not User-Agent or X-Dust-CLI-Version. Align our /me fetch to match. - ([15128aa](https://github.com/jphetphoumy/pi-dust/commit/15128aaea3d2da74e6402ece6dfc9883f33c358a))
- Show agent name in model selector via slug id; refresh token on session_start

- slugify() converts agent names (e.g. AgentSonnet → agent-sonnet) for use as
  model id so the /model selector shows human-readable names instead of opaque sIds
- sId field preserved on each model object for future API call use
- session_start now refreshes an expired access token before fetching agents,
  fixing the root cause of private agents not appearing after a long idle period
- fetchAgents() logs errors to console.error instead of silently swallowing them
- HTTP headers confirmed identical to dust-cli: User-Agent 'Dust CLI' +
  X-Dust-CLI-Version '0.4.4' on all Dust API calls
- 47 tests passing - ([11cd2cb](https://github.com/jphetphoumy/pi-dust/commit/11cd2cbe723cb5f18660a84af97052d891afa776))
- Dust extension with OAuth login, workspace switching, and mock streamSimple - ([6573ba3](https://github.com/jphetphoumy/pi-dust/commit/6573ba3cf15e19e30b3ae5bd2b6d42dff332744c))

### 🚜 Refactor

- *(entrypoint)* Split dust orchestration modules - ([bdb15b8](https://github.com/jphetphoumy/pi-dust/commit/bdb15b8d70e9b5a91fef291af8d01c574e10b7d8))
- *(project)* Reorganize source tree and quality tooling - ([c6bfeed](https://github.com/jphetphoumy/pi-dust/commit/c6bfeedad9b74e5aa2b6adf2986b760d048b5067))
- *(session)* Encapsulate runtime state management - ([1edaa37](https://github.com/jphetphoumy/pi-dust/commit/1edaa374acb6aec0e8530b1a60115377da52665a))

### 📚 Documentation

- *(dev)* Add makefile shortcuts and nix workflow - ([66c1941](https://github.com/jphetphoumy/pi-dust/commit/66c194103613962d6b597458824c5a17d42a83ee))
- *(repo)* Reorganize documentation structure - ([bf176ba](https://github.com/jphetphoumy/pi-dust/commit/bf176bad8a6f1fc2a9e39042154a850cbe8c85c3))
- Add README describing Dust extension, usage, MCP tools and dev notes - ([27f4080](https://github.com/jphetphoumy/pi-dust/commit/27f408071848e9e34aceeec8710d253e60fb75d3))

### 🧪 Testing

- *(coverage)* Improve vitest coverage baselines - ([01fe9fa](https://github.com/jphetphoumy/pi-dust/commit/01fe9faa3fd81a42c0af997310d6f3e5b8982a9c))
- *(runtime)* Cover runtime state helpers - ([a29e9f5](https://github.com/jphetphoumy/pi-dust/commit/a29e9f554f0802446475af3f5461943908e7a237))
- *(runtime)* Cover MCP and tool error paths - ([5d04eaa](https://github.com/jphetphoumy/pi-dust/commit/5d04eaaba321cc3a4f4ab5ee9f63585e1bc13823))

### ⚙️ Miscellaneous Tasks

- *(package)* Sync package metadata - ([4c3f942](https://github.com/jphetphoumy/pi-dust/commit/4c3f9429735e899934f3a18604179afa90f3cebf))
- *(release)* Validate version and release notes - ([8dec9a9](https://github.com/jphetphoumy/pi-dust/commit/8dec9a9be2e8b39c0005a69f0d20a393c10ce6de))
- *(repo)* Finalize environment updates - ([094a62e](https://github.com/jphetphoumy/pi-dust/commit/094a62e4451b230073cc70dfd1b8d28a19626ef7))
- *(repo)* Add community health standards - ([42c5ad7](https://github.com/jphetphoumy/pi-dust/commit/42c5ad7bbe5e6c00854ba6857685ba68e56531f7))
- *(repo)* Add release automation and governance - ([ae9de65](https://github.com/jphetphoumy/pi-dust/commit/ae9de659a6894c942f0b2f59ee167cb20f4a05c2))
- *(workflows)* Harden github actions pipeline - ([ba0577c](https://github.com/jphetphoumy/pi-dust/commit/ba0577c96968bc0626325ad780f5f4ad485cc4d0))

## New Contributors ❤️

* @jphetphoumy made their first contribution


<!-- generated by git-cliff -->
