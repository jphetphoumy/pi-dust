import { ATTACHMENT_MAX_IMAGE_BYTES } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import type { AttachedFile, DustContentFragment, PendingAttachment } from "./dust-types.js";
import { errorMessage, parseFileUploadResponse } from "./dust-validation.js";

interface AttachRequest {
  baseUrl: string;
  getAuthHeaders: () => Record<string, string>;
  signal: AbortSignal | undefined;
  /** `null` on the first turn, when the conversation does not exist yet. */
  conversationSId: string | null;
  attachments: PendingAttachment[];
  /** Content hash → Dust file id, for files already attached to this conversation. */
  cache: Map<string, string>;
  /**
   * Refreshes through pi and reports whether the session is still alive — the
   * same function `dust-stream-provider.ts` passes to `cancelMessageGeneration`
   * for its own 401-retry. Optional so existing callers (and tests) that do not
   * thread it through keep today's behaviour: a 401 just fails that request.
   */
  refreshAuth?: () => Promise<boolean>;
}

async function failureBody(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

/**
 * Retries a request once after a 401, the same pattern `cancelMessageGeneration`
 * uses: the turns most worth attaching a file to are the long ones, which are
 * also the ones most likely to have outlived the ~15 minute access token.
 * Without this, a token that rotates mid-turn drops every attachment for good
 * instead of recovering — `send` is called again from scratch (not just
 * retried at the transport level) so it picks up the refreshed headers.
 */
async function withAuthRetry(
  send: () => Promise<Response>,
  refreshAuth: (() => Promise<boolean>) | undefined,
  logContext: Record<string, unknown>,
): Promise<Response> {
  const res = await send();
  if (res.status !== 401 || !refreshAuth || !(await refreshAuth())) {
    return res;
  }
  debugLog("dust:files", "Refreshed token after 401, retrying upload request", logContext);
  return send();
}

/**
 * The Dust bearer token belongs to `baseUrl`'s origin, not to wherever
 * `file.uploadUrl` happens to point — it is a value taken straight out of the
 * API response and validated only as a string. A pre-signed upload URL on a
 * different host does not need it, and sending it there would leak the token
 * to whatever that origin is. Returns `null` for a URL that cannot be parsed
 * as absolute, so the caller can fail just that file instead of leaking a
 * credential to an unparseable destination or throwing out of the batch.
 */
function sameOrigin(url: string, baseUrl: string): boolean | null {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Uploads one file in Dust's two steps: a record carrying the metadata, then
 * the bytes to the pre-signed URL it hands back.
 */
async function uploadFile(
  request: AttachRequest,
  attachment: PendingAttachment,
): Promise<string> {
  const { baseUrl, getAuthHeaders, signal, conversationSId, refreshAuth } = request;

  const createRes = await withAuthRetry(
    () => fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: attachment.contentType,
        fileName: attachment.fileName,
        fileSize: attachment.bytes.byteLength,
        useCase: "conversation",
        // Dust fills this in from the content fragment when the conversation is
        // created in the same breath, so leaving it out on the first turn is fine.
        ...(conversationSId ? { useCaseMetadata: { conversationId: conversationSId } } : {}),
      }),
      signal,
    }),
    refreshAuth,
    { fileName: attachment.fileName, step: "create" },
  );

  if (!createRes.ok) {
    throw new Error(`create file failed: HTTP ${createRes.status} — ${await failureBody(createRes)}`);
  }

  const { file } = parseFileUploadResponse(await createRes.json());

  const uploadIsSameOrigin = sameOrigin(file.uploadUrl, baseUrl);
  if (uploadIsSameOrigin === null) {
    throw new Error(`upload file failed: uploadUrl is not an absolute URL — ${file.uploadUrl}`);
  }

  // No Content-Type header here: fetch has to set the multipart boundary. The
  // Dust bearer token is only sent when the pre-signed URL stays on baseUrl's
  // origin — a foreign origin does not need it, and must never see it. Rebuilt
  // fresh on retry: a `FormData`/`File` pair is consumed by the first `fetch`.
  const uploadRes = await withAuthRetry(
    () => {
      const form = new FormData();
      form.append("file", new File([attachment.bytes], attachment.fileName, { type: attachment.contentType }));
      return fetch(file.uploadUrl, {
        method: "POST",
        headers: uploadIsSameOrigin ? getAuthHeaders() : {},
        body: form,
        signal,
      });
    },
    // A foreign-origin pre-signed URL never carries the Dust token in the
    // first place, so a 401 from it is not ours to fix by refreshing.
    uploadIsSameOrigin ? refreshAuth : undefined,
    { fileName: attachment.fileName, step: "upload" },
  );

  if (!uploadRes.ok) {
    throw new Error(`upload file failed: HTTP ${uploadRes.status} — ${await failureBody(uploadRes)}`);
  }

  return file.sId;
}

