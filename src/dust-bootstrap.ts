import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DustCredentials } from "./dust-types.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function resolveAgentDir(): string {
  const configuredDir = process.env[PI_AGENT_DIR_ENV];
  if (configuredDir) {
    if (configuredDir === "~") {
      return homedir();
    }
    if (configuredDir.startsWith("~/")) {
      return join(homedir(), configuredDir.slice(2));
    }
    return configuredDir;
  }
  return join(homedir(), ".pi", "agent");
}

function normalizeStoredCredentials(credentials: DustCredentials): DustCredentials {
  return credentials.type === "oauth"
    ? credentials
    : { ...credentials, type: "oauth" };
}

export function loadBootstrapDustCredentials(): DustCredentials | null {
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const content = readFileSync(authPath, "utf8");
    if (!content.trim()) {
      return null;
    }

    const parsed = JSON.parse(content) as Record<string, DustCredentials | undefined>;
    const storedCred = parsed.dust;
    if (!storedCred || typeof storedCred !== "object") {
      return null;
    }

    return normalizeStoredCredentials(storedCred);
  } catch {
    return null;
  }
}
