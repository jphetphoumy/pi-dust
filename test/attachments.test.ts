import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACHMENT_MIN_TEXT_BYTES } from "../src/dust-constants.js";
import { applyAttachmentPointers, parseUserMessage } from "../src/dust-attachments.js";
import type { AttachedFile, PendingAttachment } from "../src/dust-types.js";

let dir: string;

/** Writes a file whose body is large enough to be worth uploading. */
function writeLargeFile(name: string, filler = "x"): { path: string; content: string } {
  const path = join(dir, name);
  const content = filler.repeat(ATTACHMENT_MIN_TEXT_BYTES + 10);
  writeFileSync(path, content, "utf8");
  return { path, content };
}

function textMarker(path: string, content: string): string {
  return `<file name="${path}">\n${content}\n</file>\n`;
}

function attached(attachment: PendingAttachment, fileId: string): AttachedFile {
  return { attachment, fileId, reused: false };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-dust-attachments-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseUserMessage", () => {
  it("returns plain text untouched when there is no attachment marker", () => {
    const parsed = parseUserMessage({ role: "user", content: "just a question" });
    expect(parsed).toEqual({ text: "just a question", attachments: [] });
  });

  it("joins text blocks like the previous text-only extraction did", () => {
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    });
    expect(parsed.text).toBe("hello world");
  });

  it("extracts an inlined text file as an attachment", () => {
    const { path, content } = writeLargeFile("big.ts");
    const text = `${textMarker(path, content)}explain this`;

    const parsed = parseUserMessage({ role: "user", content: text });

    expect(parsed.text).toBe(text);
    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment.path).toBe(path);
    expect(attachment.fileName).toBe("big.ts");
    expect(attachment.contentType).toBe("text/typescript");
    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe(content);
    expect(attachment.marker).toBe(textMarker(path, content));
  });

  it("falls back to text/plain for unknown extensions", () => {
    const { path, content } = writeLargeFile("notes.unknownext");
    const parsed = parseUserMessage({ role: "user", content: textMarker(path, content) });
    expect(parsed.attachments[0].contentType).toBe("text/plain");
  });

  it("leaves small files inline — an upload plus a read round trip costs more", () => {
    const path = join(dir, "small.ts");
    const content = "const a = 1;";
    writeFileSync(path, content, "utf8");

    const parsed = parseUserMessage({ role: "user", content: textMarker(path, content) });

    expect(parsed.attachments).toEqual([]);
  });

  it("handles a file whose own content contains a closing file tag", () => {
    const { path } = writeLargeFile("tricky.md");
    const content = `${"a".repeat(ATTACHMENT_MIN_TEXT_BYTES)}\n</file>\nstill the file`;
    writeFileSync(path, content, "utf8");

    const text = `${textMarker(path, content)}what is this`;
    const parsed = parseUserMessage({ role: "user", content: text });

    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe(content);
    expect(parsed.attachments[0].marker).toBe(textMarker(path, content));
  });

  it("ignores a marker whose body no longer matches the file on disk", () => {
    const { path, content } = writeLargeFile("changed.ts");
    const parsed = parseUserMessage({
      role: "user",
      content: textMarker(path, `${content}-stale`),
    });
    expect(parsed.attachments).toEqual([]);
  });

  it("ignores a marker that names a file that does not exist", () => {
    const parsed = parseUserMessage({
      role: "user",
      content: textMarker(join(dir, "ghost.ts"), "x".repeat(ATTACHMENT_MIN_TEXT_BYTES + 10)),
    });
    expect(parsed.attachments).toEqual([]);
  });

  it("only parses markers pi wrote as a prefix, not ones typed inside the prompt", () => {
    const { path, content } = writeLargeFile("prefix.ts");
    const text = `look at ${textMarker(path, content)}`;

    const parsed = parseUserMessage({ role: "user", content: text });

    expect(parsed.attachments).toEqual([]);
  });

  it("pairs an image block with its marker and uploads the block's bytes", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "not the resized bytes");
    const data = Buffer.from("resized-png-bytes").toString("base64");

    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: `<file name="${path}"></file>\nwhat is on screen` },
        { type: "image", mimeType: "image/png", data },
      ],
    });

    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment.fileName).toBe("shot.png");
    expect(attachment.contentType).toBe("image/png");
    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe("resized-png-bytes");
    expect(attachment.marker).toBe(`<file name="${path}"></file>\n`);
  });

  it("uploads images regardless of size — inlining drops them entirely today", () => {
    const path = join(dir, "tiny.png");
    writeFileSync(path, "x");
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: `<file name="${path}"></file>\n` },
        { type: "image", mimeType: "image/png", data: Buffer.from("x").toString("base64") },
      ],
    });
    expect(parsed.attachments).toHaveLength(1);
  });

  it("keeps pi's processing hints out of the uploaded bytes", () => {
    const path = join(dir, "hinted.jpeg");
    writeFileSync(path, "x");
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: `<file name="${path}">resized from 4000x3000</file>\n` },
        { type: "image", mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64") },
      ],
    });

    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe("jpeg-bytes");
    expect(parsed.attachments[0].marker).toBe(`<file name="${path}">resized from 4000x3000</file>\n`);
  });

  it("leaves an image marker inline when pi attached no image block for it", () => {
    const path = join(dir, "failed.png");
    writeFileSync(path, "x");
    const parsed = parseUserMessage({
      role: "user",
      content: `<file name="${path}">Image too large to process</file>\n`,
    });
    expect(parsed.attachments).toEqual([]);
  });

  it("parses a run of markers of both kinds", () => {
    const { path: textPath, content } = writeLargeFile("both.ts");
    const imagePath = join(dir, "both.png");
    writeFileSync(imagePath, "x");

    const parsed = parseUserMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `${textMarker(textPath, content)}<file name="${imagePath}"></file>\nreview`,
        },
        { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
      ],
    });

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["both.ts", "both.png"]);
  });

  it("hashes by content so the same file attached twice dedupes", () => {
    const { path, content } = writeLargeFile("twice.ts");
    const parsed = parseUserMessage({
      role: "user",
      content: `${textMarker(path, content)}${textMarker(path, content)}`,
    });

    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0].hash).toBe(parsed.attachments[1].hash);
  });

  it("stops at the first marker it cannot verify, leaving the rest inline", () => {
    const { path, content } = writeLargeFile("second.ts");
    const text = `${textMarker(join(dir, "ghost.ts"), "body")}${textMarker(path, content)}`;

    const parsed = parseUserMessage({ role: "user", content: text });

    expect(parsed.attachments).toEqual([]);
  });
});

describe("applyAttachmentPointers", () => {
  it("replaces the inlined body with a pointer carrying the local path and file id", () => {
    const { path, content } = writeLargeFile("pointer.ts");
    const text = `${textMarker(path, content)}explain`;
    const parsed = parseUserMessage({ role: "user", content: text });

    const rewritten = applyAttachmentPointers(text, [attached(parsed.attachments[0], "fil_123")]);

    expect(rewritten).toBe(`<file name="${path}" attached="fil_123" />\nexplain`);
  });

  it("leaves markers of attachments that were not uploaded untouched", () => {
    const { path, content } = writeLargeFile("kept.ts");
    const text = textMarker(path, content);

    expect(applyAttachmentPointers(text, [])).toBe(text);
  });

  it("replaces every occurrence of a repeated marker", () => {
    const { path, content } = writeLargeFile("repeat.ts");
    const text = `${textMarker(path, content)}${textMarker(path, content)}`;
    const parsed = parseUserMessage({ role: "user", content: text });

    const rewritten = applyAttachmentPointers(text, [attached(parsed.attachments[0], "fil_9")]);

    expect(rewritten).toBe(
      `<file name="${path}" attached="fil_9" />\n<file name="${path}" attached="fil_9" />\n`,
    );
  });
});
