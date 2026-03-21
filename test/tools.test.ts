import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmMessage, executeMcpTool } from "../src/dust-tools.js";

const ORIGINAL_ALLOWED_PATHS = process.env.PI_DUST_ALLOWED_PATHS;

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setAllowedPaths(...paths: string[]): void {
  process.env.PI_DUST_ALLOWED_PATHS = paths.join(":");
}

afterEach(() => {
  if (ORIGINAL_ALLOWED_PATHS === undefined) {
    delete process.env.PI_DUST_ALLOWED_PATHS;
  } else {
    process.env.PI_DUST_ALLOWED_PATHS = ORIGINAL_ALLOWED_PATHS;
  }
});

describe("dust local tools", () => {
  it("reads files inside allowed directories", () => {
    const allowedDir = makeTempDir("pi-dust-allowed-");
    const filePath = join(allowedDir, "sample.txt");

    try {
      writeFileSync(filePath, "line-1\nline-2\nline-3", "utf8");
      setAllowedPaths(allowedDir);

      const result = executeMcpTool("read", { path: filePath, offset: 2, limit: 1 });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("line-2");
    } finally {
      rmSync(allowedDir, { recursive: true, force: true });
    }
  });

  it("blocks reads outside allowed directories", () => {
    const allowedDir = makeTempDir("pi-dust-allowed-");
    const blockedDir = makeTempDir("pi-dust-blocked-");
    const blockedFile = join(blockedDir, "secret.txt");

    try {
      writeFileSync(blockedFile, "secret", "utf8");
      setAllowedPaths(allowedDir);

      const result = executeMcpTool("read", { path: blockedFile });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("outside allowed directories");
    } finally {
      rmSync(allowedDir, { recursive: true, force: true });
      rmSync(blockedDir, { recursive: true, force: true });
    }
  });

  it("edits files with literal replacement text", () => {
    const allowedDir = makeTempDir("pi-dust-edit-");
    const filePath = join(allowedDir, "edit.txt");

    try {
      writeFileSync(filePath, "before TOKEN after", "utf8");
      setAllowedPaths(allowedDir);

      const result = executeMcpTool("edit", { path: filePath, oldText: "TOKEN", newText: "$&/$1" });

      expect(result.isError).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe("before $&/$1 after");
    } finally {
      rmSync(allowedDir, { recursive: true, force: true });
    }
  });

  it("rejects edits with an empty oldText", () => {
    const allowedDir = makeTempDir("pi-dust-edit-empty-");
    const filePath = join(allowedDir, "edit.txt");

    try {
      writeFileSync(filePath, "content", "utf8");
      setAllowedPaths(allowedDir);

      const result = executeMcpTool("edit", { path: filePath, oldText: "", newText: "replacement" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("oldText must not be empty");
    } finally {
      rmSync(allowedDir, { recursive: true, force: true });
    }
  });

  it("shows the resolved path in confirmation messages", () => {
    const allowedDir = makeTempDir("pi-dust-confirm-");

    try {
      const readMessage = buildConfirmMessage("read", { path: join(allowedDir, "file.txt"), offset: 2, limit: 4 });
      const editMessage = buildConfirmMessage("edit", { path: join(allowedDir, "file.txt"), oldText: "a", newText: "b" });

      expect(readMessage).toContain(join(allowedDir, "file.txt"));
      expect(readMessage).toContain("offset: 2");
      expect(editMessage).toContain(join(allowedDir, "file.txt"));
    } finally {
      rmSync(allowedDir, { recursive: true, force: true });
    }
  });
});