async function postContentFragment(
  request: AttachRequest,
  conversationSId: string,
  fragment: DustContentFragment,
): Promise<void> {
  const res = await withAuthRetry(
    () => fetch(`${request.baseUrl}/assistant/conversations/${conversationSId}/content_fragments`, {
      method: "POST",
      headers: { ...request.getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(fragment),
      signal: request.signal,
    }),
    request.refreshAuth,
    { fileId: fragment.fileId, step: "content-fragment" },
  );

  if (!res.ok) {
    throw new Error(`content fragment failed: HTTP ${res.status} — ${await failureBody(res)}`);
  }
}

/**
 * Uploads `@`-mentioned files to Dust and attaches them to the conversation.
 *
 * Attaching is an optimisation, never a precondition: a file that cannot be
 * uploaded is simply left out of the result, and the caller keeps pi's inlined
 * copy for it. That is why nothing here throws — a failed upload must not cost
 * the user their turn.
 *
 * On the first turn there is no conversation to attach to yet. The files are
 * uploaded anyway and returned for the caller to pass as `contentFragments`
 * when it creates the conversation; Dust binds them to it at that point.
 */
export async function attachFilesToConversation(request: AttachRequest): Promise<AttachedFile[]> {
  const { attachments, cache, conversationSId } = request;
  const attached: AttachedFile[] = [];

  for (const attachment of attachments) {
    const known = cache.get(attachment.hash);
    if (known) {
      debugLog("dust:files", "Reusing a file already attached to this conversation", {
        fileName: attachment.fileName,
        fileId: known,
      });
      attached.push({ attachment, fileId: known, reused: true });
      continue;
    }

    // `dust-attachments.ts` records both an oversized image and an
    // `[Image omitted:` one (pi tried and gave up converting/resizing it, so
    // there is no `image` block and no bytes at all) as ordinary
    // PendingAttachments — rather than dropping them before they ever become
    // one — precisely so they stay visible to `applyAttachmentPointers`'s "an
    // unattached image gets a note" pass. This is where both ceilings are
    // actually enforced: no request is worth sending for bytes Dust is
    // guaranteed to reject, or for a file that has no bytes to send at all.
    if (attachment.contentType.startsWith("image/")
      && (attachment.bytes.byteLength === 0 || attachment.bytes.byteLength > ATTACHMENT_MAX_IMAGE_BYTES)) {
      debugLog("dust:files", "Image has no bytes to upload or exceeds Dust's upload ceiling, not attempting the upload", {
        fileName: attachment.fileName,
        fileSize: attachment.bytes.byteLength,
        limit: ATTACHMENT_MAX_IMAGE_BYTES,
      });
      continue;
    }

    try {
      const fileId = await uploadFile(request, attachment);
      if (conversationSId) {
        await postContentFragment(request, conversationSId, {
          title: attachment.fileName,
          fileId,
        });
      }
      cache.set(attachment.hash, fileId);
      attached.push({ attachment, fileId, reused: false });
      debugLog("dust:files", "Attached a file to the conversation", {
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        fileSize: attachment.bytes.byteLength,
        fileId,
        conversationSId,
      });
    } catch (error) {
      // A failed text attachment truly "stays inline" — its marker still
      // carries the whole body (or, for a mention, a locally-readable path).
      // An image never reaches Dust any other way: its marker is an empty tag
      // or a short hint, and the `image` content block goes nowhere else
      // either. Logged distinctly so this does not read as the harmless case.
      const isImage = attachment.contentType.startsWith("image/");
      debugLog(
        "dust:files",
        isImage
          ? "Attaching an image failed; it will not reach the model"
          : "Attaching a file failed, keeping it inline",
        {
          fileName: attachment.fileName,
          error: errorMessage(error),
        },
      );
    }
  }

  return attached;
}

/** The fragments to send when the conversation is created in the same request. */
export function toContentFragments(attached: AttachedFile[]): DustContentFragment[] {
  return attached
    .filter((entry) => !entry.reused)
    .map((entry) => ({ title: entry.attachment.fileName, fileId: entry.fileId }));
}
