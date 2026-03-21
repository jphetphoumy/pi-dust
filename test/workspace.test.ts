import { beforeEach, describe, expect, it, vi } from "vitest";
import dustExtension from "../src/dust.js";
import { makeCredentials } from "./helpers/dust-fixtures.js";

describe("dust extension", () => {
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
});
