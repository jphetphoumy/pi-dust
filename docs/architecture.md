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
- refuse a `tools/call` for a tool pi's active set no longer includes
  (`isToolActive`), ahead of the approval prompt and before any queued
  pre-approval is consumed — see the known limitation below

**Known limitation — the advertised catalogue is a turn-boundary snapshot, not live.**
Dust reads our MCP tool catalogue at most once per registration
(`tools/list`) and caches it for the whole run
(`listToolsForClientSideMCPServer`); it does not implement MCP's
`notifications/tools/list_changed`, so there is no in-band way to tell it the
catalogue moved. `dust-stream-provider.ts` compensates by diffing pi's active
tools (via `dust-tools.ts`'s `advertisedToolNames`) at the top of every turn
and re-registering (`runtime.clearMcpState()` + `ensureMcpServer`) when that
diff changes — see `DustSessionRuntime#toolCatalogueChanged`. The listener's
`getTools` closure also records what it actually just handed Dust
(`DustSessionRuntime#recordAdvertisedTools`), reconciling the baseline with
ground truth rather than trusting the diff's own prediction, since a
registration can happen (a lost heartbeat, a stale extension handle on the
triggering turn) at a moment the diff itself couldn't observe.

This staleness is advertisement-only, not a hole in enforcement: what a tool
call can actually *do* is gated independently and instantly, at the listener
(`isToolActive` in `dust-mcp.ts`'s `listenMcpRequests`, checked ahead of the
approval prompt and before any queued pre-approval is consumed) — so a
`setActiveTools` call mid-turn is authoritative for execution immediately,
even though Dust's own cached catalogue still lists the disabled tool until
the next re-registration. Tools registered by other pi extensions are still
never visible to Dust at all, because our catalogue only ever contains the
fixed set of pi built-ins this extension knows how to execute (routing
arbitrary pi tools through this bridge is tracked separately, issue #52).

### `src/dust-tools.ts`

Local tool catalog and executors.

Provided tools (pi's own built-ins, intersected with pi's currently active
tool set — see the limitation above):

- `bash`
- `read`
- `write` (create or overwrite — `edit` is substitution-only and cannot create)
- `edit`
- `grep`
- `find`
- `ls`

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
- the tool catalogue last advertised to Dust, so a change to pi's active
  tools forces exactly one re-registration (see the known limitation under
  `src/dust-mcp.ts`)

This runtime state is reset when sessions switch, credentials are invalidated,
or the extension needs to clear MCP state — which also happens when the MCP
server's registration is lost server-side, so the next turn re-registers
instead of advertising a server nothing is listening behind.

## Pod file sync

A Dust **Pod** (a `project`-kind space) mirrors the project into the agent's
sandbox, so the agent can read and write through Dust's internal `files__*`
tools instead of this extension's MCP tools. That is the whole point of the
feature: `files__*` calls are free, while any client-side MCP tool is billed at
3 AWU per call.

`/ingest` creates the pod and uploads the first selection; `src/dust-pod-sync.ts`
reconciles the two copies afterwards.

### What counts as a change

Detection is **watermark-based**, not timestamp-based. Each tracked file has a
`seen` entry holding the pod mtime and a content hash:

- **pod-changed** — the listing reports a newer `lastModifiedMs` than the watermark
- **local-changed** — the file hashes differently from the watermark

Comparing local mtimes against pod mtimes directly would be wrong: the two
clocks are unrelated, and writing a pulled file bumps the local mtime past the
pod's every time. When both sides moved, neither wins — the bytes are compared
first, and only a genuine difference is reported as a conflict and left alone.

### Sync points

Syncs are one-directional at each point, and best-effort: a failure is reported
but never fails the turn.

| When | Direction | Why |
|------|-----------|-----|
| before the turn | push | carry local edits made since the last turn |
| before `bash` | pull | a mid-turn `pytest`/build must see the agent's pod-side edits, not stale files |
| after `bash` | push | a command that *writes* — a scaffolder, codegen, `sed -i` — leaves files the pod has never seen |
| after the turn | pull | bring the agent's edits down to disk |

Only `bash` is bracketed. It is the one tool that runs on the real machine and
can move the tree behind the pod's back; `read`/`edit` already go through the
pod, and syncing around them would walk the whole tree for nothing on every
call.

The post-`bash` push runs **before the tool result is returned**, so the agent
only learns the command finished once the pod already holds everything it
produced. Without it, `ansible-galaxy role init myrole` would leave eight files
the pod could not see until the *next* turn, and the agent's immediate
`files__list` would come back empty — reading as if the command had failed. It
runs regardless of exit status, since a build that fails after emitting sources
still changed the tree.

### Selection, and how pathspecs narrow it

The push pass re-runs the same selection `/ingest` used
(`src/dust-pod-files.ts`), which is what lets files created after the ingest —
by the user or by a `bash` command — reach the pod at all. A plain filesystem
walk, with git consulted only for `.gitignore` when a repo happens to be there.

Excluded: hidden entries (which covers `.git` and, deliberately, `.env`),
dependency and build directories, files over 256 kB, and empty files — Dust
answers 400 `file_is_empty`, so `__init__.py` and `.gitkeep` are dropped rather
than failing the run.

**Pathspecs given to `/ingest` keep applying to every later sync.** `/ingest src`
is a deliberate narrowing, so a new top-level `myrole/` written afterwards
matches nothing and never reaches the pod. This is intended — silently widening
the selection would upload what the user chose to leave out — but it means a
project that expects to grow new top-level directories should be ingested
bare (`/ingest`, no pathspec).

**Directories exist only through their files.** The pod stores files, not a tree,
so a directory a scaffolder leaves empty (`myrole/files/`, `myrole/templates/`)
has nothing to upload and never appears in the pod. The pod instructions tell
the agent to create files at the path it wants; the directory follows.

Two paths are pod-owned and never pulled onto disk: `AGENTS.md` (a rendering of
the system prompt) and `skills/<name>/` (copies of the user's own skills).

### Browsing the pod: `/podfs`

`/podfs` shows the pod as a **tree**, even though the pod has none. Dust stores
flat canonical paths and no directory objects, so `src/dust-pod-tree.ts` folds
the listing into one — which means every folder-level action (tick it, pull it,
delete it) is really the file paths underneath it, resolved at the moment the key
is pressed.

The tree exists because the flat list made the common case impossible: pulling
`src/` back meant pressing `p` once per file, and there was no row that meant
"the folder".

| Key | Acts on |
|---|---|
| `space` | tick this row and everything under it |
| `a` | tick everything, or clear it when everything is ticked |
| `→` / `←` | open a folder; close it, or step out to the parent |
| `enter` | pull every ticked file |
| `p` | pull the focused row, folder or file |
| `d` | delete the focused row — a folder asks first, since it is many deletions behind one keypress |

Folders start **closed**, and nothing starts ticked. A pod mirrors a whole
project, so opening every folder is a wall of files to scroll before the
top-level shape — the thing the user is actually picking from — is even visible;
a closed folder still carries its rolled-up file count and total size, which is
what makes it pickable without opening it. Ticking nothing by default is the
matching caution: a pull overwrites whatever sits at that path locally, so the
user says which files rather than un-saying it.

Selection lives in the command, not the panel
(`ListPanelOptions.tree` in `src/dust-pod-list-panel.ts`). It has to: ticking a
folder ticks files a collapsed row is not showing, and those ticks must survive
the row list being rebuilt on every expand. So the panel reports intent — toggle,
expand — and the caller, which owns the tree and the selected-path set, decides
what it means and hands back new rows. It also follows that Enter cannot resolve
with "the ticked rows"; the panel's resolution only distinguishes Enter from Esc.

Pulls are sequential rather than concurrent. A folder pull can be hundreds of
files against a rate-limited API, and the slower loop is the one that finishes.
Every path is checked with `isPodPathSafe` before it is written — the listing is
untrusted input, since the agent writes it.

A folder delete needs a confirm dialog, and the dialog needs the panel out of
the way to be reachable, so the handler runs `openListPanel` in a loop rather
than once. `panel?.close()` resolves the open call with `undefined` — the same
value Esc produces — so on its own that would read as the user cancelling and
throw away whatever they had ticked. `dialogPending` is how the delete branch
tells the loop the difference: while it is set, the loop knows the panel came
down for a dialog, not because the user is done, and reopens the picker once
the dialog settles instead of returning. That promise is awaited twice — once
inline, since the action itself is dispatched as `void action.run(...)` and
nothing else observes its rejection, and once by the loop — so it must never
reject; every stage inside it that can throw (the confirm call, each file
delete, the watermark save, the tree refresh) gets its own try/catch that
reports what actually happened instead of letting the whole IIFE reject. The
reopened picker is not a fresh one: `pendingFocus`, recorded just before the
close, becomes `initialFocus` on the next `openListPanel` call, so the cursor
lands back near the folder that was just acted on rather than snapping to the
top of a list that may now be shorter.

### The `[DustSkills]` startup section

`src/dust-pod-skills-banner.ts` adds a `[DustSkills]` section under pi's startup
banner, listing the skills **the pod holds** — the ones the agent can actually
reach — with a tag only where something needs attention:

```text
[DustSkills]
  alpha-skill (stale), beta-skill
  Run /dust-skills sync to bring the pod up to date.
```

It answers a question pi's own `[Skills]` cannot: that list is what the *session*
discovered, whereas only the skills `/dust-skills` copied into the pod are
readable from the sandbox mount. Everything else is invisible to the agent, and
without this the only way to find out is to ask it and watch it fail.

An earlier version listed every local skill and tagged the unsynced ones
`(not-sync)`. It was dropped: with many skills and a small selection nearly every
entry carried a marker, burying the short list that mattered.

#### What "synced" is allowed to mean

`binding.skills` alone records a *selection*, not a state. It survives the pod
being cleared, files being deleted through `/podfs`, and — most commonly — the
skill being edited on disk afterwards, at which point the pod's copy silently
differs from the local one and the agent goes on reading the old version.

`binding.skillFingerprints` makes the claim checkable: `fingerprintSkill` digests
every file's name and bytes at sync time, and the section re-computes it to
classify each skill.

| State | Meaning |
|---|---|
| `synced` | local files hash to the recorded digest — the pod has this exact content |
| `stale` | they no longer do; the agent is reading instructions the user has changed |
| `unverified` | binding predates fingerprints, so there is nothing to compare — deliberately *not* reported as stale |

The check is entirely local, so it costs no network call at startup. It does not
detect pod-side deletion; only a listing would, which belongs in `/dust-skills`
rather than in session start.

`/dust-skills sync` re-uploads the recorded selection without reopening the
picker — the selection is not what changed — refreshes the fingerprints, drops
any skill that has gone from disk, and clears `agentsMdHash` so the instructions
are rewritten.

#### Adopting a skill the agent wrote

The agent can create a skill for itself by writing `skills/<name>/SKILL.md` into
the pod. Pulled as an ordinary file that lands at `<root>/skills/<name>/`, which
**pi does not scan** — pi looks in `~/.agents/skills`, `~/.pi/agent/skills`,
`<root>/.agents/skills` and `<root>/.pi/skills`. The skill would sit on disk
completely inert and leave a stray `skills/` directory in the project root.

`detectAdoptableSkills` spots these subtrees during a pull and diverts them to
**`<root>/.pi/skills/<name>/`** — pi's *project* skill directory, never
`~/.pi/agent/skills`. A skill that came out of one pod belongs to the project
bound to it; installing it globally would leak it into every other project on
the machine.

Adoption also registers the skill: it joins `binding.skills`, gets a fingerprint,
and clears `agentsMdHash`. Without that, pi would discover the skill on disk
while AGENTS.md kept omitting it — the agent would have authored a skill it
cannot see — and the next sync would treat the pod's copy as an untracked file
all over again. Once registered it is pod-owned, so it is adopted exactly once.

Because `skills/` is a plausible project directory, the bar for claiming a
subtree is deliberately high. All three must hold:

- it carries a `SKILL.md` — otherwise it is just files that happen to live there;
- nothing in it is tracked in `seen` — that would make it the user's own content;
- nothing in it already exists locally — same reason.

Getting this wrong would divert a user's source tree into their config directory.

Adoption happens on **pull only**: the pre-turn push has no business writing into
the project's config directory, and the agent's output arrives on the post-turn
pull anyway. Each adopted skill is reported by name with its destination rather
than folded into a counter — it changes what pi loads next session, not just
what is on disk. pi's own "Trust project folder?" prompt then gates the first
load, since `.pi/` now exists.

pi's startup listing is a fixed set of sections built by its interactive mode —
`resources_discover` contributes *paths* to the existing Skills/Prompts/Themes
lists but cannot add a named section — so this renders as a transcript entry
appended at session start, which lands directly under the banner.

Three details worth keeping:

- The list is driven from the skills **on disk**, paired against `binding.skills`.
  The binding records the last selection, not a live view, so a skill deleted
  since would otherwise be reported as available to the agent.
- It is appended only when the transcript starts empty (`startup`, `new`, or no
  reason at all from older pi). `/resume` and `/fork` restore a transcript that
  already carries the section.
- The theme's `fg` must be called **as a method**. pi's implementation reads
  `this.fgColors`, so a detached `const fg = theme.fg` throws and the section
  renders as "renderer failed" instead of as itself.

### Upload concurrency and Dust's rate limit

One upload is up to four round trips — delete (best effort), reserve, PUT, and a
move when the file did not land at its final path — so a sequential ingest of a
scaffolded tree spends nearly all its wall clock idle on the network. Uploads
therefore run through a bounded worker pool, `POD_UPLOAD_CONCURRENCY` (4), shared
by `/ingest` and by the push pass.

The ceiling is deliberately low. Dust rate-limits the reserve step —
`POST /api/w/{wId}/files` — to **40 per 60 seconds per workspace**, as a sliding
window, commented "Aggressively rate limit file uploads". A wider pool buys
little and costs a burst that spends the whole window at once, then stalls.

Note the mismatch: `MAX_INGEST_FILES` is 500, so a large ingest is well over that
budget even sequentially. In practice the limit does not currently fire — the
limiter returns `0` when it blocks, and that route tests `remaining < 0`, so the
429 is unreachable (other Dust routes use `<= 0`). Treat that as an accident, not
a guarantee: it is one character from being enforced.

`request()` in `src/dust-pod.ts` therefore retries a 429 with backoff, preferring
the server's `Retry-After` over its own schedule, and gives up after four tries —
by which point it has waited out more than the whole window, so anything still
refused is not a burst. Retrying at the request layer covers every limited
endpoint at once. Without it a 429 would surface as a per-file `skipped`, which
reads as a permanent rejection by the pod when waiting a second would have
worked.

Three invariants survive the concurrency:

- **Progress counts completions, not dispatches.** A counter incremented when
  work is queued would race the footer to n/n while uploads were still in flight.
- **Results are reported in input order**, collected by index rather than as they
  land, so the transcript and the tests stay deterministic.
- **A dead session aborts the run, but records what landed.** No further uploads
  start, the in-flight ones are allowed to settle rather than being cancelled
  mid-request, and the watermarks of files that genuinely reached the pod are
  saved before the error propagates. Dropping them would leave watermark-less
  files present on both sides — which read as changed-on-both-sides, reporting
  the entire project as conflicted on the next sync.

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
  dust-ceiling.ts
  dust-constants.ts
  dust-credits.ts
  dust-debug.ts
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
- workspace behavior
- credit status panel: fetching, caching, tabs and rendering
- debug logging and redaction
