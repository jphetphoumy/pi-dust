import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, resolve } from "node:path";
import { debugLog } from "./dust-debug.js";
import { archivePod, type PodApi, resolveOrCreatePod } from "./dust-pod.js";
import { describeReport, ingestFiles, isEmptyReport, syncPod } from "./dust-pod-sync.js";
import { podApiFor } from "./dust-pod-runtime.js";
import type { DustSessionRuntime } from "./dust-runtime.js";
import { forgetPodBinding, getPodBinding, savePodBinding } from "./dust-state.js";
import type { PiRuntimeContext } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

/** Keeps a stray `/ingest` in a home directory from uploading a life's work. */
const MAX_INGEST_FILES = 500;
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
function walkFiles(root: string): string[] {
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
function matchesPathspec(rel: string, pathspec: string): boolean {
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
function dropGitIgnored(root: string, candidates: string[]): string[] {
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
function candidateFiles(root: string, pathspecs: string[]): string[] {
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
function isUploadable(root: string, rel: string): boolean {
  try {
    const stat = statSync(resolve(root, rel));
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_INGEST_BYTES;
  } catch {
    return false;
  }
}

function podNameFor(root: string): string {
  return basename(root);
}

export function registerDustIngestCommand(pi: ExtensionAPI, runtime: DustSessionRuntime): void {
  pi.registerCommand("ingest", {
    description: "Upload files to a Dust Pod so the agent edits them with free tools",
    handler: async (args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const notify = (message: string, level = "info"): void =>
        runtimeCtx.ui?.notify?.(message, level);
      const root = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
      const argv = String(args ?? "").trim().split(/\s+/).filter((arg) => arg.length > 0);
      const subcommand = argv[0];

      let api: PodApi;
      try {
        api = podApiFor(runtime);
      } catch (err) {
        notify(errorMessage(err), "warning");
        return;
      }

      if (subcommand === "status") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}. Run /ingest to create one.`, "info");
          return;
        }
        notify(
          `Pod "${binding.name}" (${binding.podId}) — ${Object.keys(binding.seen).length} files tracked.`,
          "info",
        );
        return;
      }

      if (subcommand === "sync") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}. Run /ingest first.`, "warning");
          return;
        }
        try {
          const report = await syncPod(api, root, binding);
          notify(isEmptyReport(report) ? "Pod already in sync." : describeReport(report), "info");
          for (const rel of report.conflicted) {
            notify(`Conflict (changed on both sides, left alone): ${rel}`, "warning");
          }
        } catch (err) {
          notify(`Pod sync failed: ${errorMessage(err)}`, "error");
        }
        return;
      }

      if (subcommand === "clear") {
        const binding = getPodBinding(root);
        if (!binding) {
          notify(`No pod bound to ${root}.`, "info");
          return;
        }
        const confirmed = await runtimeCtx.ui?.confirm?.(
          "Archive Dust pod",
          `Archive pod "${binding.name}" and stop routing files through it?\n` +
            "Local files are untouched. The pod can be restored from the Dust UI.",
        );
        if (!confirmed) return;
        try {
          await archivePod(api, binding.podId);
        } catch (err) {
          // The binding still goes, or the session would stay pointed at a pod
          // the user has asked to be rid of.
          notify(`Pod archive failed (unbinding anyway): ${errorMessage(err)}`, "warning");
        }
        forgetPodBinding(root);
        notify(`Pod "${binding.name}" archived and unbound.`, "info");
        return;
      }

      // Bare `/ingest [pathspec…]`: pick files, resolve the pod, upload.
      const pathspecs = subcommand ? argv : [];
      const candidates = candidateFiles(root, pathspecs).filter((rel) => isUploadable(root, rel));

      if (candidates.length === 0) {
        notify(
          pathspecs.length > 0
            ? `No files matched ${pathspecs.join(" ")} (or all were too large / ignored).`
            : `No files to ingest in ${root}. Hidden files and build directories are skipped.`,
          "warning",
        );
        return;
      }
      if (candidates.length > MAX_INGEST_FILES) {
        notify(
          `${candidates.length} files matched, over the ${MAX_INGEST_FILES} limit. ` +
            "Narrow it, e.g. /ingest src test.",
          "warning",
        );
        return;
      }

      const preview = candidates.slice(0, 20).join("\n");
      const more = candidates.length > 20 ? `\n… and ${candidates.length - 20} more` : "";
      const confirmed = await runtimeCtx.ui?.confirm?.(
        `Upload ${candidates.length} files to Dust pod "${podNameFor(root)}"`,
        `${preview}${more}\n\nThese files are copied to your Dust workspace so the agent can ` +
          "read and edit them with its free tools.",
      );
      if (!confirmed) return;

      try {
        const pod = await resolveOrCreatePod(api, podNameFor(root));
        const binding = getPodBinding(root) ?? { podId: pod.sId, name: pod.name, seen: {} };
        // A pod resolved by name may differ from the one recorded earlier (the
        // old one archived, say), so the binding always takes the live ids.
        binding.podId = pod.sId;
        binding.name = pod.name;
        savePodBinding(root, binding);

        const report = await ingestFiles(api, root, binding, candidates);
        notify(`Ingested ${report.pushed.length} files into pod "${pod.name}".`, "info");
        // A file the pod refused is not a failed ingest, but the user has to
        // know it is not there — the agent will not see it.
        for (const { rel, reason } of report.skipped) {
          notify(`Skipped ${rel}: ${reason}`, "warning");
        }
      } catch (err) {
        notify(`Ingest failed: ${errorMessage(err)}`, "error");
      }
    },
  });
}
