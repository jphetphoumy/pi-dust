import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListPanelOptions, ListRow } from "../src/dust-pod-list-panel.js";
import * as dustPod from "../src/dust-pod.js";
import * as podRuntime from "../src/dust-pod-runtime.js";
import * as podSkills from "../src/dust-pod-skills.js";
import * as podUi from "../src/dust-pod-ui.js";
import { registerDustSkillsCommand } from "../src/dust-skills-command.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { getPodBinding, savePodBinding } from "../src/dust-state.js";
import { agentDir, useTempAgentDir } from "./helpers/dust-fixtures.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

describe("/dust-skills", () => {
  useTempAgentDir();

  let root: string;
  let runtime: DustSessionRuntime;
  let handler: Handler;
  let notices: Array<[string, string]>;
  let panelResult: ListRow[] | undefined | null;
  let panelOptions: Omit<ListPanelOptions, "height"> | null;

  function ctx() {
    return {
      ui: { notify: (message: string, level: string) => { notices.push([message, level]); } },
    };
  }

  function messages(): string[] {
    return notices.map(([message]) => message);
  }

  function writeSkill(name: string, extra: string[] = []): void {
    const base = join(agentDir(), "skills", name);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "SKILL.md"),
      `---\nname: ${name}\ndescription: does ${name}\n---\n\nBody.\n`,
    );
    for (const rel of extra) {
      writeFileSync(join(base, rel), "extra");
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-dust-skillcmd-"));
    notices = [];
    panelResult = undefined;
    panelOptions = null;

    runtime = new DustSessionRuntime();
    runtime.extensionContext = { cwd: root } as never;

    vi.spyOn(podRuntime, "podApiFor").mockReturnValue({
      baseUrl: "https://x/api/w/w1",
      getAuthHeaders: () => ({}),
    });
    vi.spyOn(podUi, "openListPanel").mockImplementation(async (_ctx, options) => {
      panelOptions = options;
      return panelResult;
    });
    vi.spyOn(podSkills, "syncSkillsToPod").mockResolvedValue({ uploaded: ["a"], skipped: [], seen: {} });
    vi.spyOn(podSkills, "removeSkillsFromPod").mockResolvedValue([]);
    vi.spyOn(dustPod, "listPodFiles").mockResolvedValue([]);
    // Real discovery, but confined to this suite's throwaway agent dir. The
    // default search includes ~/.agents/skills, so without this the assertions
    // would depend on whichever skills the developer happens to have installed.
    const discover = podSkills.discoverLocalSkills;
    vi.spyOn(podSkills, "discoverLocalSkills").mockImplementation((dir) =>
      discover(dir, [{ dir: join(agentDir(), "skills"), source: "user" }]));

    const registerCommand = vi.fn((_name: string, config: { handler: Handler }) => {
      handler = config.handler;
    });
    registerDustSkillsCommand({ registerCommand } as never, runtime);
    expect(registerCommand).toHaveBeenCalledWith("dust-skills", expect.anything());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("needs a pod, since skills are synced into one", async () => {
    writeSkill("herdr");

    await handler("", ctx());

    expect(messages()[0]).toContain("No pod bound");
  });

  it("offers each discovered skill with its size and file count", async () => {
    // A skill directory can be megabytes and uploads are one request per file,
    // so the cost of a choice has to be visible before making it.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr", ["notes.md"]);
    panelResult = [];

    await handler("", ctx());

    expect(panelOptions?.selectable).toBe(true);
    expect(panelOptions?.rows[0].label).toBe("herdr");
    expect(panelOptions?.rows[0].detail).toMatch(/\d+ B, 2 files/);
  });

  it("pre-ticks the skills already synced, so the picker shows current state", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"] });
    writeSkill("herdr");
    writeSkill("other");
    panelResult = undefined;

    await handler("", ctx());

    const rows = panelOptions?.rows ?? [];
    expect(rows.find((row) => row.label === "herdr")?.selected).toBe(true);
    expect(rows.find((row) => row.label === "other")?.selected).toBe(false);
  });

  it("records the chosen skills and invalidates the instructions", async () => {
    // AGENTS.md lists exactly the synced skills, so it has to be rewritten when
    // the set moves — clearing the hash is what forces that on the next turn.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, agentsMdHash: "stale" });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(getPodBinding(root)?.skills).toEqual(["herdr"]);
    expect(getPodBinding(root)?.agentsMdHash).toBeUndefined();
    expect(messages()[0]).toContain("Synced 1 skill");
  });

  it("records a fingerprint per skill, so 'synced' becomes checkable", async () => {
    // Without this, `skills` is a record of intent: it survives the skill being
    // edited afterwards, and nothing can tell that the pod's copy has drifted.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    const recorded = getPodBinding(root)?.skillFingerprints;
    expect(recorded?.herdr).toEqual(expect.any(String));
    // It is the digest of what is on disk right now.
    const [skill] = podSkills.discoverLocalSkills(root);
    expect(recorded?.herdr).toBe(podSkills.fingerprintSkill(skill));
  });

  it("seeds a watermark for each uploaded skill file, so the first pod-side edit isn't a conflict", async () => {
    // Without this, every skill file starts with no watermark at all, and
    // syncPod's routing branch reads that as changed-on-both-sides the moment
    // a local file already exists — the very #54 failure mode, for exactly
    // the files that were just synced.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];
    vi.spyOn(podSkills, "syncSkillsToPod").mockResolvedValue({
      uploaded: ["skills/herdr/SKILL.md"],
      skipped: [],
      seen: { "skills/herdr/SKILL.md": { podMs: 500, hash: "deadbeef" } },
    });

    await handler("", ctx());

    expect(getPodBinding(root)?.seen["skills/herdr/SKILL.md"]).toEqual({ podMs: 500, hash: "deadbeef" });
  });

  it("drops a de-selected skill's watermarks along with its pod files", async () => {
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: { "skills/old/SKILL.md": { podMs: 1, hash: "h" } },
      skills: ["old"],
    });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(getPodBinding(root)?.seen["skills/old/SKILL.md"]).toBeUndefined();
  });

  it("forgets the fingerprint of a de-selected skill", async () => {
    // Its files are deleted from the pod, so a lingering digest would claim a
    // skill is synced when it is gone.
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: {},
      skills: ["herdr", "other"],
      skillFingerprints: { herdr: "h", other: "o" },
    });
    writeSkill("herdr");
    writeSkill("other");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(Object.keys(getPodBinding(root)?.skillFingerprints ?? {})).toEqual(["herdr"]);
  });

  it("`sync` re-uploads the recorded selection without reopening the picker", async () => {
    // The point of the subcommand: after editing a skill, getting the pod back
    // in step should not mean re-ticking the same boxes.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"] });
    writeSkill("herdr");

    await handler("sync", ctx());

    expect(podUi.openListPanel).not.toHaveBeenCalled();
    expect(podSkills.syncSkillsToPod).toHaveBeenCalled();
    const synced = vi.mocked(podSkills.syncSkillsToPod).mock.calls[0][2];
    expect(synced.map((skill) => skill.name)).toEqual(["herdr"]);
    // A diff preview lands first, then the actual re-sync result.
    expect(messages().some((message) => message.includes("Re-synced"))).toBe(true);
  });

  it("`sync` refreshes the fingerprints, so the section stops reporting stale", async () => {
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: {},
      skills: ["herdr"],
      skillFingerprints: { herdr: "digest-from-before-the-edit" },
    });
    writeSkill("herdr");

    await handler("sync", ctx());

    const [skill] = podSkills.discoverLocalSkills(root);
    expect(getPodBinding(root)?.skillFingerprints?.herdr).toBe(podSkills.fingerprintSkill(skill));
  });

  it("`sync` also seeds a watermark for each re-uploaded file", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"] });
    writeSkill("herdr");
    vi.spyOn(podSkills, "syncSkillsToPod").mockResolvedValue({
      uploaded: ["skills/herdr/SKILL.md"],
      skipped: [],
      seen: { "skills/herdr/SKILL.md": { podMs: 700, hash: "cafe" } },
    });

    await handler("sync", ctx());

    expect(getPodBinding(root)?.seen["skills/herdr/SKILL.md"]).toEqual({ podMs: 700, hash: "cafe" });
  });

  it("`sync` drops a skill that has gone from disk", async () => {
    // Re-uploading is impossible and claiming it is synced would be a lie, so
    // the selection has to shrink to what still exists.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr", "vanished"] });
    writeSkill("herdr");

    await handler("sync", ctx());

    expect(getPodBinding(root)?.skills).toEqual(["herdr"]);
    expect(messages().join(" ")).toContain("vanished");
  });

  it("`sync` deletes a vanished skill's pod copy, not just its name from the selection", async () => {
    // Leaving the pod files behind would make the next sync's adoption logic
    // find an untracked skills/<name>/ subtree with a SKILL.md and treat the
    // skill the user just deleted as agent-authored, installing it right back
    // into .pi/skills/<name>/.
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr", "vanished"] });
    writeSkill("herdr");

    await handler("sync", ctx());

    expect(podSkills.removeSkillsFromPod).toHaveBeenCalledWith(expect.anything(), "vlt_1", ["vanished"]);
  });

  it("`sync` drops a vanished skill's own watermarks too, not just its name", async () => {
    // Once `vanished` leaves `binding.skills`, its files stop being routed by
    // syncPod's synced-skill branch. A stale watermark left behind — no local
    // file at that literal path, but a watermark that says it moved — would
    // read as changed-on-both-sides forever: a permanent conflict with no way
    // to resolve it.
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: {
        "skills/vanished/SKILL.md": { podMs: 1, hash: "h" },
        "skills/herdr/SKILL.md": { podMs: 1, hash: "h2" },
      },
      skills: ["herdr", "vanished"],
    });
    writeSkill("herdr");

    await handler("sync", ctx());

    const seen = getPodBinding(root)?.seen ?? {};
    expect(seen["skills/vanished/SKILL.md"]).toBeUndefined();
  });

  it("`sync` says so when nothing has been selected yet", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");

    await handler("sync", ctx());

    expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
    expect(messages()[0]).toContain("No skills");
  });

  it("`sync` rewrites the instructions, since the pod's copies moved", async () => {
    savePodBinding(root, {
      podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"], agentsMdHash: "stale",
    });
    writeSkill("herdr");

    await handler("sync", ctx());

    expect(getPodBinding(root)?.agentsMdHash).toBeUndefined();
  });

  it("accepts an empty selection as 'offer the agent none'", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"] });
    writeSkill("herdr");
    panelResult = [];

    await handler("", ctx());

    expect(getPodBinding(root)?.skills).toEqual([]);
    expect(messages()[0]).toContain("will be offered none");
  });

  it("changes nothing when the picker is cancelled", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"] });
    writeSkill("herdr");
    panelResult = undefined;

    await handler("", ctx());

    expect(getPodBinding(root)?.skills).toEqual(["herdr"]);
    expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
  });

  it("refuses a selection past the file limit rather than uploading for minutes", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("huge");
    vi.spyOn(podSkills, "discoverLocalSkills").mockReturnValue([
      {
        name: "huge",
        description: "big",
        baseDir: join(root, "huge"),
        filePath: join(root, "huge/SKILL.md"),
        files: Array.from({ length: podSkills.MAX_SKILL_FILES + 1 }, (_, i) => `f${i}.md`),
        bytes: 1,
      },
    ]);
    panelResult = [{ label: "huge", value: "huge", selected: true }];

    await handler("", ctx());

    expect(messages()[0]).toContain(`over the ${podSkills.MAX_SKILL_FILES} limit`);
    expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
  });

  it("deletes a de-selected skill's files rather than orphaning them in the pod", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["old", "keep"] });
    writeSkill("keep");
    panelResult = [{ label: "keep", value: "keep", selected: true }];
    vi.mocked(podSkills.removeSkillsFromPod).mockResolvedValue(["skills/old/SKILL.md"]);

    await handler("", ctx());

    expect(podSkills.removeSkillsFromPod).toHaveBeenCalledWith(expect.anything(), "vlt_1", ["old"]);
    expect(messages()[0]).toContain("Removed 1 file");
  });

  it("removes nothing when the selection only grows", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {}, skills: ["keep"] });
    writeSkill("keep");
    writeSkill("extra");
    panelResult = [
      { label: "keep", value: "keep", selected: true },
      { label: "extra", value: "extra", selected: true },
    ];

    await handler("", ctx());

    expect(podSkills.removeSkillsFromPod).toHaveBeenCalledWith(expect.anything(), "vlt_1", []);
  });

  it("refuses a skill whose name collides with the project's own skills/ directory", async () => {
    // `skills/` is no longer ours alone, so syncing over the user's files there
    // would overwrite them and then exclude them from syncing back down.
    const collidingPath = join(root, "skills", "herdr", "notes.md");
    mkdirSync(dirname(collidingPath), { recursive: true });
    writeFileSync(collidingPath, "the user's own file");
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: { "skills/herdr/notes.md": { podMs: 1, hash: "h" } },
    });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(messages()[0]).toContain("already has files under skills/herdr/");
    expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
  });

  it("does not flag a skill's own watermarks as a collision with itself", async () => {
    // A pod-side pull to a synced skill (#54) leaves watermarks under
    // `skills/<name>/` in `seen`, routed to the skill's real local directory
    // rather than to disk at that path. Re-picking the same skill here must
    // not read its own bookkeeping as "the project already has files there".
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: { "skills/herdr/SKILL.md": { podMs: 1, hash: "h" } },
      skills: ["herdr"],
    });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(messages().some((m) => m.includes("already has files"))).toBe(false);
    expect(podSkills.syncSkillsToPod).toHaveBeenCalled();
  });

  it("still flags a genuine collision even when the colliding name is already synced", async () => {
    // A name-only filter would suppress this: `herdr` is already in
    // `binding.skills`, but the project genuinely has a real file at
    // `skills/herdr/notes.md` on disk — a routed skill's own watermark never
    // has a file there, so checking for one on disk keeps this case caught.
    const collidingPath = join(root, "skills", "herdr", "notes.md");
    mkdirSync(dirname(collidingPath), { recursive: true });
    writeFileSync(collidingPath, "not from us");
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: { "skills/herdr/notes.md": { podMs: 1, hash: "h" } },
      skills: ["herdr"],
    });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(messages()[0]).toContain("already has files under skills/herdr/");
    expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
  });

  it("allows a skill when the project's skills/ holds unrelated files", async () => {
    savePodBinding(root, {
      podId: "vlt_1",
      name: "proj",
      seen: { "skills/something-else/notes.md": { podMs: 1, hash: "h" } },
    });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];

    await handler("", ctx());

    expect(podSkills.syncSkillsToPod).toHaveBeenCalled();
  });

  it("says so when there are no skills to offer", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });

    await handler("", ctx());

    expect(messages()[0]).toContain("No pi skills found");
  });

  it("explains that choosing needs a terminal when there is no panel surface", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");
    panelResult = null;

    await handler("", ctx());

    expect(messages()[0]).toContain("interactive terminal");
  });

  it("names files the pod refused", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];
    vi.spyOn(podSkills, "syncSkillsToPod").mockResolvedValue({
      uploaded: [],
      skipped: [{ rel: ".pi-skills/herdr/SKILL.md", reason: "HTTP 400" }],
      seen: {},
    });

    await handler("", ctx());

    expect(messages().join(" ")).toContain("Skipped .pi-skills/herdr/SKILL.md: HTTP 400");
  });

  it("reports a failed sync", async () => {
    savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
    writeSkill("herdr");
    panelResult = [{ label: "herdr", value: "herdr", selected: true }];
    vi.spyOn(podSkills, "syncSkillsToPod").mockRejectedValue(new Error("HTTP 500"));

    await handler("", ctx());

    expect(messages()[0]).toContain("Skill sync failed: HTTP 500");
  });

  describe("`diff`", () => {
    it("needs a pod, since there is nothing to compare against without one", async () => {
      writeSkill("herdr");

      await handler("diff", ctx());

      expect(messages()[0]).toContain("No pod bound");
      expect(dustPod.listPodFiles).not.toHaveBeenCalled();
    });

    it("reports synced when the local fingerprint matches and the pod has a matching watermark", async () => {
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        skills: ["herdr"],
        skillFingerprints: {},
        seen: { "skills/herdr/SKILL.md": { podMs: 100, hash: "h" } },
      });
      writeSkill("herdr");
      const [skill] = podSkills.discoverLocalSkills(root);
      const binding = getPodBinding(root)!;
      binding.skillFingerprints = { herdr: podSkills.fingerprintSkill(skill) };
      savePodBinding(root, binding);
      vi.mocked(dustPod.listPodFiles).mockResolvedValue([
        { path: "pod-vlt_1/skills/herdr/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 100 },
      ]);

      await handler("diff", ctx());

      expect(messages()[0]).toContain("herdr: synced");
    });

    it("reports pod-changed when a pod file is newer than its recorded watermark", async () => {
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        skills: ["herdr"],
        seen: { "skills/herdr/SKILL.md": { podMs: 100, hash: "h" } },
      });
      writeSkill("herdr");
      const [skill] = podSkills.discoverLocalSkills(root);
      const binding = getPodBinding(root)!;
      binding.skillFingerprints = { herdr: podSkills.fingerprintSkill(skill) };
      savePodBinding(root, binding);
      vi.mocked(dustPod.listPodFiles).mockResolvedValue([
        { path: "pod-vlt_1/skills/herdr/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 999 },
      ]);

      await handler("diff", ctx());

      expect(messages()[0]).toContain("herdr: pod-changed");
    });

    it("reports pod-changed with the deletion called out when a watermarked pod file is gone", async () => {
      savePodBinding(root, {
        podId: "vlt_1",
        name: "proj",
        skills: ["herdr"],
        seen: {
          "skills/herdr/SKILL.md": { podMs: 100, hash: "h" },
          "skills/herdr/notes.md": { podMs: 100, hash: "h2" },
        },
      });
      writeSkill("herdr", ["notes.md"]);
      const [skill] = podSkills.discoverLocalSkills(root);
      const binding = getPodBinding(root)!;
      binding.skillFingerprints = { herdr: podSkills.fingerprintSkill(skill) };
      savePodBinding(root, binding);
      // Only SKILL.md is still in the pod's listing; notes.md was deleted there.
      vi.mocked(dustPod.listPodFiles).mockResolvedValue([
        { path: "pod-vlt_1/skills/herdr/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 100 },
      ]);

      await handler("diff", ctx());

      expect(messages()[0]).toContain("herdr: pod-changed");
      expect(messages()[0]).toContain("deleted");
    });

    it("reports pod-only for a skill-shaped pod subtree with nothing selected locally", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", seen: {} });
      vi.mocked(dustPod.listPodFiles).mockResolvedValue([
        { path: "pod-vlt_1/skills/authored/SKILL.md", fileName: "SKILL.md", isDirectory: false, sizeBytes: 1, lastModifiedMs: 1 },
      ]);

      await handler("diff", ctx());

      expect(messages()[0]).toContain("authored: pod-only");
    });

    it("reports the listing failure and touches nothing", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", skills: ["herdr"], seen: {} });
      writeSkill("herdr");
      const before = getPodBinding(root);
      vi.mocked(dustPod.listPodFiles).mockRejectedValue(new Error("HTTP 500"));

      await handler("diff", ctx());

      expect(messages()[0]).toBe("Skill diff failed: HTTP 500");
      expect(getPodBinding(root)).toEqual(before);
    });

    it("never opens the picker or uploads anything — it is read-only", async () => {
      savePodBinding(root, { podId: "vlt_1", name: "proj", skills: ["herdr"], seen: {} });
      writeSkill("herdr");

      await handler("diff", ctx());

      expect(podUi.openListPanel).not.toHaveBeenCalled();
      expect(podSkills.syncSkillsToPod).not.toHaveBeenCalled();
    });
  });
});
