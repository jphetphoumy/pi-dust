import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { workspaceLabel } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { getStoredCredentials, patchDustState } from "./dust-state.js";
import type { PiRuntimeContext, Workspace } from "./dust-types.js";

export function registerDustWorkspaceCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workspace", {
    description: "Show current Dust workspace and switch between workspaces",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const cred = getStoredCredentials();

      if (!cred || !Array.isArray(cred.workspaces) || cred.workspaces.length === 0) {
        runtimeCtx.ui?.notify?.("Not logged in to Dust. Run /login first.", "warning");
        return;
      }

      const workspaces: Workspace[] = cred.workspaces;
      const current = workspaces.find((workspace) => workspace.sId === cred.workspaceId);
      const currentName = current?.name ?? cred.workspaceId ?? "Unknown";
      const selected = await runtimeCtx.ui?.select?.(
        `Current workspace: ${currentName}`,
        workspaces.map(workspaceLabel),
        {},
      );

      if (!selected) return;
      const picked = workspaces.find((workspace) => workspaceLabel(workspace) === selected);
      if (!picked || picked.sId === cred.workspaceId) return;

      patchDustState({ workspaceId: picked.sId });
      debugLog("dust:session", "Switched workspace", { from: cred.workspaceId, to: picked.sId, name: picked.name });
      runtimeCtx.ui?.notify?.(`Switched to workspace: ${picked.name}`, "info");
    },
  });
}
