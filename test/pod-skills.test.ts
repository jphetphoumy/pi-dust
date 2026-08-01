import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as podApi from "../src/dust-pod.js";
import {
  buildPodSkillsListing,
  discoverLocalSkills,
  isPodSkillPath,
  type LocalSkill,
  POD_SKILLS_PREFIX,
  podSkillPath,
  removeSkillsFromPod,
  skillSearchDirs,
  splitPodSkillPath,
  stripSkillsListing,
  syncSkillsToPod,
} from "../src/dust-pod-skills.js";
import { isPodOwnedPath } from "../src/dust-pod-sync.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

const api = { baseUrl: "https://x/api/w/w1", getAuthHeaders: () => ({}) };

/**
 * A skill backed by files that really exist, since the uploader reads them off
 * disk. `missingFiles` names entries deliberately absent, to exercise that path.
 */
function realSkill(
  root: string,
  name: string,
  files: string[],
  missingFiles: string[] = [],
): LocalSkill {
  const baseDir = join(root, name);
  for (const rel of files) {
    const path = join(baseDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `content of ${rel}`);
  }
  return {
    name,
    description: `does ${name}`,
    baseDir,
    filePath: join(baseDir, "SKILL.md"),
    files: [...files, ...missingFiles],
    bytes: 100,
  };
}

/** A skill described only in metadata, for the prompt-rewriting tests. */
function skill(name: string, files: string[], bytes = 100): LocalSkill {
  return {
    name,
    description: `does ${name}`,
    baseDir: `/home/u/.agents/skills/${name}`,
    filePath: `/home/u/.agents/skills/${name}/SKILL.md`,
    files,
    bytes,
  };
}

