import { CANCELLED_MESSAGE, CANCELLED_TOOL_MESSAGE, DUST_HEADERS, MCP_REGISTRATION_LOST_MESSAGE, MCP_TOOL_PREFIX, SESSION_EXPIRED_MESSAGE } from "./dust-constants.js";
import { dustApiUrl, refreshToken } from "./dust-auth.js";
import { debugLog } from "./dust-debug.js";
import { isAbortError, listenMcpRequests, registerMcpServer, startMcpHeartbeat } from "./dust-mcp.js";
import { createEventStream, findAgentMessageSId, isMissingAgentMessageError, makeEmptyMessage, streamEvents } from "./dust-stream.js";
import { advertisedToolNames, buildConfirmMessage, executeMcpTool, getMcpTools } from "./dust-tools.js";
import { appendToolEntry } from "./dust-tool-render.js";
import type { ChatMessageLike, DustCredentials, DustModel, StreamContextLike, StreamOptionsLike, ToolApproveExecutionEvent } from "./dust-types.js";
import { errorMessage, isRecord, parseConversationCreateResponse, parseConversationFetchResponse, parsePostMessageResponse } from "./dust-validation.js";
import { HOST_TOKEN_ASSUMED_TTL_MS, invalidateRuntimeCredentials, shouldRefreshAccessToken } from "./dust-runtime.js";
import type { ActiveDustTurn, DustSessionRuntime } from "./dust-runtime.js";
import { composeAgentsMd, ensureAgentsMd, POD_AGENTS_MD_MAX_CHARS } from "./dust-pod-agents-md.js";
import { podApiFor } from "./dust-pod-runtime.js";
import { buildPodSkillsListing, discoverLocalSkills, stripSkillsListing } from "./dust-pod-skills.js";
import { isEmptyReport, syncPod } from "./dust-pod-sync.js";
import { beginPodStatusTurn, podProgressReporter, refreshPodStatus } from "./dust-pod-status.js";
import { getPodBinding } from "./dust-state.js";

const STREAM_REFRESH_SKEW_MS = 30_000;
const CANCEL_REQUEST_TIMEOUT_MS = 10_000;
/** Grace for Dust to attach the agent message before the recovery re-reads. */
const AGENT_MESSAGE_RETRY_DELAY_MS = 500;

async function waitBeforeRetry(): Promise<true> {
  await new Promise((resolve) => setTimeout(resolve, AGENT_MESSAGE_RETRY_DELAY_MS));
  return true;
}

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_EXPIRED_MESSAGE;
}

function isRegistrationLostError(error: unknown): boolean {
  return error instanceof Error && error.message === MCP_REGISTRATION_LOST_MESSAGE;
}

function buildAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...DUST_HEADERS,
  };
}

/**
 * pi's currently active tool names, or null when the registry cannot be read.
 *
 * `getActiveTools()` itself is cheap and side-effect free, but three things
 * can make it unavailable, and none of them may take a turn down with it:
 * `runtime.pi` is null until the extension is bound, hosts older than the API
 * do not implement it at all, and pi's extension runner throws once the
 * extension handle is stale. Every one of those means "unknown", which
 * `activeDefinitions` (dust-tools.ts) treats as "advertise everything", never
 * as "advertise nothing".
 */
function readActiveToolNames(runtime: DustSessionRuntime): string[] | null {
  const pi = runtime.pi;
  if (!pi || typeof pi.getActiveTools !== "function") return null;
  try {
    const names = pi.getActiveTools();
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : null;
  } catch (err) {
    debugLog("dust:mcp", "Could not read pi's active tools", { error: errorMessage(err) });
    return null;
  }
}

/** The catalogue Dust would be handed right now, or null if pi cannot be read. */
function currentAdvertisedTools(runtime: DustSessionRuntime): string[] | null {
  const active = readActiveToolNames(runtime);
  return active === null ? null : advertisedToolNames(active, runtime.extensionContext as never);
}

function extractMessageText(message: ChatMessageLike): string {
  const rawContent = message.content ?? "";
  // Multiple text blocks (dust-stream.ts splits one whenever the
  // classification switches between `tokens`, `chain_of_thought` and the
  // delimiters) join with no separator: if a break ever lands on that
  // boundary it isn't reinstated. Left as-is rather than guessing at one.
  return Array.isArray(rawContent)
    ? rawContent.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
    : String(rawContent);
}

function extractUserText(context: StreamContextLike): string {
  const messages = context?.messages ?? [];
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  return lastUserMessage ? extractMessageText(lastUserMessage) : "";
}

function extractSystemPrompt(context: StreamContextLike): string {
  return context?.systemPrompt ?? "";
}

/**
 * Steers the agent towards the local tools.
 *
 * Dust ships an internal `files` MCP server whose `files__create` / `files__edit`
 * tools write to the conversation's own storage — that is what produces a
 * download link instead of a file on disk. Those run server-side and never reach
 * our MCP server, and the message API exposes no way to disable or redirect
 * them, so the only lever is telling the agent which tool to reach for.
 */
