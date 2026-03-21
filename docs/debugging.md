# Debugging guide

This guide explains how to inspect runtime behavior when developing or
troubleshooting the extension.

## Enable verbose mode

The simplest option is to start Pi with:

```bash
pi --verbose
```

The extension detects `--verbose` automatically and enables debug logs.

## Environment-based debug mode

You can also force debug logging with:

```bash
PI_DUST_DEBUG=1 pi
```

## Log file location

By default, logs are written to:

```text
/tmp/pi-dust.log
```

To override the file path:

```bash
PI_DUST_LOG_FILE=/path/to/pi-dust.log pi --verbose
```

## Inspect logs live

```bash
tail -f /tmp/pi-dust.log
```

## What is logged

The extension emits redacted traces for:

- device login
- token refresh
- workspace and agent fetching
- conversation creation and message posting
- SSE events
- MCP registration
- MCP requests and results
- workspace switching

## Redaction

Sensitive values are automatically redacted before they are written:

- `Authorization`
- `access`
- `refresh`
- `access_token`
- `refresh_token`
- `id_token`
- bearer tokens embedded in strings

## Common troubleshooting cases

### Login completes in the browser but Pi stays blocked

Check the verbose log for the WorkOS polling response and the parsed token
payload. This project includes compatibility handling for several token shapes,
including cases where expiry must be inferred.

### Dust session suddenly stops working

Look for:

- token refresh failures
- `401` responses
- credential invalidation logs

The extension invalidates credentials explicitly when the Dust session is no
longer valid.

### Tool call appears to hang

Check both sides of the flow:

- the Dust SSE stream for `tool_approve_execution`
- the MCP request stream for `tools/call`

The approval flow is split across those two channels by design.

### Agent output stops after a tool call

Inspect the event stream logs to confirm the reconnect path ran after the tool
result was posted.