describe("pod skills", () => {
  useTempAgentDir();

  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-dust-skills-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeSkill(dir: string, name: string, body: string, extra: Record<string, string> = {}): void {
    const base = join(dir, name);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "SKILL.md"), body);
    for (const [rel, content] of Object.entries(extra)) {
      const path = join(base, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }

  const frontmatter = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

  describe("discovery", () => {
    it("finds skills in the agent directory, with their files and total size", async () => {
      writeSkill(join(cwd, "user"), "herdr", frontmatter("herdr", "drive herdr"), {
        "references/keys.md": "arrows",
      });

      const found = discoverLocalSkills(cwd, [{ dir: join(cwd, "user"), source: "user" }]);

      expect(found.map((s) => s.name)).toEqual(["herdr"]);
      expect(found[0].files.sort()).toEqual(["SKILL.md", "references/keys.md"]);
      expect(found[0].bytes).toBeGreaterThan(0);
    });

    it("finds project skills under .pi/skills too", () => {
      writeSkill(join(cwd, ".pi", "skills"), "local-only", frontmatter("local-only", "project skill"));

      const found = discoverLocalSkills(cwd, [{ dir: join(cwd, ".pi", "skills"), source: "project" }]);

      expect(found.map((s) => s.name)).toEqual(["local-only"]);
    });

    it("lets a project skill shadow a user skill of the same name, as pi does", () => {
      writeSkill(join(cwd, "user"), "shared", frontmatter("shared", "user version"));
      writeSkill(join(cwd, ".pi", "skills"), "shared", frontmatter("shared", "project version"));

      const found = discoverLocalSkills(cwd, [
        { dir: join(cwd, "user"), source: "user" },
        { dir: join(cwd, ".pi", "skills"), source: "project" },
      ]);

      expect(found).toHaveLength(1);
      expect(found[0].description).toBe("project version");
    });

    it("finds skills in the shared cross-agent location", () => {
      // pi's own skills dir is often a farm of symlinks into ~/.agents/skills,
      // so an install without those links must still be discoverable.
      const shared = join(cwd, "shared-home");
      writeSkill(shared, "shared-skill", frontmatter("shared-skill", "s"));

      const found = discoverLocalSkills(cwd, [{ dir: shared, source: "shared" }]);

      expect(found.map((s) => s.name)).toEqual(["shared-skill"]);
    });

    it("lists a skill once when two search directories hold the same one", () => {
      // The usual case on this machine: ~/.pi/agent/skills symlinks into
      // ~/.agents/skills, so both scans see it.
      const a = join(cwd, "home-a");
      const b = join(cwd, "home-b");
      writeSkill(a, "dup", frontmatter("dup", "from a"));
      writeSkill(b, "dup", frontmatter("dup", "from b"));

      const found = discoverLocalSkills(cwd, [
        { dir: a, source: "shared" },
        { dir: b, source: "user" },
      ]);

      expect(found).toHaveLength(1);
      // Later directories win, which is how a project skill shadows a personal one.
      expect(found[0].description).toBe("from b");
    });

    it("looks in the shared, pi and project locations by default", () => {
      const dirs = skillSearchDirs("/work/proj").map((entry) => entry.dir);

      expect(dirs.some((dir) => dir.endsWith("/.agents/skills"))).toBe(true);
      expect(dirs.some((dir) => dir.endsWith("/skills") && dir.includes(".pi"))).toBe(true);
      expect(dirs).toContain("/work/proj/.agents/skills");
      expect(dirs).toContain("/work/proj/.pi/skills");
    });

    it("returns nothing when there are no skill directories", () => {
      expect(discoverLocalSkills(cwd, [{ dir: join(cwd, "nope"), source: "user" }])).toEqual([]);
    });

    it("sorts by name, so the picker order is stable between runs", () => {
      writeSkill(join(cwd, "user"), "zebra", frontmatter("zebra", "z"));
      writeSkill(join(cwd, "user"), "alpha", frontmatter("alpha", "a"));

      const found = discoverLocalSkills(cwd, [{ dir: join(cwd, "user"), source: "user" }]);

      expect(found.map((s) => s.name)).toEqual(["alpha", "zebra"]);
    });
  });

  describe("upload", () => {
    it("uploads a skill's whole directory, not just its entry point", async () => {
      // pi tells the agent to resolve a skill's relative references against its
      // own directory, so shipping SKILL.md alone would leave them dangling.
      const uploads: string[] = [];
      vi.spyOn(podApi, "uploadPodFile").mockImplementation(async (_a, _p, rel) => {
        uploads.push(rel);
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([]);

      await syncSkillsToPod(api, "vlt_1", [realSkill(cwd, "herdr", ["SKILL.md", "references/keys.md"])]);

      expect(uploads).toEqual([
        `${POD_SKILLS_PREFIX}/herdr/SKILL.md`,
        `${POD_SKILLS_PREFIX}/herdr/references/keys.md`,
      ]);
    });

    it("records a file the pod refused and keeps going", async () => {
      vi.spyOn(podApi, "uploadPodFile").mockImplementation(async (_a, _p, rel) => {
        if (rel.endsWith("bad.md")) throw new Error("HTTP 400");
      });
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([]);

      const result = await syncSkillsToPod(api, "vlt_1", [realSkill(cwd, "s", ["SKILL.md", "bad.md"])]);

      expect(result.uploaded).toEqual([`${POD_SKILLS_PREFIX}/s/SKILL.md`]);
      expect(result.skipped).toEqual([
        { rel: `${POD_SKILLS_PREFIX}/s/bad.md`, reason: "HTTP 400" },
      ]);
    });

    it("reports progress across every file of every skill as one count", async () => {
      vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([]);
      const steps: string[] = [];

      await syncSkillsToPod(
        api,
        "vlt_1",
        [realSkill(cwd, "a", ["SKILL.md"]), realSkill(cwd, "b", ["SKILL.md", "x.md"])],
        (done, total) => steps.push(`${done}/${total}`),
      );

      expect(steps).toEqual(["1/3", "2/3", "3/3"]);
    });

    it("records a file it cannot read locally rather than throwing", async () => {
      vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);

      const result = await syncSkillsToPod(api, "vlt_1", [realSkill(cwd, "gone", [], ["missing.md"])]);

      expect(result.uploaded).toEqual([]);
      expect(result.skipped).toHaveLength(1);
    });
  });

  describe("prompt rewriting", () => {
    it("points the listing at the pod mount rather than the local path", async () => {
      // This is the whole point: the agent reaches a skill with the free
      // `files__*` tools instead of our billed `read`.
      const listing = buildPodSkillsListing([skill("herdr", ["SKILL.md"])], "vlt_1");

      expect(listing).toContain("<name>herdr</name>");
      expect(listing).toContain(`/files/pod-vlt_1/${POD_SKILLS_PREFIX}/herdr/SKILL.md`);
      expect(listing).not.toContain("/home/u/.agents/skills/herdr/SKILL.md");
    });

    it("produces nothing when no skills are synced", () => {
      expect(buildPodSkillsListing([], "vlt_1")).toBe("");
    });

    it("strips pi's own skills block, which points at billed local paths", () => {
      const prompt = [
        "You are an expert coding assistant.",
        "",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>herdr</name>",
        "    <location>/home/u/.pi/agent/skills/herdr/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n");

      const stripped = stripSkillsListing(prompt);

      expect(stripped).toBe("You are an expert coding assistant.");
      expect(stripped).not.toContain("available_skills");
    });

    it("leaves a prompt with no skills block untouched", () => {
      expect(stripSkillsListing("You are an expert coding assistant.")).toBe(
        "You are an expert coding assistant.",
      );
    });
  });

  describe("path ownership", () => {
    it("builds pod paths under the skills prefix", () => {
      expect(podSkillPath("herdr", "SKILL.md")).toBe("skills/herdr/SKILL.md");
    });

    it("claims only the skills it actually synced", () => {
      expect(isPodSkillPath("skills/herdr/SKILL.md", ["herdr"])).toBe(true);
      expect(isPodSkillPath("skills/herdr/refs/a.md", ["herdr"])).toBe(true);
      expect(isPodSkillPath("src/main.py", ["herdr"])).toBe(false);
    });

    it("leaves a project's own skills/ directory alone", () => {
      // The prefix is no longer ours alone, so a project that genuinely keeps
      // files under skills/ has to keep syncing them normally.
      expect(isPodSkillPath("skills/my-own-thing/notes.md", ["herdr"])).toBe(false);
      expect(isPodSkillPath("skills/README.md", ["herdr"])).toBe(false);
      expect(isPodSkillPath("skills/herdr-notes.md", ["herdr"])).toBe(false);
    });

    it("claims nothing when no skills are synced", () => {
      expect(isPodSkillPath("skills/herdr/SKILL.md", [])).toBe(false);
    });

    it("keeps only the extension's own rendered files out of the pull direction", () => {
      // AGENTS.md is never pulled. A synced skill's files are NOT excluded
      // here any more — they come back through syncPod's skill-routing branch
      // instead, which is what fixes #54.
      expect(isPodOwnedPath("AGENTS.md")).toBe(true);
      expect(isPodOwnedPath("skills/herdr/SKILL.md")).toBe(false);
      expect(isPodOwnedPath("src/main.py")).toBe(false);
      expect(isPodOwnedPath("skills/theirs/x.md")).toBe(false);
    });

    it("splits a pod skill path into the skill name and its file", () => {
      expect(splitPodSkillPath("skills/herdr/SKILL.md")).toEqual({ name: "herdr", relFile: "SKILL.md" });
      expect(splitPodSkillPath("skills/herdr/refs/a.md")).toEqual({ name: "herdr", relFile: "refs/a.md" });
    });

    it("does not split a path that is not skill-shaped", () => {
      expect(splitPodSkillPath("src/main.py")).toBeNull();
      expect(splitPodSkillPath("skills/herdr")).toBeNull();
      expect(splitPodSkillPath("AGENTS.md")).toBeNull();
    });
  });

  describe("removal", () => {
    it("deletes every file of a de-selected skill", async () => {
      // Dropping it from the listing alone would leave the copy in the pod for
      // good — which went unnoticed while the prefix was hidden from Dust's UI.
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        { path: "pod-vlt_1/skills/gone/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
        { path: "pod-vlt_1/skills/gone/refs/a.md", fileName: "a.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
        { path: "pod-vlt_1/skills/kept/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
        { path: "pod-vlt_1/src/main.py", fileName: "main.py", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
      ]);
      const del = vi.spyOn(podApi, "deletePodFile").mockResolvedValue(undefined);

      const removed = await removeSkillsFromPod(api, "vlt_1", ["gone"]);

      expect(removed).toEqual(["skills/gone/SKILL.md", "skills/gone/refs/a.md"]);
      expect(del).toHaveBeenCalledTimes(2);
    });

    it("does not list the pod when nothing was de-selected", async () => {
      const list = vi.spyOn(podApi, "listPodFiles");

      expect(await removeSkillsFromPod(api, "vlt_1", [])).toEqual([]);
      expect(list).not.toHaveBeenCalled();
    });

    it("keeps going when one delete fails", async () => {
      vi.spyOn(podApi, "listPodFiles").mockResolvedValue([
        { path: "pod-vlt_1/skills/gone/a.md", fileName: "a.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
        { path: "pod-vlt_1/skills/gone/b.md", fileName: "b.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
      ]);
      vi.spyOn(podApi, "deletePodFile").mockImplementation(async (_a, _p, rel) => {
        if (rel.endsWith("a.md")) throw new Error("HTTP 500");
      });

      expect(await removeSkillsFromPod(api, "vlt_1", ["gone"])).toEqual(["skills/gone/b.md"]);
    });
  });
});
