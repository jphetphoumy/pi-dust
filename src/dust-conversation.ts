import { dustApiUrl } from "./dust-auth.js";
import { DUST_HEADERS } from "./dust-constants.js";
import { debugLog } from "./dust-debug.js";
import { readDustState } from "./dust-state.js";
import { errorMessage, parseConversationSummaryResponse } from "./dust-validation.js";
import type { DustCredentials, DustSessionReason } from "./dust-types.js";

/** Which Dust conversation a pi session should continue, and where that came from. */
export interface ConversationAttachment {
  conversationId: string | null;
  /**
   * Set when the id was taken from another session file rather than this one,
   * so the caller knows it still has to be persisted under the current file.
   */
  inheritedFrom?: string;
}

/** Everything about a starting session that bears on which conversation it continues. */
export interface AttachmentQuery {
  reason: DustSessionReason;
  sessionFile: string | undefined;
  /** The session pi left to get here. Absent at startup. */
  previousSessionFile?: string;
  /** `parentSession` from the transcript header — set for every fork and branch. */
  parentSessionFile?: string;
}

const DETACHED: ConversationAttachment = { conversationId: null };

/**
 * Decides which Dust conversation a starting session continues.
 *
 * pi keys everything on the session file, and so do we: `conversations` maps a
 * session file to the Dust conversation created while that file was live. The
 * case the map alone cannot answer is a fork, which copies an existing
 * transcript into a brand-new file. Left alone, that copy looks like a fresh
 * session and silently opens a second Dust conversation — the transcript shows
 * a full history that the agent has never seen.
 *
 * The parent is found through the transcript header, because that is the only
 * signal every fork path leaves behind: `pi --fork` arrives as a plain startup
 * with no `previousSessionFile` at all. One level up is enough — an inherited
 * id is written under the heir's own file, so a fork of a fork finds it on its
 * parent.
 *
 * Inheriting is the lesser of two wrongs, not a clean answer. Forking at an
 * entry truncates pi's transcript, while the Dust conversation keeps every
 * message: the agent still remembers what was forked away. Starting fresh
 * instead would strand the history the transcript does show, which is the worse
 * of the two and the bug this exists to fix. The notice says which it is.
 */
export function resolveAttachment(query: AttachmentQuery): ConversationAttachment {
  const { reason, sessionFile } = query;
  if (reason === "new" || !sessionFile) {
    return DETACHED;
  }

  const conversations = readDustState().conversations ?? {};
  const own = conversations[sessionFile];
  if (own) {
    return { conversationId: own };
  }

  const ancestors = [query.parentSessionFile, reason === "fork" ? query.previousSessionFile : undefined];
  for (const ancestor of ancestors) {
    const inherited = ancestor ? conversations[ancestor] : undefined;
    if (inherited) {
      return { conversationId: inherited, inheritedFrom: ancestor };
    }
  }

  return DETACHED;
}

/**
 * Result of asking Dust whether a stored conversation is still usable.
 *
 * `unknown` covers everything we must not act on — an expired token, a network
 * blip, a 500. Those are handled elsewhere (or not at all), and dropping the
 * attachment over one would be worse than keeping it.
 */
export type ConversationCheck =
  | { status: "ok"; title?: string }
  | { status: "gone" }
  | { status: "unknown" };

/**
 * Only a conversation Dust says is absent counts as gone. 403 deliberately does
 * not: Dust answers it for `conversation_access_restricted` and also for
 * `conversation_with_unavailable_agent`, which means the conversation is fine
 * but its agent is archived or momentarily invisible. Treating that as gone
 * would drop a live thread, and the next message would overwrite the mapping
 * for good.
 */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Confirms the conversation we are about to reattach to still exists and is
 * still ours. Without this, a deleted or moved conversation only surfaces as a
 * failed POST in the middle of the first turn after a resume.
 */
export async function verifyConversation(
  cred: DustCredentials,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationCheck> {
  // Without a workspace the URL collapses to `/w//assistant/...`, which Dust
  // answers 404 — indistinguishable from a deleted conversation, and we would
  // drop a live attachment over missing local state.
  if (!cred.workspaceId) {
    debugLog("dust:session", "Skipping conversation check: no workspace", { conversationId });
    return { status: "unknown" };
  }

  const baseUrl = `${dustApiUrl(cred.region ?? "us-central1")}/api/v1/w/${cred.workspaceId}`;
  // `?limit=1` keeps this to one message. Unpaginated, the route is an
  // explicit full-conversation load, and this runs on every start that has a
  // conversation to check — a long thread would be fetched in its entirety only
  // to read back its sId and title.
  const url = `${baseUrl}/assistant/conversations/${conversationId}?limit=1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cred.access ?? ""}`, ...DUST_HEADERS },
      signal,
    });

    if (GONE_STATUSES.has(res.status)) {
      debugLog("dust:session", "Stored conversation is no longer reachable", {
        conversationId,
        status: res.status,
      });
      return { status: "gone" };
    }

    if (!res.ok) {
      debugLog("dust:session", "Conversation check inconclusive", { conversationId, status: res.status });
      return { status: "unknown" };
    }

    const summary = parseConversationSummaryResponse(await res.json());
    return { status: "ok", title: summary.conversation.title };
  } catch (err) {
    debugLog("dust:session", "Conversation check failed", { conversationId, error: errorMessage(err) });
    return { status: "unknown" };
  }
}

/** How an attached conversation is named in the UI. */
export function describeConversation(conversationId: string, title?: string): string {
  const trimmed = title?.trim();
  return trimmed ? `"${trimmed}" (${conversationId})` : conversationId;
}
