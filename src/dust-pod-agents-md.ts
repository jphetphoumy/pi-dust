import { createHash } from "node:crypto";
import { debugLog } from "./dust-debug.js";
import { type PodApi, uploadPodFile } from "./dust-pod.js";
import { type DustPodBinding, savePodBinding } from "./dust-state.js";

/** The file Dust reads as pod-wide agent instructions. */
export const POD_AGENTS_MD = "AGENTS.md";

/**
 * Dust's own limit on that file.
 *
 * Content past this point is dropped **silently** — no error, no warning — so
 * we have to check it ourselves rather than let a prompt lose its tail.
 */
export const POD_AGENTS_MD_MAX_CHARS = 8192;

export function composeAgentsMd(parts: {
  basePrompt: string;
  toolGuidance: string;
  skillsListing: string;
}): string {
  return [parts.basePrompt, parts.toolGuidance, parts.skillsListing]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function agentsMdFits(content: string): boolean {
  return content.length <= POD_AGENTS_MD_MAX_CHARS;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Puts the session's instructions in the pod, if they are not already there.
 *
 * Two reasons this beats prepending the prompt to the first user message, which
 * is what it replaces. Dust injects the file as *instructions* rather than as
 * something the user said, and it deliberately keeps that block stable per pod
 * so conversations in the same pod share a cacheable prompt prefix — which a
 * fresh 7 kB preamble on every new conversation cannot.
 *
 * The upload is skipped when the content has not changed, both to save a
 * request per turn and to keep that shared prefix byte-identical.
 *
 * Returns false when the content does not fit, leaving the caller to fall back
 * to the in-message prompt rather than ship a silently truncated one.
 */
export async function ensureAgentsMd(
  api: PodApi,
  root: string,
  binding: DustPodBinding,
  content: string,
): Promise<boolean> {
  if (!agentsMdFits(content)) {
    debugLog("dust:pod", "AGENTS.md over Dust's cap; keeping the prompt in-message", {
      chars: content.length,
      cap: POD_AGENTS_MD_MAX_CHARS,
    });
    return false;
  }

  const hash = hashOf(content);
  if (binding.agentsMdHash === hash) return true;

  await uploadPodFile(api, binding.podId, POD_AGENTS_MD, Buffer.from(content, "utf8"));
  binding.agentsMdHash = hash;
  // AGENTS.md is ours, not the user's: it must never be pulled onto their disk,
  // so it deliberately gets no `seen` watermark. `isPodOwnedPath` excludes it
  // from the pull direction.
  savePodBinding(root, binding);
  debugLog("dust:pod", "Wrote pod AGENTS.md", { chars: content.length });
  return true;
}
