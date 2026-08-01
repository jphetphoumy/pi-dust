set shell := ["bash", "-c"]

npm := "npm"

blue  := '\033[34m'
cyan  := '\033[36m'
green := '\033[32m'
yell  := '\033[33m'
red   := '\033[31m'
bold  := '\033[1m'
reset := '\033[0m'

box_h   := "──────────────────────────────────────────────────────"
box_top := "╭" + box_h + "╮"
box_mid := "├" + box_h + "┤"
box_bot := "╰" + box_h + "╯"

# Display available targets
default:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ 📚  Available targets\n{{box_mid}}{{reset}}\n"
    @just --list --list-heading=''
    @printf "{{bold}}{{blue}}{{box_bot}}{{reset}}\n"

# Install npm dependencies
install:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Installing project dependencies\n{{box_bot}}{{reset}}\n"
    {{npm}} install --include=dev
    @printf "{{green}}✅  Dependencies installed.{{reset}}\n"

# Install local git hooks
hooks:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Installing local git hooks\n{{box_bot}}{{reset}}\n"
    {{npm}} run prepare
    @printf "{{green}}✅  Git hooks installed.{{reset}}\n"

# Setup dependencies and local hooks
setup-dev: install hooks
    @printf "{{green}}✅  Development environment is ready.{{reset}}\n"

# Run ESLint
lint:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running lint checks\n{{box_bot}}{{reset}}\n"
    {{npm}} run lint
    @printf "{{green}}✅  Lint checks passed.{{reset}}\n"

# Run TypeScript type-checking
typecheck:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running TypeScript checks\n{{box_bot}}{{reset}}\n"
    {{npm}} run typecheck
    @printf "{{green}}✅  TypeScript checks passed.{{reset}}\n"

# Run the Vitest suite
test:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running tests\n{{box_bot}}{{reset}}\n"
    {{npm}} test
    @printf "{{green}}✅  Tests passed.{{reset}}\n"

# Run Vitest in watch mode
test-watch:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Starting test watch mode\n{{box_bot}}{{reset}}\n"
    {{npm}} run test:watch

# Run coverage reports
coverage:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running coverage\n{{box_bot}}{{reset}}\n"
    {{npm}} run coverage
    @printf "{{green}}✅  Coverage completed.{{reset}}\n"

# Run the standard quality gate
check:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running standard quality gate\n{{box_bot}}{{reset}}\n"
    {{npm}} run check
    @printf "{{green}}✅  Quality gate passed.{{reset}}\n"

# Run the extended pre-push gate
prepush:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Running extended pre-push gate\n{{box_bot}}{{reset}}\n"
    {{npm}} run prepush
    @printf "{{green}}✅  Pre-push checks passed.{{reset}}\n"

# Generate CHANGELOG.md
changelog:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Generating changelog\n{{box_bot}}{{reset}}\n"
    {{npm}} run changelog
    @printf "{{green}}✅  Changelog generated.{{reset}}\n"

# Lint the current commit message file
commitlint:
    #!/usr/bin/env bash
    if [ ! -f .git/COMMIT_EDITMSG ]; then
        printf "{{bold}}{{red}}❌  .git/COMMIT_EDITMSG was not found. Create a commit message first.{{reset}}\n"
        exit 1
    fi
    printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Linting current commit message\n{{box_bot}}{{reset}}\n"
    {{npm}} run commitlint -- .git/COMMIT_EDITMSG
    printf "{{green}}✅  Commit message is valid.{{reset}}\n"

# Remove generated local artifacts
clean:
    @printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Cleaning generated artifacts\n{{box_bot}}{{reset}}\n"
    rm -rf coverage RELEASE_NOTES.md
    @printf "{{yell}}⚠️  Removed coverage/ and RELEASE_NOTES.md if they existed.{{reset}}\n"

worktrees_dir := justfile_directory() + "/../pi-dust-worktrees"
herdr_state_dir := justfile_directory() + "/.herdr-workspaces"

