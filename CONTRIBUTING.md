# Contributing

Thanks for contributing to `pi-dust`.

## Before you start

- read [`README.md`](README.md) for the project overview and quick start
- read [`CLAUDE.md`](CLAUDE.md) for the architecture and module reference if your change touches core behavior

## Setup

```bash
npm install
npm run prepare
```

## Required checks

Before opening a pull request:

```bash
npm run check
npm run prepush
```

## Commit style

This repository enforces Conventional Commits.

Examples:

- `feat(auth): add token expiry fallback`
- `fix(stream): reconnect after tool call`
- `docs(readme): simplify onboarding`
- `ci(repo): harden release workflow`

## Testing expectations

- add or update tests in the relevant file under `test/`
- reuse helpers from `test/helpers/dust-fixtures.ts`
- keep assertions explicit around headers, URLs, and payloads

## Pull request expectations

- keep changes focused
- explain user-visible behavior changes clearly
- include tests for code changes
- update documentation when behavior or workflow changes

## Security

Please do not disclose security issues in public issues first. See
[`SECURITY.md`](SECURITY.md).
