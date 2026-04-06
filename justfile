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
