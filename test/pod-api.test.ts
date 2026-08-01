import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_EXPIRED_MESSAGE } from "../src/dust-constants.js";
import {
  archivePod,
  createPod,
  deletePod,
  deletePodFile,
  downloadPodFile,
  listPodFiles,
  listPods,
  movePodFile,
  type PodApi,
  resolveOrCreatePod,
  toRelativePath,
  unarchivePod,
  uploadPodFile,
} from "../src/dust-pod.js";

const BASE = "https://eu.dust.test/api/w/ws-1";

function makeApi(overrides: Partial<PodApi> = {}): PodApi {
  return {
    baseUrl: BASE,
    getAuthHeaders: () => ({ Authorization: "Bearer tok" }),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(body)).buffer),
  };
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
  };
}

type FetchCall = [string, { method?: string; body?: unknown; headers?: Record<string, string> }];

function calls(mock: { mock: { calls: unknown[][] } }): FetchCall[] {
  return mock.mock.calls as FetchCall[];
}

describe("dust pod API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates a pod with an empty memberIds array", async () => {
    // Dust answers 500 "Cannot add members to Pods on creation." if memberIds
    // is seeded with the creator, so the empty array is load-bearing, not
    // incidental.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ space: { sId: "vlt_1", name: "proj" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pod = await createPod(makeApi(), "proj");

    expect(pod).toEqual({ sId: "vlt_1", name: "proj" });
    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe(`${BASE}/spaces`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "proj",
      spaceKind: "project",
      isRestricted: true,
      managementMode: "manual",
      memberIds: [],
    });
  });

  it("reuses an existing pod of the same name instead of creating a second", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        spaces: [
          { sId: "vlt_other", name: "other", kind: "project" },
          { sId: "vlt_1", name: "proj", kind: "project" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pod = await resolveOrCreatePod(makeApi(), "proj");

    expect(pod).toMatchObject({ sId: "vlt_1", name: "proj" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls(fetchMock)[0][0]).toContain("kind=project");
  });

  it("creates a pod when no existing one matches the name", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ spaces: [{ sId: "vlt_x", name: "other", kind: "project" }] }))
      .mockResolvedValueOnce(jsonResponse({ space: { sId: "vlt_new", name: "proj" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pod = await resolveOrCreatePod(makeApi(), "proj");

    expect(pod.sId).toBe("vlt_new");
    expect(calls(fetchMock)[1][1].method).toBe("POST");
  });

  it("reports archived pods, since they still hold their name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        spaces: [
          { sId: "vlt_old", name: "proj", kind: "project", archivedAt: 1785408641322 },
          { sId: "vlt_live", name: "other", kind: "project", archivedAt: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listPods(makeApi())).toEqual([
      { sId: "vlt_old", name: "proj", archivedAt: 1785408641322 },
      { sId: "vlt_live", name: "other", archivedAt: null },
    ]);
  });

  it("un-archives rather than recreating, because archiving does not free the name", async () => {
    // /ingest clear archives the pod; a later /ingest must give the user a
    // working pod under the same name. Creating it again answers 400
    // `space_already_exists`, so reviving the existing one is the only route.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        spaces: [{ sId: "vlt_old", name: "proj", kind: "project", archivedAt: 1 }],
      }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const pod = await resolveOrCreatePod(makeApi(), "proj");

    expect(pod).toEqual({ sId: "vlt_old", name: "proj", archivedAt: null });
    const [url, init] = calls(fetchMock)[1];
    expect(url).toBe(`${BASE}/spaces/vlt_old/project_metadata`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ archive: false });
  });

  it("prefers a live pod over an archived one of the same name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        spaces: [
          { sId: "vlt_old", name: "proj", kind: "project", archivedAt: 1 },
          { sId: "vlt_live", name: "proj", kind: "project", archivedAt: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await resolveOrCreatePod(makeApi(), "proj")).sId).toBe("vlt_live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores non-project spaces when listing pods", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        spaces: [
          { sId: "vlt_g", name: "Company Data", kind: "global" },
          { sId: "vlt_p", name: "proj", kind: "project" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listPods(makeApi())).toEqual([{ sId: "vlt_p", name: "proj", archivedAt: null }]);
  });

  it("drops directory entries from a file listing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        files: [
          { path: "pod-vlt_1/src", fileName: "src", isDirectory: true, sizeBytes: 0, lastModifiedMs: 1 },
          { path: "pod-vlt_1/main.py", fileName: "main.py", isDirectory: false, sizeBytes: 5, lastModifiedMs: 2 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const files = await listPodFiles(makeApi(), "vlt_1");

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("pod-vlt_1/main.py");
  });

  it("downloads through the bare `pod/` scope prefix", async () => {
    // The listing reports `pod-{id}/main.py` but the REST rel wants `pod/main.py`.
    // Sending the canonical spelling here yields a 400 "Path must start with the
    // correct scope prefix", so the two forms must not be conflated.
    const fetchMock = vi.fn().mockResolvedValue(textResponse("print(1)\n"));
    vi.stubGlobal("fetch", fetchMock);

    const content = await downloadPodFile(makeApi(), "vlt_1", "src/main.py");

    expect(content.toString()).toBe("print(1)\n");
    expect(calls(fetchMock)[0][0]).toBe(`${BASE}/spaces/vlt_1/files/pod/src/main.py`);
  });

  it("moves with a bare-prefixed source and an unprefixed destination", async () => {
    // The two ends really are spelled differently. Sending canonical
    // `pod-{id}/…` for either answers 500 "No such object" from the storage
    // layer, so getting this wrong looks like an outage rather than a bug.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await movePodFile(makeApi(), "vlt_1", "main.py", "src/main.py");

    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe(`${BASE}/spaces/vlt_1/files/pod/main.py`);
    expect(JSON.parse(String(init.body))).toEqual({ destRelativeFilePath: "src/main.py" });
  });

  it("deletes through the bare `pod/` scope prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await deletePodFile(makeApi(), "vlt_1", "main.py");

    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe(`${BASE}/spaces/vlt_1/files/pod/main.py`);
    expect(init.method).toBe("DELETE");
  });

  it("deletes the existing file before uploading, since uploads do not overwrite", async () => {
    // Dust de-duplicates a colliding name by suffixing the file id
    // (`calc.py` -> `calc_fil_abc.py`). The original then survives with its old
    // mtime, so the next sync sees no change and the edit never propagates.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "/api/w/ws-1/files/fil_1" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", path: "pod-vlt_1/main.py" } }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadPodFile(makeApi(), "vlt_1", "main.py", Buffer.from("print(1)"));

    const [deleteUrl, deleteInit] = calls(fetchMock)[0];
    expect(deleteUrl).toBe(`${BASE}/spaces/vlt_1/files/pod/main.py`);
    expect(deleteInit.method).toBe("DELETE");

    const [reserveUrl, reserveInit] = calls(fetchMock)[1];
    expect(reserveUrl).toBe(`${BASE}/files`);
    expect(JSON.parse(String(reserveInit.body))).toMatchObject({
      fileName: "main.py",
      useCase: "project_context",
      useCaseMetadata: { spaceId: "vlt_1" },
    });
    // Relative upload URLs resolve against the host, not the /api/w/… base.
    expect(calls(fetchMock)[2][0]).toBe("https://eu.dust.test/api/w/ws-1/files/fil_1");
    // Landed where asked, so no move.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uploads even when the pre-delete fails, as it does on a first ingest", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse("not found", 404))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { path: "pod-vlt_1/main.py" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadPodFile(makeApi(), "vlt_1", "main.py", Buffer.from("x"))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("moves a nested file into place after upload, since uploads land at the pod root", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", path: "pod-vlt_1/main.py" } }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await uploadPodFile(makeApi(), "vlt_1", "src/deep/main.py", Buffer.from("x"));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [moveUrl, moveInit] = calls(fetchMock)[3];
    expect(moveUrl).toBe(`${BASE}/spaces/vlt_1/files/pod/main.py`);
    expect(JSON.parse(String(moveInit.body))).toEqual({
      destRelativeFilePath: "src/deep/main.py",
    });
  });

  it("moves the file back into place when the upload reports a renamed path", async () => {
    // Belt and braces behind the pre-delete: if Dust renames anyway, the move
    // is driven by where the file actually landed, not where we asked.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { path: "pod-vlt_1/main_fil_abc.py" } }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await uploadPodFile(makeApi(), "vlt_1", "main.py", Buffer.from("x"));

    const [moveUrl, moveInit] = calls(fetchMock)[3];
    expect(moveUrl).toBe(`${BASE}/spaces/vlt_1/files/pod/main_fil_abc.py`);
    expect(JSON.parse(String(moveInit.body))).toEqual({ destRelativeFilePath: "main.py" });
  });

  it("falls back to the file name when the upload response says nothing useful", async () => {
    // An upload that answers 200 with a non-JSON body still succeeded; assume
    // it landed under the name we gave it rather than failing the ingest.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
      .mockResolvedValueOnce(textResponse("OK"))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await uploadPodFile(makeApi(), "vlt_1", "src/main.py", Buffer.from("x"));

    // Assumed to be at the root under its own name, so it still gets moved.
    expect(calls(fetchMock)[3][0]).toBe(`${BASE}/spaces/vlt_1/files/pod/main.py`);
  });

  it("surfaces a failed upload rather than reporting success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
      .mockResolvedValueOnce(textResponse("too big", 413));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadPodFile(makeApi(), "vlt_1", "main.py", Buffer.from("x")))
      .rejects.toThrow(/Pod upload failed for main.py: HTTP 413/);
  });

  it("deletes a pod outright, which Dust scrubs rather than archives", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await deletePod(makeApi(), "vlt_1");

    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe(`${BASE}/spaces/vlt_1`);
    expect(init.method).toBe("DELETE");
  });

  it("archives a pod through project_metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await archivePod(makeApi(), "vlt_1");

    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe(`${BASE}/spaces/vlt_1/project_metadata`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ archive: true });
  });

  it("refreshes once and retries after a 401", async () => {
    // An ingest of a few hundred files runs longer than the ~15 minute access
    // token, so mid-sequence expiry is routine rather than exceptional.
    let token = "stale";
    const fetchMock = vi.fn((_url: string, init?: { headers?: Record<string, string> }) =>
      Promise.resolve(
        init?.headers?.Authorization === "Bearer fresh"
          ? jsonResponse({ spaces: [] })
          : jsonResponse({}, 401),
      ));
    vi.stubGlobal("fetch", fetchMock);

    const refreshAuth = vi.fn(async () => {
      token = "fresh";
      return true;
    });

    const pods = await listPods(makeApi({
      getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
      refreshAuth,
    }));

    expect(pods).toEqual([]);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits out a 429 and retries, rather than losing the file", async () => {
    // Dust rate-limits the upload-reserve step to 40/min per workspace
    // ("Aggressively rate limit file uploads" — front-api routes/w/[wId]/files).
    // A concurrent ingest of any size will meet it. Without a retry the error
    // surfaces as a per-file `skipped`, which reads as "the pod rejected this
    // file" — permanent, when in fact waiting a moment would have worked.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { type: "rate_limit_error" } }, 429))
      .mockResolvedValueOnce(jsonResponse({ spaces: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pods = await listPods(makeApi());

    expect(pods).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After on a 429 instead of guessing", async () => {
    // The server knows when its sliding window frees up; we do not.
    const sleeps: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ...jsonResponse({}, 429), headers: new Headers({ "retry-after": "2" }) })
      .mockResolvedValueOnce(jsonResponse({ spaces: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listPods(makeApi({ sleep: async (ms: number) => void sleeps.push(ms) } as never));

    expect(sleeps).toEqual([2000]);
  });

  it("gives up on a 429 that never clears, so a sync cannot hang forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPods(makeApi({ sleep: async () => {} } as never)))
      .rejects.toThrow(/429/);
    // Bounded: the initial attempt plus a fixed number of retries.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("reports the session as expired when the refresh cannot recover a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPods(makeApi({ refreshAuth: async () => false })))
      .rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry forever when the refreshed token is also rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPods(makeApi({ refreshAuth: async () => true })))
      .rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["download", () => downloadPodFile(makeApi(), "vlt_1", "main.py"), /Pod download failed for main.py: HTTP 404/],
    ["delete", () => deletePodFile(makeApi(), "vlt_1", "main.py"), /Pod delete failed for main.py: HTTP 403/],
    ["move", () => movePodFile(makeApi(), "vlt_1", "a.py", "b.py"), /Pod move failed a.py -> b.py: HTTP 400/],
    ["archive", () => archivePod(makeApi(), "vlt_1"), /Pod archive failed: HTTP 500/],
    ["delete-pod", () => deletePod(makeApi(), "vlt_1"), /Pod delete failed: HTTP 500/],
    ["unarchive", () => unarchivePod(makeApi(), "vlt_1"), /Pod unarchive failed: HTTP 500/],
  ])("reports a failed %s with the status and body", async (_name, call, expected) => {
    // Every one of these is a step in a sync. Swallowing the failure would let
    // the watermark advance past a change that never landed, which silently
    // desynchronises the two copies.
    const status = { download: 404, delete: 403, move: 400, archive: 500, unarchive: 500, "delete-pod": 500 }[_name] ?? 500;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("nope", status)));

    await expect(call()).rejects.toThrow(expected);
  });

  it("reports a non-JSON response rather than throwing a parse error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("<html>gateway</html>")));

    await expect(listPods(makeApi())).rejects.toThrow(/returned non-JSON on \/spaces/);
  });

  it("reports a failed listing with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("boom", 500)));

    await expect(listPodFiles(makeApi(), "vlt_1")).rejects.toThrow(/Dust pod API 500 on \/spaces\/vlt_1\/files/);
  });

  it("treats a listing with no files array as empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    expect(await listPodFiles(makeApi(), "vlt_1")).toEqual([]);
    expect(await listPods(makeApi())).toEqual([]);
  });

  it("strips the canonical prefix, and leaves an already-relative path alone", () => {
    expect(toRelativePath("vlt_1", "pod-vlt_1/src/main.py")).toBe("src/main.py");
    expect(toRelativePath("vlt_1", "src/main.py")).toBe("src/main.py");
  });

  describe("path segments with URL-significant characters", () => {
    // `#` starts a fragment, `?` a query string and `%` a percent-escape, so a
    // filename with any of them interpolated raw into a URL targets the wrong
    // resource: `notes#1.md` becomes a request for `notes`, with `1.md`
    // silently dropped as a client-side fragment.

    it("encodes a `#` in the path when downloading", async () => {
      const fetchMock = vi.fn().mockResolvedValue(textResponse("body"));
      vi.stubGlobal("fetch", fetchMock);

      await downloadPodFile(makeApi(), "vlt_1", "notes#1.md");

      expect(calls(fetchMock)[0][0]).toBe(`${BASE}/spaces/vlt_1/files/pod/notes%231.md`);
    });

    it("encodes a `?` in the path when deleting", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      await deletePodFile(makeApi(), "vlt_1", "a?.py");

      expect(calls(fetchMock)[0][0]).toBe(`${BASE}/spaces/vlt_1/files/pod/a%3F.py`);
    });

    it("encodes the source path when moving, without touching the plain-path destination", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      await movePodFile(makeApi(), "vlt_1", "notes#1.md", "dest#2.md");

      const [url, init] = calls(fetchMock)[0];
      expect(url).toBe(`${BASE}/spaces/vlt_1/files/pod/notes%231.md`);
      // The destination travels in the JSON body, not the URL, so it is not a
      // path-escaping hazard and is sent exactly as given.
      expect(JSON.parse(String(init.body))).toEqual({ destRelativeFilePath: "dest#2.md" });
    });

    it("still encodes each segment while preserving the directory structure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(textResponse("body"));
      vi.stubGlobal("fetch", fetchMock);

      await downloadPodFile(makeApi(), "vlt_1", "src/notes#1.md");

      expect(calls(fetchMock)[0][0]).toBe(`${BASE}/spaces/vlt_1/files/pod/src/notes%231.md`);
    });

    it("encodes the pre-delete and move-back paths of an upload that collides with a special-character name", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
        .mockResolvedValueOnce(jsonResponse({ file: { path: "pod-vlt_1/notes#1_fil_abc.md" } }))
        .mockResolvedValueOnce(jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      await uploadPodFile(makeApi(), "vlt_1", "notes#1.md", Buffer.from("x"));

      const [deleteUrl] = calls(fetchMock)[0];
      expect(deleteUrl).toBe(`${BASE}/spaces/vlt_1/files/pod/notes%231.md`);
      const [moveUrl, moveInit] = calls(fetchMock)[3];
      expect(moveUrl).toBe(`${BASE}/spaces/vlt_1/files/pod/notes%231_fil_abc.md`);
      expect(JSON.parse(String(moveInit.body))).toEqual({ destRelativeFilePath: "notes#1.md" });
    });
  });
});
