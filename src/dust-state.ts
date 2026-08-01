import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DustAgent, DustCredentials, Workspace } from "./dust-types.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const STATE_FILE = "dust-state.json";
const AUTH_FILE = "auth.json";

/**
 * Extension-owned state.
 *
 * pi 0.81 removed `AuthStorage` from the extension API, so `auth.json` is now
 * pi's private store: it owns the OAuth token trio (access/refresh/expires) and
 * rotates it through the `oauth.refreshToken` hook we register in
 * `dust-provider.ts`. Everything below is Dust-specific state that pi knows
 * nothing about, so we persist it ourselves instead of smuggling it into the
 * credential blob.
 */
export interface DustState {
  workspaceId?: string;
  workspaces?: Workspace[];
  agents?: DustAgent[];
  region?: string;
  username?: string;
  conversations?: Record<string, string>;
  /** Pod binding per project root, keyed by absolute path. See `DustPodBinding`. */
  pods?: Record<string, DustPodBinding>;
  /**
   * Set when we detect the stored session is dead (refresh rejected, or Dust
   * answered 401). pi still holds a token-shaped blob in auth.json, so this is
   * how we force the "logged out" path until the next successful login.
   */
  invalidated?: boolean;
}

/**
 * A project root ingested into a Dust Pod.
 *
 * `seen` is the sync watermark: for each relative path, the pod-side
 * `lastModifiedMs` and the SHA-256 of the content as of the last time the two
 * sides agreed. Both halves are needed to tell the three cases apart — pod
 * changed (download), local changed (upload), or both (conflict, leave alone).
 */
export interface DustPodBinding {
  podId: string;
  name: string;
  seen: Record<string, { podMs: number; hash: string }>;
  /**
   * The pathspecs `/ingest` was given, replayed by the pre-turn push so files
   * created since are picked up. Without them the push would either miss new
   * files or, if it re-selected the whole tree, sweep up everything the user
   * deliberately left out. Absent means the whole directory.
   */
  pathspecs?: string[];
  /** Skill names synced into the pod by `/dust-skills`. */
  skills?: string[];
  /**
   * Per-skill digest of what was actually uploaded, keyed by skill name.
   *
   * `skills` alone records a *selection*: it survives the skill being edited on
   * disk afterwards, so the pod's copy silently drifts from the local one and
   * the agent reads stale instructions. Comparing a fresh `fingerprintSkill`
   * against this turns "you picked it" into "this exact content is up there",
   * without a network round trip.
   *
   * Optional and written only by `/dust-skills`, so a binding from before this
   * existed still loads — its skills simply report as unverified until the next
   * sync fills them in.
   */
  skillFingerprints?: Record<string, string>;
  /**
   * Hash of the AGENTS.md last written to the pod.
   *
   * Lets a turn skip the upload when the instructions have not changed, which
   * saves a request and — more importantly — keeps the file byte-identical so
   * conversations in the pod keep sharing one cached prompt prefix.
   */
  agentsMdHash?: string;
}

const STATE_KEYS = [
  "workspaceId",
  "workspaces",
  "agents",
  "region",
  "username",
  "conversations",
  "pods",
  "invalidated",
] as const satisfies readonly (keyof DustState)[];

