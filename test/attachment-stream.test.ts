import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { ATTACHMENT_MIN_TEXT_BYTES } from "../src/dust-constants.js";
import {
  makeCredentials,
  makePendingSseStream,
  makeSseStream,
  piToolContextFields,
  seedLoggedIn,
  useTempAgentDir,
} from "./helpers/dust-fixtures.js";

const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

let dir: string;
let filePath: string;
let fileContent: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-dust-attach-stream-"));
  filePath = join(dir, "big.ts");
  fileContent = `// ${"x".repeat(ATTACHMENT_MIN_TEXT_BYTES)}`;
  writeFileSync(filePath, fileContent, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inlinedMessage(extra = "explain this"): string {
  return `<file name="${filePath}">\n${fileContent}\n</file>\n${extra}`;
}

async function setup() {
  const creds = makeCredentials();
  seedLoggedIn(creds);
  let capturedStreamSimple: any;
  let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

  const mockApi = {
    registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
      capturedStreamSimple = config.streamSimple;
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => {
      if (event === "session_start") sessionStartHandler = handler;
    }),
  };
  dustExtension(mockApi as any);

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ agentConfigurations: creds.agents }),
  }));
  await sessionStartHandler!({}, {
    modelRegistry: {},
    ...piToolContextFields(),
    // `@` mentions are resolved against the session's working directory.
    cwd: dir,
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/sessions/attach.json"),
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("attach-session"),
    },
  });
  vi.unstubAllGlobals();

  return capturedStreamSimple;
}

/**
 * Answers every call a turn makes by URL, so extra upload requests do not shift
 * the responses the rest of the turn depends on.
 */
function makeTurnFetch(overrides: { uploadOk?: boolean; fragmentOk?: boolean; failCreate?: boolean } = {}) {
  let conversations = 0;
  let created = false;
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/mcp/register")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ serverId: "mcp-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
      });
    }
    if (url.includes("/mcp/requests")) {
      return Promise.resolve({ ok: true, body: makePendingSseStream() });
    }
    if (url.endsWith("/files")) {
      return Promise.resolve(overrides.uploadOk === false
        ? { ok: false, status: 400, text: () => Promise.resolve("nope") }
        : {
          ok: true,
          json: () => Promise.resolve({ file: { sId: "fil_1", uploadUrl: "https://upload.test/fil_1" } }),
        });
    }
    if (url.startsWith("https://upload.test/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ file: { sId: "fil_1" } }) });
    }
    if (url.includes("/content_fragments")) {
      return Promise.resolve(overrides.fragmentOk === false
        ? { ok: false, status: 500, text: () => Promise.resolve("nope") }
        : { ok: true, json: () => Promise.resolve({ contentFragment: { sId: "cf_1" } }) });
    }
    if (url.includes("/events")) {
      return Promise.resolve({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
    }
    if (url.endsWith("/messages")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ message: { sId: `msg-${++conversations}` } }) });
    }
    if (url.includes("/assistant/conversations/")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          conversation: {
            sId: "conv-1",
            content: [
              [{ type: "user_message", sId: "msg-1" }],
              [{ type: "agent_message", sId: "amsg-1", parentMessageId: "msg-1" }],
            ],
          },
        }),
      });
    }
    // Conversation creation. `failCreate` fails the first attempt only, the way
    // a transient Dust error would.
    if (overrides.failCreate && !created) {
      created = true;
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        conversation: {
          sId: "conv-1",
          content: [
            [{ type: "user_message", sId: "msg-1" }],
            [{ type: "agent_message", sId: "amsg-1", parentMessageId: "msg-1" }],
          ],
        },
        message: { sId: "msg-1" },
      }),
    });
  });
}

async function runTurn(streamSimple: any, content: unknown) {
  const stream = streamSimple(model, { messages: [{ role: "user", content }] });
  for await (const _ of stream) { /* drain */ }
}

function bodyOf(fetchMock: any, match: (url: string) => boolean) {
  const call = fetchMock.mock.calls.find(([url]: [string]) => match(url));
  return call ? JSON.parse(call[1].body) : undefined;
}

