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

Or, with the justfile shortcuts (see `justfile` for the full recipe list):

```bash
just setup-dev
just check
```

If you use Nix, the repository also provides a dev shell (`flake.nix`, currently `nodejs_22`; it runs `npm install` automatically on first entry when `node_modules/` is missing):

```bash
nix develop
just setup-dev
just check
```

## Debugging

For verbose development:

```bash
pi --verbose
tail -f /tmp/pi-dust.log
```

See [`docs/debugging.md`](docs/debugging.md) for log locations, redaction rules, and common troubleshooting cases.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture and module reference
- [Debugging guide](docs/debugging.md)
- [Release and maintenance](docs/release.md)
- [Historical specs](docs/specs/README.md) — reverse-engineered Dust protocol behaviour (SSE cursor semantics, the approval handshake, etc.)

## Repository layout

```text
.
├── docs/        Debugging guide, release notes, and historical specs
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

See [`CLAUDE.md`](CLAUDE.md) for the full command reference (including `just` shortcuts) and the module-by-module architecture.
