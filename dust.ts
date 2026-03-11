import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WORKOS_DOMAIN = "api.workos.com";
const WORKOS_CLIENT_ID = "client_01JGCT55T7FVDG9XF74925R1KT";
const REGION_CLAIM = "https://dust.tt/region";
const DUST_US_URL = "https://dust.tt";
const DUST_EU_URL = "https://eu.dust.tt";
const DUST_CLI_VERSION = "0.4.4";

const DUST_HEADERS = {
  "User-Agent": "Dust CLI",
  "X-Dust-CLI-Version": DUST_CLI_VERSION,
};

type Workspace = { sId: string; name: string; role: string };
type DustAgent = { sId: string; name: string; description: string };

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

function workspaceLabel(ws: Workspace): string {
  return `${ws.name} (${ws.role})`;
}

function dustApiUrl(region: string): string {
  return region === "europe-west1" ? DUST_EU_URL : DUST_US_URL;
}

async function* dustMockStream() {
  yield { type: "text_delta" as const, contentIndex: 0, delta: "Dust agent chat is not yet implemented.", partial: null };
  yield { type: "done" as const, reason: "stop" as const, message: null };
}

function buildDustProviderConfig(pi: ExtensionAPI, cred: any) {
  const agents: DustAgent[] = cred.agents ?? [];
  const apiUrl = dustApiUrl(cred.region ?? "us-central1");
  const workspaceId: string = cred.workspaceId ?? "";
  const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;

  pi.registerProvider("dust", {
    api: "dust" as any,
    baseUrl,
    streamSimple: (_model: unknown, _context: unknown, _options?: unknown) => dustMockStream() as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => loginFn(callbacks),
      refreshToken,
      getApiKey: (credentials) => credentials.access as string,
      modifyModels: (models, credentials) => {
        // Fallback path: called by the registry on initial load when credentials
        // already exist. Replaces any stale dust models with the current agent list.
        const c = credentials as any;
        const agents2: DustAgent[] = c.agents ?? [];
        const apiUrl2 = dustApiUrl(c.region ?? "us-central1");
        const workspaceId2: string = c.workspaceId ?? "";
        const baseUrl2 = `${apiUrl2}/api/v1/w/${workspaceId2}`;
        const dustModels = agents2.map((agent) => ({
          provider: "dust",
          id: agent.sId,
          name: agent.name,
          api: "dust" as any,
          baseUrl: baseUrl2,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 8_000,
          headers: { ...DUST_HEADERS },
        }));
        return [...(models as any[]).filter((m: any) => m.provider !== "dust"), ...dustModels];
      },
    },
    models: agents.map((agent) => ({
      id: agent.sId,
      name: agent.name,
      api: "dust" as any,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
      headers: { ...DUST_HEADERS },
    })),
  });
}

async function loginFn(callbacks: any) {
  const { onAuth, onProgress, onPrompt, signal } = callbacks;

  // Step 1: Request device code
  const deviceRes = await fetch(
    `https://${WORKOS_DOMAIN}/user_management/authorize/device`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: WORKOS_CLIENT_ID,
        scope: "openid profile email",
      }),
      signal,
    }
  );

  if (!deviceRes.ok) {
    throw new Error(`Device code request failed: ${deviceRes.status}`);
  }

  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Notify caller with auth URL
  onAuth({
    url: device.verification_uri_complete,
    instructions: `Enter code ${device.user_code} at ${device.verification_uri}`,
  });

  // Step 3: Poll for token
  const interval = Math.max(1, device.interval);
  const maxAttempts = Math.floor(device.expires_in / interval);
  let attempts = 0;
  let tokenData: { access_token: string; refresh_token: string; expires_in: number } | null = null;

  while (attempts < maxAttempts) {
    if (signal?.aborted) throw new Error("Authentication aborted");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval * 1000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Authentication aborted"));
      });
    });

    const pollRes = await fetch(
      `https://${WORKOS_DOMAIN}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: WORKOS_CLIENT_ID,
        }),
        signal,
      }
    );

    const pollData = (await pollRes.json()) as any;

    if ("error" in pollData) {
      if (pollData.error === "authorization_pending") {
        onProgress?.("Waiting for browser authorization…");
        attempts++;
      } else if (pollData.error === "slow_down") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        attempts++;
      } else {
        throw new Error(
          `Authentication error: ${pollData.error_description || pollData.error}`
        );
      }
    } else {
      tokenData = pollData;
      break;
    }
  }

  if (!tokenData) {
    throw new Error("Authentication timed out");
  }

  // Step 4: Decode JWT to get region
  let region = "us-central1";
  try {
    const payload = decodeJwtPayload(tokenData.access_token);
    const r = payload[REGION_CLAIM];
    if (typeof r === "string") region = r;
  } catch {
    // use default region
  }

  const apiUrl = dustApiUrl(region);

  // Step 5: Fetch workspaces
  const meRes = await fetch(`${apiUrl}/api/v1/me`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      ...DUST_HEADERS,
    },
    signal,
  });

  if (!meRes.ok) {
    throw new Error(`Failed to fetch workspaces: ${meRes.status}`);
  }

  const meData = (await meRes.json()) as {
    user: { workspaces: Workspace[] };
  };
  const workspaces = meData.user.workspaces;

  // Step 6: Display workspaces and prompt for selection
  const list = workspaces
    .map((ws, i) => `  ${i + 1}. ${ws.name} (${ws.role})`)
    .join("\n");
  onProgress?.(`Your workspaces:\n${list}`);

  const selection = await onPrompt({
    message: "Select workspace number:",
    placeholder: "1",
  });

  const idx = parseInt(selection, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= workspaces.length) {
    throw new Error("Invalid workspace selection");
  }

  const workspaceId = workspaces[idx].sId;

  // Step 7: Fetch agents for selected workspace
  const agentsRes = await fetch(
    `${apiUrl}/api/v1/w/${workspaceId}/assistant/agent_configurations`,
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        ...DUST_HEADERS,
      },
      signal,
    }
  );

  const agentsData = agentsRes.ok ? ((await agentsRes.json()) as any) : { agentConfigurations: [] };
  const agents: DustAgent[] = agentsData.agentConfigurations ?? [];

  // Step 8: Return credentials (with workspaces and agents for later use)
  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 30_000,
    workspaceId,
    workspaces,
    agents,
    region,
  };
}

async function refreshToken(credentials: any) {
  const res = await fetch(
    `https://${WORKOS_DOMAIN}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: WORKOS_CLIENT_ID,
        refresh_token: credentials.refresh as string,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    ...credentials,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 30_000,
  };
}

