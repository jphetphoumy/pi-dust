---
name: open-pr
description: Opens a GitHub pull request for the current branch in this repo, following the repo's fixed PR text structure (Summary / Validation / Checklist) and Conventional Commits title. Use when a feature or fix is ready to ship, typically at the end of the feature-loop skill once review is clean.
---

# Open PR

Opens a pull request for the current branch against `master`, with text that always follows this
repo's structure so PRs stay consistent regardless of which agent or loop produced them.

## Preconditions

Before opening the PR:

1. `git status` — working tree must be clean (everything committed). If not, stop and tell the
   user rather than committing on their behalf unless they've asked for that.
2. Run `just prepush` (typecheck + lint + coverage). This is the extended gate and must pass —
   don't substitute `just check` here.
3. Confirm the branch has a remote-trackable name and is pushed:
   `git rev-parse --abbrev-ref --symbolic-full-name @{u}` to check, `git push -u origin <branch>`
   if it isn't tracked yet.

If any precondition fails, fix it (or ask the user) before opening the PR — don't open a red PR.

## Gathering PR content

1. `git log master..HEAD` and `git diff master...HEAD` — read every commit in the branch, not just
   the latest, to understand the full scope.
2. Identify the originating issue/feature name from the branch (`feat/<name>`) or from context
   earlier in the conversation.

## PR title

Conventional Commits format, under 70 characters, e.g. `feat(dust-tools): add bash timeout guard`.
Match the type/scope conventions already used in `git log` (see `just changelog` / `cliff.toml`
for how types map to changelog sections).

## PR body

Always use the repo's template at `.github/pull_request_template.md` verbatim as the structure —
do not invent a different layout:

```markdown
## Summary

- describe the change
- explain why it is needed

## Validation

- [ ] `npm run check`
- [ ] `npm run prepush`

## Checklist

- [ ] tests added or updated when behavior changed
- [ ] documentation updated when needed
- [ ] commit history follows Conventional Commits
```

Fill it in, don't just paste it blank:

- **Summary** — 2-5 bullets max. What changed and why, from the commits and diff — not a
  restatement of every file touched.
- **Validation** — check off `npm run check` and `npm run prepush` only if you actually ran them
  successfully this session (you did, in Preconditions). Leave unchecked if you're unsure.
- **Checklist** — check each box only if genuinely true for this change (e.g. don't check "tests
  added or updated" if behavior changed but no test was touched — fix that first instead).

## Creating the PR

```bash
gh pr create --title "<type>(<scope>): <description>" --body "$(cat <<'EOF'
<filled-in template>
EOF
)"
```

Report the PR URL back to the user when done. Do not merge it — opening is as far as this skill
goes.
