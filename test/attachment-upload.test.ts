import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFilesToConversation, toContentFragments } from "../src/dust-files.js";
import type { PendingAttachment } from "../src/dust-types.js";

const BASE_URL = "https://dust.test/api/v1/w/ws-1";

function makeAttachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    path: "/home/dev/app/src/big.ts",
    fileName: "big.ts",
    contentType: "text/typescript",
    bytes: Buffer.from("const answer = 42;"),
    hash: "hash-1",
    marker: '<file name="/home/dev/app/src/big.ts">\nconst answer = 42;\n</file>\n',
    start: 0,
    end: 60,
    inlined: true,
    ...overrides,
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function uploadFlow() {
  return vi.fn()
    .mockResolvedValueOnce(okJson({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }))
    .mockResolvedValueOnce(okJson({ file: { sId: "fil_1" } }))
    .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_1" } }));
}

function attach(overrides: Partial<Parameters<typeof attachFilesToConversation>[0]> = {}) {
  return attachFilesToConversation({
    baseUrl: BASE_URL,
    getAuthHeaders: () => ({ Authorization: "Bearer token" }),
    signal: undefined,
    conversationSId: "conv-1",
    attachments: [makeAttachment()],
    cache: new Map<string, string>(),
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("attachFilesToConversation", () => {
  it("creates the file, uploads its bytes and attaches it as a content fragment", async () => {
    const fetchMock = uploadFlow();
    vi.stubGlobal("fetch", fetchMock);

    const attached = await attach();

    expect(attached).toEqual([
      { attachment: expect.objectContaining({ fileName: "big.ts" }), fileId: "fil_1", reused: false },
    ]);

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(`${BASE_URL}/files`);
    expect(JSON.parse(createInit.body)).toEqual({
      contentType: "text/typescript",
      fileName: "big.ts",
      fileSize: 18,
      useCase: "conversation",
      useCaseMetadata: { conversationId: "conv-1" },
    });
    expect(createInit.headers.Authorization).toBe("Bearer token");

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe("https://upload.test/fil_1");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const uploaded = (uploadInit.body as FormData).get("file") as File;
    expect(uploaded.name).toBe("big.ts");
    expect(await uploaded.text()).toBe("const answer = 42;");
    // fetch has to set the multipart boundary itself.
    expect(uploadInit.headers["Content-Type"]).toBeUndefined();

    const [fragmentUrl, fragmentInit] = fetchMock.mock.calls[2];
    expect(fragmentUrl).toBe(`${BASE_URL}/assistant/conversations/conv-1/content_fragments`);
    expect(JSON.parse(fragmentInit.body)).toEqual({ title: "big.ts", fileId: "fil_1" });
  });

  it("uploads without a conversation id and posts no fragment before the conversation exists", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_2", uploadUrl: "https://upload.test/fil_2" } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_2" } }));
    vi.stubGlobal("fetch", fetchMock);

    const attached = await attach({ conversationSId: null });

    expect(attached).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).useCaseMetadata).toBeUndefined();
    expect(toContentFragments(attached)).toEqual([{ title: "big.ts", fileId: "fil_2" }]);
  });

  it("remembers uploaded files so re-attaching one in the same conversation is free", async () => {
    const fetchMock = uploadFlow();
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    await attach({ cache });
    expect(cache.get("hash-1")).toBe("fil_1");

    const again = await attach({ cache });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(again).toEqual([
      { attachment: expect.objectContaining({ fileName: "big.ts" }), fileId: "fil_1", reused: true },
    ]);
  });

  it("does not re-attach a reused file as a second content fragment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const attached = await attach({ cache: new Map([["hash-1", "fil_1"]]) });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toContentFragments(attached)).toEqual([]);
  });

  it("keeps a file inline when Dust rejects the upload request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "file_type_not_supported",
    });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    await expect(attach({ cache })).resolves.toEqual([]);
    expect(cache.size).toBe(0);
  });

  it("keeps a file inline when the byte upload fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_3", uploadUrl: "https://upload.test/fil_3" } }))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(attach()).resolves.toEqual([]);
  });

  // A failed text upload really does "stay inline" — its marker still carries
  // the whole body. A failed image upload does not: nothing about an image
  // reaches Dust except through this call, so the same log line would read as
  // the harmless case when it is not. The two must be distinguishable without
  // reading the stack trace.
  it("logs an image upload failure distinctly from a text upload failure", async () => {
    process.env.PI_DUST_DEBUG = "1";
    process.env.PI_DUST_LOG_FILE = "/dev/null";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    vi.stubGlobal("fetch", fetchMock);

    await attach({
      attachments: [
        makeAttachment({ fileName: "shot.png", contentType: "image/png", hash: "hash-image" }),
      ],
    });

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("keeping it inline");
    expect(logged.toLowerCase()).toContain("image");

    delete process.env.PI_DUST_DEBUG;
    delete process.env.PI_DUST_LOG_FILE;
  });

  // `dust-attachments.ts` now records an oversized image as a normal
  // PendingAttachment (rather than dropping it before parsing finishes) so it
  // gets a note, same as any other failed image. This is where the size
  // ceiling is actually enforced: no request should ever be sent for bytes
  // Dust is guaranteed to reject.
  it("does not attempt to upload an image over the size ceiling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    const attached = await attach({
      cache,
      attachments: [
        makeAttachment({
          fileName: "huge.png",
          contentType: "image/png",
          hash: "hash-huge-image",
          bytes: Buffer.alloc(21 * 1024 * 1024),
        }),
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(attached).toEqual([]);
    expect(cache.size).toBe(0);
  });

  // `dust-attachments.ts` records an `[Image omitted:` marker (pi tried and
  // gave up converting/resizing it) as a PendingAttachment with zero bytes —
  // there is nothing to upload, since pi never pushed an `image` block for it.
  // Attempting the upload anyway would waste a request Dust cannot possibly
  // accept and could not even produce meaningful bytes for.
  it("does not attempt to upload an image with no bytes (an [Image omitted:] marker)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    const attached = await attach({
      cache,
      attachments: [
        makeAttachment({
          fileName: "broken.heic",
          contentType: "image/unknown",
          hash: "hash-omitted-image",
          bytes: Buffer.alloc(0),
        }),
      ],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(attached).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it("keeps a file inline when the content fragment cannot be created", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_4", uploadUrl: "https://upload.test/fil_4" } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_4" } }))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    await expect(attach({ cache })).resolves.toEqual([]);
    // The file exists in the workspace but is not in the conversation, so a
    // later turn must not point the agent at it.
    expect(cache.size).toBe(0);
  });

  it("keeps a file inline when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(attach()).resolves.toEqual([]);
  });

  it("never fails a whole message because one file could not be attached", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "too large" })
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_6", uploadUrl: "https://upload.test/fil_6" } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_6" } }))
      .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_6" } }));
    vi.stubGlobal("fetch", fetchMock);

    const attached = await attach({
      attachments: [
        makeAttachment({ fileName: "huge.ts", hash: "hash-huge" }),
        makeAttachment({ fileName: "ok.ts", hash: "hash-ok" }),
      ],
    });

    expect(attached.map((entry) => entry.attachment.fileName)).toEqual(["ok.ts"]);
  });

  it("rejects an upload response that does not carry an upload URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ file: { sId: "fil_7" } })));
    await expect(attach()).resolves.toEqual([]);
  });

  it("passes the turn's abort signal to every request", async () => {
    const fetchMock = uploadFlow();
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await attach({ signal });

    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBe(signal);
    }
  });

  it("does not send the Dust bearer token to a pre-signed upload URL on a foreign origin", async () => {
    const fetchMock = uploadFlow();
    vi.stubGlobal("fetch", fetchMock);

    await attach();

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe("https://upload.test/fil_1");
    expect(uploadInit.headers.Authorization).toBeUndefined();
  });

  it("does send the auth headers to a pre-signed upload URL that shares baseUrl's origin", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_same", uploadUrl: `${BASE_URL}/files/fil_same` } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_same" } }))
      .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_same" } }));
    vi.stubGlobal("fetch", fetchMock);

    await attach();

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe(`${BASE_URL}/files/fil_same`);
    expect(uploadInit.headers.Authorization).toBe("Bearer token");
  });

  it("fails the file, not the whole batch, when uploadUrl is not an absolute URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_bad", uploadUrl: "not-a-url" } }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map<string, string>();

    await expect(attach({ cache })).resolves.toEqual([]);
    expect(cache.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads the auth headers per request so a rotated token is picked up", async () => {
    const fetchMock = uploadFlow();
    vi.stubGlobal("fetch", fetchMock);
    let token = "first";

    await attach({
      getAuthHeaders: () => {
        const headers = { Authorization: `Bearer ${token}` };
        token = "second";
        return headers;
      },
    });

    // The upload call goes to a foreign origin (upload.test vs. dust.test), so
    // it carries no Authorization header at all — the rotation is only
    // observable on the two calls that stay on baseUrl's origin.
    expect(fetchMock.mock.calls.map((call) => call[1].headers.Authorization)).toEqual([
      "Bearer first",
      undefined,
      "Bearer second",
    ]);
  });

  // The turns most worth attaching a file to are the long ones, which are also
  // the ones most likely to have outlived the ~15 minute access token — the
  // same reasoning `cancelMessageGeneration` already applies with its
  // refresh-and-retry-once on a 401. Without it, a token that rotated mid-turn
  // permanently drops every attachment instead of recovering.
  it("retries the create-file request once after a 401, once the token is refreshed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" })
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r1", uploadUrl: "https://upload.test/fil_r1" } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r1" } }))
      .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_r1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);

    const attached = await attach({ refreshAuth });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(attached).toEqual([
      { attachment: expect.objectContaining({ fileName: "big.ts" }), fileId: "fil_r1", reused: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // A foreign-origin pre-signed URL never carries the Dust bearer token (see
  // the same-origin-only auth test above), so a same-origin uploadUrl is what
  // exercises the retry here — a 401 from a foreign host has nothing to do
  // with our token and must not trigger a refresh.
  it("retries the byte upload once after a 401, once the token is refreshed (same-origin uploadUrl)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r2", uploadUrl: `${BASE_URL}/files/fil_r2` } }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" })
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r2" } }))
      .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_r2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);

    const attached = await attach({ refreshAuth });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(attached).toHaveLength(1);
  });

  it("does not retry a 401 from a foreign-origin upload URL — refreshing our token cannot fix it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r2b", uploadUrl: "https://upload.test/fil_r2b" } }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" });
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);

    await expect(attach({ refreshAuth })).resolves.toEqual([]);

    expect(refreshAuth).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries the content-fragment request once after a 401, once the token is refreshed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r3", uploadUrl: "https://upload.test/fil_r3" } }))
      .mockResolvedValueOnce(okJson({ file: { sId: "fil_r3" } }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" })
      .mockResolvedValueOnce(okJson({ contentFragment: { sId: "cf_r3" } }));
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);

    const attached = await attach({ refreshAuth });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(attached).toHaveLength(1);
  });

  it("does not retry a 401 a second time, and still fails the file rather than the batch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "still expired" });
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(true);
    const cache = new Map<string, string>();

    await expect(attach({ refreshAuth, cache })).resolves.toEqual([]);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("does not retry when refresh itself fails, and still fails the file rather than the batch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" });
    vi.stubGlobal("fetch", fetchMock);
    const refreshAuth = vi.fn().mockResolvedValue(false);

    await expect(attach({ refreshAuth })).resolves.toEqual([]);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no refreshAuth is provided, preserving today's behaviour", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(attach()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