# Create a worktree + branch for a new feature and open it as a herdr workspace
feature name:
    #!/usr/bin/env bash
    set -euo pipefail
    printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Setting up feature '{{name}}'\n{{box_bot}}{{reset}}\n"
    branch="feat/{{name}}"
    worktree_dir="{{worktrees_dir}}/{{name}}"
    if [ -e "$worktree_dir" ]; then
        printf "{{bold}}{{red}}❌  $worktree_dir already exists.{{reset}}\n"
        exit 1
    fi
    mkdir -p "{{worktrees_dir}}" "{{herdr_state_dir}}"
    git -C "{{justfile_directory()}}" fetch origin master
    git -C "{{justfile_directory()}}" worktree add -b "$branch" "$worktree_dir" origin/master
    printf "{{green}}✅  Worktree created at $worktree_dir on branch $branch.{{reset}}\n"
    response=$(herdr workspace create --cwd "$worktree_dir" --label "{{name}}")
    workspace_id=$(printf '%s' "$response" | grep -oP '"workspace_id":"\K[^"]+' | head -n1)
    root_pane=$(printf '%s' "$response" | grep -oP '"pane_id":"\K[^"]+' | head -n1)
    if [ -z "$workspace_id" ] || [ -z "$root_pane" ]; then
        printf "{{yell}}⚠️  Worktree created, but could not parse herdr workspace/pane id from: $response{{reset}}\n"
        exit 0
    fi
    printf '%s' "$workspace_id" > "{{herdr_state_dir}}/{{name}}"
    printf "{{green}}✅  herdr workspace '{{name}}' ($workspace_id) is ready.{{reset}}\n"
    herdr pane run "$root_pane" "claude --permission-mode auto"
    printf "{{green}}✅  Started claude (auto mode) in $root_pane.{{reset}}\n"
    hunk_tab=$(herdr tab create --workspace "$workspace_id" --label hunk)
    hunk_pane=$(printf '%s' "$hunk_tab" | grep -oP '"pane_id":"\K[^"]+' | head -n1)
    if [ -n "$hunk_pane" ]; then
        herdr pane run "$hunk_pane" "hunk diff master --watch"
        printf "{{green}}✅  Started hunk diff (vs master) in $hunk_pane.{{reset}}\n"
    else
        printf "{{yell}}⚠️  Could not parse hunk tab pane id from: $hunk_tab{{reset}}\n"
    fi

# Delete a feature's worktree, branch, and herdr workspace
delete name:
    #!/usr/bin/env bash
    set -euo pipefail
    printf "{{bold}}{{blue}}{{box_top}}\n│ ▶️  Deleting feature '{{name}}'\n{{box_bot}}{{reset}}\n"
    branch="feat/{{name}}"
    worktree_dir="{{worktrees_dir}}/{{name}}"
    workspace_file="{{herdr_state_dir}}/{{name}}"
    if [ -f "$workspace_file" ]; then
        workspace_id=$(cat "$workspace_file")
        herdr workspace close "$workspace_id" 2>/dev/null && \
            printf "{{green}}✅  Closed herdr workspace $workspace_id.{{reset}}\n" || \
            printf "{{yell}}⚠️  Could not close herdr workspace $workspace_id (already closed?).{{reset}}\n"
        rm -f "$workspace_file"
    else
        printf "{{yell}}⚠️  No tracked herdr workspace for '{{name}}'.{{reset}}\n"
    fi
    if [ -d "$worktree_dir" ]; then
        git -C "{{justfile_directory()}}" worktree remove "$worktree_dir" --force
        printf "{{green}}✅  Removed worktree $worktree_dir.{{reset}}\n"
    else
        printf "{{yell}}⚠️  No worktree found at $worktree_dir.{{reset}}\n"
    fi
    if git -C "{{justfile_directory()}}" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "{{justfile_directory()}}" branch -D "$branch"
        printf "{{green}}✅  Deleted branch $branch.{{reset}}\n"
    else
        printf "{{yell}}⚠️  Branch $branch not found locally.{{reset}}\n"
    fi
