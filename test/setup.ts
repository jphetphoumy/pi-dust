import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Global guard: no test may touch the developer's real pi agent directory.
 *
 * The extension's store is file-backed (pi 0.81 removed the injectable
 * AuthStorage), so anything that calls persistCredentialState/patchDustState
 * writes to PI_CODING_AGENT_DIR — defaulting to ~/.pi/agent. A suite that
 * forgets `useTempAgentDir()` would otherwise overwrite the developer's real
 * dust-state.json with fixture credentials, pointing the extension at a
 * workspace they cannot access and breaking their next pi session with a 401.
 *
 * This file runs before every test file and pins the directory to a throwaway
 * one, so forgetting the per-suite fixture degrades to isolation-between-suites
 * rather than clobbering real state. `useTempAgentDir()` still gives each suite
 * its own clean directory.
 */
const guardDir = mkdtempSync(join(tmpdir(), "pi-dust-test-guard-"));
process.env.PI_CODING_AGENT_DIR = guardDir;

afterAll(() => {
  rmSync(guardDir, { recursive: true, force: true });
});
