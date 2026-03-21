# Security Policy

## Supported versions

Security fixes are applied to the latest code on the default branch.

## Security model

`pi-dust` can execute local tools on the host machine through the Dust MCP flow.

Important implications:

- approval prompts are a user-safety guard, not an operating-system sandbox
- approving a `bash` command still allows that command to run with the user's permissions
- file-oriented tools are restricted to allowed local directories

By default, file reads and edits are limited to the current working directory.
You can override the allowed locations with `PI_DUST_ALLOWED_PATHS`, using the
platform path separator to declare multiple base directories.

Examples:

- Linux/macOS: `PI_DUST_ALLOWED_PATHS=/workspace/project:/tmp/shared`
- Windows: `PI_DUST_ALLOWED_PATHS=C:\\work\\project;D:\\shared`

Only approve commands and file operations you understand and expect.

## Reporting a vulnerability

If you believe you have found a security issue in `pi-dust`, please avoid
opening a public issue first.

Preferred process:

1. use GitHub Security Advisories if enabled for the repository
2. if advisories are not available, open a private coordination channel with
   the maintainer before public disclosure

When reporting an issue, include:

- a clear description of the problem
- impact and affected area
- reproduction steps or proof of concept
- any suggested mitigation if available

You can use public GitHub issues for non-sensitive bugs only.