function buildToolGuidance(cwd: string): string {
  return [
    "Tool usage rules for this session:",
    `- You are driving a CLI on the user's own machine, working directory: ${cwd}.`,
    `- Files the user asks for are LOCAL files. Always use the \`${MCP_TOOL_PREFIX}__*\` tools:`,
    `  \`${MCP_TOOL_PREFIX}__write\` to create or overwrite, \`${MCP_TOOL_PREFIX}__edit\` to modify,`,
    `  \`${MCP_TOOL_PREFIX}__read\` to read, \`${MCP_TOOL_PREFIX}__bash\` to run commands.`,
    "- NEVER use `files__create`, `files__edit` or any other `files__*` tool for the user's files:",
    "  those write to Dust conversation storage, not to the user's machine, and the user cannot use them.",
    "- Do not create files with bash heredocs; use the write tool.",
  ].join("\n");
}

/**
 * The pod-mode counterpart of `buildToolGuidance`, and a deliberate inversion
 * of it.
 *
 * With the project ingested into a Pod, the same files are reachable two ways:
 * through our MCP server (3 AWU per call, billed as an external server) or
 * through Dust's internal `files__*` toolset against the pod mount (free). The
 * agent has to be told to prefer the free path, or the ingest buys nothing.
 *
 * `bash` stays local — it is the one thing the pod sandbox cannot do, since the
 * user's toolchain, dependencies and environment live on their machine. We sync
 * the tree down before each bash call so it sees the agent's edits, and back up
 * afterwards so anything the command wrote is in the pod before the agent reads
 * it. Both halves are stated here because the agent cannot infer them: told
 * nothing, it treats a scaffolder's output as lost and redoes the work with the
 * billed write tool.
 */
function buildPodToolGuidance(cwd: string, podId: string): string {
  return [
    "Tool usage rules for this session:",
    `- You are driving a CLI on the user's machine, working directory: ${cwd}.`,
    `- The user's project is mounted in your sandbox at \`/files/pod-${podId}\`.`,
    "- To read, search, create or modify the user's project files, ALWAYS use the `files__*` tools",
    `  against that mount (\`files__cat\`, \`files__edit\`, \`files__create\`, \`files__grep\`, \`files__list\`).`,
    "  Edits there are synced back to the user's machine automatically.",
    `- Use \`${MCP_TOOL_PREFIX}__bash\` ONLY to run commands (tests, builds, git). It executes on the`,
    "  user's real machine and already sees your `files__*` edits.",
    "- Files a command creates appear in the pod as soon as it finishes — a scaffolder like",
    "  `ansible-galaxy role init` is yours to read and edit with `files__*` straight away.",
    "- Directories exist only through their files: create a file at the path you want and the",
    "  directory follows. An empty one cannot be represented and will not show up.",
    `- Do NOT use \`${MCP_TOOL_PREFIX}__read\`, \`${MCP_TOOL_PREFIX}__write\` or \`${MCP_TOOL_PREFIX}__edit\`:`,
    "  they cost the user credits that the `files__*` tools do not.",
  ].join("\n");
}

/**
 * Pod syncs are best-effort on purpose.
 *
 * A sync failure means the two copies drifted, which is worth telling the user
 * about, but it is not a reason to fail a turn that otherwise worked — the
 * agent's answer is still valid and the next sync will reconcile. Throwing here
 * would turn a transient 500 on a file listing into a lost turn.
 */
async function syncPodQuietly(
  runtime: DustSessionRuntime,
  cwd: string,
  options: { push?: boolean; pull?: boolean },
  phase: string,
): Promise<void> {
  // Re-read the binding at every sync point rather than reusing one captured
  // at the top of the turn. `seen` is a watermark that each sync advances, and
  // a turn can run several: a mid-turn pull before bash, then the post-turn
  // pull. Handing the later one a stale snapshot makes it compare the pod
  // against watermarks that predate its own earlier pull, so a file it already
  // reconciled reads as changed on both sides and is reported as a conflict.
  const binding = getPodBinding(cwd);
  if (!binding) return;

  try {
    const report = await syncPod(podApiFor(runtime), cwd, binding, {
      ...options,
      onProgress: podProgressReporter(runtime, binding.name),
    });
    if (!isEmptyReport(report)) {
      debugLog("dust:pod", `Pod sync ${phase}`, report);
    }
    // Counts go to the footer rather than the transcript; only the things that
    // name a file and want the user to act stay as printed lines.
    refreshPodStatus(runtime, cwd, report);
    // A skill the agent wrote for itself now loads into this project next
    // session, which is a change to the user's setup rather than to their
    // files — it is named, with its location, rather than left to a counter.
    for (const name of report.adopted) {
      console.error(
        `[dust] adopted agent skill "${name}" → .pi/skills/${name}/ (loads next session)`,
      );
    }
    for (const rel of report.conflicted) {
      console.error(`[dust] pod conflict, left untouched: ${rel}`);
    }
    for (const { rel, reason } of report.skipped) {
      console.error(`[dust] pod skipped ${rel}: ${reason}`);
    }
    // A skill synced from a shared home (~/.agents/skills) writes back there,
    // changing the skill for every project on the machine — named explicitly,
    // like an adoption, rather than left as just a number in the pulled count.
    for (const [rel, target] of Object.entries(report.skillWritesOutsideRoot ?? {})) {
      console.error(`[dust] pod edit for synced skill written outside the project: ${rel} → ${target}`);
    }
  } catch (err) {
    console.error(`[dust] pod sync ${phase} failed: ${errorMessage(err)}`);
  }
}

