import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import type { McpToolArgs } from "./dust-types.js";
import { errorMessage } from "./dust-validation.js";

export const MCP_TOOLS = [
  {
    name: "bash",
    description:
      "Execute a bash command on the user's machine. Returns stdout and stderr. Use for running commands, scripts, and shell operations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description:
      "Read the contents of a file on the user's machine. Supports offset and limit for large files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a file on the user's machine by replacing an exact string. Fails if oldText is not found.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        oldText: { type: "string", description: "Exact text to find and replace" },
        newText: { type: "string", description: "New text to replace the old text with" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
];

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface CommandExecutionError extends Error {
  stdout?: string;
  stderr?: string;
}

function executeBash(args: McpToolArgs): McpToolResult {
  const command = String(args.command ?? "");
  const timeoutSecs = typeof args.timeout === "number" ? args.timeout : undefined;
  try {
    const stdout = execSync(command, {
      timeout: timeoutSecs !== undefined ? timeoutSecs * 1000 : undefined,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { content: [{ type: "text", text: stdout }], isError: false };
  } catch (err: unknown) {
    const execError = err as CommandExecutionError;
    const output = [execError.stdout, execError.stderr].filter(Boolean).join("\n") || errorMessage(err);
    return { content: [{ type: "text", text: output }], isError: true };
  }
}

function executeRead(args: McpToolArgs): McpToolResult {
  const filePath = String(args.path ?? "");
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const offset = typeof args.offset === "number" ? args.offset - 1 : 0;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const sliced = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
    return { content: [{ type: "text", text: sliced.join("\n") }], isError: false };
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Error reading file: ${errorMessage(err)}` }], isError: true };
  }
}

function executeEdit(args: McpToolArgs): McpToolResult {
  const filePath = String(args.path ?? "");
  const oldText = String(args.oldText ?? "");
  const newText = String(args.newText ?? "");
  try {
    const content = readFileSync(filePath, "utf8");
    if (!content.includes(oldText)) {
      return {
        content: [{ type: "text", text: `Error: oldText not found in ${filePath}` }],
        isError: true,
      };
    }
    const updated = content.replace(oldText, newText);
    writeFileSync(filePath, updated, "utf8");
    return { content: [{ type: "text", text: `Successfully edited ${filePath}` }], isError: false };
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Error editing file: ${errorMessage(err)}` }], isError: true };
  }
}

export function executeMcpTool(name: string, args: McpToolArgs): McpToolResult {
  switch (name) {
    case "bash":
      return executeBash(args);
    case "read":
      return executeRead(args);
    case "edit":
      return executeEdit(args);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

export function buildConfirmMessage(toolName: string, args: McpToolArgs): string {
  switch (toolName) {
    case "bash":
      return String(args.command ?? "");
    case "read": {
      const parts = [String(args.path ?? "")];
      if (args.offset != null) parts.push(`offset: ${args.offset}`);
      if (args.limit != null) parts.push(`limit: ${args.limit}`);
      return parts.join("  ");
    }
    case "edit": {
      const path = String(args.path ?? "");
      const oldText = String(args.oldText ?? "");
      const newText = String(args.newText ?? "");
      const preview = (value: string) => value.length > 80 ? value.slice(0, 77) + "..." : value;
      return `${path}\n- ${preview(oldText)}\n+ ${preview(newText)}`;
    }
    default:
      return JSON.stringify(args);
  }
}
