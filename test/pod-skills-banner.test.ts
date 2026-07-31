import { describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../src/dust-pod-skills.js";
import {
  buildDustSkillsBanner,
  DUST_SKILLS_ENTRY,
  formatDustSkillsBanner,
  shouldAppendBannerFor,
} from "../src/dust-pod-skills-banner.js";

function skill(name: string): LocalSkill {
  return {
    name,
    description: `${name} does things`,
    baseDir: `/skills/${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    files: ["SKILL.md"],
    bytes: 10,
  };
}

/**
 * The section lists what the *agent* can reach, which is not what pi's own
 * `[Skills]` lists — that is what the session discovered. Only skills copied
 * into the pod are readable from the sandbox mount.
 */
describe("the [DustSkills] startup section", () => {
  it("lists only the skills that are in the pod", async () => {
    // Naming the unsynced ones was noise: in a session with many skills and a
    // small selection nearly every entry carried a tag. What the user needs is
    // the short list of what the agent can actually read.
    const banner = buildDustSkillsBanner(
      [skill("herdr"), skill("remotion-create"), skill("remotion-docs")],
      { skills: ["remotion-create", "remotion-docs"] },
      () => "fp",
    );

    expect(banner.map((entry) => entry.name)).toEqual(["remotion-create", "remotion-docs"]);
  });

  it("sorts by name, so the list does not reshuffle between runs", () => {
    const banner = buildDustSkillsBanner(
      [skill("zebra"), skill("alpha"), skill("mid")],
      { skills: ["zebra", "alpha", "mid"] },
      () => "fp",
    );

    expect(banner.map((entry) => entry.name)).toEqual(["alpha", "mid", "zebra"]);
  });

  it("flags a skill edited since it was synced", () => {
    // The pod's copy is now behind the local one, and the agent reads the pod's.
    // Nothing else in the UI would ever say so.
    const banner = buildDustSkillsBanner(
      [skill("edited"), skill("untouched")],
      {
        skills: ["edited", "untouched"],
        skillFingerprints: { edited: "old-digest", untouched: "current" },
      },
      (target) => (target.name === "edited" ? "new-digest" : "current"),
    );

    expect(banner).toEqual([
      { name: "edited", state: "stale" },
      { name: "untouched", state: "synced" },
    ]);
  });

  it("treats a binding written before fingerprints existed as unverified", () => {
    // Not stale — we genuinely do not know. Claiming either way would be a
    // guess, and the point of this section is to stop guessing.
    const banner = buildDustSkillsBanner([skill("old")], { skills: ["old"] }, () => "fp");

    expect(banner).toEqual([{ name: "old", state: "unverified" }]);
  });

  it("drops a skill that is recorded as synced but no longer on disk", () => {
    // `skills` is the last selection, not a live view.
    const banner = buildDustSkillsBanner(
      [skill("still-here")],
      { skills: ["still-here", "deleted-since"] },
      () => "fp",
    );

    expect(banner.map((entry) => entry.name)).toEqual(["still-here"]);
  });

  it("renders synced names bare and tags only what needs attention", () => {
    expect(formatDustSkillsBanner([
      { name: "alpha", state: "synced" },
      { name: "beta", state: "stale" },
      { name: "gamma", state: "unverified" },
    ])).toBe("  alpha, beta (stale), gamma (unverified)");
  });

  it("points at the fix when something is stale", () => {
    // A tag the user cannot act on is just noise.
    expect(formatDustSkillsBanner([{ name: "beta", state: "stale" }]))
      .toContain("(stale)");
    expect(formatDustSkillsBanner([{ name: "beta", state: "stale" }], { hint: true }))
      .toContain("/dust-skills sync");
  });
});

describe("wiring the [DustSkills] section into startup", () => {
  it("registers a renderer for its entry type", async () => {
    const { registerDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    const registerEntryRenderer = vi.fn();

    registerDustSkillsBanner({ registerEntryRenderer } as never);

    expect(registerEntryRenderer).toHaveBeenCalledWith(DUST_SKILLS_ENTRY, expect.any(Function));
  });

  it("calls the theme's colour helper as a method, so `this` survives", async () => {
    // Regression: `const fg = theme.fg; fg(...)` detaches the method from the
    // theme object, and pi's implementation reads `this.fgColors` — so the
    // section rendered as "renderer failed: undefined is not an object".
    const { registerDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    let renderer: ((entry: unknown, opts: unknown, theme: unknown) => unknown) | null = null;
    registerDustSkillsBanner({
      registerEntryRenderer: (_type: string, fn: never) => { renderer = fn; },
    } as never);

    const theme = {
      fgColors: { dim: "d", mdHeading: "h" },
      fg(color: string, text: string) {
        return `<${(this as { fgColors: Record<string, string> }).fgColors[color]}>${text}`;
      },
    };

    expect(() => (renderer as never as (e: unknown, o: unknown, t: unknown) => unknown)(
      { data: { entries: [{ name: "alpha", state: "synced" }], podName: "proj" } },
      { expanded: false },
      theme,
    )).not.toThrow();
  });

  it("renders without colour when pi passes no theme", async () => {
    const { registerDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    let renderer: ((entry: unknown, opts: unknown, theme: unknown) => unknown) | null = null;
    registerDustSkillsBanner({
      registerEntryRenderer: (_type: string, fn: never) => { renderer = fn; },
    } as never);

    expect(() => (renderer as never as (e: unknown, o: unknown, t: unknown) => unknown)(
      { data: { entries: [{ name: "alpha", state: "synced" }], podName: "proj" } },
      { expanded: false },
      undefined,
    )).not.toThrow();
  });

  it("survives a pi build that has no entry renderers", async () => {
    const { registerDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");

    expect(() => registerDustSkillsBanner({} as never)).not.toThrow();
  });

  it("shows on a fresh transcript and not on a restored one", () => {
    // /resume and /fork restore a transcript that already carries the section.
    expect(shouldAppendBannerFor("startup")).toBe(true);
    expect(shouldAppendBannerFor("new")).toBe(true);
    expect(shouldAppendBannerFor(undefined)).toBe(true);
    expect(shouldAppendBannerFor("resume")).toBe(false);
    expect(shouldAppendBannerFor("fork")).toBe(false);
  });

  it("says nothing when no pod is bound", async () => {
    const { appendDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    const state = await import("../src/dust-state.js");
    vi.spyOn(state, "getPodBinding").mockReturnValue(undefined as never);
    const appendEntry = vi.fn();

    appendDustSkillsBanner({ appendEntry } as never, "/tmp/whatever");

    expect(appendEntry).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("says nothing when the pod holds no skills at all", async () => {
    // An empty list under a heading reads as a rendering bug, and there is
    // nothing for the user to act on.
    const { appendDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    const state = await import("../src/dust-state.js");
    const skills = await import("../src/dust-pod-skills.js");
    vi.spyOn(state, "getPodBinding").mockReturnValue({ podId: "vlt_1", name: "proj", seen: {} } as never);
    vi.spyOn(skills, "discoverLocalSkills").mockReturnValue([skill("local-only")]);
    const appendEntry = vi.fn();

    appendDustSkillsBanner({ appendEntry } as never, "/tmp/whatever");

    expect(appendEntry).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("appends only the pod's skills, with their verified state", async () => {
    const { appendDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    const state = await import("../src/dust-state.js");
    const skills = await import("../src/dust-pod-skills.js");
    vi.spyOn(state, "getPodBinding").mockReturnValue({
      podId: "vlt_1",
      name: "proj",
      seen: {},
      skills: ["synced"],
      skillFingerprints: { synced: "matching" },
    } as never);
    vi.spyOn(skills, "discoverLocalSkills").mockReturnValue([skill("synced"), skill("local-only")]);
    vi.spyOn(skills, "fingerprintSkill").mockReturnValue("matching");
    const appendEntry = vi.fn();

    appendDustSkillsBanner({ appendEntry } as never, "/tmp/whatever");

    expect(appendEntry).toHaveBeenCalledWith(DUST_SKILLS_ENTRY, {
      entries: [{ name: "synced", state: "synced" }],
      podName: "proj",
    });
    vi.restoreAllMocks();
  });

  it("does not fail the session start when appending throws", async () => {
    const { appendDustSkillsBanner } = await import("../src/dust-pod-skills-banner.js");
    const state = await import("../src/dust-state.js");
    const skills = await import("../src/dust-pod-skills.js");
    vi.spyOn(state, "getPodBinding").mockReturnValue({
      podId: "vlt_1", name: "proj", seen: {}, skills: ["herdr"],
    } as never);
    vi.spyOn(skills, "discoverLocalSkills").mockReturnValue([skill("herdr")]);

    expect(() => appendDustSkillsBanner({
      appendEntry: () => { throw new Error("no transcript yet"); },
    } as never, "/tmp/whatever")).not.toThrow();
    vi.restoreAllMocks();
  });
});