export function resolveAgentDir(): string {
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

function statePath(): string {
  return join(resolveAgentDir(), STATE_FILE);
}

function authPath(): string {
  return join(resolveAgentDir(), AUTH_FILE);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf8");
    if (!content.trim()) {
      return null;
    }
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pickStateFields(source: Record<string, unknown>): DustState {
  const state: Record<string, unknown> = {};
  for (const key of STATE_KEYS) {
    if (source[key] !== undefined) {
      state[key] = source[key];
    }
  }
  return state as DustState;
}

/**
 * Reads the OAuth credential pi persists for the `dust` provider.
 *
 * This is the same lookup as pi's own `readStoredCredential("dust")`; we
 * reimplement it so the extension keeps working against pi builds that do not
 * re-export it, and so tests can point `PI_CODING_AGENT_DIR` at a temp dir.
 */
export function readAuthCredential(): DustCredentials | null {
  const parsed = readJsonFile(authPath());
  const stored = parsed?.dust;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  return stored as DustCredentials;
}

export function readDustState(): DustState {
  const parsed = readJsonFile(statePath());
  return parsed ? pickStateFields(parsed) : {};
}

export function writeDustState(state: DustState): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write-then-rename so a crash mid-write cannot truncate existing state.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pickStateFields(state as Record<string, unknown>), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

export function patchDustState(patch: DustState): DustState {
  const next = { ...readDustState(), ...patch };
  writeDustState(next);
  return next;
}

/**
 * One-time carry-over for installs that predate the split.
 *
 * Older builds stored agents/workspaces/conversations inside the auth.json
 * credential. If we have no state file yet but that legacy state is present,
 * seed the state file from it. auth.json is left untouched — pi owns it, and
 * the stale extra keys there are harmless.
 */
export function migrateLegacyState(): DustState {
  const existing = readDustState();
  if (Object.keys(existing).length > 0) {
    return existing;
  }

  const legacy = readAuthCredential();
  if (!legacy) {
    return existing;
  }

  const seeded = pickStateFields(legacy as unknown as Record<string, unknown>);
  if (Object.keys(seeded).length === 0) {
    return existing;
  }

  writeDustState(seeded);
  return seeded;
}

/**
 * The merged view the rest of the extension consumes: tokens from pi, Dust
 * state from us. Returns null when pi has no `dust` credential at all.
 */
export function getStoredCredentials(): DustCredentials | null {
  const auth = readAuthCredential();
  if (!auth) {
    return null;
  }

  const state = readDustState();
  const merged: DustCredentials = {
    ...state,
    type: "oauth",
    access: auth.access ?? "",
    refresh: auth.refresh ?? "",
    expires: auth.expires ?? 0,
  };

  if (state.invalidated) {
    return { ...merged, access: "", refresh: "", expires: 0 };
  }
  return merged;
}

/**
 * Persists only the Dust-specific half of a credential object. Token fields are
 * deliberately dropped: pi rotates and stores those itself.
 *
 * `conversations` is dropped too. Callers hold a credential snapshot read at
 * the top of a handler and write it back much later, by which time a session
 * may have attached to or created a conversation; writing the snapshot's map
 * back would silently undo that. The map is written only by
 * `saveConversationId` and `forgetConversationId`, never as part of a
 * credential.
 */
export function persistCredentialState(credentials: DustCredentials): void {
  const { conversations: _conversations, ...rest } = credentials;
  const state = pickStateFields(rest as unknown as Record<string, unknown>);
  patchDustState(state);
}

export function markInvalidated(): void {
  patchDustState({ invalidated: true });
}

export function clearInvalidated(): void {
  patchDustState({ invalidated: false });
}

/**
 * Drops mappings whose session file is gone — deleted from `/resume`, or living
 * under a scratch directory that no longer exists. The map is append-only
 * otherwise, so without this it grows for the life of the install.
 *
 * Only a missing file counts. Anything we cannot answer (a permission error, a
 * transient stat failure) keeps its entry: losing a live mapping costs the user
 * a conversation, while keeping a dead one costs a line of JSON.
 *
 * pi creates a session file on its first assistant message, so a session that
 * has attached to a conversation but not yet been answered is briefly missing
 * from disk. A concurrent pi could sweep it away in that window; it would then
 * start a fresh conversation on its next resume, which is the same outcome as
 * before any of this existed.
 */
function pruneMissingSessions(conversations: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [sessionFile, conversationId] of Object.entries(conversations)) {
    try {
      // Not `existsSync`: it answers false for a file it merely cannot reach,
      // so an unreadable or briefly unmounted sessions directory would read as
      // "every session deleted". `statSync` tells the two apart — undefined for
      // a missing file, a throw for anything else.
      if (statSync(sessionFile, { throwIfNoEntry: false }) === undefined) continue;
    } catch {
      // Undecidable, so not evidence the session is gone.
    }
    kept[sessionFile] = conversationId;
  }
  return kept;
}

/**
 * Forgets a session's conversation, for when Dust says it is gone. Left in
 * place it would be re-checked and re-reported on every later start of that
 * session, until some message happened to overwrite it.
 */
export function forgetConversationId(sessionFile: string): void {
  const conversations = { ...(readDustState().conversations ?? {}) };
  if (!(sessionFile in conversations)) return;
  delete conversations[sessionFile];
  patchDustState({ conversations });
}

export function getPodBinding(root: string): DustPodBinding | null {
  return readDustState().pods?.[root] ?? null;
}

export function savePodBinding(root: string, binding: DustPodBinding): void {
  patchDustState({ pods: { ...(readDustState().pods ?? {}), [root]: binding } });
}

export function forgetPodBinding(root: string): void {
  const pods = { ...(readDustState().pods ?? {}) };
  if (!(root in pods)) return;
  delete pods[root];
  patchDustState({ pods });
}

export function saveConversationId(sessionFile: string, conversationId: string): void {
  const state = readDustState();
  patchDustState({
    // The write is the natural moment to sweep: it already rewrites the map, and
    // it is rare enough that stat-ing the other entries costs nothing.
    conversations: { ...pruneMissingSessions(state.conversations ?? {}), [sessionFile]: conversationId },
  });
}
