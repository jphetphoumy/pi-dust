import { describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeCredentials, makePendingSseStream, makeSseStream } from "./helpers/dust-fixtures.js";
import { piToolContextFields, readState, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  useTempAgentDir();
  // ---------------------------------------------------------------------------
  // MCP server management
  // ---------------------------------------------------------------------------

  describe("MCP server management", () => {
    async function setupWithMcp(conversations: Record<string, string> = {}) {
      const creds = makeCredentials({ conversations });
      seedLoggedIn(creds);
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

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));

      const makeCtx = (file: string | undefined = "/sessions/s1.json", entries: unknown[] = []) => ({
        modelRegistry: {},
        ...piToolContextFields(),
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue(file),
          getEntries: vi.fn().mockReturnValue(entries),

          getSessionId: vi.fn().mockReturnValue("test-session"),
        },
      });

      await sessionStartHandler!({}, makeCtx());
      vi.unstubAllGlobals();

      return { capturedStreamSimple, sessionSwitchHandler, makeCtx, creds };
    }

    const model = {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };

    function makeMcpConvFetch(
      convSId: string,
      msgSId: string,
      agentMsgSId: string,
      mcpServerId = "mcp-server-1",
      sseEvents: object[] = [{ type: "agent_message_success" }],
    ) {
      return vi.fn()
        // 1. POST /mcp/register → returns serverId
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: mcpServerId, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests → pending SSE (never closes, no reconnect)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 3. POST /assistant/conversations → create conversation
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: convSId,
              content: [
                [{ type: "user_message", sId: msgSId }],
                [{ type: "agent_message", sId: agentMsgSId, parentMessageId: msgSId }],
              ],
            },
            message: { sId: msgSId },
          }),
        })
        // 4. GET .../events  (SSE stream)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream(sseEvents),
        });
    }

    it("registers an MCP server before creating the first conversation", async () => {
      const { capturedStreamSimple } = await setupWithMcp();

      const fetchMock = makeMcpConvFetch("conv-1", "msg-1", "amsg-1");
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const mcpRegisterCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/register")
      );
      expect(mcpRegisterCall).toBeDefined();
    });

    it("POST /mcp/register sends { serverName: 'pi-dust-extension' }", async () => {
      const { capturedStreamSimple } = await setupWithMcp();

      const fetchMock = makeMcpConvFetch("conv-1", "msg-1", "amsg-1");
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const mcpRegisterCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/register")
      );
      expect(mcpRegisterCall).toBeDefined();
      const body = JSON.parse(mcpRegisterCall![1].body);
      expect(body.serverName).toBe("pi-dust-extension");
    });

    it("POST /mcp/register sends Authorization Bearer token", async () => {
      const creds = makeCredentials({ access: "mcp-access-token" });
      seedLoggedIn(creds);
      let capturedStreamSimple: any;
      let sessionStartHandler: ((e: unknown, ctx: any) => Promise<void>) | undefined;

      const mockApi = {
        registerProvider: vi.fn((_n: string, c: any) => { capturedStreamSimple = c.streamSimple; }),
        registerCommand: vi.fn(),
        on: vi.fn((ev: string, h: any) => { if (ev === "session_start") sessionStartHandler = h; }),
      };
      dustExtension(mockApi as any);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));
      const ctx = {
        modelRegistry: {},
        ...piToolContextFields(),
        sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s1.json"), getEntries: vi.fn().mockReturnValue([]) },
      };
      await sessionStartHandler!({}, ctx);
      vi.unstubAllGlobals();

      const fetchMock = makeMcpConvFetch("conv-1", "msg-1", "amsg-1");
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const mcpRegisterCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/register"));
      expect(mcpRegisterCall![1].headers["Authorization"]).toBe("Bearer mcp-access-token");
    });

    it("does NOT register MCP server again on second message in same conversation", async () => {
      const { capturedStreamSimple } = await setupWithMcp();

      const fetchMock = vi.fn()
        // Turn 1: MCP register + MCP requests SSE + conversation create + SSE
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() }) // MCP requests SSE
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "msg-1" }], [{ type: "agent_message", sId: "amsg-1", parentMessageId: "msg-1" }]] },
            message: { sId: "msg-1" },
          }),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // Turn 2: POST /messages + GET /conversation + SSE (NO extra MCP register)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ message: { sId: "msg-2" } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "msg-2" }], [{ type: "agent_message", sId: "amsg-2", parentMessageId: "msg-2" }]] } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      vi.stubGlobal("fetch", fetchMock);

      const stream1 = capturedStreamSimple(model, { messages: [{ role: "user", content: "First" }] });
      for await (const _ of stream1) { /* drain */ }

      const stream2 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Second" }] });
      for await (const _ of stream2) { /* drain */ }

      const mcpRegisterCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes("/mcp/register"));
      expect(mcpRegisterCalls).toHaveLength(1);
    });

    it("registers a new MCP server after session_switch reason=new", async () => {
      const { capturedStreamSimple, sessionSwitchHandler, makeCtx } = await setupWithMcp();

      const fetchMock1 = makeMcpConvFetch("conv-1", "msg-1", "amsg-1", "mcp-server-old");
      vi.stubGlobal("fetch", fetchMock1);
      const stream1 = capturedStreamSimple(model, { messages: [{ role: "user", content: "Old convo" }] });
      for await (const _ of stream1) { /* drain */ }
      vi.unstubAllGlobals();

      // /new resets conversation
      sessionSwitchHandler!({ reason: "new" }, makeCtx());

      const fetchMock2 = makeMcpConvFetch("conv-2", "msg-2", "amsg-2", "mcp-server-new");
      vi.stubGlobal("fetch", fetchMock2);
      const stream2 = capturedStreamSimple(model, { messages: [{ role: "user", content: "New convo" }] });
      for await (const _ of stream2) { /* drain */ }

      const mcpRegisterCalls = fetchMock2.mock.calls.filter(([url]: [string]) => url.includes("/mcp/register"));
      expect(mcpRegisterCalls).toHaveLength(1);
    });

    it("MCP register call comes BEFORE conversation create", async () => {
      const { capturedStreamSimple } = await setupWithMcp();

      const fetchMock = makeMcpConvFetch("conv-1", "msg-1", "amsg-1");
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const callUrls = fetchMock.mock.calls.map(([url]: [string]) => url);
      const mcpIdx = callUrls.findIndex((u: string) => u.includes("/mcp/register"));
      const convIdx = callUrls.findIndex((u: string) => u.includes("/assistant/conversations") && !u.includes("/messages") && !u.includes("/events"));
      expect(mcpIdx).toBeLessThan(convIdx);
    });

    it("createConversation body includes clientSideMCPServerIds with the serverId", async () => {
      const { capturedStreamSimple } = await setupWithMcp();
      const serverId = "mcp-server-1";

      const fetchMock = makeMcpConvFetch("conv-1", "msg-1", "amsg-1", serverId);
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const convCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/assistant/conversations") && !url.includes("/messages") && !url.includes("/events")
      );
      expect(convCall).toBeDefined();
      const body = JSON.parse(convCall![1].body);
      expect(body.message.context.clientSideMCPServerIds).toEqual([serverId]);
    });

    it("postUserMessage body includes clientSideMCPServerIds with the serverId", async () => {
      const { capturedStreamSimple } = await setupWithMcp();
      const serverId = "mcp-server-1";

      // Turn 1 + Turn 2 mocks in a single fetch mock to avoid global stub gaps.
      // makeMcpConvFetch provides: MCP register, create conversation, SSE
      // (MCP requests SSE is handled by the listener closing immediately)
      // Turn 2 needs: POST /messages, GET /conversations, SSE
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // Turn 1: MCP requests SSE (empty, listener exits immediately)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // Turn 1: POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: "conv-1",
              content: [
                [{ type: "user_message", sId: "m1" }],
                [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }],
              ],
            },
            message: { sId: "m1" },
          }),
        })
        // Turn 1: SSE events
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        })
        // Turn 2: POST /messages
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "m2" } }),
        })
        // Turn 2: GET /conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: {
              sId: "conv-1",
              content: [
                [{ type: "user_message", sId: "m2" }],
                [{ type: "agent_message", sId: "am2", parentMessageId: "m2" }],
              ],
            },
          }),
        })
        // Turn 2: SSE events
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        });

      vi.stubGlobal("fetch", fetchMock);

      // Turn 1
      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "First" }] })) { /* drain */ }

      // Turn 2
      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Second" }] })) { /* drain */ }

      const msgCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/assistant/conversations/conv-1/messages") && !url.includes("/events")
      );
      expect(msgCall).toBeDefined();
      const body = JSON.parse(msgCall![1].body);
      expect(body.context.clientSideMCPServerIds).toEqual([serverId]);
    });
  });

  // ---------------------------------------------------------------------------
  // Token refresh in dustRealStream — proactive refresh before each call
  // ---------------------------------------------------------------------------

  describe("token refresh in dustRealStream", () => {
    async function setupWithExpiredCreds(expiredAccess = "expired-tok", newAccess = "new-tok") {
      const expiredCreds = makeCredentials({
        access: expiredAccess,
        refresh: "ref-token",
        expires: Date.now() - 1000, // already expired
      });
      const freshCreds = { ...expiredCreds, access: newAccess, expires: Date.now() + 3600_000 };

      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      let storedCreds = { ...expiredCreds };

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

      // session_start: bake in expired credentials, no token refresh yet (expires check at session_start
      // uses <= Date.now() which is true — but here we want to test the in-stream refresh path,
      // so we stub fetch to NOT match the WorkOS refresh at session_start and let it fall through).
      vi.stubGlobal("fetch", vi.fn()
        // session_start: token refresh attempt fails → falls back to expired creds
        .mockResolvedValueOnce({ ok: false, status: 400 })
        // session_start: agent fetch (uses expired token — still works in test)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: expiredCreds.agents }),
        })
      );

      vi.spyOn(console, "error").mockImplementation(() => {});

      seedLoggedIn(storedCreds);
      const ctx = {
        modelRegistry: {},
        ...piToolContextFields(),
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue("/sessions/s1.json"),
          getEntries: vi.fn().mockReturnValue([]),

          getSessionId: vi.fn().mockReturnValue("test-session"),
        },
      };
      await sessionStartHandler!({}, ctx);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();

      return { capturedStreamSimple, freshCreds, expiredCreds };
    }

    const model = { id: "helper", sId: "agentSId-1", name: "Helper", provider: "dust", api: "dust" };

    it("refreshes expired token before sending MCP register", async () => {
      const { capturedStreamSimple, freshCreds } = await setupWithExpiredCreds();

      vi.stubGlobal("fetch", vi.fn()
        // 1. Token refresh (WorkOS)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: freshCreds.access,
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        })
        // 2. POST /mcp/register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 3. GET /mcp/requests (empty SSE)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 4. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] },
            message: { sId: "m1" },
          }),
        })
        // 5. SSE events
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        })
      );

      const events: any[] = [];
      for await (const ev of capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] })) {
        events.push(ev);
      }

      // The MCP register call should use the new (refreshed) token, not the expired one.
      const mcpCall = (globalThis as any).fetch.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/register")
      );
      expect(mcpCall).toBeDefined();
      const mcpAuthHeader = mcpCall[1]?.headers?.Authorization;
      expect(mcpAuthHeader).toBe(`Bearer ${freshCreds.access}`);
    });

    it("uses the refreshed token without writing tokens into extension state", async () => {
      const { capturedStreamSimple, freshCreds } = await setupWithExpiredCreds();

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: freshCreds.access,
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] },
            message: { sId: "m1" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        })
      );

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] })) { /* drain */ }

      const calls = (globalThis.fetch as any).mock.calls;
      const mcpCall = calls.find(([url]: [string]) => url.includes("/mcp/register"));
      expect(mcpCall[1]?.headers?.Authorization).toBe(`Bearer ${freshCreds.access}`);

      // pi owns the token trio; our state file must never carry it.
      const state = readState();
      expect(state).not.toHaveProperty("access");
      expect(state).not.toHaveProperty("refresh");
      expect(state).not.toHaveProperty("expires");
    });

    it("continues with stale token if refresh fails with a non-auth error, and surfaces the downstream failure", async () => {
      const { capturedStreamSimple } = await setupWithExpiredCreds();

      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn()
        // 1. Token refresh fails
        .mockResolvedValueOnce({ ok: false, status: 400 })
        // 2. POST /mcp/register → 401 (expired token)
        .mockResolvedValueOnce({ ok: false, status: 401 })
      );

      const events: any[] = [];
      for await (const ev of capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] })) {
        events.push(ev);
      }

      const errorEvent = events.find((e: any) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toMatch(/session expired/i);
    });

    it("marks the session invalidated when refresh returns 401 before streaming", async () => {
      const { capturedStreamSimple } = await setupWithExpiredCreds();

      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
      );

      const events: any[] = [];
      for await (const ev of capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] })) {
        events.push(ev);
      }

      const errorEvent = events.find((e: any) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toMatch(/session expired/i);
      expect(readState()).toMatchObject({ invalidated: true });
    });
  });

  // ---------------------------------------------------------------------------
  // MCP request listener — tools/list and tools/call
  // ---------------------------------------------------------------------------

  describe("MCP request listener", () => {
    /**
     * Build a fake MCP SSE stream with one or more JSON-RPC request frames.
     */
    function makeMcpSseStream(requests: object[]): ReadableStream<Uint8Array> {
      const lines = requests
        .map((r, i) => `data: ${JSON.stringify({ eventId: `mcp-e${i}`, data: r })}\n\n`)
        .join("");
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(lines));
          controller.close();
        },
      });
    }

    async function setupWithMcpListener(tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []) {
      const creds = makeCredentials();
      seedLoggedIn(creds);
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
      const ctx = {
        modelRegistry: {},
        ...piToolContextFields(),
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue("/s/s1.json"),
          getEntries: vi.fn().mockReturnValue([]),
          getSessionId: vi.fn().mockReturnValue("test-session"),
        },
      };
      await sessionStartHandler!({}, ctx);
      vi.unstubAllGlobals();

      return { capturedStreamSimple, tools };
    }

    const model = {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };

    it("opens the MCP requests SSE stream with serverId after registering", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const fetchMock = vi.fn()
        // 1. MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "srv-42", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. MCP requests SSE (empty stream — no requests)
        .mockResolvedValueOnce({
          ok: true,
          body: makeMcpSseStream([]),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] },
            message: { sId: "m1" },
          }),
        })
        // 4. SSE agent events
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const mcpRequestsCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/requests") && url.includes("srv-42")
      );
      expect(mcpRequestsCall).toBeDefined();
    });

    it("resumes from the envelope eventId after the stream ends, instead of replaying", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      // Dust emits no SSE `id:` lines — the cursor is `eventId` inside the JSON
      // envelope, and each stream ends with a bare `data: done`. Losing the
      // cursor makes the reconnect replay the Redis stream from the start and
      // re-run past tools/call requests.
      const firstStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ eventId: "evt-7", data: { jsonrpc: "2.0", id: "r1", method: "ping" } })}\n\n`,
          ));
          controller.enqueue(encoder.encode("data: done\n\n"));
          controller.close();
        },
      });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "srv-cursor", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: firstStream })
        // Reconnect: must carry lastEventId. Park it so the loop stops here.
        .mockResolvedValue({ ok: true, body: makePendingSseStream() });

      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const reconnect = fetchMock.mock.calls
        .map(([url]: [string]) => String(url))
        .filter((url) => url.includes("/mcp/requests"))
        .find((url) => url.includes("lastEventId"));

      expect(reconnect).toBeDefined();
      expect(reconnect).toContain("lastEventId=evt-7");
    });

    it("responds to tools/list with tools in MCP format", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const toolsListRequest = {
        jsonrpc: "2.0",
        id: "req-list-1",
        method: "tools/list",
        params: {},
      };

      const postedResults: any[] = [];

      const fetchMock = vi.fn()
        // 1. MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. MCP requests SSE — sends tools/list request
        .mockResolvedValueOnce({
          ok: true,
          body: makeMcpSseStream([toolsListRequest]),
        })
        // 3. POST /mcp/results (tools/list response)
        .mockImplementationOnce(async (_url: string, opts: any) => {
          postedResults.push(JSON.parse(opts.body));
          return { ok: true, json: () => Promise.resolve({ success: true }) };
        })
        // 4. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] },
            message: { sId: "m1" },
          }),
        })
        // 5. SSE agent events
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      // A result should have been posted to /mcp/results
      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"));
      expect(resultPostCall).toBeDefined();

      // Result body must be a JSON-RPC response to the tools/list request
      const resultBody = JSON.parse(resultPostCall![1].body);
      expect(resultBody.serverId).toBe("srv-1");
      expect(resultBody.result.id).toBe("req-list-1");
      expect(Array.isArray(resultBody.result.result?.tools)).toBe(true);

      // Must include bash, read, edit tools
      const tools: any[] = resultBody.result.result?.tools ?? [];
      expect(tools.some((t: any) => t.name === "bash")).toBe(true);
      expect(tools.some((t: any) => t.name === "read")).toBe(true);
      expect(tools.some((t: any) => t.name === "edit")).toBe(true);
    });

    it("tools/list response tools have name, description, and inputSchema", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const toolsListRequest = { jsonrpc: "2.0", id: "req-list-2", method: "tools/list", params: {} };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([toolsListRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }
      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      const resultBody = JSON.parse(resultPostCall[1].body);
      const tools: any[] = resultBody.result.result?.tools ?? [];
      const bashTool = tools.find((t: any) => t.name === "bash");
      expect(bashTool).toBeDefined();
      expect(typeof bashTool.description).toBe("string");
      expect(bashTool.description.length).toBeGreaterThan(0);
      expect(bashTool.inputSchema).toMatchObject({ type: "object" });
    });

    it("responds to tools/call bash with the command output", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const callRequest = {
        jsonrpc: "2.0",
        id: "req-bash-1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "echo hello-from-bash" } },
      };

      // New execution order: gate defers /mcp/results until after streamEvents finishes.
      // MCP register → MCP SSE → POST conversation → GET events → POST /mcp/results
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // POST /mcp/results — now comes after streamEvents resolves the approval gate
        .mockImplementationOnce(async (_url: string, _opts: any) => {
          return { ok: true, json: () => Promise.resolve({ success: true }) };
        });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }
      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      expect(resultPostCall).toBeDefined();
      const resultBody = JSON.parse(resultPostCall[1].body);
      expect(resultBody.result.id).toBe("req-bash-1");
      // content must be array with text block
      const content: any[] = resultBody.result.result?.content ?? [];
      expect(content.some((c: any) => c.type === "text" && c.text.includes("hello-from-bash"))).toBe(true);
    });

    it("responds to tools/call with isError=true when bash command fails", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const callRequest = {
        jsonrpc: "2.0",
        id: "req-bash-fail",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "exit 1" } },
      };

      // New execution order: MCP register → MCP SSE → POST conversation → GET events → POST /mcp/results
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // POST /mcp/results — now comes after streamEvents resolves the approval gate
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }
      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      const resultBody = JSON.parse(resultPostCall[1].body);
      // isError should be true for failed commands
      expect(resultBody.result.result?.isError).toBe(true);
    });

    it("responds to unknown tool call with isError=true and error message", async () => {
      const { capturedStreamSimple } = await setupWithMcpListener();

      const callRequest = {
        jsonrpc: "2.0",
        id: "req-unknown",
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      };

      // New execution order: MCP register → MCP SSE → POST conversation → GET events → POST /mcp/results
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // POST /mcp/results — now comes after streamEvents resolves the approval gate
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }
      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      const resultBody = JSON.parse(resultPostCall[1].body);
      expect(resultBody.result.result?.isError).toBe(true);
      const content: any[] = resultBody.result.result?.content ?? [];
      expect(content.some((c: any) => c.type === "text" && c.text.toLowerCase().includes("nonexistent_tool"))).toBe(true);
    });

    it("POST /mcp/results sends Authorization Bearer token", async () => {
      const creds = makeCredentials({ access: "results-access-token" });
      seedLoggedIn(creds);
      let capturedStreamSimple: any;
      let sessionStartHandler: ((e: unknown, ctx: any) => Promise<void>) | undefined;
      const mockApi = {
        registerProvider: vi.fn((_n: string, c: any) => { capturedStreamSimple = c.streamSimple; }),
        registerCommand: vi.fn(),
        on: vi.fn((ev: string, h: any) => { if (ev === "session_start") sessionStartHandler = h; }),
      };
      dustExtension(mockApi as any);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ agentConfigurations: creds.agents }) }));
      await sessionStartHandler!({}, { modelRegistry: {}, sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s.json"), getEntries: vi.fn().mockReturnValue([]) } });
      vi.unstubAllGlobals();

      const callRequest = { jsonrpc: "2.0", id: "req-bash-2", method: "tools/call", params: { name: "bash", arguments: { command: "echo auth-test" } } };
      // New execution order: MCP register → MCP SSE → POST conversation → GET events → POST /mcp/results
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // POST /mcp/results — now comes after streamEvents resolves the approval gate
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple({ id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" }, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }
      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      expect(resultPostCall![1].headers["Authorization"]).toBe("Bearer results-access-token");
    });
  });

  // ---------------------------------------------------------------------------
  // tool_params visibility in pi stream
  // ---------------------------------------------------------------------------

  describe("tool_params visibility in pi stream", () => {
    async function setupStreamFn() {
      const creds = makeCredentials();
      seedLoggedIn(creds);
      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      const mockApi = {
        registerProvider: vi.fn((_n: string, c: any) => { capturedStreamSimple = c.streamSimple; }),
        registerCommand: vi.fn(),
        on: vi.fn((ev: string, h: any) => { if (ev === "session_start") sessionStartHandler = h; }),
      };
      dustExtension(mockApi as any);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ agentConfigurations: creds.agents }) }));
      await sessionStartHandler!({}, { modelRegistry: {}, sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s.json"), getEntries: vi.fn().mockReturnValue([]) } });
      vi.unstubAllGlobals();
      return capturedStreamSimple;
    }

    const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

    it("does not emit tool marker text, since tool calls render as their own entry", async () => {
      const capturedStreamSimple = await setupStreamFn();

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() }) // MCP requests SSE (pending)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ conversation: { sId: "conv-1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "tool_params", action: { toolName: "bash", functionCallId: "fc-1", functionCallName: "bash", params: { command: "ls" } } },
            { type: "agent_message_success" },
          ]),
        });
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Run bash" }] });
      for await (const e of stream) events.push(e);

      const toolDeltas = events.filter((e) => e.type === "text_delta" && e.delta.includes("[Tool:"));
      expect(toolDeltas).toHaveLength(0);
    });
  });
});