/**
 * Moves the session's instructions into the pod's AGENTS.md.
 *
 * Dust injects that file as agent instructions and keeps it as a per-pod stable
 * prompt prefix, so it can be cached across conversations — which a 7 kB
 * preamble prepended to every new conversation's first user message cannot be.
 *
 * pi's own skills block is stripped and replaced with one naming only the
 * skills `/dust-skills` put in the pod, pointing at the sandbox mount. Two
 * reasons: the agent can then read a skill with the free `files__*` tools rather
 * than our billed `read`, and dropping the unselected skills is what keeps the
 * whole file under Dust's 8 kB cap.
 *
 * Returns false when the instructions could not be installed — over the cap, or
 * the upload failed — leaving the caller to send them in-message as before. A
 * failure here must not cost the user their turn.
 */
async function installPodInstructions(
  runtime: DustSessionRuntime,
  cwd: string,
  basePrompt: string,
  toolGuidance: string,
): Promise<boolean> {
  const binding = getPodBinding(cwd);
  if (!binding) return false;

  const selected = binding.skills ?? [];
  // Skill discovery stats a whole tree, so it is skipped when nothing is synced.
  const skills = selected.length === 0
    ? []
    : discoverLocalSkills(cwd).filter((skill) => selected.includes(skill.name));

  const content = composeAgentsMd({
    basePrompt: stripSkillsListing(basePrompt),
    toolGuidance,
    skillsListing: buildPodSkillsListing(skills, binding.podId),
  });

  try {
    const installed = await ensureAgentsMd(podApiFor(runtime), cwd, binding, content);
    if (!installed) {
      console.error(
        `[dust] instructions are ${content.length} chars, over Dust's ${POD_AGENTS_MD_MAX_CHARS} ` +
          "pod limit — sending them in the message instead. Sync fewer skills to fit.",
      );
    }
    return installed;
  } catch (err) {
    console.error(`[dust] could not write pod instructions: ${errorMessage(err)}`);
    return false;
  }
}

const syncPodBeforeTurn = (runtime: DustSessionRuntime, cwd: string) => {
  // The footer reports per turn, so the running totals start over here.
  beginPodStatusTurn();
  return syncPodQuietly(runtime, cwd, { push: true, pull: false }, "before turn");
};

const syncPodAfterTurn = (runtime: DustSessionRuntime, cwd: string) =>
  syncPodQuietly(runtime, cwd, { push: false, pull: true }, "after turn");

function buildConversationContext(username: string, timezone: string, runtime: DustSessionRuntime) {
  return {
    username,
    timezone,
    origin: "cli",
    clientSideMCPServerIds: runtime.mcpServerId ? [runtime.mcpServerId] : null,
  };
}

