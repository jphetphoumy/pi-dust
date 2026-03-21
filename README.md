[![CI](https://github.com/jphetphoumy/pi-dust/actions/workflows/ci.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/ci.yml)
[![Coverage](https://github.com/jphetphoumy/pi-dust/actions/workflows/coverage.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/coverage.yml)
[![Release](https://github.com/jphetphoumy/pi-dust/actions/workflows/release.yml/badge.svg)](https://github.com/jphetphoumy/pi-dust/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/jphetphoumy/pi-dust?display_name=tag)](https://github.com/jphetphoumy/pi-dust/releases)

# pi-dust

`pi-dust` is a Pi extension that connects the Dust platform (`dust.tt`) to the
Pi coding agent runtime. It registers a `dust` provider, handles the WorkOS
device login flow, streams Dust conversations into Pi, and exposes a small MCP
tool bridge (`bash`, `read`, `edit`) with local approval.

## What you get

- OAuth login with workspace selection
- Dust agents exposed as Pi models
- Conversation reuse across turns
- SSE streaming with tool approval support
- Local quality gates: lint, typecheck, tests, coverage
- CI, changelog, release automation, Dependabot, and git hooks

## Quick start

```bash
npm install
npm run prepare
npm run check
```

For verbose development:

```bash
pi --verbose
tail -f /tmp/pi-dust.log
```

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Debugging guide](docs/debugging.md)
- [Release and maintenance](docs/release.md)
- [Historical specs](docs/specs/README.md)

## Repository layout

```text
.
├── docs/        Project documentation and historical specs
├── src/         Extension source code
├── test/        Domain-focused test suites
└── .github/     CI, release and repository automation
```

## Core commands

```bash
npm run check
npm run coverage
npm run changelog
npm run prepush
```
