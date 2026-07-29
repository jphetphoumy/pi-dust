# Subagents

A subagent lets the Dust agent driving your session delegate a task to another
Dust agent running in its own process, with its own context window. The parent
sees only the subagent's final answer, so wide exploration no longer costs the
conversation its context.

## How it works

`subagent` is advertised to Dust in the same `tools/list` response as `bash`,
`read` and the rest (see [architecture](architecture.md)). When Dust calls it,
the extension spawns a child:

```
pi --mode json -p --no-session --model dust/<agent-slug> \
   --tools <granted> --append-system-prompt <tmpfile>
```

The task itself is written to the child's **stdin**, not passed as a positional
argument: `pi -p` waits on stdin regardless, so a positional prompt makes the
child hang without ever producing output.

The child loads pi-dust itself, picks up the same credentials from
`dust-state.json`, and opens its own MCP bridge to Dust. `--no-session` means it
has no session file, so it cannot reattach to the parent's Dust conversation —
each subagent starts a fresh one.

The child's NDJSON output is parsed back into a final answer plus usage totals.
A finished turn — an assistant message whose `stopReason` is not a tool call — is
what ends the run, because a child running pi-dust never exits on its own: its
MCP heartbeat timer and SSE listener keep the event loop alive long after the
answer is in. Once the turn is done the child is stopped with `SIGTERM`, then
`SIGKILL` after five seconds. Aborting the parent's turn kills every live child
the same way.

## Defining agents

An agent is a markdown file with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon; returns a compressed map, not raw file dumps
tools: read, grep, find, ls
model: my-fast-dust-agent
---

You are a scout. ...
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | How Dust refers to the agent |
| `description` | yes | Shown to Dust in the tool description; this is what it picks from |
| `tools` | no | Tools the subagent may use. Omit for all of them |
| `model` | no | **A Dust agent slug**, not a pi model id. Omit to inherit the parent session's Dust agent |

`model` is the slug the provider registers, i.e. the agent name lowercased and
hyphenated — the Dust agent "Code Scout" is `code-scout`. Run `/workspace` to
see which agents your workspace exposes. A slug the workspace does not expose is
rejected with the available list.

Files without both `name` and `description` are skipped.

## Installing the samples

`examples/agents/` and `examples/prompts/` hold ready-made definitions. The
sample agents omit `model`, so they inherit whichever Dust agent is driving the
session; set `model` on `scout` if your workspace has a cheaper, faster agent
worth delegating recon to.

```bash
mkdir -p ~/.pi/agent/agents ~/.pi/agent/prompts
cp examples/agents/*.md ~/.pi/agent/agents/
cp examples/prompts/*.md ~/.pi/agent/prompts/
```

The prompts register as `/implement`, `/scout-and-plan` and
`/implement-and-review`.

## Modes

| Mode | Parameters | Behaviour |
|---|---|---|
| single | `{ agent, task, cwd? }` | One agent, one task |
| parallel | `{ tasks: [{ agent, task, cwd? }] }` | Concurrent; max 8 tasks, 4 at a time, 50 KiB of output per task |
| chain | `{ chain: [{ agent, task, cwd? }] }` | Sequential; `{previous}` in a task is replaced with the prior step's output. Stops at the first failure |

Exactly one mode per call.

## Agent scope and trust

By default only **user agents** in `~/.pi/agent/agents` are loaded.

Project agents in `.pi/agents/` are repo-controlled prompts that can instruct a
model to run bash, so they are opt-in: Dust must pass `agentScope: "project"` or
`"both"`. Under `"both"`, a project agent shadows a user agent of the same name.
Only enable this for repositories you trust.

## What constrains a subagent

A subagent runs headless. With no TUI there is no approval dialog, so the
extension's confirm gate auto-approves inside the child — everything the child
is *able* to call, it can call unattended. Two mechanisms bound that, and both
are applied when the catalogue is built, so the child never sees a tool it would
only be refused:

- **`tools:` in the agent file.** Passed to the child both as pi's `--tools`
  flag (for its native tools) and as `PI_DUST_SUBAGENT_TOOLS` (for the MCP
  bridge, which `--tools` does not reach). Grant `scout` read-only tools and it
  cannot write, whatever it is asked to do.
- **Depth.** The child carries `PI_DUST_SUBAGENT_DEPTH=1`, which withholds
  `subagent` from its own catalogue. Subagents cannot spawn subagents.

`subagent` itself is **never** gated, in either direction. The parent is not
prompted before delegating, and the child is not prompted before using the tools
it was granted — there is nobody at the child's terminal to ask, and a prompt
there is simply a denial with extra steps.

That places the whole trust decision on the agent file. `tools:` is the control
surface: grant `scout` read-only tools and it cannot write no matter what it is
asked to do. An agent with no `tools:` line inherits everything, `bash`
included, and will use it unattended. Write agent files accordingly, and keep
project-local agents opt-in.

## Cost

Every subagent is a Dust agent and consumes credits. A parallel call with eight
tasks is eight concurrent Dust conversations. `/status` shows the totals; each
subagent result also reports its own token and context usage.
