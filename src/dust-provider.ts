import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import { DUST_HEADERS } from "./dust-constants.js";
import { dustApiUrl, loginFn, refreshToken, slugify } from "./dust-auth.js";
import type { DustAgent, DustCredentials, DustModel, LoginCallbacks, StreamContextLike, StreamOptionsLike } from "./dust-types.js";

export type DustProviderModel = Model<Api> & { sId: string };

function buildProviderBaseUrl(credentials: DustCredentials): string {
  const apiUrl = dustApiUrl(credentials.region ?? "us-central1");
  const workspaceId = credentials.workspaceId ?? "";
  return `${apiUrl}/api/v1/w/${workspaceId}`;
}

function buildRegisteredModels(credentials: DustCredentials) {
  const agents: DustAgent[] = credentials.agents ?? [];

  return agents.map((agent) => ({
    id: slugify(agent.name),
    sId: agent.sId,
    name: agent.name,
    api: "dust" as Api,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    headers: { ...DUST_HEADERS },
  }));
}

export function buildOAuthDustModels(credentials: OAuthCredentials): DustProviderModel[] {
  const cred = credentials as DustCredentials;
  const agents: DustAgent[] = cred.agents ?? [];
  const baseUrl = buildProviderBaseUrl(cred);

  return agents.map((agent) => ({
    provider: "dust",
    id: slugify(agent.name),
    sId: agent.sId,
    name: agent.name,
    api: "dust" as Api,
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    headers: { ...DUST_HEADERS },
  }));
}

export function registerDustProvider(
  pi: ExtensionAPI,
  credentials: DustCredentials,
  streamSimple: (
    cred: DustCredentials,
    model: DustModel,
    context: StreamContextLike,
    options?: StreamOptionsLike,
  ) => unknown,
  onLogin?: (cred: DustCredentials) => Promise<void> | void,
): void {
  const hasWorkspace = Boolean(credentials.workspaceId);
  const models = buildRegisteredModels(credentials);
  const providerConfig: Record<string, unknown> = {
    api: "dust" as any,
    streamSimple: (model: unknown, context: unknown, options?: unknown) =>
      streamSimple(
        credentials,
        model as DustModel,
        context as StreamContextLike,
        options as StreamOptionsLike | undefined,
      ) as any,
    oauth: {
      name: "Dust",
      login: async (callbacks: LoginCallbacks) => {
        const cred = await loginFn(callbacks);
        await onLogin?.(cred);
        return cred;
      },
      refreshToken: async (cred: OAuthCredentials) => refreshToken(cred as DustCredentials),
      getApiKey: (cred: OAuthCredentials) => (cred as DustCredentials).access ?? "",
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const dustModels = buildOAuthDustModels(cred);
        return [...models.filter((entry) => entry.provider !== "dust"), ...dustModels];
      },
    },
  };

  if (hasWorkspace) {
    providerConfig.baseUrl = buildProviderBaseUrl(credentials);
  }

  if (hasWorkspace && models.length > 0) {
    providerConfig.models = models;
  }

  pi.registerProvider("dust", providerConfig as Parameters<ExtensionAPI["registerProvider"]>[1]);
}
