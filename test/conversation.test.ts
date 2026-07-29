import { describe, expect, it, vi } from "vitest";
import { DUST_HEADERS } from "../src/dust-constants.js";
import { describeConversation, resolveAttachment, verifyConversation } from "../src/dust-conversation.js";
import { makeCredentials, seedLoggedIn, seedState, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust conversation attachment", () => {
  useTempAgentDir();

  describe("resolveAttachment", () => {
    it("returns the conversation stored for the session file", () => {
      seedState({ conversations: { "/sessions/a.json": "conv-a" } });

      expect(resolveAttachment({ reason: "resume", sessionFile: "/sessions/a.json" }))
        .toEqual({ conversationId: "conv-a" });
    });

    it("detaches on /new even when the session file has a conversation", () => {
      seedState({ conversations: { "/sessions/a.json": "conv-a" } });

      expect(resolveAttachment({ reason: "new", sessionFile: "/sessions/a.json" }))
        .toEqual({ conversationId: null });
    });

    it("detaches when pi has no session file to key on", () => {
      seedState({ conversations: { "/sessions/a.json": "conv-a" } });

      expect(resolveAttachment({ reason: "resume", sessionFile: undefined, previousSessionFile: "/sessions/a.json" }))
        .toEqual({ conversationId: null });
    });

    it("inherits from the session the fork came from", () => {
      seedState({ conversations: { "/sessions/parent.json": "conv-parent" } });

      expect(resolveAttachment({
        reason: "fork",
        sessionFile: "/sessions/fork.json",
        previousSessionFile: "/sessions/parent.json",
      })).toEqual({ conversationId: "conv-parent", inheritedFrom: "/sessions/parent.json" });
    });

    it("inherits from the transcript's parent, which is all `pi --fork` leaves behind", () => {
      seedState({ conversations: { "/sessions/parent.json": "conv-parent" } });

      // Forking from the command line arrives as a plain startup: no reason of
      // its own and no previous session file, only the header link.
      expect(resolveAttachment({
        reason: "startup",
        sessionFile: "/sessions/fork.json",
        parentSessionFile: "/sessions/parent.json",
      })).toEqual({ conversationId: "conv-parent", inheritedFrom: "/sessions/parent.json" });
    });

    it("prefers the fork's own conversation over its parent's", () => {
      seedState({
        conversations: {
          "/sessions/parent.json": "conv-parent",
          "/sessions/fork.json": "conv-fork",
        },
      });

      expect(resolveAttachment({
        reason: "fork",
        sessionFile: "/sessions/fork.json",
        previousSessionFile: "/sessions/parent.json",
        parentSessionFile: "/sessions/parent.json",
      })).toEqual({ conversationId: "conv-fork" });
    });

    it("does not inherit across a resume", () => {
      seedState({ conversations: { "/sessions/previous.json": "conv-previous" } });

      // Resuming means going back to a specific session; carrying the outgoing
      // session's conversation into it would splice two threads together.
      expect(resolveAttachment({
        reason: "resume",
        sessionFile: "/sessions/other.json",
        previousSessionFile: "/sessions/previous.json",
      })).toEqual({ conversationId: null });
    });

    it("stays detached when no ancestor ever reached Dust", () => {
      seedState({ conversations: {} });

      expect(resolveAttachment({
        reason: "fork",
        sessionFile: "/sessions/fork.json",
        previousSessionFile: "/sessions/parent.json",
        parentSessionFile: "/sessions/parent.json",
      })).toEqual({ conversationId: null });
    });
  });

  describe("verifyConversation", () => {
    const cred = makeCredentials({ workspaceId: "w-1", region: "us-central1" });

    function stubStatus(status: number, body: unknown = {}) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("reports ok with the conversation title", async () => {
      seedLoggedIn(cred);
      stubStatus(200, { conversation: { sId: "conv-1", title: "Ship the parser" } });

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({
        status: "ok",
        title: "Ship the parser",
      });
      vi.unstubAllGlobals();
    });

    it("asks the workspace's own conversation endpoint, authenticated", async () => {
      const fetchMock = stubStatus(200, { conversation: { sId: "conv-1" } });

      await verifyConversation(cred, "conv-1");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/api/v1/w/w-1/assistant/conversations/conv-1");
      // Unpaginated, this route is an explicit full-conversation load.
      expect(url).toContain("limit=1");
      // An unauthenticated check answers 401, which reads as inconclusive and
      // would quietly turn this into a no-op.
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${cred.access}`, ...DUST_HEADERS });
      vi.unstubAllGlobals();
    });

    it.each([404, 410])("reports gone on HTTP %i", async (status) => {
      stubStatus(status);

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({ status: "gone" });
      vi.unstubAllGlobals();
    });

    it("keeps a 403 conversation, which may only have an unavailable agent", async () => {
      // Dust answers 403 for `conversation_access_restricted` and for
      // `conversation_with_unavailable_agent`. The second is transient, and
      // dropping the attachment over it loses the thread for good.
      stubStatus(403);

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({ status: "unknown" });
      vi.unstubAllGlobals();
    });

    it("cannot check without a workspace, so it stays inconclusive", async () => {
      // `/w//assistant/...` answers 404, which would otherwise read as gone.
      const fetchMock = stubStatus(404);

      await expect(verifyConversation({ ...cred, workspaceId: undefined }, "conv-1"))
        .resolves.toEqual({ status: "unknown" });
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it.each([401, 500, 503])("stays inconclusive on HTTP %i", async (status) => {
      stubStatus(status);

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({ status: "unknown" });
      vi.unstubAllGlobals();
    });

    it("stays inconclusive when the request itself fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({ status: "unknown" });
      vi.unstubAllGlobals();
    });

    it("passes the caller's signal on, and an abort reads as inconclusive", async () => {
      // pi awaits session_start, and fetch has no timeout of its own, so the
      // caller's timeout is the only thing that bounds a hung Dust.
      const controller = new AbortController();
      const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }));
      vi.stubGlobal("fetch", fetchMock);

      const check = verifyConversation(cred, "conv-1", controller.signal);
      controller.abort();

      await expect(check).resolves.toEqual({ status: "unknown" });
      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
      vi.unstubAllGlobals();
    });

    it("stays inconclusive when the payload is not a conversation", async () => {
      stubStatus(200, { nope: true });

      await expect(verifyConversation(cred, "conv-1")).resolves.toEqual({ status: "unknown" });
      vi.unstubAllGlobals();
    });
  });

  describe("describeConversation", () => {
    it("names a titled conversation", () => {
      expect(describeConversation("conv-1", "Ship the parser")).toBe('"Ship the parser" (conv-1)');
    });

    it("falls back to the id when there is no usable title", () => {
      expect(describeConversation("conv-1")).toBe("conv-1");
      expect(describeConversation("conv-1", "   ")).toBe("conv-1");
    });
  });
});