export default function (pi: ExtensionAPI) {
  // Register the OAuth provider and streamSimple without models on initial load.
  // The session_start handler will re-register with explicit models if credentials exist.
  pi.registerProvider("dust", {
    api: "dust" as any,
    streamSimple: (_model: unknown, _context: unknown, _options?: unknown) => dustMockStream() as any,
    oauth: {
      name: "Dust",
      login: async (callbacks) => {
        const cred = await loginFn(callbacks);
        // Re-register immediately after login so models appear without a restart.
        buildDustProviderConfig(pi, cred);
        return cred;
      },
      refreshToken,
      getApiKey: (credentials) => credentials.access as string,
      modifyModels: (models, credentials) => {
        // Fallback: called by the registry on initial load when credentials exist.
        const cred = credentials as any;
        const agents: DustAgent[] = cred.agents ?? [];
        const apiUrl = dustApiUrl(cred.region ?? "us-central1");
        const workspaceId: string = cred.workspaceId ?? "";
        const baseUrl = `${apiUrl}/api/v1/w/${workspaceId}`;
        const dustModels = agents.map((agent) => ({
          provider: "dust",
          id: agent.sId,
          name: agent.name,
          api: "dust" as any,
          baseUrl,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 8_000,
          headers: { ...DUST_HEADERS },
        }));
        return [...(models as any[]).filter((m: any) => m.provider !== "dust"), ...dustModels];
      },
    },
  });

  // On session start, re-register with explicit models so the registry's
  // refresh() path (which resets OAuth providers before calling loadModels)
  // still populates the model list correctly.
  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_start", (_event: unknown, ctx: any) => {
      const cred = ctx.modelRegistry.authStorage.get("dust");
      if (cred?.type === "oauth") {
        buildDustProviderConfig(pi, cred);
      }
    });
  }

  pi.registerCommand("workspace", {
    description: "Show current Dust workspace and switch between workspaces",
    handler: async (_args, ctx) => {
      const cred = ctx.modelRegistry.authStorage.get("dust") as any;

      if (!cred || !Array.isArray(cred.workspaces) || cred.workspaces.length === 0) {
        ctx.ui.notify("Not logged in to Dust. Run /login first.", "warning");
        return;
      }

      const workspaces: Workspace[] = cred.workspaces;
      const current = workspaces.find((ws) => ws.sId === cred.workspaceId);
      const currentName = current?.name ?? cred.workspaceId;

      const options = workspaces.map(workspaceLabel);
      const selected = await ctx.ui.select(
        `Current workspace: ${currentName}`,
        options,
        {}
      );

      if (!selected) return;

      const picked = workspaces.find((ws) => workspaceLabel(ws) === selected);
      if (!picked || picked.sId === cred.workspaceId) return;

      ctx.modelRegistry.authStorage.set("dust", { ...cred, workspaceId: picked.sId });
      ctx.ui.notify(`Switched to workspace: ${picked.name}`, "info");
    },
  });
}
