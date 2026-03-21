import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeCredentials, makeFakeJwt, makeLoginFetchMock, makePendingSseStream, makeSseStream } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
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

      const authStorage = { get: vi.fn().mockReturnValue(creds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };

      await sessionStartHandler!({}, ctx);

      expect(authStorage.set).toHaveBeenCalledWith(
        "dust",
        expect.objectContaining({ agents: freshAgents })
      );
    });

    it("calls the correct agent_configurations endpoint for the workspace", async () => {
      const creds = makeCredentials({ workspaceId: "ws-42", region: "us-central1" });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
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

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
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

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock.mock.calls[0][1]?.headers?.["User-Agent"]).toBe("Dust CLI");
      expect(fetchMock.mock.calls[0][1]?.headers?.["X-Dust-CLI-Version"]).toBeDefined();
    });

    it("does not fetch agents if no credentials on session_start", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(undefined), set: vi.fn() } } };
      await sessionStartHandler!({}, ctx);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("silently skips credential update when agent fetch fails", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));

      const authStorage = { get: vi.fn().mockReturnValue(creds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };

      // must not throw
      let threw = false;
      try { await sessionStartHandler!({}, ctx); } catch { threw = true; }
      expect(threw).toBe(false);
      expect(authStorage.set).not.toHaveBeenCalled();
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

      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
      };
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

      const authStorage = { get: vi.fn().mockReturnValue(expiredCreds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };
      await sessionStartHandler!({}, ctx);

      // Token refresh was called first
      const refreshCall = fetchMock.mock.calls[0];
      expect(refreshCall[1]?.body?.toString()).toContain("refresh_token");

      // Agent fetch used the fresh token
      const agentCall = fetchMock.mock.calls[1];
      expect(agentCall[1]?.headers?.["Authorization"]).toBe(`Bearer ${freshToken}`);

      // Updated credentials stored with new token and fresh agents
      expect(authStorage.set).toHaveBeenCalledWith(
        "dust",
        expect.objectContaining({
          access: freshToken,
          agents: freshAgents,
        })
      );
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

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(validCreds), set: vi.fn() } } };
      await sessionStartHandler!({}, ctx);

      // Only one fetch call (agent fetch, no token refresh)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.headers?.["Authorization"]).toBe("Bearer valid-token");
    });

    it("logs an error to console.error when the agent fetch returns a non-ok response", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
      await sessionStartHandler!({}, ctx);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("401"), expect.anything());
      errorSpy.mockRestore();
    });

    it("invalidates credentials when the agent fetch returns 401", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const authStorage = { get: vi.fn().mockReturnValue(creds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };
      await sessionStartHandler!({}, ctx);

      expect(authStorage.set).toHaveBeenCalledWith(
        "dust",
        expect.objectContaining({ access: "", refresh: "", expires: 0 })
      );
    });

    it("logs an error to console.error when the agent fetch throws a network error", async () => {
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network failure")));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
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

      const authStorage = { get: vi.fn().mockReturnValue(expiredCreds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };
      await sessionStartHandler!({}, ctx);

      // Should not wipe out stale agents — no credential update with empty agents
      const setCall = authStorage.set.mock.calls.find(
        ([, c]: [string, any]) => Array.isArray(c.agents) && c.agents.length === 0
      );
      expect(setCall).toBeUndefined();
    });

    it("invalidates credentials when token refresh returns 401 at session_start", async () => {
      const expiredCreds = makeCredentials({
        access: "expired-token",
        refresh: "bad-refresh",
        expires: Date.now() - 1000,
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const authStorage = { get: vi.fn().mockReturnValue(expiredCreds), set: vi.fn() };
      const ctx = { modelRegistry: { authStorage } };
      await sessionStartHandler!({}, ctx);

      expect(authStorage.set).toHaveBeenCalledWith(
        "dust",
        expect.objectContaining({ access: "", refresh: "", expires: 0 })
      );
      expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // session_switch — conversation management on /new and /resume
  // ---------------------------------------------------------------------------

  describe("session_switch: conversation management", () => {
    /** Shared setup: registers dust extension and fires session_start to bake credentials. */
    async function setupHandlers(sessionFile = "/sessions/s1.json", conversations: Record<string, string> = {}) {
      const creds = makeCredentials({ conversations });
      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      let sessionSwitchHandler: ((event: unknown, ctx: any) => void) | undefined;
      const authStorageSet = vi.fn();

      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          capturedStreamSimple = config.streamSimple;
        }),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          if (event === "session_start") sessionStartHandler = handler;
          if (event === "session_switch") sessionSwitchHandler = handler;
        }),
      };

      dustExtension(mockApi as any);

      // Fire session_start to bake credentials into the streamSimple closure.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));

      const makeCtx = (file: string | undefined, entries: unknown[] = []) => ({
        modelRegistry: {
          authStorage: {
            get: vi.fn().mockReturnValue({ ...creds }),
            set: authStorageSet,
          },
        },
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue(file),
          getEntries: vi.fn().mockReturnValue(entries),
        },
      });

      await sessionStartHandler!({}, makeCtx(sessionFile, []));
      vi.unstubAllGlobals();

      return { capturedStreamSimple, sessionSwitchHandler, makeCtx, authStorageSet, creds };
    }

    const model = {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };

    function makeConvFetch(convSId: string, msgSId: string) {
      return vi.fn()
        // MCP register (called before any conversation fetch when mcpServerId is null)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-conv-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // MCP requests SSE (background, empty)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // POST /assistant/conversations → create conversation
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: convSId,
              content: [[{ type: "user_message", sId: msgSId }]],
            },
            message: { sId: msgSId },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success", message: { content: "OK" } }]),
          headers: { get: () => "text/event-stream" },
        });
    }

    it("reason=new resets conversation so next message starts a fresh Dust conversation", async () => {
      const { capturedStreamSimple, sessionSwitchHandler, makeCtx } = await setupHandlers();

      // First message — establishes a conversation
      vi.stubGlobal("fetch", makeConvFetch("conv-first", "msg-1"));
      const stream1 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream1) { /* drain */ }

      // /new fires session_switch with reason="new"
      sessionSwitchHandler!({ reason: "new" }, makeCtx("/sessions/s1.json"));

      // Next message must POST /assistant/conversations (new conversation)
      const fetchMock = makeConvFetch("conv-new", "msg-2");
      vi.stubGlobal("fetch", fetchMock);
      const stream2 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Fresh start" }] });
      for await (const _ of stream2) { /* drain */ }

      const convCreateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        /\/assistant\/conversations$/.test(url)
      );
      expect(convCreateCall).toBeDefined();
      expect(convCreateCall![0]).not.toContain("conv-first");
    });

    it("reason=resume restores conversation from credentials storage", async () => {
      const existingConvId = "conv-existing";
      const targetFile = "/sessions/old.json";
      const { capturedStreamSimple, sessionSwitchHandler, makeCtx } = await setupHandlers(
        "/sessions/current.json",
        { [targetFile]: existingConvId },
      );

      // /resume fires session_switch with reason="resume"; session manager now points to targetFile
      sessionSwitchHandler!({ reason: "resume" }, makeCtx(targetFile));

      // Next message must POST to /messages on the existing conversation (not create a new one)
      const fetchMock = vi.fn()
        // MCP register (cleared on session_switch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-resume-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // MCP requests SSE (background, empty)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-new" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: existingConvId,
              content: [
                [{ type: "user_message", sId: "msg-new" }],
                [{ type: "agent_message", sId: "amsg-new", parentMessageId: "msg-new" }],
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success", message: { content: "Continued" } }]),
          headers: { get: () => "text/event-stream" },
        });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Continue" }] });
      for await (const _ of stream) { /* drain */ }

      // Must have called POST to the existing conversation's messages endpoint
      const messagesCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes(`/assistant/conversations/${existingConvId}/messages`)
      );
      expect(messagesCall).toBeDefined();
    });

    it("reason=resume with no stored conversation starts a new one", async () => {
      const targetFile = "/sessions/unknown.json";
      const { capturedStreamSimple, sessionSwitchHandler, makeCtx } = await setupHandlers();

      sessionSwitchHandler!({ reason: "resume" }, makeCtx(targetFile));

      const fetchMock = makeConvFetch("conv-brand-new", "msg-x");
      vi.stubGlobal("fetch", fetchMock);
      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const convCreateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        /\/assistant\/conversations$/.test(url)
      );
      expect(convCreateCall).toBeDefined();
    });

    it("persists newly-created conversation ID in credentials storage", async () => {
      const sessionFile = "/sessions/s1.json";
      const { capturedStreamSimple, authStorageSet } = await setupHandlers(sessionFile);

      const fetchMock = makeConvFetch("conv-persisted", "msg-1");
      vi.stubGlobal("fetch", fetchMock);
      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Store me" }] });
      for await (const _ of stream) { /* drain */ }

      // authStorage.set must have been called with conversations map containing the session file
      const setCall = authStorageSet.mock.calls.find(
        ([_key, val]: any[]) => val?.conversations?.[sessionFile]
      );
      expect(setCall).toBeDefined();
      expect(setCall![1].conversations[sessionFile]).toBe("conv-persisted");
    });

    it("after resume, persists new conversation under the RESUMED session file, not the original", async () => {
      const originalFile = "/sessions/s1.json";
      const resumedFile = "/sessions/s2.json";
      const authStorageSet = vi.fn();

      const creds = makeCredentials();
      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      let sessionSwitchHandler: ((event: unknown, ctx: any) => void) | undefined;

      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          capturedStreamSimple = config.streamSimple;
        }),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          if (event === "session_start") sessionStartHandler = handler;
          if (event === "session_switch") sessionSwitchHandler = handler;
        }),
      };
      dustExtension(mockApi as any);

      // session_start: start on originalFile, no entries
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));
      const makeCtxFor = (file: string) => ({
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue({ ...creds }), set: authStorageSet } },
        sessionManager: { getSessionFile: vi.fn().mockReturnValue(file), getEntries: vi.fn().mockReturnValue([]) },
      });
      await sessionStartHandler!({}, makeCtxFor(originalFile));
      vi.unstubAllGlobals();

      // /resume to resumedFile (no stored conv for it)
      sessionSwitchHandler!({ reason: "resume" }, makeCtxFor(resumedFile));

      // Send a message — should create new Dust conversation; save under resumedFile
      const fetchMock = makeConvFetch("conv-for-resumed", "msg-r1");
      vi.stubGlobal("fetch", fetchMock);
      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Resumed msg" }] });
      for await (const _ of stream) { /* drain */ }

      // Conversation must be saved under resumedFile, NOT originalFile
      const setCall = authStorageSet.mock.calls.find(
        ([_key, val]: any[]) => val?.conversations?.[resumedFile]
      );
      expect(setCall).toBeDefined();
      expect(setCall![1].conversations[resumedFile]).toBe("conv-for-resumed");
      // originalFile must not have been set
      const badCall = authStorageSet.mock.calls.find(
        ([_key, val]: any[]) => val?.conversations?.[originalFile] === "conv-for-resumed"
      );
      expect(badCall).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // session_start — startup resume restores conversation
  // ---------------------------------------------------------------------------

  describe("session_start: startup resume restores conversation", () => {
    it("restores conversation ID when session already has entries (--resume at startup)", async () => {
      const sessionFile = "/sessions/old.json";
      const existingConvId = "conv-from-last-time";
      const creds = makeCredentials({ conversations: { [sessionFile]: existingConvId } });

      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

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

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));

      // Simulate startup --resume: session has existing entries
      await sessionStartHandler!(
        {},
        {
          modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
          sessionManager: {
            getSessionFile: vi.fn().mockReturnValue(sessionFile),
            getEntries: vi.fn().mockReturnValue([{ type: "message" }]), // non-empty = resume
          },
        },
      );
      vi.unstubAllGlobals();

      const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

      // First call after restore must POST to existing conversation's messages (not create new)
      const fetchMock = vi.fn()
        // MCP register (currentMcpServerId is null after dustExtension() was called)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-resume-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // MCP requests SSE (background, empty)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-next" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: existingConvId,
              content: [
                [{ type: "user_message", sId: "msg-next" }],
                [{ type: "agent_message", sId: "amsg-next", parentMessageId: "msg-next" }],
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success", message: { content: "Resumed" } }]),
          headers: { get: () => "text/event-stream" },
        });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Continue" }] });
      for await (const _ of stream) { /* drain */ }

      // Must have POSTed to the existing conversation's messages endpoint
      const messagesCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes(`/assistant/conversations/${existingConvId}/messages`)
      );
      expect(messagesCall).toBeDefined();
    });

    it("starts fresh when session has no entries (new session at startup)", async () => {
      const sessionFile = "/sessions/new.json";
      const creds = makeCredentials();

      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

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

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));

      await sessionStartHandler!(
        {},
        {
          modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
          sessionManager: {
            getSessionFile: vi.fn().mockReturnValue(sessionFile),
            getEntries: vi.fn().mockReturnValue([]), // empty = fresh start
          },
        },
      );
      vi.unstubAllGlobals();

      const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

      const fetchMock = vi.fn()
        // MCP register (currentMcpServerId is null after dustExtension() was called)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-fresh-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // MCP requests SSE (background, empty)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-fresh", content: [[{ type: "user_message", sId: "msg-1" }]] },
            message: { sId: "msg-1" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success", message: { content: "Hello" } }]),
          headers: { get: () => "text/event-stream" },
        });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const convCreateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        /\/assistant\/conversations$/.test(url)
      );
      expect(convCreateCall).toBeDefined();
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
});
