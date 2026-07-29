import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { slugify } from "./dust-auth.js";
import type { DustAgent, DustCredentials } from "./dust-types.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  /** Dust agent slug the subagent runs as, i.e. `slugify(dustAgent.name)`. */
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    // name and description are what the Dust agent picks from, so a file
    // missing either is unusable rather than partially usable.
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool: string) => tool.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  for (;;) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Subagent definitions, discovered fresh on every call so an agent file can be
 * edited mid-session.
 *
 * Project-local agents are repo-controlled prompts that can tell a model to run
 * bash, so they stay opt-in: the default scope is user-only.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  // Project agents deliberately win on a name clash under "both": the closer
  // definition is the more specific one.
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; ");
}

/** Dust agent slugs the workspace exposes, in the same form the provider registers. */
export function availableDustModels(credentials: DustCredentials | null): string[] {
  const agents: DustAgent[] = credentials?.agents ?? [];
  return agents.map((agent) => slugify(agent.name));
}

export type ModelResolution = { spec: string } | { error: string };

/**
 * The `--model` argument for a subagent's child process.
 *
 * Subagents always run as Dust agents, so an agent file's `model:` is a Dust
 * agent slug, not a pi model id. With no `model:`, the subagent inherits
 * whichever Dust agent is driving the parent session.
 */
export function resolveDustModelSpec(
  agent: AgentConfig,
  credentials: DustCredentials | null,
  fallbackModelId: string | null,
): ModelResolution {
  const available = availableDustModels(credentials);

  if (!agent.model) {
    if (!fallbackModelId) {
      return {
        error:
          `Agent "${agent.name}" declares no model: and the current session is not running a Dust ` +
          `agent, so there is nothing to inherit. Add a model: field. Available Dust agents: ` +
          `${available.join(", ") || "none"}.`,
      };
    }
    return { spec: `dust/${fallbackModelId}` };
  }

  // An empty catalogue means credentials have not loaded yet; refusing here
  // would be a worse failure than letting pi resolve the slug itself.
  if (available.length > 0 && !available.includes(agent.model)) {
    return {
      error:
        `Agent "${agent.name}" requests Dust agent "${agent.model}", which this workspace does not ` +
        `expose. Available Dust agents: ${available.join(", ") || "none"}.`,
    };
  }

  return { spec: `dust/${agent.model}` };
}
