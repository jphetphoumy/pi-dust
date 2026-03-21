import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadBootstrapDustCredentials } from "./dust-bootstrap.js";
import { debugLog } from "./dust-debug.js";
import { registerDustProvider } from "./dust-provider.js";
import { DustSessionRuntime } from "./dust-runtime.js";
import { registerDustSessionEvents } from "./dust-session-events.js";
import { createDustStreamHandler } from "./dust-stream-provider.js";
import type { DustCredentials, ExtensionAPIWithEvents } from "./dust-types.js";
import { registerDustWorkspaceCommand } from "./dust-workspace.js";

const EMPTY_CREDENTIALS: DustCredentials = { type: "oauth", access: "", refresh: "", expires: 0 };

export default function (pi: ExtensionAPI) {
  const piWithEvents = pi as ExtensionAPIWithEvents;
  const runtime = new DustSessionRuntime();
  const dustRealStream = createDustStreamHandler(runtime);
  const registerProviderForCredentials = (cred: DustCredentials) =>
    registerDustProvider(pi, cred, dustRealStream, registerProviderForCredentials);
  const bootstrapCredentials = loadBootstrapDustCredentials() ?? EMPTY_CREDENTIALS;

  debugLog("dust:init", "Initializing Dust extension");
  runtime.resetSessionState();
  registerProviderForCredentials(bootstrapCredentials);

  if (typeof piWithEvents.on === "function") {
    registerDustSessionEvents(piWithEvents, runtime, registerProviderForCredentials);
  }

  registerDustWorkspaceCommand(pi);
}
