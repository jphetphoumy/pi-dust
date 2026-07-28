import { beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import {
  makeCredentials,
  readState,
  seedAuth,
  seedLoggedIn,
  seedState,
  useTempAgentDir,
} from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
  describe("/workspace command", () => {
    useTempAgentDir();

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
      seedAuth(null);
      const ctx = { modelRegistry: {}, ui: { notify: vi.fn(), select: vi.fn() } };
      await workspaceFn("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("notifies if credentials have no workspace list (old login)", async () => {
      seedAuth({ type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 });
      seedState({ workspaceId: "ws-1" });
      const ctx = { modelRegistry: {}, ui: { notify: vi.fn(), select: vi.fn() } };
      await workspaceFn("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/log.?in/i), "warning");
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("shows select with current workspace name in title and all workspaces as options", async () => {
      seedLoggedIn(makeCredentials());
      const ctx = {
        modelRegistry: {},
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue(undefined) },
      };
      await workspaceFn("", ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(
        expect.stringContaining("Acme Corp"),
        ["Acme Corp (admin)", "Personal (member)"],
        expect.anything(),
      );
    });

    it("updates workspaceId in state when user selects a different workspace", async () => {
      seedLoggedIn(makeCredentials());
      const ctx = {
        modelRegistry: {},
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue("Personal (member)") },
      };
      await workspaceFn("", ctx);
      expect(readState()).toMatchObject({ workspaceId: "ws-2" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Personal"), "info");
    });

    it("does not update state when user cancels the selector", async () => {
      seedLoggedIn(makeCredentials());
      const ctx = {
        modelRegistry: {},
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue(undefined) },
      };
      await workspaceFn("", ctx);
      expect(readState()).toMatchObject({ workspaceId: "ws-1" });
    });

    it("does not update state when user selects the already active workspace", async () => {
      seedLoggedIn(makeCredentials());
      const ctx = {
        modelRegistry: {},
        ui: { notify: vi.fn(), select: vi.fn().mockResolvedValue("Acme Corp (admin)") },
      };
      await workspaceFn("", ctx);
      expect(readState()).toMatchObject({ workspaceId: "ws-1" });
    });
  });
});
