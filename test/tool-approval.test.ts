import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeConversationResponse, makeCredentials, makePendingSseStream, makeSseStream } from "./helpers/dust-fixtures.js";
import { piToolContextFields, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  useTempAgentDir();
  describe("tool_approve_execution", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    /**
     * Build a streamSimple function wired with a custom confirmFn.
     * The confirmFn is injected via session_switch so it is captured
     * by currentConfirmFn inside dust.ts.
     */
    async function setupWithConfirm(confirmFn: (title: string, message: string) => Promise<boolean>) {
      const creds = makeCredentials();
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

      const makeCtx = (file = "/sessions/s1.json") => ({
        modelRegistry: {},
        ...piToolContextFields(),
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue(file),
          getEntries: vi.fn().mockReturnValue([]),

          getSessionId: vi.fn().mockReturnValue("test-session"),
        },
        ui: { confirm: confirmFn },
      });

      await sessionStartHandler!({}, makeCtx());
      vi.unstubAllGlobals();

      // Wire the confirmFn via session_switch (simulates pi wiring up the UI)
      sessionSwitchHandler!({ reason: "new" }, makeCtx());

      return { capturedStreamSimple };
    }

    const model = {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };

    /**
     * Build a fetch mock that:
     *  1. POST /mcp/register
     *  2. GET /mcp/requests (pending SSE — no tools/call)
     *  3. POST /assistant/conversations
     *  4. GET .../events  (SSE with one tool_approve_execution event then agent_message_success)
     *  5. POST .../validate-action  (captured)
     *  6. GET .../events  (SSE reconnect — agent resumes with agent_message_success)
     */
    function makeApprovalFetch(
      approveEvent: object,
      validateActionOk = true,
      continuationSseEvents: object[] = [{ type: "agent_message_success" }],
    ) {
      return vi.fn()
        // 1. MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. MCP requests SSE (pending — no tools/call for approve-only tests)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-approve-1", "umsg-1", "amsg-1")),
        })
        // 4. GET .../events — first SSE (contains tool_approve_execution then ends)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([approveEvent]),
        })
        // 5. POST .../validate-action
        .mockResolvedValueOnce({
          ok: validateActionOk,
          status: validateActionOk ? 200 : 500,
          json: () => Promise.resolve({}),
        })
        // 6. GET .../events — reconnect SSE (agent resumes after approval)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream(continuationSseEvents),
        });
    }

    /**
     * Build a fetch mock for a full approve + tools/call cycle.
     * After the approval, the agent SSE reconnects and subsequently the
     * MCP SSE receives a tools/call request.
     */
    function makeApprovalWithToolsCallFetch(
      approveEvent: object,
      toolsCallRequest: object,
      _approved: boolean,
    ) {
      // We need the MCP requests SSE to actually deliver the tools/call.
      // We build the MCP SSE stream here so it closes after delivering the request.
      const encoder = new TextEncoder();
      const mcpSseData = `data: ${JSON.stringify({ eventId: "mcp-e0", data: toolsCallRequest })}\n\n`;

      const fetchMock = vi.fn()
        // 1. MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-srv-2", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests — delivers tools/call after approval
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(mcpSseData));
              controller.close();
            },
          }),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-tool-1", "umsg-2", "amsg-2")),
        })
        // 4. GET .../events — first SSE (tool_approve_execution)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([approveEvent]),
        })
        // 5. POST .../validate-action
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        // 6. POST /mcp/results (tool result after tools/call)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        // 7. GET .../events — reconnect SSE (agent completes)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([{ type: "agent_message_success" }]),
        });

      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Test 1
    it("calls confirmFn with tool name from event metadata", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-1",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: { command: "ls -la" },
        metadata: { toolName: "bash", agentName: "TestAgent" },
      };

      vi.stubGlobal("fetch", makeApprovalFetch(approveEvent));

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run bash" }] })) { /* drain */ }

      expect(confirmFn).toHaveBeenCalledWith(
        expect.stringContaining("bash"),
        expect.any(String),
      );
    });

    // Test 2
    it("calls confirmFn with formatted inputs", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-2",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: { command: "echo hello", timeout: 30 },
        metadata: { toolName: "bash" },
      };

      vi.stubGlobal("fetch", makeApprovalFetch(approveEvent));

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run bash" }] })) { /* drain */ }

      expect(confirmFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("echo hello"),
      );
    });

    // Test 3
    it("POSTs validate-action with 'approved' when confirmFn returns true", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-3",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: {},
        metadata: { toolName: "bash" },
      };

      const fetchMock = makeApprovalFetch(approveEvent);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) { /* drain */ }

      const validateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("validate-action")
      );
      expect(validateCall).toBeDefined();
      const body = JSON.parse(validateCall![1].body);
      expect(body.approved).toBe("approved");
    });

    // Test 4
    it("POSTs validate-action with 'rejected' when confirmFn returns false", async () => {
      const confirmFn = vi.fn().mockResolvedValue(false);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-4",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: {},
        metadata: { toolName: "bash" },
      };

      const fetchMock = makeApprovalFetch(approveEvent);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) { /* drain */ }

      const validateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("validate-action")
      );
      expect(validateCall).toBeDefined();
      const body = JSON.parse(validateCall![1].body);
      expect(body.approved).toBe("rejected");
    });

    it("surfaces an error when tool_approve_execution is missing actionId", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const fetchMock = makeApprovalFetch({
        type: "tool_approve_execution",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: {},
        metadata: { toolName: "bash" },
      });
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      for await (const event of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toMatch(/missing expected string field 'actionId'/i);
      expect(fetchMock.mock.calls.some(([url]: [string]) => url.includes("validate-action"))).toBe(false);
    });

    // Test 5
    it("auto-approves without prompt when stake is 'never_ask'", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-5",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "never_ask",
        inputs: { command: "ls" },
        metadata: { toolName: "bash" },
      };

      const fetchMock = makeApprovalFetch(approveEvent);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run bash" }] })) { /* drain */ }

      // confirmFn must NOT be called for never_ask
      expect(confirmFn).not.toHaveBeenCalled();

      // But validate-action must still be POSTed with "approved"
      const validateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("validate-action")
      );
      expect(validateCall).toBeDefined();
      const body = JSON.parse(validateCall![1].body);
      expect(body.approved).toBe("approved");
    });

    // Test 6
    it("validate-action uses correct conversationId and messageId", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-6",
        conversationId: "conv-approve-1",
        messageId: "amsg-1",
        stake: "medium",
        inputs: {},
        metadata: { toolName: "read" },
      };

      const fetchMock = makeApprovalFetch(approveEvent);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Read file" }] })) { /* drain */ }

      const validateCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("validate-action")
      );
      expect(validateCall).toBeDefined();
      // URL must contain conversationId and messageId
      expect(validateCall![0]).toContain("conv-approve-1");
      expect(validateCall![0]).toContain("amsg-1");
      // Body must include actionId
      const body = JSON.parse(validateCall![1].body);
      expect(body.actionId).toBe("action-6");
    });

    // Test 7
    it("after server-side approval, tools/call is executed without a second confirmFn call", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-7",
        conversationId: "conv-tool-1",
        messageId: "amsg-2",
        stake: "medium",
        inputs: { command: "echo pre-approved" },
        metadata: { toolName: "bash" },
      };

      const toolsCallRequest = {
        jsonrpc: "2.0",
        id: "tc-req-1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "echo pre-approved" } },
      };

      const fetchMock = makeApprovalWithToolsCallFetch(approveEvent, toolsCallRequest, true);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) { /* drain */ }

      // confirmFn should have been called exactly once (for the tool_approve_execution),
      // NOT a second time when tools/call arrives.
      expect(confirmFn).toHaveBeenCalledTimes(1);

      // pi's tools execute asynchronously, so /mcp/results lands after the drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The tool result must have been POSTed to /mcp/results (tool was executed)
      const mcpResultCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/results")
      );
      expect(mcpResultCall).toBeDefined();
      const body = JSON.parse(mcpResultCall![1].body);
      expect(body.result.result?.isError).toBe(false);
    });

    // Test 8
    it("after server-side rejection, tools/call is denied without calling confirmFn", async () => {
      const confirmFn = vi.fn().mockResolvedValue(false);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-8",
        conversationId: "conv-tool-1",
        messageId: "amsg-2",
        stake: "medium",
        inputs: { command: "rm -rf /" },
        metadata: { toolName: "bash" },
      };

      const toolsCallRequest = {
        jsonrpc: "2.0",
        id: "tc-req-2",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "rm -rf /" } },
      };

      const fetchMock = makeApprovalWithToolsCallFetch(approveEvent, toolsCallRequest, false);
      vi.stubGlobal("fetch", fetchMock);

      for await (const _ of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) { /* drain */ }

      // confirmFn called exactly once (for tool_approve_execution prompt)
      expect(confirmFn).toHaveBeenCalledTimes(1);

      // tools/call result must be posted with isError=true (denied)
      const mcpResultCall = fetchMock.mock.calls.find(([url]: [string]) =>
        url.includes("/mcp/results")
      );
      expect(mcpResultCall).toBeDefined();
      const body = JSON.parse(mcpResultCall![1].body);
      expect(body.result.result?.isError).toBe(true);
    });

    // Test 9
    it("streams continuation agent response after tool_approve_execution + tools/call cycle", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-9",
        conversationId: "conv-tool-1",
        messageId: "amsg-2",
        stake: "medium",
        inputs: { command: "echo hello" },
        metadata: { toolName: "bash" },
      };

      const toolsCallRequest = {
        jsonrpc: "2.0",
        id: "tc-req-3",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "echo hello" } },
      };

      const encoder = new TextEncoder();
      const mcpSseData = `data: ${JSON.stringify({ eventId: "mcp-e0", data: toolsCallRequest })}\n\n`;

      const fetchMock = vi.fn()
        // 1. MCP register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-srv-3", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests — delivers tools/call
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(mcpSseData));
              controller.close();
            },
          }),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-tool-1", "umsg-2", "amsg-2")),
        })
        // 4. GET .../events — first SSE (tool_approve_execution)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([approveEvent]),
        })
        // 5. POST .../validate-action
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        // 6. GET .../events — reconnect SSE (streamEvents fetches this BEFORE listenMcpRequests posts /mcp/results)
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: "Tool done!" },
            { type: "agent_message_success" },
          ]),
        })
        // 7. POST /mcp/results (tool result — posted by listenMcpRequests after streamEvents reconnects)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      for await (const e of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) {
        events.push(e);
      }

      // Should have streamed the continuation text
      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas.some((d) => d.delta.includes("Tool done!"))).toBe(true);

      // And a done event
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    // Test 10
    it("resumes the agent stream from lastEventId so the reconnect does not replay text", async () => {
      const confirmFn = vi.fn().mockResolvedValue(true);
      const { capturedStreamSimple } = await setupWithConfirm(confirmFn);

      const approveEvent = {
        type: "tool_approve_execution",
        actionId: "action-10",
        conversationId: "conv-tool-2",
        messageId: "amsg-3",
        stake: "medium",
        inputs: { command: "echo hi" },
        metadata: { toolName: "bash" },
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-srv-4", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        .mockResolvedValueOnce({ ok: true, body: makePendingSseStream() })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-tool-2", "umsg-3", "amsg-3")),
        })
        // First events stream: some text, then the approval that forces a reconnect.
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: "Working on it." },
            approveEvent,
          ]),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        // Reconnect stream: only the continuation, because the cursor was sent.
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: " Done." },
            { type: "agent_message_success" },
          ]),
        })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      for await (const e of capturedStreamSimple(model, { messages: [{ role: "user", content: "Run it" }] })) {
        events.push(e);
      }

      // The reconnect must carry the cursor from the last envelope it saw.
      const eventStreamCalls = fetchMock.mock.calls
        .map(([url]: [string]) => String(url))
        .filter((url) => url.includes("/events"));
      expect(eventStreamCalls.length).toBeGreaterThan(1);
      expect(eventStreamCalls[0]).not.toContain("lastEventId");
      expect(eventStreamCalls[1]).toContain("lastEventId=");

      // Without the cursor Dust replays from 0-0 and the opening text is
      // appended a second time, which is what produced the duplicated
      // transcript in the TUI.
      const done = events.find((e) => e.type === "done");
      const finalText = done.message.content[0].text as string;
      expect(finalText.match(/Working on it\./g) ?? []).toHaveLength(1);
      expect(finalText).toContain(" Done.");
    });
  });
});
