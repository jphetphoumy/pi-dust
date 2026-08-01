import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintSkill, type LocalSkill } from "../src/dust-pod-skills.js";

/**
 * The fingerprint is what turns "you picked this skill" into "this exact
 * content is in the pod". Without it `binding.skills` is a record of intent
 * that survives the pod being cleared or the skill being edited afterwards.
 */
describe("skill fingerprints", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-dust-fp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function skill(files: Record<string, string>): LocalSkill {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return {
      name: "demo",
      description: "demo",
      baseDir: dir,
      filePath: join(dir, "SKILL.md"),
      files: Object.keys(files).sort(),
      bytes: 0,
    };
  }

  it("is stable across calls, so an unchanged skill never reads as stale", () => {
    const one = skill({ "SKILL.md": "hello" });

    expect(fingerprintSkill(one)).toBe(fingerprintSkill(one));
  });

  it("changes when a file's content changes", () => {
    const before = fingerprintSkill(skill({ "SKILL.md": "hello" }));
    const after = fingerprintSkill(skill({ "SKILL.md": "goodbye" }));

    expect(after).not.toBe(before);
  });

  it("changes when a file is added, not just when one is edited", () => {
    // A skill that grew a reference file is stale even though SKILL.md is
    // untouched — the agent would follow a reference the pod does not have.
    const before = fingerprintSkill(skill({ "SKILL.md": "hello" }));
    const after = fingerprintSkill(skill({ "SKILL.md": "hello", "ref.md": "extra" }));

    expect(after).not.toBe(before);
  });

  it("covers the file names, not only the bytes", () => {
    // Renaming a file with identical content still breaks the pod's copy.
    const before = fingerprintSkill(skill({ "SKILL.md": "x", "a.md": "same" }));
    rmSync(join(dir, "a.md"));
    const after = fingerprintSkill(skill({ "SKILL.md": "x", "b.md": "same" }));

    expect(after).not.toBe(before);
  });

  it("does not throw on a file that has vanished mid-read", () => {
    const gone = { ...skill({ "SKILL.md": "hi" }), files: ["SKILL.md", "deleted.md"] };

    expect(() => fingerprintSkill(gone)).not.toThrow();
  });
});
