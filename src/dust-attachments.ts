import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { basename, extname, resolve } from "path";
import {
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_TEXT_BYTES,
  ATTACHMENT_MIN_TEXT_BYTES,
} from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type {
  AttachedFile,
  ChatMessageLike,
  MessageContentBlock,
  ParsedUserMessage,
  PendingAttachment,
} from "./dust-types.js";

const MARKER_OPEN = '<file name="';
const MARKER_NAME_CLOSE = '">';
const MARKER_CLOSE = "</file>";

/**
 * Content types Dust accepts for conversation uploads, keyed by extension
 * (`front/types/files.ts`). Anything else that pi managed to inline is UTF-8
 * text by construction, so `text/plain` is the safe fallback.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".c": "text/x-c",
  ".css": "text/css",
  ".csv": "text/csv",
  ".cjs": "text/javascript",
  ".cs": "text/x-csharp",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".groovy": "text/x-groovy",
  ".h": "text/x-c",
  ".htm": "text/html",
  ".html": "text/html",
  ".java": "text/x-java-source",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/javascript",
  ".kt": "text/x-kotlin",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".php": "text/x-php",
  ".pl": "text/x-perl",
  ".pm": "text/x-perl",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".scala": "text/x-scala",
  ".sh": "text/x-sh",
  ".sql": "text/x-sql",
  ".svg": "image/svg+xml",
  ".swift": "text/x-swift",
  ".ts": "text/typescript",
  ".tsv": "text/tsv",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

function contentTypeForPath(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? "text/plain";
}

function isImagePath(path: string): boolean {
  return contentTypeForPath(path).startsWith("image/");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeAttachment(
  path: string,
  contentType: string,
  bytes: Uint8Array<ArrayBuffer>,
  text: string,
  start: number,
  end: number,
  inlined: boolean,
): PendingAttachment {
  return {
    path,
    fileName: basename(path),
    contentType,
    bytes,
    hash: hashBytes(bytes),
    marker: text.slice(start, end),
    start,
    end,
    inlined,
  };
}

function collectContent(message: ChatMessageLike): { text: string; images: MessageContentBlock[] } {
  const rawContent = message.content ?? "";
  if (!Array.isArray(rawContent)) {
    return { text: String(rawContent), images: [] };
  }
  return {
    text: rawContent
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    images: rawContent.filter((block) => block.type === "image"),
  };
}

/** Reads the file back to confirm the marker really is pi's inliner output. */
function readTextFile(path: string): string | null {
  try {
    if (statSync(path).size > ATTACHMENT_MAX_TEXT_BYTES) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    debugLog("dust:files", "Could not read an attachment marker's file", { path, error: String(error) });
    return null;
  }
}

/**
 * Reads a file an `@` mention names, or `null` when the mention does not point
 * at one — a directory, a path that does not exist, or an `@` that was never a
 * mention at all (`dev@example.com`, a `@Component` decorator).
 */
function readMentionedFile(path: string): Uint8Array<ArrayBuffer> | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return null;
    }
    const limit = isImagePath(path) ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_TEXT_BYTES;
    if (stats.size > limit) {
      return null;
    }
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Scans the message for pi's `@path` mentions.
 *
 * The interactive editor's `@` is only a path autocomplete: it writes the path
 * into the message as plain text and leaves reading it to the agent. So unlike
 * the CLI's inliner there is nothing to undo here — the point is that a
 * mentioned file reaches Dust at all, which for an image is the difference
 * between the model seeing it and the agent staring at a path it cannot read.
 *
 * A mention has to start the message or follow whitespace, and has to name a
 * file that exists; everything else is left alone.
 */
function parseMentions(text: string, from: number, cwd: string): PendingAttachment[] {
  const attachments: PendingAttachment[] = [];
  const mention = /(^|\s)@("[^"]+"|\S+)/g;
  mention.lastIndex = from;

  for (let match = mention.exec(text); match !== null; match = mention.exec(text)) {
    const start = match.index + match[1].length;
    const end = start + 1 + match[2].length;
    const quoted = match[2].startsWith('"');
    const path = resolve(cwd, quoted ? match[2].slice(1, -1) : match[2]);

    // No size floor here, unlike the inlined form: there is no cheaper
    // alternative to fall back to, and silently ignoring `@small-file.ts` —
    // most source files are small — reads as the feature being broken.
    // Dust rejects a zero-byte upload, so those are left alone.
    const bytes = readMentionedFile(path);
    if (!bytes || bytes.byteLength === 0) continue;

    attachments.push(makeAttachment(path, contentTypeForPath(path), bytes, text, start, end, false));
  }

  return attachments;
}

