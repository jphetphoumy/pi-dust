import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
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
  marker: string,
): PendingAttachment {
  return { path, fileName: basename(path), contentType, bytes, hash: hashBytes(bytes), marker };
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
 * Splits pi's `@file` inlining back out of a user message.
 *
 * pi's CLI file processor prefixes the message with one `<file name="...">`
 * marker per `@`-mentioned file — the whole body for a text file, an empty tag
 * (or processing hints) for an image, whose bytes ride along as an `image`
 * content block. The text ones are billed as prompt tokens on every later turn
 * of the conversation and the image ones were dropped outright, so both are
 * pulled out here to be uploaded to Dust instead.
 *
 * Markers are only recognised as a prefix run, and a text marker only counts
 * when its body still matches the file on disk byte for byte. That keeps a
 * `<file name="...">` the user typed themselves — or one quoted inside an
 * attached file — from being mistaken for an attachment. The first marker that
 * fails to verify ends the scan: the ones after it can no longer be located
 * reliably, so they stay inline, which is the current behaviour anyway.
 */
export function parseUserMessage(message: ChatMessageLike): ParsedUserMessage {
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
    const marker = text.slice(position, markerEnd);

    if (image) {
      // pi resizes images before attaching them, so the block's bytes — not the
      // ones on disk — are what the model was meant to see.
      const block = images[nextImage];
      if (!block?.data) break;
      nextImage += 1;
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.byteLength <= ATTACHMENT_MAX_IMAGE_BYTES) {
        attachments.push(makeAttachment(path, block.mimeType ?? contentTypeForPath(path), bytes, marker));
      }
    } else {
      const bytes = Buffer.from(diskContent as string, "utf8");
      if (bytes.byteLength >= ATTACHMENT_MIN_TEXT_BYTES) {
        attachments.push(makeAttachment(path, contentTypeForPath(path), bytes, marker));
      }
    }

    position = markerEnd;
  }

  return { text, attachments };
}

/**
 * Swaps each uploaded file's inlined body for a pointer to the conversation
 * attachment. The local path stays in the pointer: the copy in the conversation
 * is a read-only snapshot, and edits still have to target the file on disk.
 */
export function applyAttachmentPointers(text: string, attached: AttachedFile[]): string {
  return attached.reduce((current, { attachment, fileId }) => {
    const pointer = `<file name="${attachment.path}" attached="${fileId}" />`;
    const replacement = attachment.marker.endsWith("\n") ? `${pointer}\n` : pointer;
    return current.split(attachment.marker).join(replacement);
  }, text);
}
