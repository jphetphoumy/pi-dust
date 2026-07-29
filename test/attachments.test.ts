import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_IMAGE_BYTES, ATTACHMENT_MIN_TEXT_BYTES } from "../src/dust-constants.js";
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
    const parsed = parseUserMessage({ role: "user", content: "just a question" }, dir);
    expect(parsed).toEqual({ text: "just a question", attachments: [] });
  });

  it("joins text blocks like the previous text-only extraction did", () => {
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    }, dir);
    expect(parsed.text).toBe("hello world");
  });

  it("extracts an inlined text file as an attachment", () => {
    const { path, content } = writeLargeFile("big.ts");
    const text = `${textMarker(path, content)}explain this`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

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
    const parsed = parseUserMessage({ role: "user", content: textMarker(path, content) }, dir);
    expect(parsed.attachments[0].contentType).toBe("text/plain");
  });

  it("leaves small files inline — an upload plus a read round trip costs more", () => {
    const path = join(dir, "small.ts");
    const content = "const a = 1;";
    writeFileSync(path, content, "utf8");

    const parsed = parseUserMessage({ role: "user", content: textMarker(path, content) }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  it("handles a file whose own content contains a closing file tag", () => {
    const { path } = writeLargeFile("tricky.md");
    const content = `${"a".repeat(ATTACHMENT_MIN_TEXT_BYTES)}\n</file>\nstill the file`;
    writeFileSync(path, content, "utf8");

    const text = `${textMarker(path, content)}what is this`;
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe(content);
    expect(parsed.attachments[0].marker).toBe(textMarker(path, content));
  });

  it("ignores a marker whose body no longer matches the file on disk", () => {
    const { path, content } = writeLargeFile("changed.ts");
    const parsed = parseUserMessage({
      role: "user",
      content: textMarker(path, `${content}-stale`),
    }, dir);
    expect(parsed.attachments).toEqual([]);
  });

  it("ignores a marker that names a file that does not exist", () => {
    const parsed = parseUserMessage({
      role: "user",
      content: textMarker(join(dir, "ghost.ts"), "x".repeat(ATTACHMENT_MIN_TEXT_BYTES + 10)),
    }, dir);
    expect(parsed.attachments).toEqual([]);
  });

  // Round five: the marker run no longer has to start the message — pi puts
  // piped stdin content *before* it (dist/cli/initial-message.js:6-16). What
  // actually protects a `<file name="...">` that a user (or piped stdin) typed
  // themselves from being mistaken for an attachment is verification: the
  // marker's body has to match a real file byte for byte, regardless of what
  // precedes it.
  it("attaches a marker preceded by other text, once its body verifies", () => {
    const { path, content } = writeLargeFile("prefix.ts");
    const text = `look at ${textMarker(path, content)}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].path).toBe(path);
  });

  it("does not mistake unverifiable marker-shaped text for an attachment, wherever it sits", () => {
    const text = `look at <file name="${join(dir, "nonexistent.ts")}">totally made up</file>`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

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
    }, dir);

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
    }, dir);
    expect(parsed.attachments).toHaveLength(1);
  });

  // The hint text pi actually writes (formatDimensionNote() in
  // dist/utils/image-resize.js), not a paraphrase of it.
  it("keeps pi's processing hints out of the uploaded bytes", () => {
    const path = join(dir, "hinted.jpeg");
    writeFileSync(path, "x");
    const hint = "[Image: original 4000x3000, displayed at 1024x768. Multiply coordinates by 3.91 to map to original image.]";
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: `<file name="${path}">${hint}</file>\n` },
        { type: "image", mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64") },
      ],
    }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe("jpeg-bytes");
    expect(parsed.attachments[0].marker).toBe(`<file name="${path}">${hint}</file>\n`);
  });

  // A hint-shaped body pi really writes (conversionHint()), but with no
  // `image` content block at all — a message where the text half of pi's
  // output survived but its `images` array did not, or one hand-built without
  // it. `classifyImageBody` still calls this "consumes-block" (it is exactly
  // the shape pi emits when a block *should* exist), so this is what exercises
  // the defensive `!block?.data` fallback rather than the `"omitted"` path.
  it("leaves an image marker inline when pi attached no image block for it", () => {
    const path = join(dir, "failed.png");
    writeFileSync(path, "x");
    const parsed = parseUserMessage({
      role: "user",
      content: `<file name="${path}">[Image converted from image/bmp to image/png.]</file>\n`,
    }, dir);
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
    }, dir);

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["both.ts", "both.png"]);
  });

  it("hashes by content so the same file attached twice dedupes", () => {
    const { path, content } = writeLargeFile("twice.ts");
    const parsed = parseUserMessage({
      role: "user",
      content: `${textMarker(path, content)}${textMarker(path, content)}`,
    }, dir);

    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0].hash).toBe(parsed.attachments[1].hash);
  });

  it("stops at the first marker it cannot verify, leaving the rest inline", () => {
    const { path, content } = writeLargeFile("second.ts");
    const text = `${textMarker(join(dir, "ghost.ts"), "body")}${textMarker(path, content)}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  // pi's inliner decides text-vs-image independently of the extension map: a
  // `.svg` gets inlined as text, but the map says `image/svg+xml`. Deciding the
  // branch from the extension guess instead of the marker's own shape used to
  // make this one wrong guess `break` the whole prefix run, losing every marker
  // after it too.
  it("does not lose later markers when an earlier one is a misclassified extension (svg)", () => {
    const { path: svgPath, content: svgContent } = writeLargeFile("icon.svg");
    const { path: tsPath, content: tsContent } = writeLargeFile("c.ts");
    const text = `${textMarker(svgPath, svgContent)}${textMarker(tsPath, tsContent)}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["icon.svg", "c.ts"]);
  });

  // An image extension not in CONTENT_TYPE_BY_EXTENSION used to fall back to
  // text/plain, so the text branch tried to read binary bytes as UTF-8 and the
  // byte-for-byte check failed, breaking the run. `.jxl` is deliberately kept
  // out of CONTENT_TYPE_BY_EXTENSION so this test actually exercises that map
  // miss — adding it (as `.heic` etc. were) would make the old,
  // extension-keyed branch pass this test too, pinning nothing.
  it("recognises an image extension that is not in the content-type map (jxl)", () => {
    const path = join(dir, "photo.jxl");
    writeFileSync(path, "not the resized bytes");
    const data = Buffer.from("resized-jxl-bytes").toString("base64");

    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text: `<file name="${path}"></file>\nwhat is on screen` },
        { type: "image", mimeType: "image/jxl", data },
      ],
    }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileName).toBe("photo.jxl");
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe("resized-jxl-bytes");
  });

  // Regression: the text-first fallback tried the image interpretation for
  // *any* marker whose text verification failed, with no check that the body
  // actually looks like an image marker. `text.indexOf("</file>", bodyStart)`
  // then found the text marker's own closing tag, and `images[nextImage]` —
  // belonging to a different attachment entirely — got consumed and attached
  // under the text file's path. `pi @notes.md @shot.png "..."` where
  // `notes.md` changed on disk after being inlined (so its text verification
  // fails) reproduces this: the PNG must never end up attached under the
  // `.md` path, and `notes.md`'s stale multi-line body must not be mistaken
  // for an image hint.
  it("does not let an unverifiable text marker steal the next image block", () => {
    const notesPath = join(dir, "notes2.md");
    const staleBody = "this is the old body, not what pi actually inlined\nacross two lines";
    writeFileSync(notesPath, "completely different content now", "utf8");
    const shotPath = join(dir, "shot2.png");
    writeFileSync(shotPath, "disk bytes, not the resized ones");

    const text = `${textMarker(notesPath, staleBody)}<file name="${shotPath}"></file>\nwhat is on screen`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-png-bytes").toString("base64") },
      ],
    }, dir);

    const stolen = parsed.attachments.find((a) => a.path === notesPath && a.contentType.startsWith("image/"));
    expect(stolen).toBeUndefined();
    const wrongBytes = parsed.attachments.some(
      (a) => Buffer.from(a.bytes).toString("utf8") === "resized-png-bytes" && a.fileName !== "shot2.png",
    );
    expect(wrongBytes).toBe(false);
  });

  // Round-four regression: `looksLikeImageHint` assumed an image marker's
  // body never spans a line break, which is false. Per pi's own source
  // (node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js:49
  // and dist/utils/image-process.js), `processImage` can emit *two* hints —
  // a conversion hint (any mime not in {png,jpeg,gif,webp}, e.g. `.bmp`) plus
  // a dimension note when the image was also resized — joined with "\n". This
  // is the real output of `pi @big.bmp "what is this?"` on a 4000x3000 BMP.
  it("attaches an image whose hint body has two lines (converted and resized)", () => {
    const bmpPath = join(dir, "big.bmp");
    writeFileSync(bmpPath, "original bmp bytes");
    const hintBody =
      "[Image converted from image/bmp to image/png.]\n" +
      "[Image: original 4000x3000, displayed at 1024x768. Multiply coordinates by 3.91 to map to original image.]";
    const text = `<file name="${bmpPath}">${hintBody}</file>\nwhat is this?`;

    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-bmp-bytes").toString("base64") },
      ],
    }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileName).toBe("big.bmp");
    expect(parsed.attachments[0].contentType).toBe("image/png");
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe("resized-bmp-bytes");
  });

  // The two-line hint body must not kill-switch mention scanning for the rest
  // of the message either — a verified marker and an `@mention` after the
  // image marker must both still come through.
  it("does not drop later markers or mentions after a two-line image hint", () => {
    const bmpPath = join(dir, "big2.bmp");
    writeFileSync(bmpPath, "original bmp bytes");
    const hintBody =
      "[Image converted from image/bmp to image/png.]\n" +
      "[Image: original 4000x3000, displayed at 1024x768. Multiply coordinates by 3.91 to map to original image.]";
    const { path: docPath, content: docContent } = writeLargeFile("doc.ts");
    writeLargeFile("other.md");

    const text = `<file name="${bmpPath}">${hintBody}</file>\n${textMarker(docPath, docContent)}also @other.md please`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-bmp-bytes").toString("base64") },
      ],
    }, dir);

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["big2.bmp", "doc.ts", "other.md"]);
  });

  // Round-four regression, defect class from round three re-opened: an
  // `[Image omitted: ...]` body is single-line, so the old shape check called
  // it an image hint — but pi pushed no `image` block for it at all
  // (file-processor.js:37-40, the `!processed.ok` branch never reaches the
  // `images.push` call). `images[nextImage]` therefore belongs to a *later*
  // marker, and consuming it here attaches the wrong bytes under the wrong
  // path/fileName/contentType while the real marker's own image goes missing.
  it("does not let an [Image omitted:] marker steal the next real image block", () => {
    const brokenPath = join(dir, "broken.heic");
    writeFileSync(brokenPath, "unconvertible bytes");
    const goodPath = join(dir, "good.png");
    writeFileSync(goodPath, "disk bytes, not the resized ones");

    const text =
      `<file name="${brokenPath}">[Image omitted: could not be converted to a supported inline image format.]</file>\n` +
      `<file name="${goodPath}"></file>\ncompare these`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("good-png-bytes").toString("base64") },
      ],
    }, dir);

    const good = parsed.attachments.find((a) => a.fileName === "good.png");
    expect(good).toBeDefined();
    expect(good?.contentType).toBe("image/png");
    expect(Buffer.from(good!.bytes).toString("utf8")).toBe("good-png-bytes");

    const broken = parsed.attachments.find((a) => a.fileName === "broken.heic");
    // Recorded (so it can get a note later) but with no stolen bytes.
    expect(broken).toBeDefined();
    expect(Buffer.from(broken!.bytes).toString("utf8")).not.toBe("good-png-bytes");
    expect(broken?.bytes.byteLength).toBe(0);
  });

  // `imageContentType`'s `"image/unknown"` fallback only matters for an
  // extension `CONTENT_TYPE_BY_EXTENSION` does not know — `.heic` above maps
  // to a real `image/*` type, so it never reaches the fallback. `pi
  // @screenshot.dat` on a BMP pi could not resize is content-sniffed as an
  // image by pi (not by us) and gets an `[Image omitted:` marker the same as
  // any other failed image, but with no extension to guess a type from.
  it("still gets an image/* contentType for an [Image omitted:] marker with an unmapped extension", () => {
    const path = join(dir, "screenshot.dat");
    writeFileSync(path, "unresizable bmp bytes");
    const text = `<file name="${path}">[Image omitted: could not be resized below the inline image size limit.]</file>\nwhat is this`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentType).toBe("image/unknown");
    expect(parsed.attachments[0].contentType.startsWith("image/")).toBe(true);
  });

  // Proves `nextImage` stays aligned across a mix: a verified text marker (no
  // image block involved at all), an `[Image omitted:]` marker (consumes no
  // block), and a genuine image marker (must get the *first*, and only,
  // image block — not a later one shifted by a phantom consumption).
  it("keeps nextImage aligned across verified text, an omitted image, and a real image", () => {
    const { path: docPath, content: docContent } = writeLargeFile("aligned-doc.ts");
    const brokenPath = join(dir, "aligned-broken.heic");
    writeFileSync(brokenPath, "unconvertible bytes");
    const goodPath = join(dir, "aligned-good.png");
    writeFileSync(goodPath, "disk bytes");

    const text =
      `${textMarker(docPath, docContent)}` +
      `<file name="${brokenPath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n` +
      `<file name="${goodPath}"></file>\ndescribe`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("only-image-block").toString("base64") },
      ],
    }, dir);

    const good = parsed.attachments.find((a) => a.fileName === "aligned-good.png");
    expect(good).toBeDefined();
    expect(Buffer.from(good!.bytes).toString("utf8")).toBe("only-image-block");
    expect(parsed.attachments.map((a) => a.fileName)).toEqual([
      "aligned-doc.ts",
      "aligned-broken.heic",
      "aligned-good.png",
    ]);
  });

  // Round-five: pi puts piped stdin *before* the inlined markers, not just the
  // user's typed message after them. Confirmed in
  // dist/cli/initial-message.js:6-16 — buildInitialMessage joins
  // `[stdinContent, fileText, messages[0]]` in that order. Requiring the
  // marker run to start at index 0 meant `cat notes.txt | pi @shot.png
  // @doc.ts "what is this"` never entered the while loop at all: the whole
  // message, including doc.ts's inlined body, fell through to a single
  // unguarded mention scan.
  it("finds the marker run after piped stdin content, not just at index 0", () => {
    const stdinMentionPath = join(dir, "stdin-mention.md");
    writeLargeFile("stdin-mention.md");
    const stdinContent = `look at this: @${stdinMentionPath}\n`;

    const shotPath = join(dir, "shot.png");
    writeFileSync(shotPath, "disk bytes, not the resized ones");
    const { path: docPath, content: docContent } = writeLargeFile("doc.ts");
    const secretPath = join(dir, "secret.env");
    writeLargeFile("secret.env");
    // doc.ts's own body merely *references* secret.env — the user never
    // mentioned it. writeLargeFile's content is filler, so splice a
    // reference into what pi "inlined" and reuse that as both the marker
    // body and the file's real disk content, keeping verification honest.
    const docWithReference = `see @${secretPath} for details\n${docContent}`;
    writeFileSync(docPath, docWithReference, "utf8");

    const fileText = `<file name="${shotPath}"></file>\n${textMarker(docPath, docWithReference)}`;
    const text = `${stdinContent}${fileText}what is this`;

    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-png-bytes").toString("base64") },
      ],
    }, dir);

    const byPath = (path: string) => parsed.attachments.find((a) => a.path === path);

    expect(byPath(shotPath)).toBeDefined();
    expect(byPath(shotPath)?.contentType).toBe("image/png");
    expect(Buffer.from(byPath(shotPath)!.bytes).toString("utf8")).toBe("resized-png-bytes");

    expect(byPath(docPath)).toBeDefined();
    expect(Buffer.from(byPath(docPath)!.bytes).toString("utf8")).toBe(docWithReference);

    expect(byPath(secretPath)).toBeUndefined();

    expect(byPath(stdinMentionPath)).toBeDefined();
  });

  // The `position > 0` gate from round three has to mean "a marker in this
  // run has verified", not "we are not at index 0" — the run can now
  // legitimately start at a nonzero offset because of stdin content, so a
  // literal `position > 0` would wrongly treat "nothing verified yet, just
  // offset by stdin" as "trustworthy inliner output".
  it("does not kill-switch on an unverifiable first marker in the run merely because stdin precedes it", () => {
    const stdinContent = "some piped text first\n";
    const { path: secretPath } = writeLargeFile("secret-after-stdin.env");
    // Malformed marker attempt (unclosed name tag) as the *first* thing in the
    // run — nothing has verified yet, even though its index in the message is
    // well past 0.
    const text = `${stdinContent}<file name="unclosed see @${secretPath}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.path)).toEqual([secretPath]);
  });
});

describe("applyAttachmentPointers", () => {
  it("replaces an inlined body with a bare mention of the local path", () => {
    const { path, content } = writeLargeFile("pointer.ts");
    const text = `${textMarker(path, content)}explain`;
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    const rewritten = applyAttachmentPointers(text, [attached(parsed.attachments[0], "fil_123")]);

    expect(rewritten).toBe(`@${path}\nexplain`);
  });

  // Dust renders every attachment into the model's context itself, with its id,
  // title and a snippet. Repeating that inline would pay twice for it; the only
  // thing Dust cannot know is the local path, which the mention already is.
  it("leaves a mention exactly as the user typed it", () => {
    writeLargeFile("as-typed.ts");
    writeLargeFile("as-typed.ts.bak");
    const text = "@as-typed.ts and @as-typed.ts.bak please";
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    const rewritten = applyAttachmentPointers(
      text,
      parsed.attachments.map((attachment) => attached(attachment, "fil_a")),
    );

    expect(rewritten).toBe(text);
  });

  it("leaves markers of attachments that were not uploaded untouched", () => {
    const { path, content } = writeLargeFile("kept.ts");
    const text = textMarker(path, content);

    expect(applyAttachmentPointers(text, [])).toBe(text);
  });

  it("rewrites each occurrence of a repeated file at its own position", () => {
    const { path, content } = writeLargeFile("repeat.ts");
    const text = `${textMarker(path, content)}${textMarker(path, content)}`;
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    const rewritten = applyAttachmentPointers(
      text,
      parsed.attachments.map((attachment) => attached(attachment, "fil_9")),
    );

    expect(rewritten).toBe(`@${path}\n@${path}\n`);
  });

  // Unlike text, nothing about an image ever reaches Dust except through the
  // upload: its inline marker is an empty tag (or a short hint pi wrote), and
  // the `image` content block goes nowhere else. Leaving a failed image's
  // marker untouched — the old, text-shaped behaviour — means the model
  // silently answers about a picture it was never shown.
  it("replaces a failed inlined image's marker with a visible note instead of leaving it silent", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "not the resized bytes");
    const text = `<file name="${path}"></file>\nwhat is on screen`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-png-bytes").toString("base64") },
      ],
    }, dir);
    expect(parsed.attachments).toHaveLength(1);

    // No AttachedFile for it: the upload failed.
    const rewritten = applyAttachmentPointers(text, [], parsed.attachments);

    expect(rewritten).not.toContain(`<file name="${path}">`);
    expect(rewritten).toContain("could not be attached");
    expect(rewritten).toContain("shot.png");
    expect(rewritten).toContain("what is on screen");
  });

  it("annotates, but keeps, a failed mentioned image's @path", () => {
    writeFileSync(join(dir, "mention-shot.png"), "png-bytes");
    const text = "@mention-shot.png what is this";
    const parsed = parseUserMessage({ role: "user", content: text }, dir);
    expect(parsed.attachments).toHaveLength(1);

    const rewritten = applyAttachmentPointers(text, [], parsed.attachments);

    // The mention is left exactly as typed, same as a successful one would be
    // — the only difference is the note appended after it.
    expect(rewritten).toContain("@mention-shot.png");
    expect(rewritten).toContain("could not be attached");
  });

  it("does not touch a failed image's marker when it did upload successfully", () => {
    const path = join(dir, "ok-shot.png");
    writeFileSync(path, "x");
    const text = `<file name="${path}"></file>\nlook`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("bytes").toString("base64") },
      ],
    }, dir);

    const rewritten = applyAttachmentPointers(
      text,
      [attached(parsed.attachments[0], "fil_ok")],
      parsed.attachments,
    );

    expect(rewritten).toBe(`@${path}\nlook`);
    expect(rewritten).not.toContain("could not be attached");
  });

  // An image over ATTACHMENT_MAX_IMAGE_BYTES used to be dropped at parse time,
  // before it ever became a PendingAttachment — invisible to this function, so
  // it got no note at all, breaking the "any image that did not attach is
  // visible to the model" invariant established above for upload failures.
  it("notes that an oversized inlined image was too large to attach", () => {
    const path = join(dir, "huge-shot.png");
    writeFileSync(path, "x");
    const text = `<file name="${path}"></file>\nwhat is this`;
    const hugeBytes = Buffer.from("x".repeat(ATTACHMENT_MAX_IMAGE_BYTES + 1));
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: hugeBytes.toString("base64") },
      ],
    }, dir);
    // Recorded (not dropped) so the note logic below can see it.
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].bytes.byteLength).toBeGreaterThan(ATTACHMENT_MAX_IMAGE_BYTES);

    const rewritten = applyAttachmentPointers(text, [], parsed.attachments);

    expect(rewritten).not.toContain(`<file name="${path}">`);
    expect(rewritten).toContain("too large");
    expect(rewritten).toContain("huge-shot.png");
  });

  // Round-four item 2: an `[Image omitted:` marker is recorded with zero
  // bytes precisely so it flows through the same "unattached image gets a
  // note" pass as an oversized one — pi never gave the model a way to see
  // this image, and the message must say so instead of leaving the hint
  // (which reads as "here is an image" while not actually being one) as if
  // nothing were wrong.
  it("notes that an [Image omitted:] marker could not be attached", () => {
    const path = join(dir, "broken-note.heic");
    writeFileSync(path, "unconvertible bytes");
    const text = `<file name="${path}">[Image omitted: could not be converted to a supported inline image format.]</file>\nwhat is this`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].bytes.byteLength).toBe(0);

    const rewritten = applyAttachmentPointers(text, [], parsed.attachments);

    expect(rewritten).not.toContain("[Image omitted:");
    expect(rewritten).toContain("could not be attached");
    expect(rewritten).toContain("broken-note.heic");
    expect(rewritten).toContain("what is this");
  });
});

describe("parseUserMessage: @ mentions typed in the TUI", () => {
  it("attaches a file mentioned by a relative path", () => {
    writeLargeFile("mentioned.ts");
    const parsed = parseUserMessage({ role: "user", content: "@mentioned.ts explain this" }, dir);

    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment.path).toBe(join(dir, "mentioned.ts"));
    expect(attachment.fileName).toBe("mentioned.ts");
    expect(attachment.contentType).toBe("text/typescript");
    expect(attachment.marker).toBe("@mentioned.ts");
  });

  it("attaches a file mentioned by an absolute path", () => {
    const { path } = writeLargeFile("absolute.ts");
    const parsed = parseUserMessage({ role: "user", content: `look at @${path}` }, dir);

    expect(parsed.attachments[0].path).toBe(path);
  });

  it("attaches a quoted path containing spaces", () => {
    writeLargeFile("with space.ts");
    const parsed = parseUserMessage({ role: "user", content: '@"with space.ts" please' }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileName).toBe("with space.ts");
    expect(parsed.attachments[0].marker).toBe('@"with space.ts"');
  });

  it("uploads a mentioned image, which the agent could not read otherwise", () => {
    const path = join(dir, "mention.png");
    writeFileSync(path, "png-bytes");
    const parsed = parseUserMessage({ role: "user", content: "@mention.png what is this" }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentType).toBe("image/png");
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe("png-bytes");
  });

  // The size floor only makes sense for the CLI's inlined form, where leaving
  // the file inline is the cheaper alternative. Typing `@` is an explicit
  // request, and silently ignoring it for small files — most source files are
  // small — just looks broken.
  it("attaches a mentioned file however small it is", () => {
    writeFileSync(join(dir, "mention-small.ts"), "const a = 1;", "utf8");
    const parsed = parseUserMessage({ role: "user", content: "@mention-small.ts" }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileName).toBe("mention-small.ts");
  });

  it("ignores an empty mentioned file, which Dust rejects", () => {
    writeFileSync(join(dir, "mention-empty.ts"), "", "utf8");
    const parsed = parseUserMessage({ role: "user", content: "@mention-empty.ts" }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  it("ignores a mention that does not name an existing file", () => {
    const parsed = parseUserMessage({ role: "user", content: "@nope.ts and @also/missing" }, dir);
    expect(parsed.attachments).toEqual([]);
  });

  // Uploading a folder would be a bulk operation with a bill attached — the
  // agent can still explore it with the local tools, as it does today.
  it("ignores a mention that names a directory", () => {
    const parsed = parseUserMessage({ role: "user", content: "@." }, dir);
    expect(parsed.attachments).toEqual([]);
  });

  it("ignores a directory mentioned with a trailing slash, as the autocomplete writes it", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeLargeFile(join("nested", "inside.ts"));

    const parsed = parseUserMessage({ role: "user", content: "@nested/ summarise" }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  it("ignores an @ that is not a mention", () => {
    writeLargeFile("inbox.ts");
    const parsed = parseUserMessage(
      { role: "user", content: "mail dev@inbox.ts about the @Component decorator" },
      dir,
    );
    expect(parsed.attachments).toEqual([]);
  });

  it("attaches every mention in one message", () => {
    writeLargeFile("first-mention.ts");
    writeLargeFile("second-mention.ts");
    const parsed = parseUserMessage(
      { role: "user", content: "compare @first-mention.ts with @second-mention.ts" },
      dir,
    );

    expect(parsed.attachments.map((a) => a.fileName)).toEqual([
      "first-mention.ts",
      "second-mention.ts",
    ]);
  });

  it("reads mentions that follow pi's inlined markers", () => {
    const { path, content } = writeLargeFile("inlined-too.ts");
    writeLargeFile("after-marker.ts");
    const parsed = parseUserMessage(
      { role: "user", content: `${textMarker(path, content)}also @after-marker.ts` },
      dir,
    );

    expect(parsed.attachments.map((a) => a.fileName)).toEqual([
      "inlined-too.ts",
      "after-marker.ts",
    ]);
  });

  // parseMentions used to seed `lastIndex = from` against a regex whose `\s`
  // must consume a character at/after lastIndex — so a mention starting at
  // exactly `from` (right after the marker run, since markerEnd consumed the
  // trailing newline) could never match.
  it("reads a mention that starts immediately after the marker run, with nothing between", () => {
    const { path: aPath, content: aContent } = writeLargeFile("a.ts");
    writeLargeFile("b.md");
    const text = `${textMarker(aPath, aContent)}@b.md summarize`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["a.ts", "b.md"]);
  });

  // dev@inbox.ts-style false positives must still be rejected even though the
  // mention scan now starts one character earlier.
  it("still ignores an @ that is not a mention when scanning right after a marker", () => {
    const { path, content } = writeLargeFile("prefix2.ts");
    writeLargeFile("inbox.ts");
    const text = `${textMarker(path, content)}mail dev@inbox.ts please`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.fileName)).toEqual(["prefix2.ts"]);
  });

  // A marker that fails verification (stale body) must not turn its own
  // inlined body into a surface parseMentions scans for `@path` mentions — a
  // file merely referenced inside another file's text must never be uploaded
  // as if the user had mentioned it.
  it("does not scan the body of a failed-verification marker for mentions", () => {
    const { path: secretPath } = writeLargeFile("secret.env");
    const docPath = join(dir, "doc.md");
    const staleBody = `see @${secretPath} for creds\n${"x".repeat(ATTACHMENT_MIN_TEXT_BYTES)}`;
    writeFileSync(docPath, `${staleBody}-changed-after-inlining`, "utf8");

    const text = textMarker(docPath, staleBody);
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  // A marker whose name tag never closes (`">` missing) cannot even be given a
  // span. As the *first* marker attempt (nothing verified yet), pi never emits
  // an unclosed name tag, so this is far more likely to just be a message that
  // happens to start with the literal string `<file name="` than the mangled
  // remains of real inliner output — killing the mention scan over the whole
  // rest of the message would silently drop an ordinary `@` upload. The
  // `@notes.md` mention must still go through.
  it("does not kill-switch the mention scan on an unclosed name tag with nothing verified yet", () => {
    const { path: notesPath, content } = writeLargeFile("notes.md");
    const text = `<file name="foo — how do I write this? see @${notesPath}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].path).toBe(notesPath);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe(content);
  });

  // Same reasoning, but for a marker whose `</file>` is never found at all —
  // still the first attempt, still indistinguishable from ordinary text.
  it("does not kill-switch the mention scan on a never-closed marker with nothing verified yet", () => {
    const { path: notesPath, content } = writeLargeFile("notes3.md");
    const text = `<file name="foo.ts">hello — see @${notesPath}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].path).toBe(notesPath);
    expect(Buffer.from(parsed.attachments[0].bytes).toString("utf8")).toBe(content);
  });

  // The combination that matters: once a marker in the run has actually
  // verified (`position > 0`), the run is confirmed to be genuine inliner
  // output, and a malformed marker after it is far more likely the mangled
  // remains of another one than user-typed text — the kill-switch must still
  // engage then, closing the same leak as before for real multi-marker runs.
  it("still kill-switches an unclosed name tag once a prior marker in the run has verified", () => {
    const { path: aPath, content: aContent } = writeLargeFile("verified-a.ts");
    const { path: secretPath } = writeLargeFile("secret-after-unclosed.env");
    const text = `${textMarker(aPath, aContent)}<file name="unclosed see @${secretPath}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.path)).toEqual([aPath]);
  });

  it("still kill-switches a never-closed marker once a prior marker in the run has verified", () => {
    const { path: aPath, content: aContent } = writeLargeFile("verified-b.ts");
    const { path: secretPath } = writeLargeFile("secret-after-no-close.env");
    const text = `${textMarker(aPath, aContent)}<file name="foo.ts">hello see @${secretPath}`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments.map((a) => a.path)).toEqual([aPath]);
  });

  // Fix 3's incompleteness: the "neither verified, but this marker's own span
  // is known" branch only excluded *that* marker's span from the mention
  // scan, leaving every marker *after* it inside the scanned region — so an
  // `@path` sitting inside another file's inlined body still got uploaded.
  it("does not scan mentions inside a later marker's body when an earlier marker fails to verify", () => {
    const { path: secretPath } = writeLargeFile("secret-two-markers.env");
    const aPath = join(dir, "a-stale.md");
    writeFileSync(aPath, "totally different now", "utf8");
    const staleBody = "the old body\nspans two lines";
    const bBody = `mentions @${secretPath} inside its own body\n${"x".repeat(ATTACHMENT_MIN_TEXT_BYTES)}`;
    const bPath = join(dir, "b-mentions-secret.md");
    writeFileSync(bPath, bBody, "utf8");

    const text = `${textMarker(aPath, staleBody)}${textMarker(bPath, bBody)}`;
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toEqual([]);
  });

  // Same leak, via the documented no-image-block path (test above, "leaves an
  // image marker inline when pi attached no image block for it") rather than a
  // stale text body — not exotic, already covered elsewhere in this suite.
  it("does not scan mentions inside a later marker's body when an earlier image marker has no block", () => {
    const shotPath = join(dir, "shot3.png");
    writeFileSync(shotPath, "x");
    const { path: secretPath } = writeLargeFile("secret-after-shot.env");
    const bBody = `mentions @${secretPath} inside its own body\n${"x".repeat(ATTACHMENT_MIN_TEXT_BYTES)}`;
    const bPath = join(dir, "b2-mentions-secret.md");
    writeFileSync(bPath, bBody, "utf8");

    const text = `<file name="${shotPath}">[Image converted from image/bmp to image/png.]</file>\n${textMarker(bPath, bBody)}`;
    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toEqual([]);
  });
});

describe("parseUserMessage: debug log does not leak file content", () => {
  const previousDebug = process.env.PI_DUST_DEBUG;
  const previousLogFile = process.env.PI_DUST_LOG_FILE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDebug === undefined) delete process.env.PI_DUST_DEBUG;
    else process.env.PI_DUST_DEBUG = previousDebug;
    if (previousLogFile === undefined) delete process.env.PI_DUST_LOG_FILE;
    else process.env.PI_DUST_LOG_FILE = previousLogFile;
  });

  // The marker for an inlined text attachment is `\n<exact file contents>\n` —
  // logging even 80 bytes of it is 80 bytes of the file's own content leaking
  // into a debug log that a user might paste into a bug report.
  it("never includes a text attachment's own body in the log line", () => {
    const { path, content } = writeLargeFile("secret-body.ts", "SENSITIVE_MARKER_CONTENT_");
    const text = `${textMarker(path, content)}explain`;

    process.env.PI_DUST_DEBUG = "1";
    process.env.PI_DUST_LOG_FILE = join(dir, "debug.log");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    parseUserMessage({ role: "user", content: text }, dir);

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    // A `not.toContain` on the file's own filler text only holds by
    // accident — it passes as long as `marker.slice(0, 80)` happens to run out
    // of room on the opening tag before reaching the body, which depends on
    // how long the tmpdir path is. Asserting on the exact logged shape (the
    // marker field stops right at the opening tag's `">`) pins the actual
    // contract instead of a fragile side effect of a truncation length.
    const jsonStart = logged.indexOf("{");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(logged.slice(jsonStart));
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].marker).toBe(`<file name="${path}">`);
    expect(logged).not.toContain("SENSITIVE_MARKER");
  });
});
