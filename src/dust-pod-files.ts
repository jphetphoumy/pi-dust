import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { debugLog } from "./dust-debug.js";
import { errorMessage } from "./dust-validation.js";

/**
 * Whether a pod-reported relative path stays inside `root` once joined onto it.
 *
 * `rel` comes straight off the Dust listing API — the agent's own writes, not
 * something we chose — so a `../../.ssh/authorized_keys` style entry has to be
 * caught before it is ever joined onto a local path. `resolve` collapses `..`
 * segments, so comparing the resolved target against the resolved root catches
 * every escaping shape (leading `..`, absolute paths, `a/../../b`) in one place,
 * shared by every caller that turns a pod path into a local one.
 */
export function isPodPathSafe(root: string, rel: string): boolean {
  const base = resolve(root);
  const target = resolve(base, rel);
  return target === base || target.startsWith(base + sep);
}

/**
 * Choosing which local files belong in a Pod.
 *
 * Shared by `/ingest`, which makes the initial selection, and by the pre-turn
 * push, which re-applies it to notice files created since. Both must agree, or
 * a file the user deliberately left out would be swept up later.
 */

/** Keeps a stray `/ingest` in a home directory from uploading a life's work. */
export const MAX_INGEST_FILES = 500;
/** Pod files are read by an LLM; anything this large is a binary or a build artefact. */
const MAX_INGEST_BYTES = 256 * 1024;
/** Traversal bound, so `/ingest` in a huge tree fails fast instead of hanging. */
const MAX_WALK_ENTRIES = 20_000;

/**
 * Directories that are never worth sending to an LLM: dependency trees, build
 * output and caches. Hidden entries are skipped separately, which covers `.git`
 * and friends.
 */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  "env",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
]);

/**
 * Every file under `root`, as relative paths.
 *
 * A plain filesystem walk, so `/ingest` works in any directory — a scratch
 * folder, an unpacked tarball, a subdirectory of something larger. Git is not
 * required and is not consulted here.
 *
 * Hidden entries (those starting with `.`) are skipped wholesale. That is
 * partly noise reduction — `.git`, `.venv`, `.DS_Store` — but mostly a safety
 * property: it keeps `.env` and similar credential files from being uploaded to
 * a workspace by an unqualified `/ingest`.
 *
 * Symlinks are not followed, so the walk cannot cycle or escape the tree.
 */
export function walkFiles(root: string): string[] {
  const found: string[] = [];
  const pending: string[] = [""];

  while (pending.length > 0 && found.length < MAX_WALK_ENTRIES) {
    const relDir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(resolve(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(rel);
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }

  return found.sort();
}

/**
 * True when `rel` is selected by one of the user's pathspecs.
 *
 * A pathspec is either a path — matching that file, or everything under it if
 * it names a directory — or a glob, where `*` stops at a path separator and
 * `**` does not. This is our own matching rather than git's, because pathspecs
 * have to behave the same whether or not the directory happens to be a repo.
 */
export function matchesPathspec(rel: string, pathspec: string): boolean {
  const spec = pathspec.replace(/\/+$/, "");
  if (rel === spec || rel.startsWith(`${spec}/`)) return true;
  if (!spec.includes("*")) return false;

  // One pass, so `**` is translated before its `*`s are seen individually,
  // which a sequence of replaces cannot do without a placeholder. `**/`
  // absorbs its slash so it can match zero directories: `**/*.py` is expected
  // to find a top-level `main.py`, not only nested ones.
  const pattern = spec.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\?]/g, (token) => {
    if (token === "**/") return "(?:.*/)?";
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    return `\\${token}`;
  });
  return new RegExp(`^${pattern}$`).test(rel);
}

/**
 * Drops files a `.gitignore` excludes, when there is a git repository to ask.
 *
 * This is the one place git is used, and it is strictly an enhancement: outside
 * a repository, or without git installed, `check-ignore` fails and every
 * candidate is kept. Being a repo therefore refines the selection rather than
 * being a precondition for `/ingest` working at all.
 */
export function dropGitIgnored(root: string, candidates: string[]): string[] {
  if (candidates.length === 0) return candidates;

  let ignored: Set<string>;
  try {
    const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      input: `${candidates.join("\0")}\0`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // stderr is swallowed: outside a repository git writes "fatal: not a git
      // repository" straight to the terminal, on top of the TUI.
      stdio: ["pipe", "pipe", "ignore"],
    });
    ignored = new Set(out.split("\0").filter((line) => line.length > 0));
  } catch (err) {
    // Exit 1 (nothing ignored) and exit 128 (not a repo, or no git) both land
    // here, and both mean the same thing to us: filter nothing.
    debugLog("dust:pod", "No gitignore filtering applied", { root, error: errorMessage(err) });
    return candidates;
  }

  return candidates.filter((rel) => !ignored.has(rel));
}

/** Candidate files for ingestion, as relative paths. */
export function candidateFiles(root: string, pathspecs: string[]): string[] {
  const walked = walkFiles(root);
  const selected = pathspecs.length === 0
    ? walked
    : walked.filter((rel) => pathspecs.some((spec) => matchesPathspec(rel, spec)));
  return dropGitIgnored(root, selected);
}

/**
 * Whether a file is worth (and possible) to upload.
 *
 * Empty files are excluded because the pod rejects them outright — Dust answers
 * 400 `file_is_empty` — and `__init__.py` / `.gitkeep` are common enough that
 * hitting that mid-ingest is routine. They carry no content for the agent to
 * read anyway.
 */
export function isUploadable(root: string, rel: string): boolean {
  try {
    const stat = statSync(resolve(root, rel));
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_INGEST_BYTES;
  } catch {
    return false;
  }
}


/** The selection `/ingest` offers and the pre-turn push re-applies. */
export function selectIngestableFiles(root: string, pathspecs: string[]): string[] {
  return candidateFiles(root, pathspecs).filter((rel) => isUploadable(root, rel));
}
