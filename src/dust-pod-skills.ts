import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { debugLog } from "./dust-debug.js";
import { type PodApi, uploadPodFile } from "./dust-pod.js";
import type { SyncProgress } from "./dust-pod-sync.js";
import { resolveAgentDir } from "./dust-state.js";

/**
 * Where a synced skill lives inside the pod.
 *
 * Dotted so it reads as tooling rather than project content, and so it is
 * skipped by the ingest walk (which ignores hidden entries) if it ever ends up
 * on disk. The pull direction excludes it outright — see `isPodSkillPath`.
 */
export const POD_SKILLS_PREFIX = ".pi-skills";

/** Guards against a `/dust-skills` selection that would take minutes to upload. */
export const MAX_SKILL_FILES = 120;

export function isPodSkillPath(rel: string): boolean {
  return rel === POD_SKILLS_PREFIX || rel.startsWith(`${POD_SKILLS_PREFIX}/`);
}

export interface LocalSkill {
  name: string;
  description: string;
  /** Directory holding SKILL.md and anything it references. */
  baseDir: string;
  /** SKILL.md itself, the file the agent is told to read. */
  filePath: string;
  files: string[];
  bytes: number;
}

/** Files under a skill directory, as paths relative to it. */
function skillFiles(baseDir: string): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile() && stat.size > 0) {
        files.push(relative(baseDir, path));
        bytes += stat.size;
      }
    }
  };
  walk(baseDir);
  return { files: files.sort(), bytes };
}

/**
 * The skills pi would offer this session.
 *
 * Discovery goes through pi's own `loadSkillsFromDir` rather than our own
 * walk, so the picker cannot drift from the set pi actually knows about — and
 * so `baseDir` is whatever pi decided it is.
 */
/**
 * Where skills are looked for, in increasing precedence.
 *
 * Several homes, because skills are shared between agents: `~/.agents/skills`
 * is the cross-agent location and `~/.pi/agent/skills` is pi's own, which on
 * many installs is just a farm of symlinks into the former. Both are scanned so
 * discovery works whether or not those links exist. Later entries win, so a
 * project skill shadows a personal one of the same name — pi's own precedence.
 *
 * Exported and injectable so tests can point it somewhere disposable: two of
 * these are under the real home directory, which a test must never write to.
 */
export function skillSearchDirs(cwd: string): Array<{ dir: string; source: string }> {
  return [
    { dir: join(homedir(), ".agents", "skills"), source: "shared" },
    { dir: join(resolveAgentDir(), "skills"), source: "user" },
    { dir: join(cwd, ".agents", "skills"), source: "project-shared" },
    { dir: join(cwd, ".pi", "skills"), source: "project" },
  ];
}

export function discoverLocalSkills(
  cwd: string,
  dirs: Array<{ dir: string; source: string }> = skillSearchDirs(cwd),
): LocalSkill[] {
  const found = new Map<string, LocalSkill>();
  for (const { dir, source } of dirs) {
    let skills: Skill[];
    try {
      skills = loadSkillsFromDir({ dir, source }).skills;
    } catch (err) {
      debugLog("dust:pod", "Skill discovery failed", { dir, error: String(err) });
      continue;
    }
    for (const skill of skills) {
      if (skill.disableModelInvocation) continue;
      // A project skill of the same name wins, matching pi's own precedence.
      const { files, bytes } = skillFiles(skill.baseDir);
      found.set(skill.name, {
        name: skill.name,
        description: skill.description,
        baseDir: skill.baseDir,
        filePath: skill.filePath,
        files,
        bytes,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pod-relative path a skill's file takes. */
export function podSkillPath(skillName: string, relFile: string): string {
  return `${POD_SKILLS_PREFIX}/${skillName}/${relFile}`;
}

/**
 * Uploads each skill's whole directory.
 *
 * The directory rather than SKILL.md alone, because pi tells the agent to
 * resolve a skill's relative references against its own directory — shipping
 * only the entry point would leave those references pointing at files the pod
 * does not have.
 */
export async function syncSkillsToPod(
  api: PodApi,
  podId: string,
  skills: LocalSkill[],
  onProgress?: SyncProgress,
): Promise<{ uploaded: string[]; skipped: Array<{ rel: string; reason: string }> }> {
  const uploaded: string[] = [];
  const skipped: Array<{ rel: string; reason: string }> = [];
  const total = skills.reduce((sum, skill) => sum + skill.files.length, 0);
  let done = 0;

  for (const skill of skills) {
    for (const relFile of skill.files) {
      onProgress?.(++done, total);
      const podPath = podSkillPath(skill.name, relFile);
      let content: Buffer;
      try {
        content = readFileSync(resolve(skill.baseDir, relFile));
      } catch (err) {
        skipped.push({ rel: podPath, reason: String(err) });
        continue;
      }
      try {
        await uploadPodFile(api, podId, podPath, content);
        uploaded.push(podPath);
      } catch (err) {
        skipped.push({ rel: podPath, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { uploaded, skipped };
}

/**
 * The `<available_skills>` block for the synced skills, pointing at the pod.
 *
 * Built with pi's own `formatSkillsForPrompt` so the wording and shape stay
 * whatever pi expects, with only the location swapped for the in-sandbox mount
 * path. That is the whole point: the agent reads a skill with the free
 * `files__*` tools instead of our billed `read`.
 */
export function buildPodSkillsListing(skills: LocalSkill[], podId: string): string {
  if (skills.length === 0) return "";
  return formatSkillsForPrompt(
    skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: `/files/pod-${podId}/${podSkillPath(skill.name, basename(skill.filePath))}`,
      baseDir: `/files/pod-${podId}/${POD_SKILLS_PREFIX}/${skill.name}`,
      sourceInfo: { source: "pod" } as Skill["sourceInfo"],
      disableModelInvocation: false,
    })),
  );
}

/**
 * Strips pi's own skills block out of a system prompt.
 *
 * pi lists every local skill with an absolute local path. Left in place next to
 * our pod listing the agent would see each skill twice and be pointed at the
 * billed local path for it, so the original has to go.
 */
export function stripSkillsListing(prompt: string): string {
  return prompt
    .replace(/\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>/, "")
    .trimEnd();
}
