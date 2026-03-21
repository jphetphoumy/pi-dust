import { appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEBUG_ENV = "PI_DUST_DEBUG";
const LOG_FILE_ENV = "PI_DUST_LOG_FILE";
export const DEFAULT_LOG_FILE_PATH = join(tmpdir(), "pi-dust.log");

function envValue(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function hasVerboseArg(): boolean {
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return false;
  return process.argv.some((arg) => arg === "--verbose" || arg.startsWith("--verbose="));
}

export function isDebugEnabled(): boolean {
  const value = envValue(DEBUG_ENV)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on" || hasVerboseArg();
}

export function logFilePath(): string {
  return envValue(LOG_FILE_ENV) || DEFAULT_LOG_FILE_PATH;
}

function redactString(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export function redactForLog(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactForLog);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        const lowerKey = key.toLowerCase();
        if (["authorization", "access", "refresh", "access_token", "refresh_token", "id_token"].includes(lowerKey)) {
          return [key, "[REDACTED]"];
        }
        return [key, redactForLog(entryValue)];
      }),
    );
  }

  return value;
}

export function debugLog(scope: string, message: string, data?: unknown): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();
  const suffix = data === undefined ? "" : ` ${JSON.stringify(redactForLog(data))}`;
  const line = `[${timestamp}] [${scope}] ${message}${suffix}`;

  console.error(line);

  const filePath = logFilePath();
  appendFileSync(filePath, `${line}\n`, "utf8");
}
