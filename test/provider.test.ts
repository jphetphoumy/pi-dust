import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeConversationResponse, makeCredentials, makeModel, makePendingSseStream, makeSseStream } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  it("registers 'Dust' as an OAuth provider", () => {
    let registeredName: string | undefined;
    let registeredConfig: Record<string, any> | undefined;

    const mockApi = {
      registerProvider: vi.fn((name: string, config: Record<string, any>) => {
        registeredName = name;
        registeredConfig = config;
      }),
      registerCommand: vi.fn(),
    };

    dustExtension(mockApi as any);

    expect(registeredName).toBe("dust");
    expect(registeredConfig?.oauth?.name).toBe("Dust");
    expect(typeof registeredConfig?.oauth?.login).toBe("function");
    expect(typeof registeredConfig?.oauth?.refreshToken).toBe("function");
    expect(typeof registeredConfig?.oauth?.getApiKey).toBe("function");
  });
  describe("modifyModels", () => {
    let modifyModelsFn: any;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          modifyModelsFn = config.oauth.modifyModels;
        }),
        registerCommand: vi.fn(),
      };
      dustExtension(mockApi as any);
    });

    it("is defined on the provider oauth config", () => {
      expect(typeof modifyModelsFn).toBe("function");
    });

    it("converts stored agents to models with slugified id, human name and provider", () => {
      const creds = makeCredentials({
        agents: [
          { sId: "miV7ukZhGD", name: "AgentSonnet", description: "Does stuff" },
        ],
      });
      const models = modifyModelsFn([], creds);

      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: "agent-sonnet",       // slugified name — what the user sees
        name: "AgentSonnet",      // original name — used for search
        provider: "dust",
      });
      // sId is preserved for API calls
      expect(models[0].sId).toBe("miV7ukZhGD");
    });

    it("slugifies agent names with spaces and mixed case", () => {
      const creds = makeCredentials({
        agents: [
          { sId: "abc123", name: "My Custom Agent", description: "" },
        ],
      });
      const [model] = modifyModelsFn([], creds);
      expect(model.id).toBe("my-custom-agent");
    });

    it("replaces existing dust models, keeps non-dust models (slug-based ids)", () => {
      const creds = makeCredentials({
        agents: [{ sId: "newSId", name: "New Agent", description: "" }],
      });
      const existing = [
        { provider: "dust", id: "old-agent", name: "Old" },
        { provider: "anthropic", id: "claude-3", name: "Claude" },
      ];
      const result = modifyModelsFn(existing, creds);

      expect(result.some((m: any) => m.id === "old-agent")).toBe(false);
      expect(result.some((m: any) => m.id === "claude-3")).toBe(true);
      expect(result.some((m: any) => m.id === "new-agent")).toBe(true);
    });

    it("sets baseUrl using dust.tt for us-central1", () => {
      const creds = makeCredentials({ region: "us-central1", workspaceId: "ws-99" });
      const [model] = modifyModelsFn([], creds);
      expect(model.baseUrl).toContain("dust.tt");
      expect(model.baseUrl).not.toContain("eu.");
      expect(model.baseUrl).toContain("ws-99");
    });

    it("sets baseUrl using eu.dust.tt for europe-west1", () => {
      const creds = makeCredentials({ region: "europe-west1", workspaceId: "ws-eu" });
      const [model] = modifyModelsFn([], creds);
      expect(model.baseUrl).toContain("eu.dust.tt");
      expect(model.baseUrl).toContain("ws-eu");
    });

    it("includes User-Agent 'Dust CLI' in model headers", () => {
      const creds = makeCredentials();
      const [model] = modifyModelsFn([], creds);
      expect(model.headers?.["User-Agent"]).toBe("Dust CLI");
    });

    it("returns empty array when credentials have no agents", () => {
      const creds = makeCredentials({ agents: [] });
      expect(modifyModelsFn([], creds)).toHaveLength(0);
    });

    it("returns empty array when credentials have no agents field (old login)", () => {
      const creds = makeCredentials({ agents: undefined });
      expect(modifyModelsFn([], creds)).toHaveLength(0);
    });

    it("replaces existing dust models, keeps non-dust models (legacy check)", () => {
      const creds = makeCredentials({
        agents: [{ sId: "new-agent", name: "New", description: "" }],
      });
      const existing = [
        { provider: "dust", id: "old-agent", name: "Old" },
        { provider: "anthropic", id: "claude-3", name: "Claude" },
      ];
      const result = modifyModelsFn(existing, creds);

      expect(result.some((m: any) => m.id === "old-agent")).toBe(false);
      expect(result.some((m: any) => m.id === "claude-3")).toBe(true);
      expect(result.some((m: any) => m.id === "new")).toBe(true);
    });
  });

  describe("streamSimple (provider registration)", () => {
    let streamSimpleFn: any;
    let capturedConfig: Record<string, any>;

    beforeEach(async () => {
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          capturedConfig = config;
          streamSimpleFn = config.streamSimple;
        }),
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          if (event === "session_start") sessionStartHandler = handler;
        }),
      };
      dustExtension(mockApi as any);

      // Trigger buildDustProviderConfig via session_start so streamSimpleFn has real credentials.
      const creds = makeCredentials();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));
      const ctx = { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } } };
      await sessionStartHandler!({}, ctx);
      vi.unstubAllGlobals();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("provider config has api set", () => {
      expect(capturedConfig?.api).toBeDefined();
    });

    it("provider config has streamSimple defined", () => {
      expect(typeof streamSimpleFn).toBe("function");
    });

    it("streamSimple returns an async iterable", () => {
      const model = makeModel();
      const context = { messages: [] };
      const result = streamSimpleFn(model, context);
      expect(result != null && typeof result[Symbol.asyncIterator] === "function").toBe(true);
    });

    it("streamSimple stream yields at least one text_delta event", async () => {
      const model = makeModel();
      vi.stubGlobal("fetch", vi.fn()
        // 1. POST /mcp/register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests (background SSE — stays open, no reconnect)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        // 4. SSE events
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: "Hello from Dust!" },
            { type: "agent_message_success" },
          ]),
        })
      );

      const events: any[] = [];
      for await (const event of streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] })) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "text_delta" && typeof e.delta === "string" && e.delta.length > 0)).toBe(true);
    });

    it("streamSimple stream terminates with a done event", async () => {
      const model = makeModel();
      vi.stubGlobal("fetch", vi.fn()
        // 1. POST /mcp/register
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
        // 2. GET /mcp/requests (empty background SSE)
        .mockResolvedValueOnce({
          ok: true,
          body: makePendingSseStream(),
        })
        // 3. POST /assistant/conversations
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeConversationResponse("conv-1", "msg-1", "amsg-1")),
        })
        // 4. SSE events
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseStream([
            { type: "generation_tokens", classification: "tokens", text: "Done!" },
            { type: "agent_message_success" },
          ]),
        })
      );

      const events: any[] = [];
      for await (const event of streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] })) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "done")).toBe(true);
    });
  });
});
