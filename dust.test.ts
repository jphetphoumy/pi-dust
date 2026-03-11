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
    json: () => Promise.resolve({ user: { workspaces } }),
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

    it("login() sends User-Agent 'Dust CLI' header on Dust API calls", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({ jwt });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      // /me call (3rd call, index 2) and agents call (4th call, index 3)
      const meCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes("/api/v1"));
      expect(meCalls.length).toBeGreaterThanOrEqual(2);
      for (const [, init] of meCalls) {
        expect(init?.headers?.["User-Agent"]).toBe("Dust CLI");
      }
    });

    it("login() sends X-Dust-CLI-Version header on Dust API calls", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({ jwt });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      await loginPromise;

      const meCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes("/api/v1"));
      for (const [, init] of meCalls) {
        expect(init?.headers?.["X-Dust-CLI-Version"]).toBeDefined();
      }
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

  describe("streamSimple (mock provider)", () => {
    let streamSimpleFn: any;
    let capturedConfig: Record<string, any>;

    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn((_name: string, config: Record<string, any>) => {
          capturedConfig = config;
          streamSimpleFn = config.streamSimple;
        }),
        registerCommand: vi.fn(),
      };
      dustExtension(mockApi as any);
    });

    it("provider config has api set", () => {
      expect(capturedConfig?.api).toBeDefined();
    });

    it("provider config has streamSimple defined", () => {
      expect(typeof streamSimpleFn).toBe("function");
    });

    it("streamSimple returns an async iterable", () => {
      const model = { id: "agent-1", provider: "dust", api: "dust", name: "Helper" };
      const context = { messages: [] };
      const result = streamSimpleFn(model, context);
      expect(result != null && typeof result[Symbol.asyncIterator] === "function").toBe(true);
    });

    it("streamSimple stream yields at least one text_delta event", async () => {
      const model = { id: "agent-1", provider: "dust", api: "dust", name: "Helper" };
      const context = { messages: [] };
      const stream = streamSimpleFn(model, context);

      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "text_delta" && typeof e.delta === "string" && e.delta.length > 0)).toBe(true);
    });

    it("streamSimple stream terminates with a done event", async () => {
      const model = { id: "agent-1", provider: "dust", api: "dust", name: "Helper" };
      const context = { messages: [] };
      const stream = streamSimpleFn(model, context);

      const events: any[] = [];
      for await (const event of stream) {
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
});
