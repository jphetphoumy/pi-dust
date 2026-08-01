import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_TIMEOUT_MS } from "./dust-constants.js";
import type { McpToolArgs } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Dust reads `_meta.dust.timeoutMs` per tool and overrides its 3-minute
   * default MCP request timeout. Without it, a slow local approval dialog
   * times the call out on Dust's side before the tool ever runs.
   */
  _meta: { dust: { timeoutMs: number } };
}

/**
 * The tools Dust may call are pi's own built-in tools, not reimplementations.
 *
 * pi exports its tool definitions as factories, each returning the same
 * `ToolDefinition` the pi agent uses itself: description, TypeBox `parameters`
 * (already JSON Schema, so it drops straight into MCP `inputSchema`), and
 * `execute`. Wrapping them means Dust sees exactly what pi offers, behaviour
 * cannot drift from pi's, and we inherit pi's path handling, truncation and
 * output limits for free.
 */
const TOOL_FACTORIES = [
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
] as const;

type AnyToolDefinition = ToolDefinition<never, unknown, unknown>;

let cachedCwd: string | null = null;
let cachedDefinitions: AnyToolDefinition[] = [];

function toolDefinitions(cwd: string): AnyToolDefinition[] {
  if (cachedCwd !== cwd) {
    cachedDefinitions = TOOL_FACTORIES.map(
      (factory) => factory(cwd) as unknown as AnyToolDefinition,
    );
    cachedCwd = cwd;
  }
  return cachedDefinitions;
}

function currentCwd(ctx?: ExtensionContext): string {
  return ctx?.cwd ?? process.cwd();
}

/**
 * The built-in tools to advertise, given pi's current active tool set.
 *
 * `activeToolNames === null` means pi's registry could not be read at all (no
 * extension handle bound yet, a host without `getActiveTools`, or a stale
 * extension runner) — not "no tools are active". The full catalogue is
 * advertised in that case, which is the behaviour that predates this filter.
 * An *empty array* is different and is honoured literally: the user really
 * did turn everything off.
 *
 * Names pi reports that this extension cannot run (tools contributed by other
 * extensions) are dropped: `executeMcpTool` only knows the factories above,
 * so advertising them would hand Dust tools that always answer "Unknown
 * tool". Surfacing those is tracked separately (issue #52).
 *
 * Filters the array `toolDefinitions` returns rather than writing back into
 * it — `cachedDefinitions` is shared across every caller for a given cwd, so
 * mutating it would poison the next unfiltered call.
 */
function activeDefinitions(
  cwd: string,
  activeToolNames: readonly string[] | null,
): AnyToolDefinition[] {
  const definitions = toolDefinitions(cwd);
  if (activeToolNames === null) return definitions;
  const active = new Set(activeToolNames);
  return definitions.filter((definition) => active.has(definition.name));
}

/**
 * Tool catalogue advertised to Dust in response to `tools/list`, and — more
 * importantly — at MCP server registration, which is the only time Dust
 * actually reads it (see the re-registration note in dust-stream-provider.ts).
 */
export function getMcpTools(
  ctx?: ExtensionContext,
  activeToolNames: readonly string[] | null = null,
): McpToolSpec[] {
  return activeDefinitions(currentCwd(ctx), activeToolNames).map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters as unknown as Record<string, unknown>,
    _meta: { dust: { timeoutMs: MCP_TOOL_TIMEOUT_MS } },
  }));
}

/**
 * Names of the tools `getMcpTools` would advertise for this active set — the
 * catalogue Dust would receive, reduced to its identity. This, not pi's raw
 * active list, is what dust-stream-provider.ts's turn-boundary diff compares:
 * a tool registered by another extension changes pi's list without changing
 * anything Dust can see, and must not cost a re-registration.
 */
export function advertisedToolNames(
  activeToolNames: readonly string[] | null,
  ctx?: ExtensionContext,
): string[] {
  return activeDefinitions(currentCwd(ctx), activeToolNames).map((definition) => definition.name);
}

function findDefinition(name: string, ctx?: ExtensionContext): AnyToolDefinition | undefined {
  return toolDefinitions(currentCwd(ctx)).find((definition) => definition.name === name);
}

/** pi's definition for a tool, used to reuse its native TUI renderers. */
export function getToolDefinition(name: string, cwd: string): AnyToolDefinition | undefined {
  return toolDefinitions(cwd).find((definition) => definition.name === name);
}

/**
 * Runs a Dust tool call through pi's own tool implementation.
 *
 * pi tools signal failure by throwing, and return content blocks that may
 * include images; MCP results here are text, so non-text blocks are dropped.
 */
export async function executeMcpTool(
  name: string,
  args: McpToolArgs,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const definition = findDefinition(name, ctx);
  if (!definition) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await definition.execute(
      `dust-${name}-${Date.now()}`,
      args as never,
      signal,
      undefined,
      ctx,
    );

    const text = (result.content ?? [])
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("\n");

    return { content: [{ type: "text", text }], isError: false };
  } catch (err: unknown) {
    return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
  }
}

/**
 * Approval prompt body. pi renders tool calls with `renderCall`, but that
 * produces a TUI Component and the Dust approval gate is a plain confirm
 * dialog, so the most useful arguments are summarised as text instead.
 */
export function buildConfirmMessage(toolName: string, args: McpToolArgs): string {
  const preview = (value: unknown, max = 200): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return "";
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  };

  switch (toolName) {
    case "bash":
      return String(args.command ?? "");
    case "read":
    case "ls":
      return preview(args.path ?? args.dir ?? "");
    case "write": {
      const content = String(args.content ?? "");
      const lineCount = content === "" ? 0 : content.split("\n").length;
      return `${String(args.path ?? "")}  (${lineCount} lines, ${content.length} bytes)\n${preview(content)}`;
    }
    case "edit":
      return `${String(args.path ?? "")}\n- ${preview(args.oldText ?? args.old_text, 80)}\n+ ${preview(args.newText ?? args.new_text, 80)}`;
    case "grep":
    case "find":
      return preview(args.pattern ?? args.query ?? JSON.stringify(args));
    default:
      return JSON.stringify(args);
  }
}