async function ensureMcpServer(
  runtime: DustSessionRuntime,
  baseUrl: string,
  authHeaders: Record<string, string>,
  refreshAuth: () => Promise<boolean>,
): Promise<void> {
  // A no-op whenever a registration is already live — which is exactly what
  // makes `dustRealStream`'s pre-call to `runtime.clearMcpState()` meaningful:
  // clearing `mcpServerId` there is the only way to make this fall through
  // and register a fresh catalogue after pi's active tool set changes.
  if (runtime.mcpServerId) {
    return;
  }

  const serverId = await registerMcpServer(baseUrl, authHeaders);
  runtime.mcpServerId = serverId;

  // The listener and heartbeat outlive the access token that registered the
  // server, so they must not close over the headers used above. Go through
  // the single `currentAccessToken()` accessor (prefers a freshly refreshed
  // in-memory token, with its own expiry, over storage — see its doc on
  // DustSessionRuntime) and fall back to those headers only if nothing is
  // available at all.
  const getAuthHeaders = (): Record<string, string> => {
    const access = runtime.currentAccessToken();
    return access ? buildAuthHeaders(access) : authHeaders;
  };

  // Registration lapsed server-side (heartbeat got a 403/404, or the listener
  // reconnect did): nothing left to talk to. Clear the runtime's MCP state so
  // the next turn's ensureMcpServer call re-registers and reconnects, instead
  // of short-circuiting on a dead `mcpServerId` forever.
  //
  // This callback is bound to `serverId` from this specific registration. A
  // stale beat can still be in flight after a newer registration replaced
  // this one (heartbeat A's fetch resolves after listener A already lost its
  // registration and a fresh B took over) — without the identity check, A's
  // late callback would tear down B's live server mid-turn.
  const onRegistrationLost = (): void => {
    if (runtime.mcpServerId !== serverId) {
      debugLog("dust:mcp", "Ignoring registration-lost signal from a superseded MCP heartbeat", { serverId });
      return;
    }
    debugLog("dust:mcp", "MCP registration lost, clearing runtime state for re-registration");
    runtime.clearMcpState();
  };

  runtime.mcpHeartbeatTimer = startMcpHeartbeat(baseUrl, getAuthHeaders, serverId, refreshAuth, onRegistrationLost);
  runtime.createApprovalGate();

  const abortController = new AbortController();
  runtime.mcpRequestsAbortController = abortController;
  listenMcpRequests({
    baseUrl,
    getAuthHeaders,
    refreshAuth,
    serverId,
    abortController,
    buildConfirmMessage,
    getTools: () => {
      const tools = getMcpTools(runtime.extensionContext as never, readActiveToolNames(runtime));
      // The one moment we know, for certain, what Dust is about to cache —
      // see `recordAdvertisedTools`'s doc for why this is more trustworthy
      // than the turn-boundary diff's own prediction.
      runtime.recordAdvertisedTools(tools.map((tool) => tool.name));
      return tools;
    },
    // Fails open (true) when pi's active tools cannot be read — an
    // unreadable registry must not disable every tool, the same fallback the
    // advertised catalogue itself uses. Checked by the listener before the
    // approval prompt, ahead of `preApprovedActions`: gating inside
    // `executeMcpTool` below would run after a pre-approval was already
    // popped for this call, positionally misapplying it to whatever request
    // comes next.
    isToolActive: (name: string) => {
      const active = readActiveToolNames(runtime);
      return active === null || advertisedToolNames(active, runtime.extensionContext as never).includes(name);
    },
    executeMcpTool: async (name, args) => {
      // Second line of defence behind the listener's own check: the turn can be
      // cancelled while a tool sits at the approval prompt, and running it then
      // would touch the user's machine for a turn they just stopped.
      if (runtime.isTurnCancelled()) {
        debugLog("dust:mcp", "Dropping tool call from a cancelled turn", { name });
        return { content: [{ type: "text", text: CANCELLED_TOOL_MESSAGE }], isError: true };
      }
      // In pod mode the agent edits files server-side, so the local tree is
      // stale until the post-turn pull. A command run mid-turn — `pytest`, a
      // build — would then execute against the old code and report a failure
      // the agent has already fixed. Pull first so bash sees current files.
      //
      // Only bash gets bracketed this way: it is the one tool that runs on the
      // real machine and can move the tree behind the pod's back. `read`/`edit`
      // already go through the pod, and syncing around them would walk the
      // whole tree for nothing on every call.
      const bashCwd = name === "bash"
        ? (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd()
        : null;
      if (bashCwd) {
        await syncPodQuietly(runtime, bashCwd, { push: false, pull: true }, "before bash");
      }
      const startedAt = Date.now();
      const result = await executeMcpTool(
        name,
        args,
        runtime.extensionContext as never,
        runtime.activeTurn?.toolAbortController.signal,
      );
      // The other half of the same problem. A command that *writes* — a
      // scaffolder like `ansible-galaxy role init myrole`, a codegen step,
      // `npm init` — leaves files the pod has never seen. Without a push here
      // they stay invisible until the next turn's pre-turn push, so the agent's
      // very next `files__list` comes back empty and it concludes the command
      // did nothing.
      //
      // Pushing before the result is returned is what makes the ordering hold:
      // the agent only learns the command finished once the pod already holds
      // everything the command produced. It runs regardless of exit status —
      // a build that fails after emitting sources still changed the tree, so
      // the exit code says nothing about whether there is anything to sync.
      if (bashCwd) {
        await syncPodQuietly(runtime, bashCwd, { push: true, pull: false }, "after bash");
      }
      // Dust tool calls bypass pi's tool pipeline, so nothing would appear in
      // the transcript. Record the call so it renders like a native one.
      if (runtime.pi) {
        appendToolEntry(
          runtime.pi,
          name,
          args,
          result,
          Date.now() - startedAt,
          (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd(),
        );
      }
      return result;
    },
    getConfirmFn: () => runtime.confirmFn,
    getPendingApprovalPromise: () => runtime.pendingApprovalPromise,
    preApprovedActions: runtime.preApprovedActions,
    isCancelledRequest: (requestId) => runtime.isCancelledRequest(requestId),
  }).catch((err) => {
    // Shutting the session down aborts the listener; that is not a failure.
    if (isAbortError(err, abortController.signal)) {
      debugLog("dust:mcp", "MCP listener stopped by abort");
      return;
    }
    // This listener is bound to `serverId` from its own registration. A later
    // turn's registration may have already superseded it (its own SSE 404
    // fired and cleared state, and a fresh one started) before this rejection
    // was handled — acting on a stale failure here would tear down the fresh
    // registration or invalidate still-valid credentials that belong to it.
    if (runtime.mcpServerId !== serverId) {
      debugLog("dust:mcp", "Ignoring failure from a superseded MCP listener", { serverId, error: String(err) });
      return;
    }

    if (isRegistrationLostError(err)) {
      // Self-healing: the next turn's ensureMcpServer re-registers, so this
      // is not a "fatal" condition worth logging as an error.
      debugLog("dust:mcp", "MCP registration lost, clearing runtime state for re-registration", { serverId });
      runtime.clearMcpState();
      return;
    }

    console.error(`[dust:mcp] listenMcpRequests fatal: ${err}`);
    // Session expired means the refresh attempted inside listenMcpRequests
    // already failed — only now is it safe to invalidate credentials and
    // force a re-login. invalidateRuntimeCredentials also clears MCP state.
    if (isSessionExpiredError(err)) {
      const credentials = runtime.sessionContext.getCredentials();
      if (credentials) {
        debugLog("dust:session", "MCP session expired after failed refresh, invalidating credentials in runtime context");
        invalidateRuntimeCredentials(runtime, credentials);
      } else {
        debugLog("dust:session", "Session expired but no credentials found in runtime context — clearing MCP state only");
        runtime.clearMcpState();
      }
      return;
    }
    // Any other unexpected terminal exit must not leave a dead
    // mcpServerId/heartbeat/abort controller behind — clear them so the next
    // turn re-registers instead of running toolless.
    runtime.clearMcpState();
  });
}

async function postValidateAction(
  baseUrl: string,
  authHeaders: Record<string, string>,
  conversationId: string,
  messageId: string,
  actionId: string,
  approved: boolean,
): Promise<void> {
  const url = `${baseUrl}/assistant/conversations/${conversationId}/messages/${messageId}/validate-action`;
  debugLog("dust:session", "Posting validate-action", { conversationId, messageId, actionId, approved, url });
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, approved: approved ? "approved" : "rejected" }),
  });
  if (!res.ok) {
    // A long approval wait can outlive the access token, and this can 401 —
    // surfaced here rather than left silent, though there is nothing useful
    // to retry with: the approval decision has already been made and Dust's
    // side of it is what failed to record.
    debugLog("dust:session", "Post validate-action failed", { status: res.status, conversationId, messageId, actionId });
  }
}

