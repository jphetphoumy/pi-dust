import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConversationGetResponse, makeConversationResponse, makeModel, makePendingSseStream, makeRawSseStream, makeSseStream, makeStreamSimpleFn } from "./helpers/dust-fixtures.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  useTempAgentDir();
  // ---------------------------------------------------------------------------
  // streamSimple — first message (creates new conversation)
  // ---------------------------------------------------------------------------

  describe("streamSimple (real provider — first message)", () => {
    let streamSimpleFn: any;

    beforeEach(async () => {
      streamSimpleFn = await makeStreamSimpleFn();
      vi.unstubAllGlobals();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function makeFirstMessageFetch(
      conversationSId = "conv-1",
      userMessageSId = "msg-1",
      agentMessageSId = "agent-msg-1",
      sseEvents: object[] = [
        { type: "generation_tokens", classification: "tokens", text: "Hello!" },
        { type: "agent_message_success" },
      ]
    ) {
      const fetchMock = vi.fn()
        // 1. POST /mcp/register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests?serverId=... (background SSE listener, empty stream)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse(conversationSId, userMessageSId, agentMessageSId)),
        })
        // 4. GET .../events  (SSE stream)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream(sseEvents),
        });
      return fetchMock;
    }

    it("calls POST .../assistant/conversations on the first message", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hello" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages") && !url.includes("/events")
      );
      expect(postCall).toBeDefined();
      expect(postCall![0]).toContain("ws-1"); // workspaceId
    });

    it("createConversation body has correct message content", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "What is 2+2?" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      const body = JSON.parse(postCall[1].body);
      // The user's text is preceded by a preamble steering the agent to the
      // local pi_dust_extension__* tools rather than Dust's remote files__*.
      expect(body.message.content).toContain("What is 2+2?");
      expect(body.message.content).toContain("pi_dust_extension__write");
      expect(body.message.content).toContain("files__create");
    });

    it("createConversation body has mentions with model.sId", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      const body = JSON.parse(postCall[1].body);
      expect(body.message.mentions[0].configurationId).toBe("agentSId-1");
    });

    it("createConversation body has context.origin === 'cli'", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      const body = JSON.parse(postCall[1].body);
      expect(body.message.context.origin).toBe("cli");
    });

    it("createConversation body has visibility === 'unlisted'", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      const body = JSON.parse(postCall[1].body);
      expect(body.visibility).toBe("unlisted");
    });

    it("createConversation body has context.username from credentials", async () => {
      const customStreamSimpleFn = await makeStreamSimpleFn({ username: "myuser" });
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = customStreamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      const body = JSON.parse(postCall[1].body);
      expect(body.message.context.username).toBe("myuser");
    });

    it("createConversation sends Authorization Bearer token", async () => {
      const customStreamSimpleFn = await makeStreamSimpleFn({ access: "my-access-token" });
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = customStreamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      expect(postCall[1].headers["Authorization"]).toBe("Bearer my-access-token");
    });

    it("createConversation sends User-Agent: 'Dust CLI'", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      expect(postCall[1].headers["User-Agent"]).toBe("Dust CLI");
    });

    it("createConversation sends X-Dust-CLI-Version header", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      expect(postCall[1].headers["X-Dust-CLI-Version"]).toBeDefined();
    });

    it("calls GET .../conversations/{convId}/messages/{agentMsgId}/events after creating conversation", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-123", "umsg-1", "amsg-99");
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const sseCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/events"));
      expect(sseCall).toBeDefined();
      expect(sseCall![0]).toContain("conv-123");
      expect(sseCall![0]).toContain("amsg-99");
    });

    it("sends Accept: text/event-stream on the SSE request", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const sseCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/events"))!;
      expect(sseCall[1].headers["Accept"]).toBe("text/event-stream");
    });

    it("sends Dust CLI headers on the SSE request", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const sseCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/events"))!;
      expect(sseCall[1].headers["User-Agent"]).toBe("Dust CLI");
      expect(sseCall[1].headers["X-Dust-CLI-Version"]).toBeDefined();
    });

    it("yields text_delta events for generation_tokens with classification 'tokens'", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Hello" },
        { type: "generation_tokens", classification: "tokens", text: " world" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas).toHaveLength(2);
      expect(deltas[0].delta).toBe("Hello");
      expect(deltas[1].delta).toBe(" world");
    });

    it("discards generation_tokens with classification 'chain_of_thought'", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "thinking..." },
        { type: "generation_tokens", classification: "tokens", text: "Answer" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe("Answer");
    });

    it("ignores malformed SSE JSON frames and still processes later valid events", async () => {
      const model = makeModel();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeRawSseStream([
            "data: {not-json}\n\n",
            `data: ${JSON.stringify({ eventId: "e1", data: { type: "generation_tokens", classification: "tokens", text: "Recovered" } })}\n\n`,
            `data: ${JSON.stringify({ eventId: "e2", data: { type: "agent_message_success" } })}\n\n`,
          ]),
        });
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const event of stream) events.push(event);

      const deltas = events.filter((event) => event.type === "text_delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe("Recovered");
      expect(events.some((event) => event.type === "done")).toBe(true);
    });

    it("handles SSE frames split across chunks", async () => {
      const model = makeModel();
      const partialFrame = `data: ${JSON.stringify({ eventId: "e1", data: { type: "generation_tokens", classification: "tokens", text: "Chunked" } })}\n\n`;
      const doneFrame = `data: ${JSON.stringify({ eventId: "e2", data: { type: "agent_message_success" } })}\n\n`;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeRawSseStream([
            partialFrame.slice(0, 18),
            partialFrame.slice(18, 43),
            partialFrame.slice(43),
            doneFrame.slice(0, 12),
            doneFrame.slice(12),
          ]),
        });
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const event of stream) events.push(event);

      const deltas = events.filter((event) => event.type === "text_delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe("Chunked");
      expect(events.some((event) => event.type === "done")).toBe(true);
    });

    it("yields done event when agent_message_success is received", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Hi" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    // Cancellation can also originate elsewhere — the Dust web UI, another
    // client — and a stopped turn must not render as a clean completion.
    it("ends as aborted when agent_generation_cancelled is received", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Half an answer" },
        { type: "agent_generation_cancelled" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: "aborted",
        content: [{ type: "text", text: "Half an answer" }],
      });
    });

    it("throws with agent error message when agent_error is received", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "agent_error", error: { message: "Agent exploded" } },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain("Agent exploded");
    });

    it("throws with user message error when user_message_error is received", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "user_message_error", error: { message: "Bad input" } },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain("Bad input");
    });

    it("throws with session-expired message on 401 from createConversation", async () => {
      const model = makeModel();
      vi.stubGlobal("fetch", vi.fn()
        // MCP register succeeds
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // MCP requests SSE (background, empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        // POST /assistant/conversations → 401
        .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("") })
      );

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toMatch(/session expired/i);
    });

    it("throws when createConversation response is missing message.sId", async () => {
      const model = makeModel();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            conversation: makeConversationResponse("conv-1", "msg-1", "amsg-1").conversation,
            message: {},
          }),
        })
      );

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toMatch(/missing expected string field 'sId'/i);
    });

    it("forwards AbortSignal to the createConversation fetch call", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const controller = new AbortController();
      const stream = streamSimpleFn(
        model,
        { messages: [{ role: "user", content: "Hi" }] },
        { signal: controller.signal }
      );
      for await (const _ of stream) { /* drain */ }

      const postCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("assistant/conversations") && !url.includes("/messages")
      )!;
      expect(postCall[1].signal).toBe(controller.signal);
    });

    it("forwards AbortSignal to the SSE stream fetch call", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch();
      vi.stubGlobal("fetch", fetchMock);

      const controller = new AbortController();
      const stream = streamSimpleFn(
        model,
        { messages: [{ role: "user", content: "Hi" }] },
        { signal: controller.signal }
      );
      for await (const _ of stream) { /* drain */ }

      const sseCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/events"))!;
      expect(sseCall[1].signal).toBe(controller.signal);
    });
  });

  // ---------------------------------------------------------------------------
  // streamSimple — subsequent messages (reuses conversation)
  // ---------------------------------------------------------------------------

  describe("streamSimple (real provider — subsequent messages)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * Set up streamSimpleFn from a freshly registered provider (via session_start),
     * then drive two sequential calls through it with the given fetch mock.
     */
    async function runTwoTurns(fetchMock: ReturnType<typeof vi.fn>) {
      // Get a streamSimpleFn with real test credentials baked in via closure.
      const capturedStreamSimple = await makeStreamSimpleFn();

      // Now stub fetch for the actual conversation calls.
      vi.stubGlobal("fetch", fetchMock);

      const model = makeModel();
      const ctx = { messages: [{ role: "user", content: "First message" }] };

      // First turn
      for await (const _ of capturedStreamSimple(model, ctx)) { /* drain */ }

      // Second turn
      const events: any[] = [];
      for await (const e of capturedStreamSimple(model, { messages: [{ role: "user", content: "Second message" }] })) {
        events.push(e);
      }
      return { calls: fetchMock.mock.calls, events };
    }

    it("second message sends POST .../conversations/{convId}/messages (not a new conversation)", async () => {
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // Turn 1: MCP requests SSE (empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        // Turn 1: create conversation
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        // Turn 1: SSE stream
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        // Turn 2: POST .../conversations/conv-1/messages
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-2" } }),
        })
        // Turn 2: GET conversation (to find agent message sId)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "msg-2", "amsg-2")),
        })
        // Turn 2: SSE stream
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      const { calls } = await runTwoTurns(fetchMock);

      // Turn 2 first call should be POST to .../conversations/conv-1/messages
      const turn2Post = calls.find(([url, opts]: [string, any]) =>
        url.includes("conversations/conv-1/messages") && opts?.method === "POST"
      );
      expect(turn2Post).toBeDefined();
    });

    it("second message does NOT call POST .../assistant/conversations again", async () => {
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // Turn 1: MCP requests SSE (empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-2" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "msg-2", "amsg-2")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      const { calls } = await runTwoTurns(fetchMock);

      // Only one call to POST .../assistant/conversations (no /messages suffix, no /events)
      const newConvCalls = calls.filter(([url, opts]: [string, any]) => {
        const path = url.split("?")[0];
        return path.endsWith("assistant/conversations") && opts?.method === "POST";
      });
      expect(newConvCalls).toHaveLength(1);
    });

    it("after postUserMessage, fetches conversation to get agent message sId", async () => {
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // Turn 1: MCP requests SSE (empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-2" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "msg-2", "amsg-2")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      const { calls } = await runTwoTurns(fetchMock);

      // Should have a GET .../conversations/conv-1 call
      const getConvCall = calls.find(([url, opts]: [string, any]) => {
        const path = url.split("?")[0];
        return path.endsWith("conversations/conv-1") && (!opts?.method || opts.method === "GET");
      });
      expect(getConvCall).toBeDefined();
    });

    it("second message streams from the agent message sId in the updated conversation", async () => {
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // Turn 1: MCP requests SSE (empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-2" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "msg-2", "amsg-2")),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: "Turn 2 answer" },
            { type: "agent_message_success" },
          ]),
        });

      const { events } = await runTwoTurns(fetchMock);

      const sseCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("amsg-2") && url.includes("/events")
      );
      expect(sseCall).toBeDefined();

      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas[0].delta).toBe("Turn 2 answer");
    });

    it("second message body has correct content and mention", async () => {
      const fetchMock = vi.fn()
        // Turn 1: MCP register
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        // Turn 1: MCP requests SSE (empty)
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { sId: "msg-2" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationGetResponse("conv-1", "msg-2", "amsg-2")),
        })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });

      const { calls } = await runTwoTurns(fetchMock);

      const turn2Post = calls.find(([url, opts]: [string, any]) =>
        url.includes("conversations/conv-1/messages") && opts?.method === "POST"
      )!;
      const body = JSON.parse(turn2Post[1].body);
      expect(body.content).toBe("Second message");
      expect(body.mentions[0].configurationId).toBe("agentSId-1");
      expect(body.context.origin).toBe("cli");
    });
  });

  // ---------------------------------------------------------------------------
  // tool_approve_execution — server-side approval flow
  // ---------------------------------------------------------------------------
});
