import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * Second guard: skills live outside PI_CODING_AGENT_DIR.
 *
 * Skill discovery also searches `~/.agents/skills`, the cross-agent location,
 * which the guard above does not cover — it is derived from `homedir()`, not
 * from the env var. A test that wrote a fixture skill there would be writing
 * into the developer's real skill collection, and one that merely *reads* the
 * default search path would pass or fail depending on which skills they happen
 * to have installed.
 *
 * Both were live problems while this suite was written, so writes under that
 * directory are refused outright. Tests pass explicit directories to
 * `discoverLocalSkills` instead.
 */
const realSkillsDir = join(homedir(), ".agents", "skills");
const realWriteFileSync = fs.writeFileSync;
const realMkdirSync = fs.mkdirSync;

function refuseRealSkillWrites(target: unknown): void {
  if (typeof target === "string" && target.startsWith(realSkillsDir)) {
    throw new Error(
      `Refusing to write inside ${realSkillsDir}: that is the developer's real skill collection. ` +
        "Pass explicit directories to discoverLocalSkills instead.",
    );
  }
}

fs.writeFileSync = function guardedWriteFileSync(this: unknown, ...args: unknown[]) {
  refuseRealSkillWrites(args[0]);
  return (realWriteFileSync as (...a: unknown[]) => unknown).apply(this, args);
} as typeof fs.writeFileSync;

fs.mkdirSync = function guardedMkdirSync(this: unknown, ...args: unknown[]) {
  refuseRealSkillWrites(args[0]);
  return (realMkdirSync as (...a: unknown[]) => unknown).apply(this, args);
} as typeof fs.mkdirSync;

afterAll(() => {
  fs.writeFileSync = realWriteFileSync;
  fs.mkdirSync = realMkdirSync;
  rmSync(guardDir, { recursive: true, force: true });
});
