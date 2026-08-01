---
name: feature-loop
description: Drives a feature or bugfix to completion inside a `just feature` worktree — Opus plans, Sonnet (this session) implements, Opus reviews, repeating until the reviewer has nothing left to say. Then hands off to the open-pr skill. Use when the user says to work a feature/issue end-to-end, "run the loop", or asks to plan+implement+review a change in this repo.
---

# Feature Loop

Runs inside the `claude --permission-mode auto` pane that `just feature <name>` starts in a
worktree (`../pi-dust-worktrees/<name>` on branch `feat/<name>`). Drives a single feature or bug
through plan → implement → review cycles until an Opus reviewer approves with zero findings, then
opens the PR via the `open-pr` skill.

Division of labor:

- **Plan** — delegate to an Opus agent. Never write the plan yourself.
- **Implement** — done by *this* session directly (do not delegate implementation to a subagent;
  you are already the coding agent in the pane).
- **Review** — delegate to an Opus agent, on every round, even the first. Never self-review.

## Workflow

1. **Confirm the target.** If not already clear from context, ask the user (or read the issue
   referenced by the worktree/branch name) what the feature or bug is. Read `CLAUDE.md` for
   project conventions before planning.

2. **Plan (Opus).** Call the `Agent` tool with `subagent_type: "Plan"` and `model: "opus"`. Give it
   the full feature/bug description, relevant file paths you already know about, and a reminder to
   follow this repo's module boundaries (see the module table in `CLAUDE.md`) and conventions
   (Conventional Commits, `just check`/`just prepush` gates, tests mirrored under `test/`). Ask for
   a concrete step-by-step plan naming the files to touch. Run this in the foreground
   (`run_in_background: false`) since you need the plan before implementing.

3. **Implement (this session, Sonnet).** Turn the plan into `TaskCreate` tasks and implement them
   yourself, step by step, marking each complete as you go. Follow the plan; if you must deviate
   materially, note why (the reviewer will see the diff, not your reasoning). After implementing:
   - Run `just check` (typecheck + lint + test) and fix failures before moving on.
   - Do not run `just prepush` every round — save the coverage gate for just before opening the PR.

4. **Review (Opus).** Once `just check` is green and the round's planned work is done, call `Agent`
   with `subagent_type: "code-reviewer"` (defined in `.claude/agents/code-reviewer.md`, already
   pinned to `model: opus` with read-only tools). Give it:
   - The diff scope: `git diff master...HEAD` (or `git diff` for uncommitted work) in the worktree.
   - The original feature/bug description and the plan from step 2, so it can judge fidelity, not
     just style.
   - Explicit instruction to report findings as a list, or an explicit empty list if there is
     nothing to raise — you need an unambiguous signal to end the loop.

   Run this in the foreground; you need the verdict before deciding whether to loop.

5. **Branch on the review result.**
   - **Findings exist:** treat them as the next round's plan input. You may go straight back to
     step 3 for small/mechanical fixes, but for anything non-trivial or that changes the approach,
     loop back to step 2 (Opus re-plans incorporating the findings) to keep planning and
     implementing separated. Then re-run step 4. Repeat.
   - **No findings:** the loop is done. Move to step 6.

6. **Hand off to PR.** Invoke the `open-pr` skill to open the pull request. Do not open the PR
   yourself outside that skill — it enforces the repo's PR text structure.

## Guardrails

- Never skip the review round, including the first one — "looks done to me" is not a substitute
  for an Opus pass.
- Never let the implementing session mark its own work as reviewed.
- If `just check` won't go green after a reasonable number of attempts, stop and surface the
  blocker to the user rather than looping indefinitely.
- Keep review agents scoped to the diff plus enough surrounding context to judge it — don't dump
  the whole repo into the prompt.
