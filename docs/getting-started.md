# Getting started

This guide explains what `pi-dust` is, what it does, and how to work with it
locally.

## Purpose

`pi-dust` is a Pi extension that makes Dust agents available inside the Pi
coding agent host. The extension is responsible for:

- authenticating the user with WorkOS device login
- listing available Dust workspaces and agents
- exposing Dust agents as Pi-selectable models
- streaming assistant responses back to Pi
- handling MCP tool execution with user confirmation

## Prerequisites

- Node.js compatible with the project CI matrix: `20`, `22`, or `24`
- `npm`
- access to a Dust workspace
- access to a Pi host that loads this extension

## Install dependencies

```bash
npm install
```

## Install local git hooks

```bash
npm run prepare
```

This installs:

- `pre-commit` -> `npm run precommit`
- `pre-push` -> `npm run prepush`
- `commit-msg` -> Conventional Commit validation with `commitlint`

## Run the local quality gate

```bash
npm run check
```

This runs:

- TypeScript type-checking
- ESLint
- the Vitest suite

## Run coverage

```bash
npm run coverage
```

## Main development commands

```bash
npm test
npm run test:watch
npm run lint
npm run typecheck
npm run changelog
```

## Repository structure

```text
src/        Production code
test/       Tests split by domain
docs/       User, developer, and maintenance documentation
.github/    CI, coverage, changelog, release, Dependabot
```

## Where to go next

- Read [Architecture](architecture.md) to understand the module boundaries
- Read [Development guide](development.md) for daily workflow rules
- Read [Debugging guide](debugging.md) if you need traces or auth diagnostics
