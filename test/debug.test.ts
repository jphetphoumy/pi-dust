import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOG_FILE_PATH, debugLog, logFilePath, redactForLog } from "../src/dust-debug.js";

describe("debug logging", () => {
  const originalDebug = process.env.PI_DUST_DEBUG;
  const originalLogFile = process.env.PI_DUST_LOG_FILE;
  const originalArgv = [...process.argv];

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.PI_DUST_DEBUG;
    } else {
      process.env.PI_DUST_DEBUG = originalDebug;
    }

    if (originalLogFile === undefined) {
      delete process.env.PI_DUST_LOG_FILE;
    } else {
      process.env.PI_DUST_LOG_FILE = originalLogFile;
    }

    process.argv = [...originalArgv];

    vi.restoreAllMocks();
  });

  it("redacts sensitive fields and bearer tokens", () => {
    expect(redactForLog({
      access_token: "secret-access",
      refresh: "secret-refresh",
      headers: { Authorization: "Bearer super-secret" },
      nested: ["Bearer nested-secret"],
    })).toEqual({
      access_token: "[REDACTED]",
      refresh: "[REDACTED]",
      headers: { Authorization: "[REDACTED]" },
      nested: ["Bearer [REDACTED]"],
    });
  });

  it("writes sanitized debug logs to stderr and file", () => {
    process.env.PI_DUST_DEBUG = "1";
    const tempDir = mkdtempSync(join(tmpdir(), "pi-dust-"));
    const logFile = join(tempDir, "debug.log");
    process.env.PI_DUST_LOG_FILE = logFile;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debugLog("dust:test", "dump", {
      access_token: "secret-access",
      headers: { Authorization: "Bearer super-secret" },
    });

    const output = consoleSpy.mock.calls[0]?.[0];
    const fileOutput = readFileSync(logFile, "utf8");

    expect(output).toContain("[dust:test] dump");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-access");
    expect(output).not.toContain("super-secret");
    expect(fileOutput).toContain("[REDACTED]");
    expect(fileOutput).not.toContain("secret-access");
    expect(fileOutput).not.toContain("super-secret");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enables debug logging when the process is started with --verbose", () => {
    delete process.env.PI_DUST_DEBUG;
    process.argv = [...originalArgv, "--verbose"];

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debugLog("dust:test", "verbose flag active", { Authorization: "Bearer super-secret" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("[dust:test] verbose flag active");
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("[REDACTED]");
    expect(consoleSpy.mock.calls[0]?.[0]).not.toContain("super-secret");
  });

  it("uses the default temp log file when PI_DUST_LOG_FILE is not set", () => {
    delete process.env.PI_DUST_LOG_FILE;

    expect(logFilePath()).toBe(DEFAULT_LOG_FILE_PATH);
  });
});
