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

    expect(fetchMock.mock.calls.map((call) => call[1].headers.Authorization)).toEqual([
      "Bearer first",
      "Bearer second",
      "Bearer second",
    ]);
  });
});
