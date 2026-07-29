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
  ".avif": "image/avif",
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
  ".heic": "image/heic",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/vnd.microsoft.icon",
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
  // pi's CLI inliner content-sniffs by magic bytes (`detectSupportedImageMimeType`
  // in dist/utils/mime.js) and only ever recognises png/jpeg/gif/webp/bmp that
  // way — an `.svg` is never routed through `processImage` at all and is
  // inlined as plain text, so the branch decision in `parseUserMessage` below
  // (`classifyImageBody`) never needs this entry for CLI-inlined markers. It
  // is still correct, and still used, for the TUI's `@` mention path, which
  // has no inliner output to sniff and falls back to this extension map.
  ".svg": "image/svg+xml",
  ".swift": "text/x-swift",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
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

/**
 * A content type for a marker pi has already told us is an image (via an
 * `[Image omitted:` body) but never gave us bytes for, so the real mime type
 * is unknowable and irrelevant — this is never uploaded. Falls back to a
 * generic `image/*` marker rather than `contentTypeForPath`'s `text/plain`
 * default so `applyAttachmentPointers`'s `startsWith("image/")` check (and
 * `attachFilesToConversation`'s) still recognise it as an image needing a note.
 */
function imageContentType(path: string): string {
  const guess = contentTypeForPath(path);
  return guess.startsWith("image/") ? guess : "image/unknown";
}

/**
 * Every hint line pi's inliner ever writes for an image is one of these three
 * shapes (`node_modules/@earendil-works/pi-coding-agent/dist/utils/image-process.js`,
 * `dist/utils/image-resize.js`):
 *   - `[Image converted from ${from} to ${to}.]` — conversionHint(), for any
 *     mime `normalizeSupportedImageMimeType()` rejects. In practice this can
 *     only be BMP: `detectSupportedImageMimeType` (dist/utils/mime.js) — the
 *     content-sniff that decides whether a `@file` is even routed through
 *     `processImage` in the first place — only ever recognises png/jpeg/gif
 *     /webp/bmp, and the first four already pass `normalizeSupportedImageMimeType`
 *     unconverted. A `.heic`/`.avif`/`.tiff`/`.ico`/`.svg` is never sniffed as
 *     an image at all and is inlined by pi as plain text instead — those
 *     `CONTENT_TYPE_BY_EXTENSION` entries exist only for the TUI's `@` mention
 *     path (`readMentionedFile`/`contentTypeForPath`), not for this shape check.
 *   - `[Image: original WxH, displayed at WxH. Multiply coordinates by N to
 *     map to original image.]` — formatDimensionNote(), only when resized.
 *   - `[Image omitted: could not be converted to a supported inline image
 *     format.]` / `[Image omitted: could not be resized below the inline
 *     image size limit.]` — processImage()'s two failure messages.
 * `processFileArguments` (`dist/cli/file-processor.js:49`) joins multiple
 * hints with `"\n"`, so a genuine image marker's body can span more than one
 * line — unlike a stale/mismatched text marker's body, which never matches
 * this per-line shape at all.
 */
const IMAGE_HINT_LINE = /^\[Image[ :].*\]$/;
/**
 * `file-processor.js:37-40`: when `processImage` fails, pi writes this
 * message as the *entire* marker body and — critically — never pushes
 * anything to its `images` array for it. A marker with this body is still a
 * real, located image marker (the model just never received the picture), but
 * it must not consume `images[nextImage]`, which belongs to a later marker.
 */
const IMAGE_OMITTED_PREFIX = "[Image omitted:";

type ImageBodyShape = "consumes-block" | "omitted" | "not-image";

/** Classifies an image marker's body by its literal shape — see the two constants above. */
function classifyImageBody(body: string): ImageBodyShape {
  if (body === "") return "consumes-block";
  if (body.startsWith(IMAGE_OMITTED_PREFIX)) return "omitted";
  return body.split("\n").every((line) => IMAGE_HINT_LINE.test(line)) ? "consumes-block" : "not-image";
}

