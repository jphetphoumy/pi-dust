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
- `/status` credit panel: seat credits, spend cap, reset date, and a 30-day breakdown
- Local quality gates: lint, typecheck, tests, coverage
- CI, changelog, release automation, Dependabot, and git hooks

## Requirements

| Requirement | Version |
|-------------|---------|
| Pi (`pi` CLI) | `0.82.x` (tested with `0.82.0`) |
| `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` | `^0.82.1` |
| Node.js | `>=22.19.0` (required by `pi-ai` / `pi-coding-agent`) |

Check your local Pi version with:

```bash
pi --version
```

## Quick start

```bash
npm install
npm run prepare
npm run check
```

Or, with the justfile shortcuts:

```bash
just setup-dev
just check
```

If you use Nix, the repository also provides a dev shell:

```bash
nix develop
just setup-dev
just check
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