/**
 * Finds the files a user attached with `@`, in either form pi produces.
 *
 * The CLI (`pi @foo.ts "..."`) inlines: it prefixes the message with one
 * `<file name="...">` marker per file — the whole body for a text file, an
 * empty tag (or processing hints) for an image whose bytes ride along as an
 * `image` content block. The text bodies are billed as prompt tokens on every
 * later turn of the conversation and the image blocks never reached Dust at
 * all, so both are pulled back out here.
 *
 * The interactive editor does not inline: its `@` is a path autocomplete that
 * leaves `@path` in the message as plain text. Those are picked up too — see
 * `parseMentions`.
 *
 * Inlined markers are only recognised as a prefix run, and a text marker only
 * counts when its body still matches the file on disk byte for byte. That
 * keeps a `<file name="...">` the user typed themselves — or one quoted inside
 * an attached file — from being mistaken for an attachment. The first marker
 * that fails to verify ends that scan: the ones after it can no longer be
 * located reliably, so they stay inline, which is the current behaviour anyway.
 */
export function parseUserMessage(message: ChatMessageLike, cwd: string): ParsedUserMessage {
  const { text, images } = collectContent(message);
  const attachments: PendingAttachment[] = [];
  let position = 0;
  let nextImage = 0;

  while (text.startsWith(MARKER_OPEN, position)) {
    const nameStart = position + MARKER_OPEN.length;
    const nameEnd = text.indexOf(MARKER_NAME_CLOSE, nameStart);
    if (nameEnd < 0) break;

    const path = text.slice(nameStart, nameEnd);
    const bodyStart = nameEnd + MARKER_NAME_CLOSE.length;
    const image = isImagePath(path);

    // A text marker's body is `\n<content>\n`, so the closing tag sits at a
    // known offset — no scanning, which is what makes a file that itself
    // contains `</file>` parse correctly. An image marker's body is pi's own
    // hint text, which never contains the closing tag.
    const diskContent = image ? null : readTextFile(path);
    const closeAt = image
      ? text.indexOf(MARKER_CLOSE, bodyStart)
      : diskContent === null
        ? -1
        : bodyStart + diskContent.length + 2;
    if (closeAt < 0 || !text.startsWith(MARKER_CLOSE, closeAt)) break;
    if (!image && text.slice(bodyStart, closeAt) !== `\n${diskContent}\n`) break;

    let markerEnd = closeAt + MARKER_CLOSE.length;
    if (text.startsWith("\n", markerEnd)) markerEnd += 1;

    if (image) {
      // pi resizes images before attaching them, so the block's bytes — not the
      // ones on disk — are what the model was meant to see.
      const block = images[nextImage];
      if (!block?.data) break;
      nextImage += 1;
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.byteLength <= ATTACHMENT_MAX_IMAGE_BYTES) {
        const contentType = block.mimeType ?? contentTypeForPath(path);
        attachments.push(makeAttachment(path, contentType, bytes, text, position, markerEnd, true));
      }
    } else {
      const bytes = Buffer.from(diskContent as string, "utf8");
      if (bytes.byteLength >= ATTACHMENT_MIN_TEXT_BYTES) {
        attachments.push(makeAttachment(path, contentTypeForPath(path), bytes, text, position, markerEnd, true));
      }
    }

    position = markerEnd;
  }

  attachments.push(...parseMentions(text, position, cwd));

  // Logged even when nothing matched: "my `@file` was not uploaded" is
  // otherwise indistinguishable from "the upload failed", and the two have
  // nothing in common to investigate.
  debugLog("dust:files", "Scanned the user message for attachments", {
    cwd,
    inlinedMarkers: position > 0,
    imageBlocks: images.length,
    attachments: attachments.map((attachment) => ({
      path: attachment.path,
      contentType: attachment.contentType,
      fileSize: attachment.bytes.byteLength,
      marker: attachment.marker.slice(0, 80),
    })),
  });

  return { text, attachments };
}

/**
 * Drops the body of every file that was uploaded, leaving a bare `@` mention of
 * its local path.
 *
 * Nothing else is added, because nothing else is missing: Dust renders each
 * attachment into the model's context itself, with its file id, title and a
 * snippet. The one thing it cannot know is where the file lives on the user's
 * machine — which edits have to target, since the conversation's copy is a
 * snapshot — and a mention already says that as briefly as it can be said.
 * Mentions are therefore left exactly as typed.
 *
 * Rewriting happens by position rather than by string match, so one marker
 * never rewrites another that merely starts the same way.
 */
export function applyAttachmentPointers(text: string, attached: AttachedFile[]): string {
  const ordered = attached
    .filter((entry) => entry.attachment.inlined)
    .sort((a, b) => a.attachment.start - b.attachment.start);
  let rewritten = "";
  let position = 0;

  for (const { attachment } of ordered) {
    // A file attached twice yields two markers; a stale span would mean the
    // caller passed spans from a different text.
    if (attachment.start < position) continue;
    rewritten += text.slice(position, attachment.start);
    rewritten += attachment.marker.endsWith("\n") ? `@${attachment.path}\n` : `@${attachment.path}`;
    position = attachment.end;
  }

  return rewritten + text.slice(position);
}
