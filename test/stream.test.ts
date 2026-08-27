import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConversationGetResponse, makeConversationResponse, makeModel, makePendingSseStream, makeRawSseStream, makeReconnectingFetch, makeSseStream, makeStreamSimpleFn } from "./helpers/dust-fixtures.js";
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

    // pi's agent loop only forwards partial updates once a `start` event has
    // established the streaming message (see pi-agent-core's agent-loop: every
    // *_delta is dropped while `partialMessage` is undefined). Without it the
    // whole turn renders in one go at `done`.
    it("emits a start event carrying an empty partial before any delta", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Hello" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events[0]).toMatchObject({ type: "start" });
      expect(events[0].partial.role).toBe("assistant");
      expect(events[0].partial.content).toEqual([]);
    });

    it("streams generation_tokens with classification 'chain_of_thought' as thinking deltas", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "Let me " },
        { type: "generation_tokens", classification: "chain_of_thought", text: "check." },
        { type: "generation_tokens", classification: "tokens", text: "Answer" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingDeltas.map((e) => e.delta)).toEqual(["Let me ", "check."]);
      // Each delta carries the reasoning accumulated so far, so the transcript
      // grows while the agent reasons instead of appearing at the end.
      expect(thinkingDeltas[0].partial.content[0]).toEqual({ type: "thinking", thinking: "Let me " });
      expect(thinkingDeltas[1].partial.content[0]).toEqual({ type: "thinking", thinking: "Let me check." });

      const starts = events.filter((e) => e.type === "thinking_start");
      expect(starts).toHaveLength(1);
      expect(starts[0].contentIndex).toBe(0);
      expect(thinkingDeltas.every((e) => e.contentIndex === 0)).toBe(true);
    });

    it("emits thinking deltas before the answer's text deltas, as they arrive", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "reasoning" },
        { type: "generation_tokens", classification: "tokens", text: "Answer" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.map((e) => e.type)).toEqual([
        "start",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      // The answer keeps its own content block, after the reasoning one.
      const textDelta = events.find((e) => e.type === "text_delta");
      expect(textDelta.contentIndex).toBe(1);
      expect(textDelta.delta).toBe("Answer");
    });

    it("keeps chain_of_thought out of the final answer text", async () => {
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

      const done = events.find((e) => e.type === "done");
      // A regressed fix would drop this event silently rather than change its
      // shape; failing here first gives a readable diff instead of a
      // "Cannot read properties of undefined" a few lines down.
      expect(done).toBeDefined();
      // Reasoning stays in its own `thinking` block; the answer text is clean.
      expect(done.message.content).toEqual([
        { type: "thinking", thinking: "thinking..." },
        { type: "text", text: "Answer" },
      ]);
    });

    it("keeps chain_of_thought out of the partial answer text once the answer starts", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "thinking..." },
        { type: "generation_tokens", classification: "tokens", text: "Ans" },
        { type: "generation_tokens", classification: "tokens", text: "wer" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      const lastTextDelta = events.filter((e) => e.type === "text_delta").at(-1);
      expect(lastTextDelta).toBeDefined();
      expect(lastTextDelta.partial.content).toEqual([
        { type: "thinking", thinking: "thinking..." },
        { type: "text", text: "Answer" },
      ]);
    });

    it("keeps the reasoning trace on a turn the user cancels", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "half a thought" },
        { type: "agent_generation_cancelled" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      // finishAborted closes whatever block is open before pushing `error`
      // (dust-stream.ts) — losing that call would leave the reasoning block
      // open on the abort path, and only the last-two-types check below would
      // notice, since the final content is the same either way.
      expect(events.slice(-2).map((e) => e.type)).toEqual(["thinking_end", "error"]);
      const error = events.at(-1);
      expect(error).toMatchObject({ type: "error", reason: "aborted" });
      expect(error.error.content).toEqual([{ type: "thinking", thinking: "half a thought" }]);
    });

    it("splits the reasoning at the delimiters and drops the delimiter markup", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "opening_delimiter", text: "<thinking>" },
        { type: "generation_tokens", classification: "chain_of_thought", text: "step one" },
        { type: "generation_tokens", classification: "closing_delimiter", text: "</thinking>" },
        { type: "generation_tokens", classification: "chain_of_thought", text: "step two" },
        { type: "generation_tokens", classification: "tokens", text: "Answer" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      // Delimiter events push no stream event of their own — not text with
      // different markup, not a delta some other way. A delimiter only ever
      // closes the block that was open.
      expect(events.every((e) => e.delta !== "<thinking>" && e.delta !== "</thinking>")).toBe(true);
      expect(events.map((e) => e.type)).toEqual([
        "start",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      const done = events.find((e) => e.type === "done");
      expect(done.message.content).toEqual([
        { type: "thinking", thinking: "step one" },
        { type: "thinking", thinking: "step two" },
        { type: "text", text: "Answer" },
      ]);
      // The `content` an end event carries is a guess about pi's real
      // contract (src/dust-types.ts), so it's the field most worth pinning:
      // each end event must carry its own block's index and full text, not
      // an empty string or the wrong block's.
      const thinkingEnds = events.filter((e) => e.type === "thinking_end");
      expect(thinkingEnds).toEqual([
        expect.objectContaining({ contentIndex: 0, content: "step one" }),
        expect.objectContaining({ contentIndex: 1, content: "step two" }),
      ]);
      const textEnd = events.find((e) => e.type === "text_end");
      expect(textEnd).toMatchObject({ contentIndex: 2, content: "Answer" });
    });

    it("does not open a block or push a delta for an empty-text token batch", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "" },
        { type: "generation_tokens", classification: "tokens", text: "Hi" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      // The empty batch must not be the one that opens the block.
      expect(events.filter((e) => e.type === "text_start")).toHaveLength(1);
      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas.map((e) => e.delta)).toEqual(["Hi"]);
    });

    it("ignores generation_tokens with an unrecognized classification, without disturbing the open block", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Hel" },
        { type: "generation_tokens", classification: "some_future_kind", text: "???" },
        { type: "generation_tokens", classification: "tokens", text: "lo" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      // An unrecognized classification is dropped, not treated as a boundary —
      // the block stays open and the two known batches land in it together.
      // Both counts matter: a spurious `text_end` here (with no matching
      // `text_start`) would pass a "reopen" check alone but still be wrong.
      expect(events.filter((e) => e.type === "text_start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "text_end")).toHaveLength(1);
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.message.content).toEqual([{ type: "text", text: "Hello" }]);
    });

    it("ignores an unhandled event type, without disturbing the open block", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Hel" },
        // Dust sends these today and can add more; the dispatch must fall to its
        // default and carry on rather than reaching any other branch.
        { type: "agent_action_success", action: { id: 1 } },
        { type: "tool_notification", notification: "working" },
        { type: "generation_tokens", classification: "tokens", text: "lo" },
        { type: "agent_message_success" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.filter((e) => e.type === "text_start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "text_end")).toHaveLength(1);
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.message.content).toEqual([{ type: "text", text: "Hello" }]);
    });

    // pi's agent loop drops every partial update until `start` has established
    // the streaming message; a second `start` mid-turn would look like a new
    // turn beginning and reset whatever pi already rendered. streamEvents
    // reconnects on every tool call and on Dust's 60s window cap, so this has
    // to hold across a reconnect, not just for a single SSE window.
    it("emits start only once, even when the SSE window reconnects mid-turn", async () => {
      const model = makeModel();
      const fetchMock = makeReconnectingFetch("conv-1", "msg-1", "amsg-1", [
        // First window: some text, then the connection closes without a
        // terminal event — Dust's 60s cap, not the end of the turn.
        [{ type: "generation_tokens", classification: "tokens", text: "Hel" }],
        // Reconnect window: finishes the turn.
        [
          { type: "generation_tokens", classification: "tokens", text: "lo" },
          { type: "agent_message_success" },
        ],
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.filter((e) => e.type === "start")).toHaveLength(1);
      // The block opened before the reconnect keeps accumulating across it,
      // rather than a second one opening when the window resumes.
      expect(events.filter((e) => e.type === "text_start")).toHaveLength(1);
      // ...and the window boundary itself must not close it either — a
      // `text_end` there would render the block finished while the turn
      // continues. There should be exactly one, at `done`.
      expect(events.filter((e) => e.type === "text_end")).toHaveLength(1);
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.message.content).toEqual([{ type: "text", text: "Hello" }]);
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

    // Every other terminal exit (agent_message_success, gracefully_stopped,
    // both abort paths) closes whatever block is open before its terminal
    // event — a block never told it finished renders as still in progress.
    // agent_error/user_message_error throw instead of returning, and that
    // throw path skipped the close; this pins the fix.
    it("closes the open block before agent_error interrupts a turn with an answer in progress", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "tokens", text: "Half" },
        { type: "agent_error", error: { message: "Agent exploded" } },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);

      const types = events.map((e) => e.type);
      expect(types).toContain("text_end");
      expect(types.indexOf("text_end")).toBeLessThan(types.indexOf("error"));
      const textEnd = events.find((e) => e.type === "text_end");
      expect(textEnd).toMatchObject({ contentIndex: 0, content: "Half" });
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

    it("closes the open block before user_message_error interrupts a turn with reasoning in progress", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "generation_tokens", classification: "chain_of_thought", text: "half a thought" },
        { type: "user_message_error", error: { message: "Bad input" } },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      const events: any[] = [];
      for await (const e of stream) events.push(e);

      const types = events.map((e) => e.type);
      expect(types).toContain("thinking_end");
      expect(types.indexOf("thinking_end")).toBeLessThan(types.indexOf("error"));
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

    it("uses the agent message returned by POST instead of racing a conversation fetch", async () => {
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
        // Turn 2: the API response includes the agent message created by this POST.
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            message: { sId: "msg-2" },
            agentMessages: [{
              type: "agent_message",
              sId: "amsg-direct",
              parentMessageId: "msg-2",
            }],
          }),
        })
        // There must be no GET conversation between these two calls.
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        });

      const { calls } = await runTwoTurns(fetchMock);

      expect(calls.some(([url, opts]: [string, any]) =>
        url.endsWith("/assistant/conversations/conv-1") && (!opts?.method || opts.method === "GET")
      )).toBe(false);
      expect(calls.some(([url]: [string]) => url.includes("amsg-direct/events"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // tool_approve_execution — server-side approval flow
  // ---------------------------------------------------------------------------
});
