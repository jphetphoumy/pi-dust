import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeFakeJwt, makeLoginFetchMock } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  describe("OAuth functions", () => {
    let loginFn: any;
    let refreshFn: any;
    beforeEach(() => {
      const mockApi = {
        registerProvider: vi.fn((name: string, config: Record<string, any>) => {
          loginFn = config.oauth.login;
          refreshFn = config.oauth.refreshToken;
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
          json: () => Promise.resolve({
            user: {
              workspaces: [{ sId: "ws-1", name: "Acme Corp", role: "admin" }],
              username: "janedoe",
            },
          }),
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

    it("login() accepts token responses where expires_in is a numeric string", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const fetchMock = makeLoginFetchMock({ jwt });
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: "dc-abc",
            user_code: "USER-CODE",
            verification_uri: "https://auth.workos.com/verify",
            verification_uri_complete: "https://api.workos.com/verify",
            expires_in: 300,
            interval: 5,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: jwt,
            refresh_token: "refresh-tok",
            expires_in: "3600",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user: { workspaces: [{ sId: "ws-1", name: "Acme Corp", role: "admin" }], username: "janedoe" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: [] }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(result.expires).toBeGreaterThan(Date.now());
    });

    it("login() falls back to JWT exp when the device auth response omits expires fields", async () => {
      const jwt = makeFakeJwt({
        "https://dust.tt/region": "us-central1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: "dc-abc",
            user_code: "USER-CODE",
            verification_uri: "https://signin.dust.tt/device",
            verification_uri_complete: "https://signin.dust.tt/device?user_code=USER-CODE",
            expires_in: 300,
            interval: 5,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            user: {
              object: "user",
              id: "user_123",
              email: "jane@example.com",
            },
            organization_id: "org_123",
            access_token: jwt,
            refresh_token: "refresh-tok",
            authentication_method: "SSO",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user: { workspaces: [{ sId: "ws-1", name: "Acme Corp", role: "admin" }], username: "janedoe" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ agentConfigurations: [] }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const loginPromise = loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") });
      await vi.runAllTimersAsync();
      const result = await loginPromise;

      expect(result.access).toBe(jwt);
      expect(result.refresh).toBe("refresh-tok");
      expect(result.expires).toBeGreaterThan(Date.now());
    });

    it("login() throws when /api/v1/me response is missing username", async () => {
      const jwt = makeFakeJwt({ "https://dust.tt/region": "us-central1" });
      const mock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: "dc-abc",
            user_code: "USER-CODE",
            verification_uri: "https://auth.workos.com/verify",
            verification_uri_complete: "https://api.workos.com/verify",
            expires_in: 300,
            interval: 5,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: jwt, refresh_token: "ref", expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            user: {
              workspaces: [{ sId: "ws-1", name: "Acme Corp", role: "admin" }],
            },
          }),
        });
      vi.stubGlobal("fetch", mock);

      const assertion = expect(
        loginFn({ onAuth: vi.fn(), onProgress: vi.fn(), onPrompt: vi.fn().mockResolvedValue("1") })
      ).rejects.toThrow(/missing expected string field 'username'/i);
      await vi.runAllTimersAsync();
      await assertion;
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
      ).rejects.toThrow(/session expired/i);
    });

    it("refreshToken() treats 400 invalid_grant as an expired session", async () => {
      // WorkOS returns 400, not 401, for an expired or revoked refresh token.
      // If this is reported as a generic failure the session is never marked
      // invalidated and every session_start retries the same doomed refresh.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"error":"invalid_grant"}'),
        })
      );

      await expect(
        refreshFn({ access: "old", refresh: "dead-refresh", expires: 12345, workspaceId: "ws-123", region: "us-central1" })
      ).rejects.toThrow(/session expired/i);
    });

    it("refreshToken() still reports other failures as generic errors", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));

      await expect(
        refreshFn({ access: "old", refresh: "old-refresh", expires: 12345, workspaceId: "ws-123", region: "us-central1" })
      ).rejects.toThrow(/Token refresh failed: 500/);
    });

    it("refreshToken() falls back to expires_at when expires_in is absent", async () => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_at: expiresAt,
            }),
        })
      );

      const result = await refreshFn({
        access: "old-access",
        refresh: "old-refresh",
        expires: 12345,
        workspaceId: "ws-123",
        region: "europe-west1",
      });

      expect(result.access).toBe("new-access-token");
      expect(result.refresh).toBe("new-refresh-token");
      expect(result.expires).toBeGreaterThan(Date.now());
    });
  });
});