/**
 * Identifies a marker for the debug log without its body: an inlined text
 * marker's body is the file's own content, and even a short slice of it is
 * bytes of that file leaking into a log a user might paste into a bug report.
 * A mention marker (`@path`) carries no file content at all, so it is safe to
 * log whole.
 */
function markerSummary(marker: string): string {
  if (!marker.startsWith(MARKER_OPEN)) return marker;
  const nameClose = marker.indexOf(MARKER_NAME_CLOSE);
  return nameClose < 0 ? MARKER_OPEN : marker.slice(0, nameClose + MARKER_NAME_CLOSE.length);
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

/**
 * Reads the file back to confirm the marker really is pi's inliner output.
 *
 * `remainingLength` — how much of the message is left from the body's start
 * onward, in UTF-16 code units (a JS string's `.length`) — lets this reject up
 * front, on nothing more than a `statSync`, every marker the file cannot
 * possibly match: a verified text marker's body is `\n<content>\n` immediately
 * followed by `</file>`, so if `diskContent.length + 2 + MARKER_CLOSE.length`
 * (the actual necessary bound below, once the file is read) cannot fit in
 * what is left of the message, no amount of reading it will make
 * `textVerified` true. Without this, an image marker (never a text match)
 * means reading a multi-megabyte image off disk as UTF-8 and diffing it, per
 * image marker, per turn, purely to fail.
 *
 * `size` from `statSync` is UTF-8 *bytes*, not UTF-16 *units* — comparing it
 * to `remainingLength` directly (as an earlier version of this check did)
 * silently drops every attachment whose disk content has any multibyte
 * character, once the overhead exceeds the suffix after the marker: real
 * files (accented comments, emoji, non-Latin text) routinely have more UTF-8
 * bytes than UTF-16 units. What's actually needed is a lower bound on
 * `diskContent.length` computed from `size` alone. UTF-8 encodes a BMP
 * character (one UTF-16 unit) in at most 3 bytes, and a non-BMP character (a
 * surrogate pair, two UTF-16 units) in exactly 4 bytes — i.e. at most 2 bytes
 * per unit, which is *less* overhead than the BMP case. So 3 bytes per UTF-16
 * unit is the worst case either way, giving `diskContent.length >=
 * size / 3`, i.e. `Math.ceil(size / 3)` never overestimates how many units the
 * file could produce. Rejecting when even that optimistic estimate cannot fit
 * is therefore still a necessary condition — real matches are never dropped —
 * while continuing to short-circuit anything that truly cannot verify.
 */
function readTextFile(path: string, remainingLength: number): string | null {
  try {
    const size = statSync(path).size;
    const minPossibleStringLength = Math.ceil(size / 3);
    if (size > ATTACHMENT_MAX_TEXT_BYTES || minPossibleStringLength + 2 + MARKER_CLOSE.length > remainingLength) {
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
      // A folder is left to the agent's local tools rather than expanded here:
      // uploading one is a bulk operation with a bill and a rate limit
      // attached, and `@node_modules` should not be able to trigger it by
      // accident. Logged so it does not look like the mention was missed.
      debugLog("dust:files", "Mention does not name a file, leaving it to the agent", {
        path,
        isDirectory: stats.isDirectory(),
      });
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
 * Scans `[from, to)` of the message for pi's `@path` mentions.
 *
 * The interactive editor's `@` is only a path autocomplete: it writes the path
 * into the message as plain text and leaves reading it to the agent. So unlike
 * the CLI's inliner there is nothing to undo here — the point is that a
 * mentioned file reaches Dust at all, which for an image is the difference
 * between the model seeing it and the agent staring at a path it cannot read.
 *
 * A mention has to start the message or follow whitespace, and has to name a
 * file that exists; everything else is left alone. `to` lets `parseUserMessage`
 * scan the text on both sides of an inlined marker run (piped stdin content
 * can precede it) without also scanning the run's own, untrustworthy body.
 */
function parseMentions(text: string, from: number, cwd: string, to: number = text.length): PendingAttachment[] {
  const attachments: PendingAttachment[] = [];
  const mention = /(^|\s)@("[^"]+"|\S+)/g;
  // A mention starting at exactly `from` — the common case right after a
  // marker run, since `markerEnd` above consumes the trailing newline — would
  // never match if `lastIndex` were set to `from`: the regex has no `m` flag,
  // so `^` only matches real index 0, and `\s` has to consume a character at
  // or after `lastIndex`. Starting one character earlier lets `\s` consume the
  // boundary character (e.g. the marker's trailing newline) so the `@` at
  // `from` itself can still match. `.exec` never returns a match starting
  // before `lastIndex`, so this cannot pull in anything from before `from`
  // except that one boundary character, and it only ever matches as `\s`.
  mention.lastIndex = Math.max(0, from - 1);

  for (let match = mention.exec(text); match !== null; match = mention.exec(text)) {
    const start = match.index + match[1].length;
    if (start >= to) break;
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
 * The run is not required to start the message: pi puts piped stdin content
 * *before* the inlined markers (`buildInitialMessage` joins `[stdinContent,
 * fileText, messages[0]]` — `dist/cli/initial-message.js:6-16`), so
 * `cat notes.txt | pi @file.ts "..."` has real stdin text ahead of the run.
 * The run is instead found at the first `MARKER_OPEN` occurrence anywhere in
 * the message and is still only recognised as a *contiguous* run from there —
 * a text marker only counts when its body still matches the file on disk byte
 * for byte, which is what keeps a `<file name="...">` the user (or piped
 * stdin) typed themselves from being mistaken for an attachment even now that
 * it need not be the very first thing in the message. The first marker that
 * fails to verify ends that scan: the ones after it can no longer be located
 * reliably, so they stay inline, which is the current behaviour anyway.
 */
export function parseUserMessage(message: ChatMessageLike, cwd: string): ParsedUserMessage {
  const { text, images } = collectContent(message);
  const attachments: PendingAttachment[] = [];
  // Where the run *could* start — the message up to here (piped stdin, in
  // pi's CLI form) is ordinary text and stays mention-scannable below.
  const runStart = text.indexOf(MARKER_OPEN);
  let position = runStart < 0 ? text.length : runStart;
  // Tracks the end of the prefix marker run for the mention scan below, even
  // past a marker that failed verification: that marker's body is still file
  // content (or the remains of it), never text the user typed, so it must
  // never be searched for `@mentions` — see the loop's failure branch.
  // Defaults to `position` (not 0): when there is no run at all, the whole
  // message is scanned in the "before the run" pass below regardless.
  let scanFrom = position;
  let nextImage = 0;

  while (text.startsWith(MARKER_OPEN, position)) {
    const nameStart = position + MARKER_OPEN.length;
    const nameEnd = text.indexOf(MARKER_NAME_CLOSE, nameStart);
    if (nameEnd < 0) {
      // The marker never closes its name tag. If a verified marker precedes
      // this one within the run (`position > runStart` — *not* `position > 0`:
      // the run can legitimately start at a nonzero offset because of stdin,
      // so a literal `> 0` would treat "nothing verified yet, just offset by
      // stdin" as trustworthy inliner output), the run so far is real inliner
      // output and this unclosed tag is most likely the mangled remains of
      // another one — unsafe to mention-scan. Starting cold at the run's own
      // beginning, pi never emits an unclosed name tag, so this is far more
      // likely to just be text that happens to start with the marker's
      // literal prefix — treating the rest of the message as off-limits would
      // silently drop every `@` mention in an ordinary message.
      if (position > runStart) scanFrom = text.length;
      break;
    }

    const path = text.slice(nameStart, nameEnd);
    const bodyStart = nameEnd + MARKER_NAME_CLOSE.length;

    // pi's inliner decides text-vs-image independently of any extension guess
    // we make here, so the two are tried in turn against the marker's own
    // shape instead of trusting CONTENT_TYPE_BY_EXTENSION: a text marker's
    // body is `\n<disk content>\n` at a byte-exact offset (which is also what
    // lets a file that itself contains `</file>` parse correctly), an image
    // marker's is pi's own hint text with the closing tag findable by a plain
    // scan. A wrong extension guess (`.svg` inlined as text, `.heic` with no
    // entry in the map at all) then degrades to "try the other shape" instead
    // of losing every marker after this one.
    const diskContent = readTextFile(path, text.length - bodyStart);
    const textCloseAt = diskContent === null ? -1 : bodyStart + diskContent.length + 2;
    const textVerified =
      diskContent !== null &&
      text.startsWith(MARKER_CLOSE, textCloseAt) &&
      text.slice(bodyStart, textCloseAt) === `\n${diskContent}\n`;

    if (textVerified) {
      let markerEnd = textCloseAt + MARKER_CLOSE.length;
      if (text.startsWith("\n", markerEnd)) markerEnd += 1;
      const bytes = Buffer.from(diskContent as string, "utf8");
      if (bytes.byteLength >= ATTACHMENT_MIN_TEXT_BYTES) {
        attachments.push(makeAttachment(path, contentTypeForPath(path), bytes, text, position, markerEnd, true));
      }
      position = markerEnd;
      scanFrom = position;
      continue;
    }

    const imageCloseAt = text.indexOf(MARKER_CLOSE, bodyStart);
    if (imageCloseAt < 0) {
      // Neither interpretation could even locate a closing tag. Same
      // position-gated reasoning as the branch above.
      if (position > runStart) scanFrom = text.length;
      break;
    }

    let markerEnd = imageCloseAt + MARKER_CLOSE.length;
    if (text.startsWith("\n", markerEnd)) markerEnd += 1;

    // Classified from what pi actually writes (see `classifyImageBody` and its
    // two constants), not guessed at from newlines: a genuine image marker's
    // body can be multiple lines (a conversion hint plus a dimension note), and
    // a single-line `[Image omitted:` body is still a genuine image marker —
    // just one that consumed no `image` content block. A text marker whose
    // disk content changed after pi inlined it (the text interpretation just
    // failed above) never matches either shape, and falls through below.
    const imageShape = classifyImageBody(text.slice(bodyStart, imageCloseAt));

    if (imageShape === "omitted") {
      // pi tried and gave up — no `image` block was ever pushed for this
      // marker, so there is nothing to upload and `nextImage` must not move.
      // Still recorded (with no bytes) so `applyAttachmentPointers` can tell
      // the model it never saw this image, the same as any other image that
      // never reached Dust — the "not-image" fallback below would otherwise
      // treat it as unlocated and kill-switch the mention scan past it too,
      // when its span is in fact perfectly well known.
      attachments.push(makeAttachment(path, imageContentType(path), new Uint8Array(0), text, position, markerEnd, true));
      position = markerEnd;
      scanFrom = position;
      continue;
    }

    if (imageShape === "consumes-block") {
      // pi resizes images before attaching them, so the block's bytes — not
      // the ones on disk — are what the model was meant to see. Recorded
      // regardless of size: an oversized image is still a real, located
      // marker, and dropping it here — before it ever reaches `attachments` —
      // would make it invisible to `applyAttachmentPointers`, leaving the
      // model with no idea the image existed at all. `attachFilesToConversation`
      // is what actually enforces `ATTACHMENT_MAX_IMAGE_BYTES`, the same way it
      // handles any other reason an upload cannot proceed.
      const block = images[nextImage];
      if (block?.data) {
        nextImage += 1;
        const bytes = Buffer.from(block.data, "base64");
        const contentType = block.mimeType ?? contentTypeForPath(path);
        attachments.push(makeAttachment(path, contentType, bytes, text, position, markerEnd, true));
        position = markerEnd;
        scanFrom = position;
        continue;
      }
    }

    // Neither interpretation verified: this marker's own span is known (its
    // closing tag was located), which is strong enough evidence of genuine
    // inliner output — a well-formed `<file name="...">...</file>` block is
    // not the kind of thing someone pastes by coincidence — that the run ends
    // here unconditionally, regardless of `position`. Every marker after this
    // one in the original text is unlocated and therefore untrustworthy too,
    // so the whole remainder is excluded from the mention scan, not just this
    // marker's own span.
    scanFrom = text.length;
    break;
  }

  // Two disjoint regions, never the run's own span: whatever precedes it
  // (nothing, or piped stdin content) and whatever the run's own logic above
  // decided is safe to resume scanning from afterward.
  attachments.push(...parseMentions(text, 0, cwd, runStart < 0 ? text.length : runStart));
  attachments.push(...parseMentions(text, scanFrom, cwd));

  // Logged even when nothing matched: "my `@file` was not uploaded" is
  // otherwise indistinguishable from "the upload failed", and the two have
  // nothing in common to investigate.
  debugLog("dust:files", "Scanned the user message for attachments", {
    cwd,
    inlinedMarkers: runStart >= 0 && position > runStart,
    imageBlocks: images.length,
    attachments: attachments.map((attachment) => ({
      path: attachment.path,
      contentType: attachment.contentType,
      fileSize: attachment.bytes.byteLength,
      marker: markerSummary(attachment.marker),
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
 * A file that failed to upload is left as-is — that is the safe fallback for
 * text, whose marker still carries the whole body (or, for a mention, a path
 * the agent's local tools can still read). An image is different: nothing
 * about it ever reaches Dust except through this upload, so its marker is
 * either an empty tag or a short processing hint pi wrote, and its `image`
 * content block never leaves this extension either — meaning a failed image
 * upload otherwise vanishes without a trace, and the model answers about a
 * picture it was never shown. `pendingAttachments` — the full parse, not just
 * the successes — is what makes a failure visible: any image in it that
 * `attached` does not cover gets a note in its place instead of silence.
 *
 * Rewriting happens by position rather than by string match, so one marker
 * never rewrites another that merely starts the same way.
 */
export function applyAttachmentPointers(
  text: string,
  attached: AttachedFile[],
  pendingAttachments: PendingAttachment[] = [],
): string {
  const attachedPointers = new Set(attached.map((entry) => entry.attachment));
  const failedImages = pendingAttachments.filter(
    (attachment) => attachment.contentType.startsWith("image/") && !attachedPointers.has(attachment),
  );

  const edits = [
    ...attached
      .filter((entry) => entry.attachment.inlined)
      .map((entry) => ({
        start: entry.attachment.start,
        end: entry.attachment.end,
        replacement: entry.attachment.marker.endsWith("\n")
          ? `@${entry.attachment.path}\n`
          : `@${entry.attachment.path}`,
      })),
    ...failedImages.map((attachment) => {
      // `dust-files.ts` never even tries to upload an image over Dust's
      // ceiling — recomputing the same comparison here (rather than plumbing
      // a reason code through `AttachedFile`) is what lets the note say why,
      // rather than the generic message a network failure gets.
      const reason = attachment.bytes.byteLength > ATTACHMENT_MAX_IMAGE_BYTES
        ? "it is too large to attach"
        : "it could not be attached";
      return {
        start: attachment.start,
        end: attachment.end,
        // Inlined: the marker itself carries nothing worth keeping (an empty
        // tag or a hint like "resized from..."), so it is replaced outright. A
        // mention's `@path` is still a real, locally-readable path, so it is
        // kept and just annotated.
        replacement: attachment.inlined
          ? `[the image "${attachment.fileName}" is not visible to you — ${reason}]${attachment.marker.endsWith("\n") ? "\n" : ""}`
          : `${attachment.marker} (${reason} — the image is not visible to you)`,
      };
    }),
  ].sort((a, b) => a.start - b.start);

  let rewritten = "";
  let position = 0;

  for (const { start, end, replacement } of edits) {
    // A file attached (or failed) twice yields two markers; a stale span
    // would mean the caller passed spans from a different text.
    if (start < position) continue;
    rewritten += text.slice(position, start);
    rewritten += replacement;
    position = end;
  }

  return rewritten + text.slice(position);
}
