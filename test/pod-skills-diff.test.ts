import { describe, expect, it } from "vitest";
import type { LocalSkill } from "../src/dust-pod-skills.js";
import { diffSkills, formatSkillDiff, type SkillDiffBinding } from "../src/dust-pod-skills-diff.js";
import type { PodFileEntry } from "../src/dust-pod.js";

const PODID = "abc123";

function skill(name: string, files: string[] = ["SKILL.md"]): LocalSkill {
  return {
    name,
    description: `${name} does things`,
    baseDir: `/skills/${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    files,
    bytes: 10,
  };
}

function podEntry(rel: string, lastModifiedMs: number): PodFileEntry {
  return {
    path: `pod-${PODID}/${rel}`,
    fileName: rel.split("/").pop() ?? rel,
    isDirectory: false,
    sizeBytes: 10,
    lastModifiedMs,
  };
}

function binding(overrides: Partial<SkillDiffBinding> = {}): SkillDiffBinding {
  return { skills: [], skillFingerprints: {}, seen: {}, ...overrides };
}

/**
 * `diffSkills` is the honest version of `[DustSkills]`'s comparison: it also
 * looks at the pod, via one already-fetched listing, rather than trusting the
 * digest recorded at the last sync alone.
 */
describe("diffSkills", () => {
  it("reports synced when neither side has moved since the sync", () => {
    const diffs = diffSkills({
      local: [skill("herdr")],
      binding: binding({
        skills: ["herdr"],
        skillFingerprints: { herdr: "fp" },
        seen: { "skills/herdr/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/herdr/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs).toEqual([
      { name: "herdr", state: "synced", localFileCount: 1, podFileCount: 1, podChangedFiles: [], podDeletedFiles: [] },
    ]);
  });

  it("reports local-changed when the disk fingerprint no longer matches, and the pod is untouched", () => {
    const diffs = diffSkills({
      local: [skill("edited")],
      binding: binding({
        skills: ["edited"],
        skillFingerprints: { edited: "old" },
        seen: { "skills/edited/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/edited/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "new",
    });

    expect(diffs[0].state).toBe("local-changed");
  });

  it("reports pod-changed when a pod file is newer than its watermark", () => {
    const diffs = diffSkills({
      local: [skill("touched")],
      binding: binding({
        skills: ["touched"],
        skillFingerprints: { touched: "fp" },
        seen: { "skills/touched/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/touched/SKILL.md", 200)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("pod-changed");
    expect(diffs[0].podChangedFiles).toEqual(["SKILL.md"]);
  });

  it("reports pod-changed when a watermarked path is missing from the pod listing (pod-side deletion)", () => {
    // This is exactly the case `[DustSkills]` can never see: it never contacts
    // the pod, so a deletion there reads as nothing has changed.
    const diffs = diffSkills({
      local: [skill("half-deleted", ["SKILL.md", "notes.md"])],
      binding: binding({
        skills: ["half-deleted"],
        skillFingerprints: { "half-deleted": "fp" },
        seen: {
          "skills/half-deleted/SKILL.md": { podMs: 100, hash: "h" },
          "skills/half-deleted/notes.md": { podMs: 100, hash: "h2" },
        },
      }),
      podEntries: [podEntry("skills/half-deleted/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("pod-changed");
    expect(diffs[0].podDeletedFiles).toEqual(["notes.md"]);
  });

  it("reports pod-changed when the pod has an extra unwatermarked file alongside known ones", () => {
    const diffs = diffSkills({
      local: [skill("grown", ["SKILL.md", "extra.md"])],
      binding: binding({
        skills: ["grown"],
        skillFingerprints: { grown: "fp" },
        seen: { "skills/grown/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/grown/SKILL.md", 100), podEntry("skills/grown/extra.md", 150)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("pod-changed");
    expect(diffs[0].podChangedFiles).toEqual(["extra.md"]);
  });

  it("reports both-changed when disk and pod both moved", () => {
    const diffs = diffSkills({
      local: [skill("chaos")],
      binding: binding({
        skills: ["chaos"],
        skillFingerprints: { chaos: "old" },
        seen: { "skills/chaos/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/chaos/SKILL.md", 200)],
      podId: PODID,
      fingerprint: () => "new",
    });

    expect(diffs[0].state).toBe("both-changed");
  });

  it("reports pod-only for a skill-shaped pod subtree with nothing on disk", () => {
    const diffs = diffSkills({
      local: [],
      binding: binding({ skills: [] }),
      podEntries: [podEntry("skills/authored/SKILL.md", 100), podEntry("skills/authored/ref.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs).toEqual([
      { name: "authored", state: "pod-only", localFileCount: 0, podFileCount: 2, podChangedFiles: [], podDeletedFiles: [] },
    ]);
  });

  it("does not report a pod subtree without a SKILL.md — that is someone's own project directory", () => {
    // The exact hazard `POD_SKILLS_PREFIX`'s own docs warn about: `skills/` is a
    // plausible project directory too.
    const diffs = diffSkills({
      local: [],
      binding: binding({ skills: [] }),
      podEntries: [podEntry("skills/vendor/index.js", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs).toEqual([]);
  });

  it("reports local-only for a selected skill with no files in the pod at all", () => {
    const diffs = diffSkills({
      local: [skill("never-landed")],
      binding: binding({ skills: ["never-landed"] }),
      podEntries: [],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("local-only");
  });

  it("reports missing for a selected skill present on neither side", () => {
    const diffs = diffSkills({
      local: [],
      binding: binding({ skills: ["gone"] }),
      podEntries: [],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs).toEqual([
      { name: "gone", state: "missing", localFileCount: 0, podFileCount: 0, podChangedFiles: [], podDeletedFiles: [] },
    ]);
  });

  it("reports unverified when the local fingerprint was never recorded", () => {
    const diffs = diffSkills({
      local: [skill("old-binding")],
      binding: binding({
        skills: ["old-binding"],
        seen: { "skills/old-binding/SKILL.md": { podMs: 100, hash: "h" } },
      }),
      podEntries: [podEntry("skills/old-binding/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("unverified");
  });

  it("reports unverified when the pod side has no watermark at all, rather than pod-changed for every file", () => {
    // A settle failure (see syncSkillsToPod's own note on this) must not read
    // as "every file changed" — that would be a worse lie than saying nothing.
    const diffs = diffSkills({
      local: [skill("unsettled")],
      binding: binding({
        skills: ["unsettled"],
        skillFingerprints: { unsettled: "fp" },
        seen: {},
      }),
      podEntries: [podEntry("skills/unsettled/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs[0].state).toBe("unverified");
  });

  it("prefers a known change over unverified when both baselines are partially missing", () => {
    const diffs = diffSkills({
      local: [skill("half-known")],
      binding: binding({
        skills: ["half-known"],
        seen: {}, // no pod watermark at all
      }),
      podEntries: [podEntry("skills/half-known/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    // No local fingerprint AND no pod watermark: still unverified, not synced.
    expect(diffs[0].state).toBe("unverified");
  });

  it("sorts by name and never lists an unselected local skill", () => {
    const diffs = diffSkills({
      local: [skill("zebra"), skill("alpha"), skill("unselected")],
      binding: binding({
        skills: ["zebra", "alpha"],
        skillFingerprints: { zebra: "fp", alpha: "fp" },
        seen: {
          "skills/zebra/SKILL.md": { podMs: 100, hash: "h" },
          "skills/alpha/SKILL.md": { podMs: 100, hash: "h" },
        },
      }),
      podEntries: [podEntry("skills/zebra/SKILL.md", 100), podEntry("skills/alpha/SKILL.md", 100)],
      podId: PODID,
      fingerprint: () => "fp",
    });

    expect(diffs.map((d) => d.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("formatSkillDiff", () => {
  it("reports the empty case the same way the sync command already does", () => {
    expect(formatSkillDiff([], "proj")).toBe(
      "No skills are synced into this pod yet. Run /dust-skills to choose some.",
    );
  });

  it("renders one line per skill under a pod-named header", () => {
    const text = formatSkillDiff(
      [
        { name: "herdr", state: "synced", localFileCount: 4, podFileCount: 4, podChangedFiles: [], podDeletedFiles: [] },
      ],
      "proj",
    );

    expect(text).toBe('Skills in pod "proj":\n  herdr: synced (4 files)');
  });

  it("adds the sync hint only when a state that needs syncing is present", () => {
    const synced = formatSkillDiff(
      [{ name: "a", state: "synced", localFileCount: 1, podFileCount: 1, podChangedFiles: [], podDeletedFiles: [] }],
      "proj",
    );
    expect(synced).not.toContain("Run /dust-skills sync");

    const changed = formatSkillDiff(
      [{ name: "a", state: "local-changed", localFileCount: 1, podFileCount: 0, podChangedFiles: [], podDeletedFiles: [] }],
      "proj",
    );
    expect(changed).toContain("Run /dust-skills sync to bring the pod up to date.");
  });

  it("adds the pod-changed hint only when a pod-changed skill is present", () => {
    const text = formatSkillDiff(
      [{ name: "a", state: "pod-changed", localFileCount: 1, podFileCount: 1, podChangedFiles: ["SKILL.md"], podDeletedFiles: [] }],
      "proj",
    );
    expect(text).toContain("Pod-side edits are pulled by the next sync.");
  });

  it("names the skills a conflict hint applies to", () => {
    const text = formatSkillDiff(
      [
        { name: "wiki", state: "both-changed", localFileCount: 1, podFileCount: 1, podChangedFiles: ["a.md"], podDeletedFiles: [] },
        { name: "other", state: "both-changed", localFileCount: 1, podFileCount: 1, podChangedFiles: ["b.md"], podDeletedFiles: [] },
      ],
      "proj",
    );
    expect(text).toContain(
      "Both sides moved for wiki, other — the next sync reports that as a conflict rather than picking a winner.",
    );
  });

  it("describes pod-only and local-only skills without a file-count sentence borrowed from the other side", () => {
    const podOnly = formatSkillDiff(
      [{ name: "a", state: "pod-only", localFileCount: 0, podFileCount: 3, podChangedFiles: [], podDeletedFiles: [] }],
      "proj",
    );
    expect(podOnly).toContain("a: pod-only (3 files) — not on disk");

    const localOnly = formatSkillDiff(
      [{ name: "a", state: "local-only", localFileCount: 2, podFileCount: 0, podChangedFiles: [], podDeletedFiles: [] }],
      "proj",
    );
    expect(localOnly).toContain("a: local-only (2 files) — nothing left in the pod");
  });
});