/**
 * Hard-stops the Dust agent loop running under `messageIds`.
 *
 * Dust signals the agent's workflow, marks the messages cancelled and publishes
 * `agent_generation_cancelled`. Without this the loop keeps running server-side
 * after the user hits escape — still burning tokens and, worse, still asking our
 * MCP server to run local tools.
 *
 * Deliberately not tied to the turn's abort signal: it is sent *because* that
 * signal fired, so it must outlive it. Failures are logged, never thrown — the
 * turn is already over and there is nothing the user could do about them.
 */
export async function cancelMessageGeneration(
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
  conversationId: string,
  messageIds: string[],
  refreshAuth?: () => Promise<boolean>,
): Promise<void> {
  const url = `${baseUrl}/assistant/conversations/${conversationId}/cancel`;
  debugLog("dust:session", "Cancelling message generation", { conversationId, messageIds, url });

  const post = async (): Promise<Response> => fetch(url, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds }),
    signal: AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
  });

  try {
    let res = await post();
    // The turns most worth cancelling are the long ones, which are also the
    // ones most likely to have outlived the ~15 minute access token. Giving up
    // on the 401 would fail exactly when this matters most.
    if (res.status === 401 && refreshAuth && await refreshAuth()) {
      debugLog("dust:session", "Refreshed token after 401, retrying cancel", { conversationId });
      res = await post();
    }
    if (!res.ok) {
      debugLog("dust:session", "Cancel request failed", { status: res.status, conversationId, messageIds });
      return;
    }
    // Dust answers `{ success: true }`; anything else means the agent loop was
    // not signalled, which would otherwise pass silently as a 200.
    const body = await res.json().catch(() => null);
    if (!isRecord(body) || body.success !== true) {
      debugLog("dust:session", "Cancel request returned an unexpected body", { conversationId, body });
      return;
    }
    debugLog("dust:session", "Cancel request accepted", { conversationId, messageIds });
  } catch (error) {
    debugLog("dust:session", "Cancel request threw", { error: errorMessage(error), conversationId });
  }
}

/**
 * Cancels the agent message Dust spawned for `userMessageSId`, looking it up
 * first.
 *
 * Posting the user message is what starts the agent loop, so a turn cancelled
 * between that POST and learning the agent message's id still has a loop
 * running — with no id, the normal cancel path has nothing to send. Best effort
 * throughout: the lookup runs on its own timeout (the turn's signal is already
 * aborted) and every failure is logged rather than raised.
 */
export async function cancelPendingAgentMessage(
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
  conversationSId: string,
  userMessageSId: string,
  refreshAuth?: () => Promise<boolean>,
  /**
   * Called the moment the id is known, before the cancel is dispatched. The
   * cancel POST can take seconds, and the caller needs the id to start refusing
   * that loop's tool calls immediately — not once Dust has answered.
   */
  onAgentMessageResolved?: (agentMessageSId: string) => void,
): Promise<string | null> {
  debugLog("dust:session", "Recovering agent message id to cancel", { conversationSId, userMessageSId });

  const lookup = async (): Promise<string> => fetchConversationAgentMessageId(
    baseUrl,
    getAuthHeaders(),
    AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
    conversationSId,
    userMessageSId,
  );

  let agentMessageSId: string;
  try {
    agentMessageSId = await lookup();
  } catch (error) {
    // Two failures worth telling apart. An expired token is fixable by
    // refreshing; a conversation that does not carry the agent message yet just
    // needs a moment, and that is exactly the window this recovery exists for,
    // so retrying beats giving up. Anything else is a transport failure.
    const retryable = isMissingAgentMessageError(error)
      ? await waitBeforeRetry()
      : isSessionExpiredError(error) && refreshAuth !== undefined && await refreshAuth();
    if (!retryable) {
      debugLog("dust:session", "Agent message lookup for cancel failed", {
        error: errorMessage(error),
        reason: isMissingAgentMessageError(error) ? "not-materialized" : "transport",
      });
      return null;
    }
    try {
      agentMessageSId = await lookup();
    } catch (retryError) {
      debugLog("dust:session", "Agent message lookup failed on retry", {
        error: errorMessage(retryError),
        reason: isMissingAgentMessageError(retryError) ? "not-materialized" : "transport",
      });
      return null;
    }
  }
  onAgentMessageResolved?.(agentMessageSId);
  await cancelMessageGeneration(baseUrl, getAuthHeaders, conversationSId, [agentMessageSId], refreshAuth);
  return agentMessageSId;
}