describe("@file attachments in a turn", () => {
  useTempAgentDir();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uploads the file and creates the conversation with it as a content fragment", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage());

    const upload = bodyOf(fetchMock, (url) => url.endsWith("/files"));
    expect(upload).toMatchObject({ fileName: "big.ts", useCase: "conversation" });
    // The conversation does not exist yet; Dust binds the file when it is
    // attached at creation.
    expect(upload.useCaseMetadata).toBeUndefined();

    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toEqual([{ title: "big.ts", fileId: "fil_1" }]);
    expect(create.message.content).toContain(`@${filePath}`);
    expect(create.message.content).toContain("explain this");
    expect(create.message.content).not.toContain(fileContent);
  });

  it("titles the conversation from what the user actually wrote", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage("why is this slow?"));

    expect(bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations")).title)
      .toBe("why is this slow?");
  });

  // Dust already tells the agent how to read an attachment, and it did so
  // unprompted in a live run. The one thing it cannot know is that edits belong
  // to the local path rather than to the conversation's snapshot.
  it("tells the agent that an @path is attached but edited locally", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage());

    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.message.content).toContain("edit the local path");
  });

  it("attaches a content fragment to a conversation that already exists", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, "hello");
    await runTurn(streamSimple, inlinedMessage());

    expect(bodyOf(fetchMock, (url) => url.endsWith("/files")).useCaseMetadata)
      .toEqual({ conversationId: "conv-1" });
    expect(bodyOf(fetchMock, (url) => url.includes("/content_fragments")))
      .toEqual({ title: "big.ts", fileId: "fil_1" });
    expect(bodyOf(fetchMock, (url) => url.endsWith("/messages")).content)
      .toContain(`@${filePath}`);
  });

  it("does not upload the same file twice in one conversation", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage());
    await runTurn(streamSimple, inlinedMessage("and again"));

    const uploads = fetchMock.mock.calls.filter(([url]: [string]) => url.endsWith("/files"));
    expect(uploads).toHaveLength(1);
    const fragments = fetchMock.mock.calls.filter(([url]: [string]) => url.includes("/content_fragments"));
    expect(fragments).toHaveLength(0);
    expect(bodyOf(fetchMock, (url) => url.endsWith("/messages")).content)
      .toContain(`@${filePath}`);
  });

  it("re-uploads when the conversation the file was meant for was never created", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch({ failCreate: true });
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage());
    await runTurn(streamSimple, inlinedMessage());

    // Reusing the first turn's file id would point the agent at a file that
    // was never attached to this conversation.
    expect(fetchMock.mock.calls.filter(([url]: [string]) => url.endsWith("/files"))).toHaveLength(2);
    const create = fetchMock.mock.calls
      .filter(([url]: [string]) => url.endsWith("/assistant/conversations"))
      .map(([, init]: [string, any]) => JSON.parse(init.body))
      .at(-1);
    expect(create.contentFragments).toEqual([{ title: "big.ts", fileId: "fil_1" }]);
  });

  it("keeps the file inline when it cannot be uploaded", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch({ uploadOk: false });
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, inlinedMessage());

    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toBeUndefined();
    expect(create.message.content).toContain(fileContent);
  });

  it("keeps the file inline when the content fragment cannot be attached", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch({ fragmentOk: false });
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, "hello");
    await runTurn(streamSimple, inlinedMessage());

    expect(bodyOf(fetchMock, (url) => url.endsWith("/messages")).content).toContain(fileContent);
  });

  // Unlike a failed text upload, whose marker still carries the whole body,
  // a failed image upload used to leave the model with nothing at all: the
  // inline marker is an empty tag, and the `image` content block never
  // reaches Dust through any other path. The message text must say so.
  it("tells the model an image could not be attached instead of silently dropping it", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch({ uploadOk: false });
    vi.stubGlobal("fetch", fetchMock);
    const imagePath = join(dir, "failed-shot.png");
    writeFileSync(imagePath, "x");

    await runTurn(streamSimple, [
      { type: "text", text: `<file name="${imagePath}"></file>\nwhat is this` },
      { type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
    ]);

    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toBeUndefined();
    expect(create.message.content).not.toContain(`<file name="${imagePath}">`);
    expect(create.message.content).toContain("could not be attached");
    expect(create.message.content).toContain("what is this");
  });

  it("uploads an image block that would otherwise be dropped", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);
    const imagePath = join(dir, "shot.png");
    writeFileSync(imagePath, "x");

    await runTurn(streamSimple, [
      { type: "text", text: `<file name="${imagePath}"></file>\nwhat is this` },
      { type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
    ]);

    expect(bodyOf(fetchMock, (url) => url.endsWith("/files"))).toMatchObject({
      fileName: "shot.png",
      contentType: "image/png",
    });
    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toEqual([{ title: "shot.png", fileId: "fil_1" }]);
  });

  // The interactive editor does not inline: `@big.ts` reaches the extension as
  // plain text, which is the form most users actually send.
  it("uploads a file mentioned as @path in the interactive prompt", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, "@big.ts explain this");

    expect(bodyOf(fetchMock, (url) => url.endsWith("/files"))).toMatchObject({ fileName: "big.ts" });
    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toEqual([{ title: "big.ts", fileId: "fil_1" }]);
    expect(create.message.content).toContain("@big.ts explain this");
  });

  it("leaves a message with no attachment untouched", async () => {
    const streamSimple = await setup();
    const fetchMock = makeTurnFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runTurn(streamSimple, "just a question");

    expect(fetchMock.mock.calls.some(([url]: [string]) => url.endsWith("/files"))).toBe(false);
    const create = bodyOf(fetchMock, (url) => url.endsWith("/assistant/conversations"));
    expect(create.contentFragments).toBeUndefined();
    expect(create.message.content).toContain("just a question");
  });
});
