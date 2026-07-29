import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBootstrapDustCredentials } from "./dust-bootstrap.js";
import { debugLog } from "./dust-debug.js";
import { registerDustProvider } from "./dust-provider.js";
import { DustSessionRuntime } from "./dust-runtime.js";
import { registerDustSessionEvents } from "./dust-session-events.js";
import { clearInvalidated, persistCredentialState } from "./dust-state.js";
import { createDustStreamHandler } from "./dust-stream-provider.js";
import type { DustCredentials, ExtensionAPIWithEvents } from "./dust-types.js";
import { registerDustApprovalMode } from "./dust-approval.js";
import { registerDustStatusCommand } from "./dust-status.js";
import { registerDustToolRenderer } from "./dust-tool-render.js";
import { registerDustWorkspaceCommand } from "./dust-workspace.js";

const EMPTY_CREDENTIALS: DustCredentials = { type: "oauth", access: "", refresh: "", expires: 0 };

export default function (pi: ExtensionAPI) {
  const piWithEvents = pi as ExtensionAPIWithEvents;
  const runtime = new DustSessionRuntime();
  runtime.pi = pi;
  const dustRealStream = createDustStreamHandler(runtime);
  // Login returns workspaces/agents alongside the tokens. pi keeps the tokens;
  // the Dust-specific half is ours to persist, and a fresh login clears any
  // earlier "session dead" marker.
  const onLogin = (cred: DustCredentials) => {
    clearInvalidated();
    // A fresh login can be a different account or workspace entirely. A
    // previous account's still-live in-memory token must not go on
    // outranking the new one — that would send the new session's requests
    // under someone else's identity until the old holder happened to expire.
    runtime.clearRefreshedAccessToken();
    persistCredentialState(cred);
    registerProviderForCredentials(cred);
  };
  const registerProviderForCredentials = (cred: DustCredentials) =>
    registerDustProvider(pi, cred, dustRealStream, onLogin);
  const bootstrapCredentials = loadBootstrapDustCredentials() ?? EMPTY_CREDENTIALS;

  debugLog("dust:init", "Initializing Dust extension");
  runtime.resetSessionState();
  registerProviderForCredentials(bootstrapCredentials);

  if (typeof piWithEvents.on === "function") {
    registerDustSessionEvents(piWithEvents, runtime, registerProviderForCredentials);
  }

  registerDustToolRenderer(pi);
  registerDustApprovalMode(pi, runtime);
  registerDustWorkspaceCommand(pi, runtime);
  registerDustStatusCommand(pi, runtime);
}
