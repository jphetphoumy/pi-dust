import { basename } from "node:path";
import { DUST_HEADERS, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import { errorMessage } from "./dust-validation.js";

/**
 * Client for Dust "Pods" — spaces of kind `project`, which carry a file tree
 * the agent sees mounted in its sandbox.
 *
 * Why this exists: tools served by our own MCP server are billed as an
 * *external* server, a flat 3 AWU per call with no free tier. Dust's internal
 * `files__*` toolset is `basic` + `freeUsage`, so it costs nothing. Putting the
 * user's files in a Pod lets the agent read and edit them with the free tools,
 * and we only pay for the calls that genuinely need the user's machine (bash).
 *
 * Two quirks of the underlying API are load-bearing here:
 *
 *  - Pod file endpoints live on the *internal* `/api/w/{wId}` API, not
 *    `/api/v1`. The public `project_files` route is system-key-only. The OAuth
 *    bearer token we already hold authenticates both, so this is a base-URL
 *    difference and nothing more.
 *  - The same file has two path spellings. REST rels use the bare `pod/`
 *    scope prefix (`/files/pod/src/main.py`); listings and the agent use the
 *    canonical `pod-{podId}/src/main.py`. Mixing them up yields a 400.
 */

export interface PodRef {
  sId: string;
  name: string;
  /** Epoch ms when the pod was archived, or null while it is live. */
  archivedAt?: number | null;
}

export interface PodFileEntry {
  path: string;
  fileName: string;
  isDirectory: boolean;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface PodApi {
  /** Private API base, e.g. `https://eu.dust.tt/api/w/afoH8Y2BIz`. */
  baseUrl: string;
  getAuthHeaders: () => Record<string, string>;
  /** Single-flight refresh shared with the rest of the session; see `DustSessionRuntime`. */
  refreshAuth?: () => Promise<boolean>;
  /** Injectable delay, so the 429 backoff does not make tests wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How often a rate-limited request is retried before giving up.
 *
 * Dust limits the upload-reserve step to 40 per 60 seconds per workspace, as a
 * sliding window. Four retries at the backoff below spans well over a minute,
 * which is the whole window — so anything still refused after that is not a
 * burst we can wait out, and reporting it beats hanging the sync.
 */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = [1_000, 4_000, 15_000, 30_000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retrying a 429.
 *
 * `Retry-After` is preferred wherever the server sends one: it knows when its
 * window frees up and we are guessing. The header is defined as either seconds
 * or an HTTP date; only the seconds form is handled, since that is what Dust
 * sends, and an unparseable value falls back to the schedule.
 */
function retryDelayMs(res: { headers?: { get?: (name: string) => string | null } }, attempt: number): number {
  const header = res.headers?.get?.("retry-after");
  const seconds = header == null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  return RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
}

/** Strips the canonical `pod-{id}/` prefix a listing reports down to a plain relative path. */
export function toRelativePath(podId: string, canonicalPath: string): string {
  const prefix = `pod-${podId}/`;
  return canonicalPath.startsWith(prefix) ? canonicalPath.slice(prefix.length) : canonicalPath;
}

/**
 * Encodes a relative path for use in a URL, one segment at a time.
 *
 * A file name is not automatically URL-safe: `#` starts a fragment, `?` starts
 * a query string, and `%` begins a percent-escape, so `notes#1.md` interpolated
 * raw targets `/files/pod/notes` with `1.md` dropped from the request entirely.
 * Each segment is escaped and rejoined with a literal `/`, so the path
 * structure itself is untouched.
 */
export function encodePodPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Issues a private-API request, refreshing once on 401 and waiting out a 429.
 *
 * Ingesting a large tree is many requests and can outlive the ~15 minute access
 * token, so the 401 retry is not theoretical.
 *
 * The 429 retry matters because Dust rate-limits the upload-reserve step to 40
 * per 60 seconds per workspace. Uploading concurrently makes meeting that limit
 * the norm rather than the exception, and without this the error would surface
 * as a per-file `skipped` — which reads as a permanent rejection by the pod,
 * when waiting a second would have worked. Retrying here rather than in the
 * sync loop covers every limited endpoint at once.
 */
async function request(
  api: PodApi,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: {
        ...DUST_HEADERS,
        ...api.getAuthHeaders(),
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

  const sleep = api.sleep ?? defaultSleep;
  let res = await send();
  for (let attempt = 0; res.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
    const delay = retryDelayMs(res, attempt);
    debugLog("dust:pod", "Rate limited, backing off", { path, attempt: attempt + 1, delay });
    await sleep(delay);
    res = await send();
  }
  if (res.status !== 401) return res;

  if (!(await api.refreshAuth?.())) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  const retried = await send();
  if (retried.status === 401) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  return retried;
}

async function requestJson<T>(api: PodApi, path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(api, path, init);
  const text = await res.text();
  if (!res.ok) {
    debugLog("dust:pod", "Request failed", { path, status: res.status, body: text.slice(0, 400) });
    throw new Error(`Dust pod API ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Dust pod API returned non-JSON on ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * Every pod in the workspace, archived ones included.
 *
 * Archived pods stay in this listing with `archivedAt` set, and they still hold
 * their name — creating a pod that reuses it answers 400 `space_already_exists`
 * — so callers have to reason about them rather than skip them.
 */
export async function listPods(api: PodApi): Promise<PodRef[]> {
  const data = await requestJson<{
    spaces?: Array<{ sId?: string; name?: string; kind?: string; archivedAt?: number | null }>;
  }>(api, "/spaces?kind=project");
  return (data.spaces ?? [])
    .filter((space): space is { sId: string; name: string; kind: string; archivedAt?: number | null } =>
      typeof space.sId === "string" && typeof space.name === "string" && space.kind === "project",
    )
    .map((space) => ({ sId: space.sId, name: space.name, archivedAt: space.archivedAt ?? null }));
}

/**
 * Deletes the pod outright.
 *
 * Dust soft-deletes the space and launches a scrub workflow, so unlike
 * `archivePod` this is not something the user can undo from the UI. Callers
 * must confirm first.
 */
export async function deletePod(api: PodApi, podId: string): Promise<void> {
  const res = await request(api, `/spaces/${podId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod delete failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
}

export async function unarchivePod(api: PodApi, podId: string): Promise<void> {
  const res = await request(api, `/spaces/${podId}/project_metadata`, {
    method: "PATCH",
    body: JSON.stringify({ archive: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod unarchive failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
}

/**
 * Pods reject `memberIds` on creation — the API answers 500 "Cannot add
 * members to Pods on creation." The creator is added implicitly, so the array
 * has to be sent empty rather than seeded with the current user.
 */
export async function createPod(api: PodApi, name: string): Promise<PodRef> {
  const data = await requestJson<{ space: { sId: string; name: string } }>(api, "/spaces", {
    method: "POST",
    body: JSON.stringify({
      name,
      spaceKind: "project",
      isRestricted: true,
      managementMode: "manual",
      memberIds: [],
    }),
  });
  debugLog("dust:pod", "Created pod", { name, sId: data.space.sId });
  return { sId: data.space.sId, name: data.space.name };
}

/**
 * The pod for a project name: reuse a live one, revive an archived one, or
 * create it.
 *
 * The middle case exists because archiving does not release the name. After
 * `/ingest clear`, creating the pod again fails with `space_already_exists`, so
 * the only way to give the user a working pod under the name they expect is to
 * un-archive the one that is already there. Its old files are harmless — every
 * upload replaces the path it targets.
 */
export async function resolveOrCreatePod(api: PodApi, name: string): Promise<PodRef> {
  const sameName = (await listPods(api)).filter((pod) => pod.name === name);

  const live = sameName.find((pod) => pod.archivedAt == null);
  if (live) {
    debugLog("dust:pod", "Reusing existing pod", live);
    return live;
  }

  const archived = sameName[0];
  if (archived) {
    debugLog("dust:pod", "Un-archiving pod", archived);
    await unarchivePod(api, archived.sId);
    return { ...archived, archivedAt: null };
  }

  return createPod(api, name);
}

export async function listPodFiles(api: PodApi, podId: string): Promise<PodFileEntry[]> {
  const data = await requestJson<{ files?: PodFileEntry[] }>(api, `/spaces/${podId}/files`);
  return (data.files ?? []).filter((entry) => !entry.isDirectory);
}

/**
 * Uploads one file into the pod, replacing whatever was at that path.
 *
 * Three steps, each forced on us by how the upload endpoint behaves:
 *
 *  - Delete first. Uploading over an existing name does not overwrite it; Dust
 *    de-duplicates by suffixing the file id, so `calc.py` becomes
 *    `calc_fil_abc123.py`. The pod then holds two copies and the original keeps
 *    its old mtime, so the next sync concludes nothing changed — a silent
 *    failure to propagate edits, which is the worst kind.
 *  - Reserve a file row, which returns the URL to push the bytes to.
 *  - Move it into place. Uploads land at the pod root whatever name they were
 *    given, so anything destined for a subdirectory has to be moved; the move
 *    uses the path the upload actually reported rather than the one we asked
 *    for, so a rename we did not anticipate still ends up in the right place.
 */
export async function uploadPodFile(
  api: PodApi,
  podId: string,
  relPath: string,
  content: Buffer,
): Promise<void> {
  // Best effort: a 404 for a path that does not exist yet is the normal case on
  // first ingest, and there is nothing useful to do with any other failure —
  // the upload below will surface a real problem on its own.
  await deletePodFile(api, podId, relPath).catch(() => undefined);

  const fileName = basename(relPath);
  const reserved = await requestJson<{ file: { sId: string; uploadUrl: string } }>(api, "/files", {
    method: "POST",
    body: JSON.stringify({
      contentType: "text/plain",
      fileName,
      fileSize: content.length,
      useCase: "project_context",
      useCaseMetadata: { spaceId: podId },
    }),
  });

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)], { type: "text/plain" }), fileName);
  const uploadUrl = reserved.file.uploadUrl.startsWith("http")
    ? reserved.file.uploadUrl
    : `${new URL(api.baseUrl).origin}${reserved.file.uploadUrl}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...DUST_HEADERS, ...api.getAuthHeaders() },
    body: form,
  });
  const upText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Pod upload failed for ${relPath}: HTTP ${res.status} — ${upText.slice(0, 200)}`);
  }

  const landedPath = parseUploadedPath(upText);
  const landedRel = landedPath ? toRelativePath(podId, landedPath) : fileName;
  if (landedRel !== relPath) {
    await movePodFile(api, podId, landedRel, relPath);
  }
}

/** The canonical path an upload reported landing at, when it says. */
function parseUploadedPath(body: string): string | null {
  try {
    const path = (JSON.parse(body) as { file?: { path?: unknown } })?.file?.path;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

/**
 * Moves a file inside the pod.
 *
 * The two ends are spelled differently, which is easy to get wrong: the source
 * is a scoped path in the URL and takes the bare `pod/` prefix, like GET and
 * DELETE, while the destination is a plain path relative to the pod root with
 * no prefix at all. Sending canonical `pod-{id}/…` for either answers 500 with
 * a "No such object" from the storage layer rather than a validation error, so
 * the mistake surfaces as an infrastructure failure.
 */
export async function movePodFile(
  api: PodApi,
  podId: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const res = await request(api, `/spaces/${podId}/files/pod/${encodePodPath(fromRel)}`, {
    method: "POST",
    body: JSON.stringify({ destRelativeFilePath: toRel }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod move failed ${fromRel} -> ${toRel}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
}

export async function downloadPodFile(api: PodApi, podId: string, relPath: string): Promise<Buffer> {
  const res = await request(api, `/spaces/${podId}/files/pod/${encodePodPath(relPath)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod download failed for ${relPath}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function deletePodFile(api: PodApi, podId: string, relPath: string): Promise<void> {
  const res = await request(api, `/spaces/${podId}/files/pod/${encodePodPath(relPath)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod delete failed for ${relPath}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
}

/**
 * Archives the pod. Pods are workspace-visible objects, so a session that
 * creates one owes the workspace a way to put it away again; archiving is
 * reversible from the Dust UI, unlike deleting the space outright.
 */
export async function archivePod(api: PodApi, podId: string): Promise<void> {
  const res = await request(api, `/spaces/${podId}/project_metadata`, {
    method: "PATCH",
    body: JSON.stringify({ archive: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pod archive failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
}
