import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeCredentials, makeFakeJwt, makeLoginFetchMock, makePendingSseStream, makeSseStream, readState, sessionPath as S, seedAuth, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  useTempAgentDir();
  describe("session_start: fresh agent fetch", () => {
    let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          if (event === "session_start") sessionStartHandler = handler;
        }),
      };
      dustExtension(mockApi as any);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("registers a session_start handler", () => {
      expect(typeof sessionStartHandler).toBe("function");
    });

    it("fetches agents from the API on session_start and updates credentials", async () => {
      const creds = makeCredentials({
        agents: [{ sId: "old-agent", name: "Old", description: "" }],
      });
      const freshAgents = [
        { sId: "agent-1", name: "Helper", description: "A helpful agent" },
        { sId: "agent-2", name: "My Custom Agent", description: "User created" },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: freshAgents }),
        })
      );

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };

      await sessionStartHandler!({}, ctx);

      expect(readState()).toMatchObject({ agents: freshAgents });
    });

    it("restores models from legacy stored credentials without a type field", async () => {
      const legacyCreds = makeCredentials({
        type: undefined,
        agents: [],
      });
      const freshAgents = [{ sId: "agent-1", name: "Helper", description: "A helpful agent" }];

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: freshAgents }),
        }),
      );

      seedLoggedIn(legacyCreds);
      const ctx = { modelRegistry: {} };

      await sessionStartHandler!({}, ctx);

      expect(readState()).toMatchObject({ agents: freshAgents });
    });

    it("calls the correct agent_configurations endpoint for the workspace", async () => {
      const creds = makeCredentials({ workspaceId: "ws-42", region: "us-central1" });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock.mock.calls[0][0]).toContain("ws-42");
      expect(fetchMock.mock.calls[0][0]).toContain("agent_configurations");
    });

    it("sends Authorization header with Bearer token on agent fetch", async () => {
      const creds = makeCredentials({ access: "my-access-token" });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock.mock.calls[0][1]?.headers?.["Authorization"]).toBe("Bearer my-access-token");
    });

    it("sends Dust CLI headers on agent fetch", async () => {
      const creds = makeCredentials();
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock.mock.calls[0][1]?.headers?.["User-Agent"]).toBe("Dust CLI");
      expect(fetchMock.mock.calls[0][1]?.headers?.["X-Dust-CLI-Version"]).toBeDefined();
    });

    it("does not fetch agents if no credentials on session_start", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      seedAuth(null);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("silently skips credential update when agent fetch fails", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };

      // must not throw
      let threw = false;
      try { await sessionStartHandler!({}, ctx); } catch { threw = true; }
      expect(threw).toBe(false);
      // A failed fetch must leave the previously stored agents untouched.
      expect(readState()).toMatchObject({ agents: creds.agents });
    });

    it("re-registers the provider with fresh agents after session_start fetch", async () => {
      const creds = makeCredentials({ agents: [] });
      const freshAgents = [
        { sId: "new-agent", name: "New Agent", description: "Fresh" },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: freshAgents }),
        })
      );

      let lastRegisteredModels: any[] | undefined;
      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          lastRegisteredModels = config.models;
        }),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          if (event === "session_start") sessionStartHandler = handler;
        }),
      };
      dustExtension(mockApi as any);

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(lastRegisteredModels).toBeDefined();
      // id is slugified name — "New Agent" → "new-agent"
      expect(lastRegisteredModels!.some((m: any) => m.id === "new-agent")).toBe(true);
    });

    it("refreshes the token before fetching agents when the access token is expired", async () => {
      const expiredCreds = makeCredentials({
        access: "expired-token",
        refresh: "valid-refresh",
        expires: Date.now() - 1000, // already expired
        agents: [],
      });

      const freshToken = "fresh-access-token";
      const freshAgents = [{ sId: "agent-priv", name: "AgentSonnet", description: "private" }];

      const fetchMock = vi.fn()
        // 1st call: token refresh
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: freshToken,
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
        })
        // 2nd call: agent fetch with fresh token
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: freshAgents }),
        });
      vi.stubGlobal("fetch", fetchMock);

      seedLoggedIn(expiredCreds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      // Token refresh was called first
      const refreshCall = fetchMock.mock.calls[0];
      expect(refreshCall[1]?.body?.toString()).toContain("refresh_token");

      // Agent fetch used the fresh token
      const agentCall = fetchMock.mock.calls[1];
      expect(agentCall[1]?.headers?.["Authorization"]).toBe(`Bearer ${freshToken}`);

      // Updated credentials stored with new token and fresh agents
      expect(readState()).toMatchObject({ agents: freshAgents });
    });

    it("uses the stored token without refreshing when the token is still valid", async () => {
      const validCreds = makeCredentials({
        access: "valid-token",
        expires: Date.now() + 3600_000, // not expired
        agents: [],
      });

      const freshAgents = [{ sId: "agent-1", name: "Helper", description: "" }];
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: freshAgents }),
      });
      vi.stubGlobal("fetch", fetchMock);

      seedLoggedIn(validCreds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      // Only one fetch call (agent fetch, no token refresh)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.headers?.["Authorization"]).toBe("Bearer valid-token");
    });

    it("logs an error to console.error when the agent fetch returns a non-ok response", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("401"), expect.anything());
      errorSpy.mockRestore();
    });

    it("invalidates credentials when the agent fetch returns 401", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(readState()).toMatchObject({ invalidated: true });
    });

    it("logs an error to console.error when the agent fetch throws a network error", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network failure")));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(creds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("network failure"), expect.anything());
      errorSpy.mockRestore();
    });

    it("falls back to stale agents (not empty) when token refresh fails at session_start", async () => {
      const expiredCreds = makeCredentials({
        access: "expired-token",
        refresh: "bad-refresh",
        expires: Date.now() - 1000,
        agents: [{ sId: "stale-agent", name: "Stale", description: "" }],
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(expiredCreds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      // Should not wipe out stale agents — no credential update with empty agents
      expect(readState().agents).not.toEqual([]);
    });

    it("invalidates credentials when token refresh returns 401 at session_start", async () => {
      const expiredCreds = makeCredentials({
        access: "expired-token",
        refresh: "bad-refresh",
        expires: Date.now() - 1000,
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(expiredCreds);
      const ctx = { modelRegistry: {} };
      await sessionStartHandler!({}, ctx);

      expect(readState()).toMatchObject({ invalidated: true });
      expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // session_start — which Dust conversation a session continues
  // ---------------------------------------------------------------------------

  describe("session_start: conversation attachment", () => {
    const model = {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };

    /**
     * A fetch double that answers by URL rather than by call order, so a test
     * only states the conversation it expects and stays readable when the
     * number of MCP round trips changes.
     */
    function makeStreamFetch(conversationSId: string, userMessageSId = "msg-1") {
      const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      return vi.fn().mockImplementation((url: string) => {
        if (url.includes("/mcp/register")) {
          return ok({ serverId: "mcp-1", expiresAt: new Date(Date.now() + 300_000).toISOString() });
        }
        if (url.includes("/mcp/requests")) {
          return Promise.resolve({ ok: true, body: makePendingSseStream() });
        }
        if (url.includes("/events")) {
          return Promise.resolve({
            ok: true,
            body: makeSseStream([{ type: "agent_message_success", message: { content: "OK" } }]),
            headers: { get: () => "text/event-stream" },
          });
        }
        if (/\/assistant\/conversations$/.test(url)) {
          return ok({
            conversation: { sId: conversationSId, content: [[{ type: "user_message", sId: userMessageSId }]] },
            message: { sId: userMessageSId },
          });
        }
        if (url.endsWith("/messages")) {
          return ok({ message: { sId: userMessageSId } });
        }
        // GET of the conversation, to find the agent message that answers ours.
        return ok({
          conversation: {
            sId: conversationSId,
            content: [
              [{ type: "user_message", sId: userMessageSId }],
              [{ type: "agent_message", sId: "amsg-1", parentMessageId: userMessageSId }],
            ],
          },
        });
      });
    }

    /** Runs one turn and reports which conversation endpoint it went to. */
    async function sendMessage(capturedStreamSimple: any, conversationSId: string) {
      const fetchMock = makeStreamFetch(conversationSId);
      vi.stubGlobal("fetch", fetchMock);
      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Continue" }] });
      for await (const _ of stream) { /* drain */ }
      vi.unstubAllGlobals();

      const urls: string[] = fetchMock.mock.calls.map(([url]: [string]) => url);
      return {
        createdConversation: urls.some((url) => /\/assistant\/conversations$/.test(url)),
        postedTo: urls.find((url) => url.endsWith("/messages")),
      };
    }

    /** Lets a handler run up to its next real await. */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    interface StartOptions {
      /** Status Dust answers the reattach check with. */
      conversationStatus?: number;
      title?: string;
      /** `parentSession` in the transcript header, as forks and branches carry. */
      parentSessionFile?: string;
    }

    async function setup(conversations: Record<string, string> = {}) {
      const creds = makeCredentials({ conversations });
      seedLoggedIn(creds);
      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      const notify = vi.fn();

      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          capturedStreamSimple = config.streamSimple;
        }),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          if (event === "session_start") sessionStartHandler = handler;
        }),
      };
      dustExtension(mockApi as any);

      const makeCtx = (file: string | undefined, parentSession?: string) => ({
        modelRegistry: {},
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue(file),
          getEntries: vi.fn().mockReturnValue([]),
          getHeader: vi.fn().mockReturnValue(parentSession ? { parentSession } : {}),
        },
        ui: { notify },
      });

      /** Fires session_start the way pi does, answering the calls it makes. */
      const start = async (
        event: { reason?: string; previousSessionFile?: string },
        sessionFile: string | undefined = S("s1.json"),
        options: StartOptions = {},
      ) => {
        const status = options.conversationStatus ?? 200;
        const fetchMock = vi.fn().mockImplementation((url: string) => {
          if (url.includes("/assistant/conversations/")) {
            return Promise.resolve({
              ok: status < 400,
              status,
              json: () => Promise.resolve({ conversation: { sId: "conv", title: options.title } }),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ agentConfigurations: creds.agents }) });
        });
        vi.stubGlobal("fetch", fetchMock);
        await sessionStartHandler!(event, makeCtx(sessionFile, options.parentSessionFile));
        vi.unstubAllGlobals();
        return fetchMock;
      };

      /**
       * Fires session_start but holds the conversation check open, the way a
       * slow Dust would, so a turn can begin while the extension is still
       * attaching. `finish()` lets the handler run to completion.
       */
      const startWithPendingCheck = (
        event: { reason?: string; previousSessionFile?: string },
        sessionFile: string | undefined = S("s1.json"),
      ) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const agents = () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: creds.agents }),
        });
        const checkFetch = vi.fn().mockImplementation((url: string) => {
          if (url.includes("/assistant/conversations/")) {
            return held.then(() => ({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ conversation: { sId: "conv" } }),
            }));
          }
          return agents();
        });
        vi.stubGlobal("fetch", checkFetch);
        const done = sessionStartHandler!(event, makeCtx(sessionFile));

        return {
          finish: async () => {
            // The turn under test replaced the stub; restore one so the rest of
            // the handler cannot reach the network.
            vi.stubGlobal("fetch", checkFetch);
            release();
            await done;
            vi.unstubAllGlobals();
          },
        };
      };

      /**
       * Fires session_start with an expired token and holds the refresh open.
       * Refreshing is the first network call the handler makes, so this is the
       * earliest window in which a turn can race a session transition.
       */
      const startWithPendingRefresh = (
        event: { reason?: string; previousSessionFile?: string },
        sessionFile: string | undefined = S("s1.json"),
      ) => {
        seedLoggedIn({ ...creds, expires: Date.now() - 1_000 });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const refreshFetch = vi.fn().mockImplementation((url: string) => {
          if (url.includes("user_management")) {
            return held.then(() => ({
              ok: true,
              json: () => Promise.resolve({
                access_token: creds.access,
                refresh_token: creds.refresh,
                expires_in: 900,
              }),
            }));
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              agentConfigurations: creds.agents,
              conversation: { sId: "conv" },
            }),
          });
        });
        vi.stubGlobal("fetch", refreshFetch);
        const done = sessionStartHandler!(event, makeCtx(sessionFile));

        return {
          finish: async () => {
            vi.stubGlobal("fetch", refreshFetch);
            release();
            await done;
            vi.unstubAllGlobals();
          },
        };
      };

      return {
        get capturedStreamSimple() { return capturedStreamSimple; },
        start,
        startWithPendingCheck,
        startWithPendingRefresh,
        notify,
        makeCtx,
      };
    }

    it("reason=new detaches, so the next message opens a fresh conversation", async () => {
      const session = await setup({ [S("s1.json")]: "conv-old" });

      await session.start({ reason: "new" });

      const turn = await sendMessage(session.capturedStreamSimple, "conv-new");
      expect(turn.createdConversation).toBe(true);
    });

    it("reason=resume reattaches to the conversation stored for that session file", async () => {
      const session = await setup({ [S("old.json")]: "conv-existing" });

      await session.start({ reason: "resume", previousSessionFile: S("s1.json") }, S("old.json"));

      const turn = await sendMessage(session.capturedStreamSimple, "conv-existing");
      expect(turn.createdConversation).toBe(false);
      expect(turn.postedTo).toContain("/assistant/conversations/conv-existing/messages");
    });

    it("reason=resume with no stored conversation starts a new one", async () => {
      const session = await setup();

      await session.start({ reason: "resume" }, S("unknown.json"));

      const turn = await sendMessage(session.capturedStreamSimple, "conv-brand-new");
      expect(turn.createdConversation).toBe(true);
    });

    it("startup restores the conversation even before the session has entries", async () => {
      const session = await setup({ [S("old.json")]: "conv-from-last-time" });

      await session.start({ reason: "startup" }, S("old.json"));

      const turn = await sendMessage(session.capturedStreamSimple, "conv-from-last-time");
      expect(turn.postedTo).toContain("/assistant/conversations/conv-from-last-time/messages");
    });

    it("a fork keeps talking to the conversation its parent session was on", async () => {
      const session = await setup({ [S("parent.json")]: "conv-parent" });

      await session.start(
        { reason: "fork", previousSessionFile: S("parent.json") },
        S("fork.json"),
      );

      const turn = await sendMessage(session.capturedStreamSimple, "conv-parent");
      expect(turn.createdConversation).toBe(false);
      expect(turn.postedTo).toContain("/assistant/conversations/conv-parent/messages");
    });

    it("records the inherited conversation under the fork's own session file", async () => {
      const session = await setup({ [S("parent.json")]: "conv-parent" });

      await session.start(
        { reason: "fork", previousSessionFile: S("parent.json") },
        S("fork.json"),
      );

      // Without this the fork would come back detached on its next resume,
      // where there is no previousSessionFile left to inherit from.
      expect(readState().conversations).toMatchObject({ [S("fork.json")]: "conv-parent" });
    });

    it("`pi --fork` keeps the parent's conversation, though it looks like a startup", async () => {
      const session = await setup({ [S("parent.json")]: "conv-parent" });

      // Forking from the command line reports reason "startup" with no
      // previousSessionFile; the transcript header is the only link left.
      await session.start({ reason: "startup" }, S("fork.json"), {
        parentSessionFile: S("parent.json"),
      });

      const turn = await sendMessage(session.capturedStreamSimple, "conv-parent");
      expect(turn.postedTo).toContain("/assistant/conversations/conv-parent/messages");
    });

    it("a fork of a session that never reached Dust starts fresh", async () => {
      const session = await setup();

      await session.start(
        { reason: "fork", previousSessionFile: S("parent.json") },
        S("fork.json"),
      );

      const turn = await sendMessage(session.capturedStreamSimple, "conv-new");
      expect(turn.createdConversation).toBe(true);
    });

    it("detaches and warns when the stored conversation is gone", async () => {
      const session = await setup({ [S("old.json")]: "conv-deleted" });

      await session.start({ reason: "resume" }, S("old.json"), { conversationStatus: 404 });

      expect(session.notify).toHaveBeenCalledWith(expect.stringContaining("conv-deleted"), "warning");
      const turn = await sendMessage(session.capturedStreamSimple, "conv-new");
      expect(turn.createdConversation).toBe(true);
    });

    it("keeps the attachment when the reattach check is inconclusive", async () => {
      const session = await setup({ [S("old.json")]: "conv-existing" });

      // A 500 says nothing about whether the conversation is still there;
      // dropping it over one would lose a live session.
      await session.start({ reason: "resume" }, S("old.json"), { conversationStatus: 500 });

      const turn = await sendMessage(session.capturedStreamSimple, "conv-existing");
      expect(turn.createdConversation).toBe(false);
    });

    it("names the conversation it reattached to", async () => {
      const session = await setup({ [S("old.json")]: "conv-existing" });

      await session.start({ reason: "resume" }, S("old.json"), { title: "Ship the parser" });

      expect(session.notify).toHaveBeenCalledWith(
        expect.stringContaining('"Ship the parser" (conv-existing)'),
        "info",
      );
    });

    it("says nothing on a plain start with no conversation to restore", async () => {
      const session = await setup();

      const fetchMock = await session.start({ reason: "startup" });

      expect(session.notify).not.toHaveBeenCalled();
      const checkedConversation = fetchMock.mock.calls.some(([url]: [string]) =>
        url.includes("/assistant/conversations/"),
      );
      expect(checkedConversation).toBe(false);
    });

    it("persists a newly created conversation under the current session file", async () => {
      const session = await setup();

      await session.start({ reason: "startup" }, S("s1.json"));
      await sendMessage(session.capturedStreamSimple, "conv-persisted");

      expect(readState().conversations).toMatchObject({ [S("s1.json")]: "conv-persisted" });
    });

    it("after a resume, a new conversation is stored under the resumed file", async () => {
      const session = await setup();

      await session.start({ reason: "startup" }, S("s1.json"));
      await session.start({ reason: "resume", previousSessionFile: S("s1.json") }, S("s2.json"));
      await sendMessage(session.capturedStreamSimple, "conv-for-resumed");

      const conversations = readState().conversations as Record<string, string>;
      expect(conversations[S("s2.json")]).toBe("conv-for-resumed");
      expect(conversations[S("s1.json")]).not.toBe("conv-for-resumed");
    });

    it("forgets a conversation Dust says is gone, so it is not re-checked forever", async () => {
      // Left in state, the next start of this session repeats the request and
      // the warning — for as long as the user reads scrollback without sending.
      const session = await setup({ [S("old.json")]: "conv-deleted" });

      await session.start({ reason: "resume" }, S("old.json"), { conversationStatus: 404 });

      expect(readState().conversations ?? {}).not.toHaveProperty(S("old.json"));
    });

    it("keeps the mapping when the check is only inconclusive", async () => {
      const session = await setup({ [S("old.json")]: "conv-existing" });

      await session.start({ reason: "resume" }, S("old.json"), { conversationStatus: 500 });

      expect(readState().conversations).toMatchObject({ [S("old.json")]: "conv-existing" });
    });

    it("forgets a gone conversation where it is actually recorded — on the ancestor", async () => {
      // A fork's id lives under its parent's file. Dropping it under the fork's
      // own file would clear nothing, and the fork would inherit the dead
      // conversation again on every start.
      const session = await setup({ [S("parent.json")]: "conv-deleted" });

      await session.start(
        { reason: "fork", previousSessionFile: S("parent.json") },
        S("fork.json"),
        { conversationStatus: 404 },
      );

      expect(readState().conversations ?? {}).not.toHaveProperty(S("parent.json"));
      const turn = await sendMessage(session.capturedStreamSimple, "conv-fresh");
      expect(turn.createdConversation).toBe(true);
    });

    it("attaches before refreshing a token, so a message sent meanwhile continues the thread", async () => {
      // Refreshing is a network round-trip. Attaching after it would leave the
      // session unattached during that window, so a message arriving first
      // would open a second conversation — and the session would then be
      // pointed at a thread its own first message never reached.
      const session = await setup({ [S("old.json")]: "conv-existing" });

      const pending = session.startWithPendingRefresh({ reason: "resume" }, S("old.json"));
      await tick();
      const turn = await sendMessage(session.capturedStreamSimple, "conv-existing");

      expect(turn.createdConversation).toBe(false);
      expect(turn.postedTo).toContain("/assistant/conversations/conv-existing/messages");
      await pending.finish();
    });

    it("attaches before the check answers, so a message sent meanwhile lands in the right conversation", async () => {
      // pi accepts input before extensions finish starting. If the id were only
      // assigned once Dust answered, that message would open a second
      // conversation and the session would end up split across two threads.
      const session = await setup({ [S("old.json")]: "conv-existing" });
      const pending = session.startWithPendingCheck({ reason: "resume" }, S("old.json"));
      await tick();

      const turn = await sendMessage(session.capturedStreamSimple, "conv-existing");

      expect(turn.createdConversation).toBe(false);
      expect(turn.postedTo).toContain("/assistant/conversations/conv-existing/messages");
      await pending.finish();
    });
  });

  // ---------------------------------------------------------------------------
  // login() — username storage
  // ---------------------------------------------------------------------------

  describe("login() username storage", () => {
    let loginFn: any;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          loginFn = config.oauth.login;
        }),
        registerCommand: vi.fn(),
      };
      dustExtension(mockApi as any);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("stores username from /api/v1/me in credentials", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal("fetch", makeLoginFetchMock({ jwt }));

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(result.username).toBe("janedoe");
    });
  });

  describe("session_start: belt-and-braces /loop stop", () => {
    let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
    let loopHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    let sendUserMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      sendUserMessage = vi.fn();
      const mockApi = {
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, cfg: any) => {
          if (name === "loop") loopHandler = cfg.handler;
        }),
        on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          if (event === "session_start") sessionStartHandler = handler;
        }),
        sendUserMessage,
      };
      dustExtension(mockApi as any);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("stops an active loop when a new session_start arrives, even without a matching session_shutdown", async () => {
      const creds = makeCredentials();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ agentConfigurations: [] }) }),
      );
      seedLoggedIn(creds);

      const ctx = { modelRegistry: {}, ui: { notify: vi.fn(), setStatus: vi.fn() }, isIdle: () => true };
      await loopHandler!("5m /babysit-prs", ctx);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);

      await sessionStartHandler!({ reason: "new" }, ctx);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("dust-loop", undefined);

      sendUserMessage.mockClear();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sendUserMessage).not.toHaveBeenCalled();
    });
  });
});
