import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCredentials } from "./helpers/dust-fixtures.js";

describe("dust bootstrap", () => {
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns null when auth.json is missing", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-dust-bootstrap-missing-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("normalizes legacy stored credentials without a type field", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-dust-bootstrap-legacy-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        dust: makeCredentials({ type: undefined }),
      }),
    );

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toEqual(
      expect.objectContaining({
        type: "oauth",
        workspaceId: "ws-1",
      }),
    );

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns null when auth.json is empty", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-dust-bootstrap-empty-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "auth.json"), "   \n");

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns null when auth.json contains invalid JSON", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-dust-bootstrap-invalid-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "auth.json"), "{not-json");

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns null when dust credentials are missing from auth.json", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-dust-bootstrap-no-dust-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ other: makeCredentials() }));

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("expands PI_CODING_AGENT_DIR when set to ~", async () => {
    process.env.PI_CODING_AGENT_DIR = "~";
    const existsSync = vi.fn().mockReturnValue(false);
    const readFileSync = vi.fn();

    vi.doMock("node:fs", () => ({
      existsSync,
      readFileSync,
    }));
    vi.doMock("node:os", () => ({
      homedir: () => "/mock-home",
    }));

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();
    expect(existsSync).toHaveBeenCalledWith("/mock-home/auth.json");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("expands PI_CODING_AGENT_DIR when set to ~/path", async () => {
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent-dir";
    const existsSync = vi.fn().mockReturnValue(false);
    const readFileSync = vi.fn();

    vi.doMock("node:fs", () => ({
      existsSync,
      readFileSync,
    }));
    vi.doMock("node:os", () => ({
      homedir: () => "/mock-home",
    }));

    const { loadBootstrapDustCredentials } = await import("../src/dust-bootstrap.js");

    expect(loadBootstrapDustCredentials()).toBeNull();
    expect(existsSync).toHaveBeenCalledWith("/mock-home/custom-agent-dir/auth.json");
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