async function createConversation(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  runtime: DustSessionRuntime,
  agentSId: string,
  userText: string,
  username: string,
  timezone: string,
  systemPrompt?: string,
  spaceId?: string,
): Promise<{ conversationSId: string; userMessageSId: string; agentMessageSId: string }> {
  const messageContent = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;
  const reqBody = {
    title: userText.substring(0, 50) + (userText.length > 50 ? "..." : ""),
    visibility: "unlisted",
    // Binds the conversation to the Pod, which is what puts the pod's files on
    // the agent's sandbox mount. It can only be set at creation time — there is
    // no way to move a live conversation into a pod through this API.
    ...(spaceId ? { spaceId } : {}),
    message: {
      content: messageContent,
      mentions: [{ configurationId: agentSId }],
      context: buildConversationContext(username, timezone, runtime),
    },
  };
  debugLog("dust:session", "Creating Dust conversation", reqBody);

  const res = await fetch(`${baseUrl}/assistant/conversations`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    debugLog("dust:session", "Create conversation failed", { status: res.status, errBody });
    if (res.status === 401) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`Failed to create conversation: HTTP ${res.status} — ${errBody}`);
  }

  const data = parseConversationCreateResponse(await res.json());
  debugLog("dust:session", "Created Dust conversation", data);
  const conversationSId = data.conversation.sId;
  const userMessageSId = data.message.sId;
  runtime.conversationId = conversationSId;
  runtime.sessionContext.saveConversationId(conversationSId);

  return {
    conversationSId,
    userMessageSId,
    agentMessageSId: findAgentMessageSId(data.conversation.content, userMessageSId),
  };
}

async function postMessageToConversation(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  runtime: DustSessionRuntime,
  conversationSId: string,
  agentSId: string,
  userText: string,
  username: string,
  timezone: string,
): Promise<string> {
  debugLog("dust:session", "Posting message to existing conversation", { conversationSId, userText });

  const msgRes = await fetch(`${baseUrl}/assistant/conversations/${conversationSId}/messages`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: userText,
      mentions: [{ configurationId: agentSId }],
      context: buildConversationContext(username, timezone, runtime),
    }),
    signal,
  });

  if (!msgRes.ok) {
    debugLog("dust:session", "Post message failed", { status: msgRes.status, conversationSId });
    if (msgRes.status === 401) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`Failed to post message: HTTP ${msgRes.status}`);
  }

  const msgData = parsePostMessageResponse(await msgRes.json());
  debugLog("dust:session", "Posted user message", msgData);
  return msgData.message.sId;
}

async function fetchConversationAgentMessageId(
  baseUrl: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  conversationSId: string,
  userMessageSId: string,
): Promise<string> {
  const convRes = await fetch(`${baseUrl}/assistant/conversations/${conversationSId}`, {
    headers: authHeaders,
    signal,
  });

  if (!convRes.ok) {
    debugLog("dust:session", "Fetch conversation failed", { status: convRes.status, conversationSId });
    if (convRes.status === 401) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(`Failed to fetch conversation: HTTP ${convRes.status}`);
  }

  const convData = parseConversationFetchResponse(await convRes.json());
  debugLog("dust:session", "Fetched updated conversation", convData);
  return findAgentMessageSId(convData.conversation.content, userMessageSId);
}

