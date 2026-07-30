import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentsMdFits,
  composeAgentsMd,
  ensureAgentsMd,
  POD_AGENTS_MD,
  POD_AGENTS_MD_MAX_CHARS,
} from "../src/dust-pod-agents-md.js";
import * as podApi from "../src/dust-pod.js";
import { type DustPodBinding, getPodBinding } from "../src/dust-state.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

const api = { baseUrl: "https://x/api/w/w1", getAuthHeaders: () => ({}) };

function binding(overrides: Partial<DustPodBinding> = {}): DustPodBinding {
  return { podId: "vlt_1", name: "proj", seen: {}, ...overrides };
}

describe("pod AGENTS.md", () => {
  useTempAgentDir();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("joins the parts it was given, skipping empty ones", () => {
    expect(composeAgentsMd({ basePrompt: "base", toolGuidance: "rules", skillsListing: "" }))
      .toBe("base\n\nrules");
    expect(composeAgentsMd({ basePrompt: "base", toolGuidance: "rules", skillsListing: "skills" }))
      .toBe("base\n\nrules\n\nskills");
  });

  it("knows Dust's cap, which truncates silently past 8192", () => {
    expect(agentsMdFits("x".repeat(POD_AGENTS_MD_MAX_CHARS))).toBe(true);
    expect(agentsMdFits("x".repeat(POD_AGENTS_MD_MAX_CHARS + 1))).toBe(false);
  });

  it("writes the file and records its hash", async () => {
    const upload = vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);
    const bound = binding();

    expect(await ensureAgentsMd(api, "/work/proj", bound, "instructions")).toBe(true);

    expect(upload).toHaveBeenCalledWith(api, "vlt_1", POD_AGENTS_MD, Buffer.from("instructions", "utf8"));
    expect(bound.agentsMdHash).toBe(createHash("sha256").update("instructions").digest("hex"));
    expect(getPodBinding("/work/proj")?.agentsMdHash).toBe(bound.agentsMdHash);
  });

  it("skips the upload when the instructions have not changed", async () => {
    // Rewriting identical bytes costs a request and, worse, would churn the file
    // Dust caches as a per-pod prompt prefix.
    const upload = vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);
    const bound = binding({
      agentsMdHash: createHash("sha256").update("instructions").digest("hex"),
    });

    expect(await ensureAgentsMd(api, "/work/proj", bound, "instructions")).toBe(true);

    expect(upload).not.toHaveBeenCalled();
  });

  it("rewrites when the instructions changed", async () => {
    const upload = vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);
    const bound = binding({ agentsMdHash: "stale" });

    await ensureAgentsMd(api, "/work/proj", bound, "new instructions");

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("refuses content over the cap rather than shipping a truncated prompt", async () => {
    // Dust drops the overflow without complaint, so the prompt would lose its
    // tail — the tool rules — with no signal at all.
    const upload = vi.spyOn(podApi, "uploadPodFile").mockResolvedValue(undefined);
    const bound = binding();

    const installed = await ensureAgentsMd(
      api,
      "/work/proj",
      bound,
      "x".repeat(POD_AGENTS_MD_MAX_CHARS + 1),
    );

    expect(installed).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(bound.agentsMdHash).toBeUndefined();
  });

  it("propagates an upload failure, so the caller can fall back", async () => {
    vi.spyOn(podApi, "uploadPodFile").mockRejectedValue(new Error("HTTP 500"));

    await expect(ensureAgentsMd(api, "/work/proj", binding(), "instructions"))
      .rejects.toThrow("HTTP 500");
  });
});
