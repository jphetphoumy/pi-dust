import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  availableDustModels,
  discoverAgents,
  formatAgentList,
  resolveDustModelSpec,
} from "../src/dust-subagent-agents.js";
import { agentDir, useTempAgentDir } from "./helpers/dust-fixtures.js";

function writeAgent(dir: string, fileName: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), contents, "utf8");
}

function agentFile(fields: Record<string, string>, body: string): string {
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const projectDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-dust-project-"));
  projectDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (projectDirs.length > 0) {
    rmSync(projectDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("subagent discovery", () => {
  useTempAgentDir();

  it("reads name, description, tools and model from frontmatter", () => {
    writeAgent(
      join(agentDir(), "agents"),
      "scout.md",
      agentFile(
        { name: "scout", description: "Fast recon", tools: "read, grep , ls", model: "my-agent" },
        "You are a scout.",
      ),
    );

    const { agents } = discoverAgents(makeProjectDir(), "user");

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "scout",
      description: "Fast recon",
      tools: ["read", "grep", "ls"],
      model: "my-agent",
      source: "user",
    });
    expect(agents[0].systemPrompt).toContain("You are a scout.");
  });

  it("skips files missing name or description", () => {
    const dir = join(agentDir(), "agents");
    writeAgent(dir, "no-name.md", agentFile({ description: "orphan" }, "body"));
    writeAgent(dir, "no-desc.md", agentFile({ name: "orphan" }, "body"));
    writeAgent(dir, "not-markdown.txt", "name: nope");

    expect(discoverAgents(makeProjectDir(), "user").agents).toEqual([]);
  });

  it("returns no agents when the user directory does not exist", () => {
    expect(discoverAgents(makeProjectDir(), "user").agents).toEqual([]);
  });

  it("ignores project agents unless the scope opts in", () => {
    writeAgent(
      join(agentDir(), "agents"),
      "scout.md",
      agentFile({ name: "scout", description: "user scout" }, "user body"),
    );
    const project = makeProjectDir();
    writeAgent(
      join(project, ".pi", "agents"),
      "local.md",
      agentFile({ name: "local", description: "project only" }, "project body"),
    );

    const userScope = discoverAgents(project, "user");
    expect(userScope.agents.map((agent) => agent.name)).toEqual(["scout"]);
    // The directory is still reported so a caller can name it in a warning.
    expect(userScope.projectAgentsDir).toBe(join(project, ".pi", "agents"));

    const bothScope = discoverAgents(project, "both");
    expect(bothScope.agents.map((agent) => agent.name).sort()).toEqual(["local", "scout"]);

    const projectScope = discoverAgents(project, "project");
    expect(projectScope.agents.map((agent) => agent.name)).toEqual(["local"]);
  });

  it("lets a project agent shadow a user agent of the same name under both", () => {
    writeAgent(
      join(agentDir(), "agents"),
      "scout.md",
      agentFile({ name: "scout", description: "user scout" }, "user body"),
    );
    const project = makeProjectDir();
    writeAgent(
      join(project, ".pi", "agents"),
      "scout.md",
      agentFile({ name: "scout", description: "project scout" }, "project body"),
    );

    const { agents } = discoverAgents(project, "both");

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ source: "project", description: "project scout" });
  });

  it("finds a project agents directory in an ancestor of the cwd", () => {
    const project = makeProjectDir();
    writeAgent(
      join(project, ".pi", "agents"),
      "local.md",
      agentFile({ name: "local", description: "project only" }, "body"),
    );
    const nested = join(project, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(discoverAgents(nested, "project").agents.map((agent) => agent.name)).toEqual(["local"]);
  });

  it("summarises agents for the tool description", () => {
    expect(formatAgentList([])).toBe("none");
    expect(
      formatAgentList([
        {
          name: "scout",
          description: "Fast recon",
          systemPrompt: "",
          source: "user",
          filePath: "/x",
        },
      ]),
    ).toBe("scout (user): Fast recon");
  });
});

describe("subagent model resolution", () => {
  const credentials = {
    type: "oauth" as const,
    access: "",
    refresh: "",
    expires: 0,
    agents: [
      { sId: "a1", name: "Code Scout", description: "" },
      { sId: "a2", name: "Planner", description: "" },
    ],
  };

  const agent = {
    name: "scout",
    description: "Fast recon",
    systemPrompt: "",
    source: "user" as const,
    filePath: "/x",
  };

  it("lists workspace agents as provider slugs", () => {
    expect(availableDustModels(credentials)).toEqual(["code-scout", "planner"]);
    expect(availableDustModels(null)).toEqual([]);
  });

  it("resolves a declared model to a dust provider spec", () => {
    const result = resolveDustModelSpec({ ...agent, model: "planner" }, credentials, null);

    expect(result).toEqual({ spec: "dust/planner" });
  });

  it("rejects a model the workspace does not expose", () => {
    const result = resolveDustModelSpec({ ...agent, model: "ghost" }, credentials, null);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("code-scout");
  });

  it("inherits the session model when the agent declares none", () => {
    expect(resolveDustModelSpec(agent, credentials, "planner")).toEqual({ spec: "dust/planner" });
  });

  it("errors when there is no declared model and nothing to inherit", () => {
    const result = resolveDustModelSpec(agent, credentials, null);

    expect(result).toHaveProperty("error");
  });

  it("accepts any slug when the credential catalogue has not loaded", () => {
    // Refusing here would turn a transient empty catalogue into a hard failure;
    // pi resolves the slug itself when the child starts.
    expect(resolveDustModelSpec({ ...agent, model: "planner" }, null, null)).toEqual({
      spec: "dust/planner",
    });
  });
});
