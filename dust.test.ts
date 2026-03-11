import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dustExtension from "./dust.js";

type Workspace = { sId: string; name: string; role: string };
type DustAgent = { sId: string; name: string; description: string };

function makeCredentials(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    access: "tok",
    refresh: "ref",
    expires: Date.now() + 3600_000,
    workspaceId: "ws-1",
    workspaces: [
      { sId: "ws-1", name: "Acme Corp", role: "admin" },
      { sId: "ws-2", name: "Personal", role: "member" },
    ] as Workspace[],
    agents: [
      { sId: "agent-1", name: "Helper", description: "A helpful agent" },
    ] as DustAgent[],
    region: "us-central1",
    username: "janedoe",
    ...overrides,
  };
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa('{"alg":"none"}');
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.`;
}

/** Builds a mock fetch sequence for a complete login flow. */
function makeLoginFetchMock({
  jwt,
  workspaces = [{ sId: "ws-1", name: "Acme Corp", role: "admin" }],
  agents = [] as DustAgent[],
  extraPolls = 0,
}: {
  jwt: string;
  workspaces?: Workspace[];
  agents?: DustAgent[];
  extraPolls?: number;
}) {
  const mock = vi.fn();

  // 1. Device code
  mock.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        device_code: "dc-abc",
        user_code: "USER-CODE",
        verification_uri: "https://auth.workos.com/verify",
        verification_uri_complete: "https://api.workos.com/verify",
        expires_in: 300,
        interval: 5,
      }),
  });

  // 2+. Extra polls (authorization_pending)
  for (let i = 0; i < extraPolls; i++) {
    mock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: "authorization_pending" }),
    });
  }

  // Poll → token
  mock.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        access_token: jwt,
        refresh_token: "refresh-tok",
        expires_in: 3600,
      }),
  });

  // GET /api/v1/me
  mock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ user: { workspaces, username: "janedoe", fullName: "Jane Doe", email: "jane@example.com" } }),
  });

  // GET assistant/agent_configurations
  mock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ agentConfigurations: agents }),
  });

  return mock;
}

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

  describe("OAuth functions", () => {
    let loginFn: any;
    let refreshFn: any;
    let getApiKeyFn: any;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn((name: string, config: Record<string, any>) => {
          loginFn = config.oauth.login;
          refreshFn = config.oauth.refreshToken;
          getApiKeyFn = config.oauth.getApiKey;
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

    it("login() calls onAuth with the WorkOS URL", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal("fetch", makeLoginFetchMock({ jwt }));

      const onAuth = vi.fn();
      const loginPromise = loginFn({ onAuth, onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      expect(onAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("api.workos.com"),
          instructions: expect.stringContaining("USER-CODE"),
        })
      );
    });

    it("login() polls through authorization_pending then resolves", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal("fetch", makeLoginFetchMock({ jwt, extraPolls: 2 }));

      const onProgress = vi.fn();
      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress, onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(onProgress).toHaveBeenCalledWith("Waiting for browser authorization…");
      expect(result).toMatchObject({
        access: jwt,
        refresh: "refresh-tok",
        expires: expect.any(Number),
      });
    });

    it("login() fetches workspaces, lists them, and prompts for selection", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal(
        "fetch",
        makeLoginFetchMock({
          jwt,
          workspaces: [
            { sId: "ws-111", name: "Acme Corp", role: "admin" },
            { sId: "ws-222", name: "Personal", role: "member" },
          ],
        })
      );

      const onProgress = vi.fn();
      const onPrompt = vi.fn().mockResolvedValue("1");
      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress, onPrompt });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Acme Corp"));
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Personal"));
      expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ message: "Select workspace number:" }));
      expect(result.workspaceId).toBe("ws-111");
    });

    it("login() stores the full workspace list in credentials", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal(
        "fetch",
        makeLoginFetchMock({
          jwt,
          workspaces: [
            { sId: "ws-1", name: "Acme Corp", role: "admin" },
            { sId: "ws-2", name: "Personal", role: "member" },
          ],
        })
      );

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(result.workspaces).toEqual([
        { sId: "ws-1", name: "Acme Corp", role: "admin" },
        { sId: "ws-2", name: "Personal", role: "member" },
      ]);
    });

    it("login() throws a clear error when workspace selection input is not a number", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });

      // This test throws before reaching the agents fetch, so no agents mock needed
      const mock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: "dc-abc", user_code: "USER-CODE",
            verification_uri: "https://auth.workos.com/verify",
            verification_uri_complete: "https://api.workos.com/verify",
            expires_in: 300, interval: 5,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: jwt, refresh_token: "ref", expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user: { workspaces: [{ sId: "ws-1", name: "Acme Corp", role: "admin" }] } }),
        });
      vi.stubGlobal("fetch", mock);

      const assertion = expect(
        loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("") })
      ).rejects.toThrow("Invalid workspace selection");
      await vi.runAllTimersAsync();
      await assertion;
    });

    it("login() fetches agents from the workspace-scoped endpoint after workspace selection", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({
        jwt,
        workspaces: [{ sId: "ws-42", name: "My Workspace", role: "admin" }],
        agents: [{ sId: "agent-1", name: "Helper", description: "Helps" }],
      });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      // The agents fetch is the last call
      const agentsCall = fetchMock.mock.calls.at(-1)!;
      expect(agentsCall[0]).toContain("ws-42");
      expect(agentsCall[0]).toContain("agent_configurations");
    });

    it("login() sends User-Agent 'Dust CLI' header on agent_configurations call but NOT on /me", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({ jwt });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      const meCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/api/v1/me"));
      const agentsCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("agent_configurations"));

      expect(meCall).toBeDefined();
      expect(agentsCall).toBeDefined();
      // dust-cli does NOT send these headers on /me
      expect(meCall![1]?.headers?.["User-Agent"]).toBeUndefined();
      expect(meCall![1]?.headers?.["X-Dust-CLI-Version"]).toBeUndefined();
      // dust-cli DOES send them on agent_configurations
      expect(agentsCall![1]?.headers?.["User-Agent"]).toBe("Dust CLI");
    });

    it("login() sends X-Dust-CLI-Version header on agent_configurations call but NOT on /me", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({ jwt });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      const meCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/api/v1/me"));
      const agentsCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("agent_configurations"));

      expect(meCall![1]?.headers?.["X-Dust-CLI-Version"]).toBeUndefined();
      expect(agentsCall![1]?.headers?.["X-Dust-CLI-Version"]).toBeDefined();
    });

    it("login() stores fetched agents in credentials", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      vi.stubGlobal(
        "fetch",
        makeLoginFetchMock({
          jwt,
          agents: [
            { sId: "agent-1", name: "Coder", description: "Writes code" },
            { sId: "agent-2", name: "Reviewer", description: "Reviews code" },
          ],
        })
      );

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(result.agents).toEqual([
        { sId: "agent-1", name: "Coder", description: "Writes code" },
        { sId: "agent-2", name: "Reviewer", description: "Reviews code" },
      ]);
    });

    it("refreshToken() returns updated credentials preserving workspaceId/region", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        })
      );

      const existing = {
        access: "old-access",
        refresh: "old-refresh",
        expires: 12345,
        workspaceId: "ws-123",
        region: "europe-west1",
      };

      const result = await refreshFn(existing);

      expect(result.access).toBe("new-access-token");
      expect(result.refresh).toBe("new-refresh-token");
      expect(result.expires).toBeGreaterThan(Date.now());
      expect(result.workspaceId).toBe("ws-123");
      expect(result.region).toBe("europe-west1");
    });

    it("refreshToken() throws on 401", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: false, status: 401 })
      );

      await expect(
        refreshFn({ access: "old", refresh: "old-refresh", expires: 12345, workspaceId: "ws-123", region: "us-central1" })
      ).rejects.toThrow();
    });
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
        // 2. GET /mcp/requests (empty background SSE)
        .mockResolvedValueOnce({
          ok: true,
          body: new ReadableStream({ start(c) { c.close(); } }),
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
          body: new ReadableStream({ start(c) { c.close(); } }),
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

  describe("/workspace command", () => {
    let workspaceFn: (args: string, ctx: any) => Promise<void>;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn(),
        registerCommand: vi.fn((name: string, config: any) => {
          if (name === "workspace") workspaceFn = config.handler;
        }),
      };
      dustExtension(mockApi as any);
    });

    it("registers a 'workspace' command", () => {
      expect(typeof workspaceFn).toBe("function");
    });

    it("notifies if not logged in (no credentials)", async () => {
      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(undefined) } },
        ui: { notify: vi.fn(), select: vi.fn() },
      };
      await workspaceFn("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("notifies if credentials have no workspace list (old login)", async () => {
      const ctx = {
        modelRegistry: {
          authStorage: { get: vi.fn().mockReturnValue({ type: "oauth", workspaceId: "ws-1" }) },
        },
        ui: { notify: vi.fn(), select: vi.fn() },
      };
      await workspaceFn("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("shows select with current workspace name in title and all workspaces as options", async () => {
      const creds = makeCredentials();
      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue(undefined) },
      };
      await workspaceFn("", ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(
        expect.stringContaining("Acme Corp"),
        ["Acme Corp (admin)", "Personal (member)"],
        expect.anything(),
      );
    });

    it("updates workspaceId in credentials when user selects a different workspace", async () => {
      const creds = makeCredentials();
      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue("Personal (member)") },
      };
      await workspaceFn("", ctx);
      expect(ctx.modelRegistry.authStorage.set).toHaveBeenCalledWith(
        "dust",
        expect.objectContaining({ workspaceId: "ws-2" })
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Personal"), "info");
    });

    it("does not update credentials when user cancels the selector", async () => {
      const creds = makeCredentials();
      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue(undefined) },
      };
      await workspaceFn("", ctx);
      expect(ctx.modelRegistry.authStorage.set).not.toHaveBeenCalled();
    });

    it("does not update credentials when user selects the already active workspace", async () => {
      const creds = makeCredentials();
      const ctx = {
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue("Acme Corp (admin)") },
      };
      await workspaceFn("", ctx);
      expect(ctx.modelRegistry.authStorage.set).not.toHaveBeenCalled();
    });
  });

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
          body: new ReadableStream({ start(c) { c.close(); } }),
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
          body: new ReadableStream({ start(c) { c.close(); } }),
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
      expect(setCall[1].conversations[sessionFile]).toBe("conv-persisted");
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
      expect(setCall[1].conversations[resumedFile]).toBe("conv-for-resumed");
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
          body: new ReadableStream({ start(c) { c.close(); } }),
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
          body: new ReadableStream({ start(c) { c.close(); } }),
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

  // ---------------------------------------------------------------------------
  // MCP server management
  // ---------------------------------------------------------------------------

  describe("MCP server management", () => {
    async function setupWithMcp(conversations: Record<string, string> = {}) {
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

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agentConfigurations: creds.agents }),
      }));

      const makeCtx = (file: string | undefined = "/sessions/s1.json", entries: unknown[] = []) => ({
        modelRegistry: {
          authStorage: { get: vi.fn().mockReturnValue({ ...creds }), set: authStorageSet },
        },
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue(file),
          getEntries: vi.fn().mockReturnValue(entries),
        },
      });

      await sessionStartHandler!({}, makeCtx());
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
        // 2. POST /assistant/conversations → create conversation
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
        // 3. GET .../events  (SSE stream)
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
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
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
        // Turn 1: MCP register + conversation create + SSE
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverId: "mcp-s1", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        })
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
      const authStorageSet = vi.fn();
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

      const authStorage = {
        get: vi.fn(() => storedCreds),
        set: vi.fn((key: string, val: any) => {
          authStorageSet(key, val);
          storedCreds = val;
        }),
      };
      const ctx = {
        modelRegistry: { authStorage },
        sessionManager: {
          getSessionFile: vi.fn().mockReturnValue("/sessions/s1.json"),
          getEntries: vi.fn().mockReturnValue([]),
        },
      };
      await sessionStartHandler!({}, ctx);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();

      return { capturedStreamSimple, freshCreds, expiredCreds, authStorage, authStorageSet };
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
          body: new ReadableStream({ start(c) { c.close(); } }),
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

    it("persists refreshed token to authStorage", async () => {
      const { capturedStreamSimple, freshCreds, authStorageSet } = await setupWithExpiredCreds();

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
          body: new ReadableStream({ start(c) { c.close(); } }),
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

      const setCall = authStorageSet.mock.calls.find(
        ([, c]: [string, any]) => c.access === freshCreds.access
      );
      expect(setCall).toBeDefined();
    });

    it("continues with stale token if refresh fails, and surfaces the error downstream", async () => {
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
      expect(errorEvent.error.errorMessage).toMatch(/401/);
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
        modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } },
        sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s1.json"), getEntries: vi.fn().mockReturnValue([]) },
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

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        // POST /mcp/results with bash output
        .mockImplementationOnce(async (_url: string, opts: any) => {
          return { ok: true, json: () => Promise.resolve({ success: true }) };
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

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

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

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

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

      const resultPostCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/mcp/results"))!;
      const resultBody = JSON.parse(resultPostCall[1].body);
      expect(resultBody.result.result?.isError).toBe(true);
      const content: any[] = resultBody.result.result?.content ?? [];
      expect(content.some((c: any) => c.type === "text" && c.text.toLowerCase().includes("nonexistent_tool"))).toBe(true);
    });

    it("POST /mcp/results sends Authorization Bearer token", async () => {
      const creds = makeCredentials({ access: "results-access-token" });
      let capturedStreamSimple: any;
      let sessionStartHandler: ((e: unknown, ctx: any) => Promise<void>) | undefined;
      const mockApi = {
        registerProvider: vi.fn((_n: string, c: any) => { capturedStreamSimple = c.streamSimple; }),
        registerCommand: vi.fn(),
        on: vi.fn((ev: string, h: any) => { if (ev === "session_start") sessionStartHandler = h; }),
      };
      dustExtension(mockApi as any);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ agentConfigurations: creds.agents }) }));
      await sessionStartHandler!({}, { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } }, sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s.json"), getEntries: vi.fn().mockReturnValue([]) } });
      vi.unstubAllGlobals();

      const callRequest = { jsonrpc: "2.0", id: "req-bash-2", method: "tools/call", params: { name: "bash", arguments: { command: "echo auth-test" } } };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: makeMcpSseStream([callRequest]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ conversation: { sId: "c1", content: [[{ type: "user_message", sId: "m1" }], [{ type: "agent_message", sId: "am1", parentMessageId: "m1" }]] }, message: { sId: "m1" } }) })
        .mockResolvedValueOnce({ ok: true, body: makeSseStream([{ type: "agent_message_success" }]) });
      vi.stubGlobal("fetch", fetchMock);

      const stream = capturedStreamSimple({ id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" }, { messages: [{ role: "user", content: "Hi" }] });
      for await (const _ of stream) { /* drain */ }

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
      let capturedStreamSimple: any;
      let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      const mockApi = {
        registerProvider: vi.fn((_n: string, c: any) => { capturedStreamSimple = c.streamSimple; }),
        registerCommand: vi.fn(),
        on: vi.fn((ev: string, h: any) => { if (ev === "session_start") sessionStartHandler = h; }),
      };
      dustExtension(mockApi as any);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ agentConfigurations: creds.agents }) }));
      await sessionStartHandler!({}, { modelRegistry: { authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() } }, sessionManager: { getSessionFile: vi.fn().mockReturnValue("/s/s.json"), getEntries: vi.fn().mockReturnValue([]) } });
      vi.unstubAllGlobals();
      return capturedStreamSimple;
    }

    const model = { id: "agent-sonnet", sId: "agentSId-1", name: "AgentSonnet", provider: "dust", api: "dust" };

    it("emits a text_delta indicating tool name when tool_params event is received", async () => {
      const capturedStreamSimple = await setupStreamFn();

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ serverId: "srv-1", expiresAt: new Date(Date.now() + 300_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }) // MCP requests SSE (empty)
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

      const toolDeltas = events.filter((e) => e.type === "text_delta" && e.delta.toLowerCase().includes("bash"));
      expect(toolDeltas.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // SSE helpers used by streamSimple tests
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal SSE ReadableStream from an array of Dust event payloads.
   * Each event is wrapped in the wire format: data: {"eventId":"eN","data":{...}}\n\n
   */
  function makeSseStream(events: object[]): ReadableStream<Uint8Array> {
    const lines = events
      .map((e, i) => `data: ${JSON.stringify({ eventId: `e${i}`, data: e })}\n\n`)
      .join("");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(lines);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  /**
   * Build a mock model object for the dust provider.
   * Credentials are no longer stored on the model — they live in the streamSimple
   * closure created by buildDustProviderConfig.
   */
  function makeModel() {
    return {
      id: "agent-sonnet",
      sId: "agentSId-1",
      name: "AgentSonnet",
      provider: "dust",
      api: "dust",
    };
  }

  /**
   * Register the dust extension and trigger buildDustProviderConfig via session_start
   * so that the captured streamSimpleFn has the test credentials in its closure.
   * Returns the streamSimpleFn from the last registerProvider call.
   */
  async function makeStreamSimpleFn(credOverrides: Record<string, unknown> = {}): Promise<any> {
    const creds = makeCredentials(credOverrides);
    let capturedStreamSimple: any;
    let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | undefined;

    const mockApi = {
      registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
        capturedStreamSimple = config.streamSimple;
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
        if (event === "session_start") sessionStartHandler = handler;
      }),
    };

    dustExtension(mockApi as any);

    // Stub fetch for the session_start agent refresh call
    const savedFetch = (globalThis as any).fetch;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ agentConfigurations: creds.agents }),
    }));

    const ctx = {
      modelRegistry: {
        authStorage: { get: vi.fn().mockReturnValue(creds), set: vi.fn() },
      },
      sessionManager: {
        getSessionFile: vi.fn().mockReturnValue(undefined),
        getEntries: vi.fn().mockReturnValue([]),
      },
    };
    await sessionStartHandler!({}, ctx);

    // Restore fetch (caller will stub it for their own mocks)
    vi.stubGlobal("fetch", savedFetch);

    return capturedStreamSimple;
  }

  /**
   * Build the minimal conversation response that createConversation returns.
   * agentMessageSId is the sId of the agent_message that follows the user message.
   */
  function makeConversationResponse(conversationSId: string, userMessageSId: string, agentMessageSId: string) {
    return {
      conversation: {
        sId: conversationSId,
        content: [
          [{ type: "user_message", sId: userMessageSId }],
          [{ type: "agent_message", sId: agentMessageSId, parentMessageId: userMessageSId }],
        ],
      },
      message: { sId: userMessageSId },
    };
  }

  /**
   * Build the conversation object returned by getConversation (used for subsequent messages).
   */
  function makeConversationGetResponse(conversationSId: string, userMessageSId: string, agentMessageSId: string) {
    return {
      conversation: {
        sId: conversationSId,
        content: [
          [{ type: "user_message", sId: userMessageSId }],
          [{ type: "agent_message", sId: agentMessageSId, parentMessageId: userMessageSId }],
        ],
      },
    };
  }

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
          body: new ReadableStream({ start(c) { c.close(); } }),
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
      expect(body.message.content).toBe("What is 2+2?");
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

    it("yields done event when agent_generation_cancelled is received", async () => {
      const model = makeModel();
      const fetchMock = makeFirstMessageFetch("conv-1", "msg-1", "amsg-1", [
        { type: "agent_generation_cancelled" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const events: any[] = [];
      const stream = streamSimpleFn(model, { messages: [{ role: "user", content: "Hi" }] });
      for await (const e of stream) events.push(e);

      expect(events.some((e) => e.type === "done")).toBe(true);
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
        .mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })
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
});
