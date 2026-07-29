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
}

async function failureBody(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

/**
 * Uploads one file in Dust's two steps: a record carrying the metadata, then
 * the bytes to the pre-signed URL it hands back.
 */
async function uploadFile(
  request: AttachRequest,
  attachment: PendingAttachment,
): Promise<string> {
  const { baseUrl, getAuthHeaders, signal, conversationSId } = request;

  const createRes = await fetch(`${baseUrl}/files`, {
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
  });

  if (!createRes.ok) {
    throw new Error(`create file failed: HTTP ${createRes.status} — ${await failureBody(createRes)}`);
  }

  const { file } = parseFileUploadResponse(await createRes.json());

  const form = new FormData();
  form.append("file", new File([attachment.bytes], attachment.fileName, { type: attachment.contentType }));

  // No Content-Type header here: fetch has to set the multipart boundary.
  const uploadRes = await fetch(file.uploadUrl, {
    method: "POST",
    headers: getAuthHeaders(),
    body: form,
    signal,
  });

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
  const res = await fetch(`${request.baseUrl}/assistant/conversations/${conversationSId}/content_fragments`, {
    method: "POST",
    headers: { ...request.getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(fragment),
    signal: request.signal,
  });

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
      debugLog("dust:files", "Attaching a file failed, keeping it inline", {
        fileName: attachment.fileName,
        error: errorMessage(error),
      });
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
