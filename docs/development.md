# Development guide

This guide describes the expected development workflow for contributors.

## Local workflow

### Install dependencies

```bash
npm install
```

### Install hooks

```bash
npm run prepare
```

### Standard quality gate

```bash
npm run check
```

### Extended local gate before pushing

```bash
npm run prepush
```

This runs:

- `npm run typecheck`
- `npm run lint`
- `npm run coverage`

## Commit policy

The repository enforces Conventional Commits through the `commit-msg` hook.

Examples:

- `feat(auth): add token refresh fallback`
- `fix(stream): reconnect after tool call`
- `docs(readme): simplify onboarding links`
- `ci(repo): add release workflow`

## Project quality rules

When changing behavior:

- update or add tests in the appropriate domain suite under `test/`
- keep runtime validation explicit for external payloads
- prefer focused modules instead of growing `src/dust.ts`
- preserve explicit error reporting
- avoid silent fallbacks unless they are intentional and documented

## Where to add code

- auth logic -> `src/dust-auth.ts`
- stream parsing -> `src/dust-stream.ts`
- MCP transport -> `src/dust-mcp.ts`
- local tools -> `src/dust-tools.ts`
- runtime payload parsing -> `src/dust-validation.ts`
- cross-module contracts -> `src/dust-types.ts`
- orchestration and Pi wiring -> `src/dust.ts`

## Test layout

Tests are intentionally grouped by domain:

- `test/oauth.test.ts`
- `test/provider.test.ts`
- `test/session.test.ts`
- `test/mcp.test.ts`
- `test/stream.test.ts`
- `test/tool-approval.test.ts`
- `test/workspace.test.ts`
- `test/debug.test.ts`

Shared fixtures live in `test/helpers/dust-fixtures.ts`.

## Useful commands

```bash
npm run test:watch
npm run coverage
npm run changelog
npm run commitlint -- .git/COMMIT_EDITMSG
```

## Node.js versions

The CI matrix validates the project against:

- Node.js 20
- Node.js 22
- Node.js 24

Using one of these versions locally is recommended.