export function createDustStreamHandler(runtime: DustSessionRuntime) {
  async function handleToolApproveExecution(event: ToolApproveExecutionEvent): Promise<boolean> {
    if (event.stake === "never_ask") {
      return true;
    }
    const toolName = event.metadata?.toolName ?? "unknown";
    const inputs = event.inputs ?? {};
    return runtime.confirmFn(`Allow tool: ${toolName}`, buildConfirmMessage(toolName, inputs));
  }

  return function dustRealStream(
    cred: DustCredentials,
    model: DustModel,
    context: StreamContextLike,
    options?: StreamOptionsLike,
  ) {
    const stream = createEventStream();
    let liveCred: DustCredentials = runtime.sessionContext.getCredentials() ?? cred;
    /** Filled in once the turn is armed; drained in `finally`. */
    const turnCleanup: {
      abortSignal: AbortSignal | null;
      onAbort: (() => void) | null;
      endTurn: (() => void) | null;
    } = { abortSignal: null, onAbort: null, endTurn: null };

    (async () => {
      try {
        const signal = options?.signal;
        liveCred = runtime.sessionContext.getCredentials() ?? cred;
        debugLog("dust:session", "Starting Dust stream", {
          modelId: model.id,
          existingConversationId: runtime.conversationId,
        });

        // Refresh a little before expiry so a long-lived stream does not start with
        // a token that will expire in the middle of the Dust/MCP exchange.
        if (shouldRefreshAccessToken(liveCred.expires, STREAM_REFRESH_SKEW_MS)) {
          // Prefer pi's own refresh: it runs our `oauth.refreshToken` hook and
          // persists the rotated token. Refreshing directly would rotate the
          // refresh token and discard it, since we can no longer write auth.json.
          const hostToken = await runtime.sessionContext.resolveAccessToken();
          if (hostToken) {
            liveCred = { ...(runtime.sessionContext.getCredentials() ?? liveCred), access: hostToken };
            runtime.setRefreshedAccessToken(hostToken, Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
            debugLog("dust:session", "Pre-stream token refresh delegated to host");
          } else {
            try {
              liveCred = await refreshToken(liveCred);
              runtime.sessionContext.setCredentials(liveCred);
              // setCredentials (persistCredentialState) drops the token trio —
              // it never reaches auth.json — so without this, every later
              // getAuthHeaders() would keep reading the old, still-expired
              // token back out of storage. refreshToken() reports a real
              // expiry (unlike the host path above), so use it rather than
              // the assumed TTL.
              if (liveCred.access) {
                runtime.setRefreshedAccessToken(liveCred.access, liveCred.expires || Date.now() + HOST_TOKEN_ASSUMED_TTL_MS);
              }
              debugLog("dust:session", "Pre-stream token refresh succeeded");
            } catch (err) {
              if (isSessionExpiredError(err)) {
                invalidateRuntimeCredentials(runtime, liveCred);
                throw err;
              }
              console.error(`[dust] token refresh failed before stream: ${errorMessage(err)}`);
            }
          }
        }

        const accessToken = liveCred.access ?? "";
        const workspaceId = liveCred.workspaceId ?? "";
        const region = liveCred.region ?? "us-central1";
        const username = liveCred.username ?? "unknown";
        const baseUrl = `${dustApiUrl(region)}/api/v1/w/${workspaceId}`;
        const agentSId = model.sId ?? "";
        debugLog("dust:session", "Resolved stream context", { workspaceId, region, baseUrl, agentSId, username });

        // Last-resort fallback: only reached if nothing is in memory AND
        // nothing is stored yet (there should always be something by the time
        // any of these run, but a snapshot beats an empty Authorization header).
        const fallbackAuthHeaders = buildAuthHeaders(accessToken);
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // The single accessor every call site below goes through, instead of
        // each hand-rolling its own priority chain — see
        // `DustSessionRuntime#currentAccessToken()`'s doc. A turn can outlive
        // the ~15 minute access token, so this is called fresh at each site
        // rather than pinning one snapshot for the whole turn.
        const resolveAuthHeaders = (): Record<string, string> => {
          const current = runtime.currentAccessToken();
          return current ? buildAuthHeaders(current) : fallbackAuthHeaders;
        };
        const getAuthHeaders = resolveAuthHeaders;

        // Called after a 401: refresh through pi (which persists the rotation)
        // and fall back to a direct refresh. Returning false means the session
        // really is dead. `liveCred` is passed as the fallback in case
        // `sessionContext` itself has nothing yet — see
        // `DustSessionRuntime#refreshAccessToken()`'s doc for why this is a
        // single shared method rather than each caller rolling its own body.
        const refreshAuth = (): Promise<boolean> => runtime.refreshAccessToken(liveCred);

        // Dust reads the client-side MCP catalogue exactly once, when the
        // server is registered, and caches it as the run's tool
        // configuration (`listToolsForClientSideMCPServer`). It ignores
        // `notifications/tools/list_changed`, so there is no in-band way to
        // tell it the catalogue moved: a tool the user disabled with
        // `setActiveTools` would go on being callable from Dust's stale
        // copy. Re-registering is the only lever, and a turn boundary is the
        // only safe place to pull it — this is best effort, not instant: a
        // change made mid-turn takes effect on the following turn. Tools
        // registered by *other* pi extensions remain invisible to Dust
        // regardless, since our catalogue is a fixed set of built-ins this
        // extension knows how to execute (issue #52 tracks routing arbitrary
        // pi tools through this bridge).
        const advertised = currentAdvertisedTools(runtime);
        if (runtime.toolCatalogueChanged(advertised)) {
          debugLog("dust:mcp", "Active tool set changed, re-registering MCP server", { tools: advertised });
          runtime.clearMcpState();
        }

        await ensureMcpServer(runtime, baseUrl, resolveAuthHeaders(), refreshAuth);

        const userText = extractUserText(context);
        const cwd = (runtime.extensionContext as { cwd?: string } | null)?.cwd ?? process.cwd();
        const podBinding = getPodBinding(cwd);
        const basePrompt = extractSystemPrompt(context);
        const toolGuidance = podBinding
          ? buildPodToolGuidance(cwd, podBinding.podId)
          : buildToolGuidance(cwd);
        let systemPrompt = [basePrompt, toolGuidance]
          .filter((part) => part.length > 0)
          .join("\n\n");

        // Push local edits made since the last turn, so the agent reads the tree
        // the user is actually looking at rather than the ingest-time snapshot.
        if (podBinding) {
          await syncPodBeforeTurn(runtime, cwd);
          // With the instructions in the pod, the user message carries only what
          // the user actually said.
          if (await installPodInstructions(runtime, cwd, basePrompt, toolGuidance)) {
            systemPrompt = "";
          }
        }
        debugLog("dust:session", "Prepared user message", { userText, systemPrompt, currentConversationId: runtime.conversationId });

        let agentMessageSId: string;
        let conversationSId: string;
        let userMessageSId: string;

        /**
         * Arms cancellation for this turn. Called as soon as the user message is
         * accepted, because that POST is what starts the agent loop: from here
         * on escape has something real to stop, whether or not the agent message
         * id is known yet.
         */
        /** The turn this stream owns, once armed. */
        let currentTurn: ActiveDustTurn;

        const startTurn = (turn: ActiveDustTurn): void => {
          currentTurn = turn;
          const onAbort = () => {
            const cancelled = runtime.cancelActiveTurn();
            if (!cancelled) return;
            if (cancelled.agentMessageSId) {
              void cancelMessageGeneration(
                baseUrl,
                getAuthHeaders,
                cancelled.conversationSId,
                [cancelled.agentMessageSId],
                refreshAuth,
              );
            } else {
              // Cancelled before the lookup resolved: find the message first.
              // It is recorded as the lookup lands rather than when the cancel
              // POST returns — that request can stall for seconds, and until the
              // id is known its loop's tool calls cannot be told apart.
              void cancelPendingAgentMessage(
                baseUrl,
                getAuthHeaders,
                cancelled.conversationSId,
                cancelled.userMessageSId,
                refreshAuth,
                (agentMessageSId) => runtime.markAgentMessageCancelled(agentMessageSId),
              );
            }
          };
          turnCleanup.onAbort = onAbort;
          if (signal) {
            // The turn may already have been cancelled while we were setting the
            // conversation up; addEventListener alone would never fire then.
            if (signal.aborted) {
              onAbort();
            } else {
              turnCleanup.abortSignal = signal;
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }
          turnCleanup.endTurn = () => runtime.endTurn(turn);
        };

        if (!runtime.conversationId) {
          ({ conversationSId, userMessageSId, agentMessageSId } = await createConversation(
            baseUrl,
            resolveAuthHeaders(),
            signal,
            runtime,
            agentSId,
            userText,
            username,
            timezone,
            systemPrompt || undefined,
            podBinding?.podId,
          ));
          startTurn(runtime.beginTurn(conversationSId, userMessageSId, agentMessageSId));
        } else {
          conversationSId = runtime.conversationId;
          userMessageSId = await postMessageToConversation(
            baseUrl,
            resolveAuthHeaders(),
            signal,
            runtime,
            conversationSId,
            agentSId,
            userText,
            username,
            timezone,
          );
          // Posting the user message is what starts the agent loop, so the turn
          // begins here rather than after the lookup below: escaping during that
          // lookup has to count as a cancellation, not as a turn that never was.
          const turn = runtime.beginTurn(conversationSId, userMessageSId);
          startTurn(turn);
          agentMessageSId = await fetchConversationAgentMessageId(
            baseUrl,
            resolveAuthHeaders(),
            signal,
            conversationSId,
            userMessageSId,
          );
          turn.agentMessageSId = agentMessageSId;
        }

        runtime.credits.recordMessageSent();

        await streamEvents({
          baseUrl,
          conversationSId,
          agentMsgSId: agentMessageSId,
          getAuthHeaders,
          refreshAuth,
          signal,
          stream,
          model,
          handleToolApproveExecution,
          postValidateAction: (conversationId, messageId, actionId, approved) =>
            postValidateAction(baseUrl, resolveAuthHeaders(), conversationId, messageId, actionId, approved),
          // Approving is two awaits long (the dialog, then validate-action, the
          // latter not tied to the turn's signal), so it can outlive the turn
          // entirely. The check is against *this* turn rather than whichever is
          // current: by the time a late approval lands the next turn may have
          // started, and writing the entry then would positionally approve that
          // turn's first tool call out of a queue `cancelActiveTurn` had cleared.
          recordPreApproval: (actionId, approved) => {
            if (currentTurn.cancelled) {
              debugLog("dust:session", "Dropping pre-approval for a cancelled turn", { actionId });
              return;
            }
            runtime.preApprovedActions.set(actionId, approved);
          },
          resolveApprovalGate: () => runtime.resolveApprovalGate(),
          // Dust stopped the loop itself; no cancel request to send, but the
          // turn is over and any tool call still in flight must be refused.
          onCancelled: () => { runtime.cancelActiveTurn(); },
        });

        // The agent's `files__*` edits landed in the pod, not on disk. Pull them
        // down now the turn is over, so the user's tree matches what the agent
        // just told them it did.
        if (podBinding) {
          await syncPodAfterTurn(runtime, cwd);
        }
      } catch (error) {
        // Aborting mid-setup (before the SSE stream owns the abort) surfaces as
        // a rejected fetch. That is the user cancelling, not a failure.
        const aborted = options?.signal?.aborted === true;
        debugLog("dust:session", aborted ? "Dust stream aborted" : "Dust stream failed", { error: errorMessage(error) });
        if (!aborted && isSessionExpiredError(error)) {
          invalidateRuntimeCredentials(runtime, liveCred);
        }
        const message = makeEmptyMessage(model);
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = aborted ? CANCELLED_MESSAGE : errorMessage(error);
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        stream.end();
      } finally {
        runtime.resolveApprovalGate();
        const { abortSignal, onAbort, endTurn } = turnCleanup;
        if (abortSignal && onAbort) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        endTurn?.();
        // A turn burns credits whether or not it ended cleanly — an aborted or
        // failed turn still ran tools — so `/status` must re-read afterwards
        // rather than answer from what it cached before the turn.
        runtime.credits.recordTurnCompleted();
      }
    })();

    return stream;
  };
}
