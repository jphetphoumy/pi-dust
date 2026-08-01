import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { debugLog } from "./dust-debug.js";
import { discoverLocalSkills, fingerprintSkill, podSkillPathsFor, type LocalSkill } from "./dust-pod-skills.js";
import { getPodBinding } from "./dust-state.js";

/**
 * The `[DustSkills]` startup section.
 *
 * pi's own `[Skills]` list says what the *session* discovered, which tells the
 * user nothing about what the *agent* can reach: only the skills `/dust-skills`
 * copied into the pod are readable from the sandbox mount, with the free
 * `files__*` tools. Everything else is invisible to the agent, and the only way
 * to notice today is to ask it and watch it fail.
 *
 * pi's startup listing is a fixed set of sections built by its interactive mode
 * — extensions cannot add one — so this renders as a transcript entry appended
 * at session start instead. It lands directly under the banner, which is close
 * enough to read as part of it.
 */

export const DUST_SKILLS_ENTRY = "dust-skills-banner";

/**
 * How much we can actually claim about a skill in the pod.
 *
 * - `synced` — the local files hash to the digest recorded when they were
 *   uploaded, so the pod's copy is the one on disk.
 * - `stale` — they no longer do. The pod is behind, and the agent reads the
 *   pod, so it is working from instructions the user has already changed.
 * - `unverified` — the binding predates fingerprints, so there is nothing to
 *   compare against. Not stale: we genuinely do not know, and guessing either
 *   way is what this section exists to stop.
 */
export type DustSkillState = "synced" | "stale" | "unverified";

export interface DustSkillEntry {
  name: string;
  state: DustSkillState;
}

/** What a rendered banner needs to know; a subset of `DustPodBinding`. */
export interface BannerData {
  entries: DustSkillEntry[];
  podName: string;
}

/** The parts of the binding this section reads. */
export interface BannerBinding {
  skills?: string[];
  skillFingerprints?: Record<string, string>;
  /**
   * Per-file pod watermarks, keyed the same way `DustPodBinding.seen` is.
   *
   * Optional, and only ever used to withhold a `synced` claim — never to
   * detect a pod-side change itself, which needs a `listPodFiles` call this
   * section deliberately does not make (see `appendDustSkillsBanner`'s own
   * note on the cost of one). Its only job here is telling "we uploaded this
   * and confirmed it landed" apart from "we uploaded this and never checked",
   * the latter being exactly what a failed watermark settle in
   * `syncSkillsToPod` leaves behind.
   */
  seen?: Record<string, unknown>;
}

/**
 * The skills the pod holds, each with what we can verify about it.
 *
 * Intersected with the skills on disk rather than taken from `binding.skills`
 * alone: that field is the last *selection*, not a live view, so a skill the
 * user has deleted since would otherwise be reported as available to the agent.
 *
 * `fingerprint` is injected so the check stays a pure function — and so the
 * hashing, which reads every file of every synced skill, can be skipped
 * entirely in tests.
 */
export function buildDustSkillsBanner(
  skills: LocalSkill[],
  binding: BannerBinding,
  fingerprint: (skill: LocalSkill) => string = fingerprintSkill,
): DustSkillEntry[] {
  const synced = new Set(binding.skills ?? []);
  // Only consulted to downgrade a `synced` claim, and gated on `seen` existing
  // at all rather than being non-empty: a binding written before this field
  // existed can genuinely lack it at runtime despite the type, and that is the
  // only case allowed to skip the check. A binding that *has* `seen` — the
  // normal case, even a brand-new one with nothing in it yet — has to earn
  // `synced` per skill: a global "seen has anything at all" gate would keep
  // claiming `synced` for a skill whose own watermark settle failed, for as
  // long as some *other* skill in the same pod happened to have one.
  const hasWatermark = (name: string): boolean =>
    Object.keys(binding.seen ?? {}).some((rel) => rel.startsWith(podSkillPathsFor(name)));

  return skills
    .filter((skill) => synced.has(skill.name))
    .map((skill) => {
      const recorded = binding.skillFingerprints?.[skill.name];
      if (recorded === undefined) return { name: skill.name, state: "unverified" as const };
      if (recorded !== fingerprint(skill)) return { name: skill.name, state: "stale" as const };
      if (binding.seen !== undefined && !hasWatermark(skill.name)) {
        return { name: skill.name, state: "unverified" as const };
      }
      return { name: skill.name, state: "synced" as const };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The section body, in pi's own compact-list shape: two-space indent, names
 * joined by commas, wrapped by the terminal.
 *
 * Only the pod's skills are listed, and only the ones needing attention carry a
 * tag — so the bare names read as "what the agent can use right now". Listing
 * the unsynced ones was tried and dropped: with many skills and a small
 * selection nearly every entry carried a marker, burying the short list that
 * actually mattered.
 */
export function formatDustSkillsBanner(
  entries: DustSkillEntry[],
  options: { hint?: boolean } = {},
): string {
  const list = entries
    .map((entry) => (entry.state === "synced" ? entry.name : `${entry.name} (${entry.state})`))
    .join(", ");
  // The hint only appears when there is something to act on; a tag the user
  // cannot do anything about is just noise.
  const needsSync = options.hint && entries.some((entry) => entry.state !== "synced");
  return needsSync
    ? `  ${list}\n  Run /dust-skills sync to bring the pod up to date, or /dust-skills diff to compare against the pod.`
    : `  ${list}`;
}

interface ThemeLike {
  fg?: (color: string, text: string) => string;
}

/**
 * Colours `text`, falling back to plain text when there is no usable theme.
 *
 * Called as a method on the theme, never as a detached function: pi's `fg`
 * reads `this.fgColors`, so `const fg = theme.fg; fg(...)` throws and the
 * section renders as "renderer failed" instead of as itself.
 */
function paint(theme: unknown, color: string, text: string): string {
  const themed = theme as ThemeLike | undefined;
  if (typeof themed?.fg !== "function") return text;
  try {
    return themed.fg(color, text);
  } catch {
    // A theme that cannot colour is not a reason to lose the section.
    return text;
  }
}

function isBannerData(value: unknown): value is BannerData {
  return typeof value === "object" && value !== null && Array.isArray((value as BannerData).entries);
}

/** Registers the renderer for the section's transcript entry. */
export function registerDustSkillsBanner(pi: ExtensionAPI): void {
  const register = (pi as unknown as {
    registerEntryRenderer?: (
      customType: string,
      renderer: (entry: unknown, opts: { expanded: boolean }, theme: unknown) => unknown,
    ) => void;
  }).registerEntryRenderer;

  if (typeof register !== "function") {
    debugLog("dust:skills", "registerEntryRenderer unavailable; no [DustSkills] section");
    return;
  }

  register(DUST_SKILLS_ENTRY, (entry, _options, theme) => {
    const data = (entry as { data?: unknown })?.data;
    if (!isBannerData(data) || data.entries.length === 0) return new Text("");

    // Same shape as pi's own sections: an mdHeading label, then a dim body.
    const header = paint(theme, "mdHeading", "[DustSkills]");
    const body = paint(theme, "dim", formatDustSkillsBanner(data.entries, { hint: true }));
    return new Text(`${header}\n${body}`, 0, 0);
  });
}

/**
 * Whether a session start of this kind should get the section.
 *
 * Only where the transcript begins empty. `/resume` and `/fork` restore a
 * transcript that already carries the section from when it was written, so
 * appending again would stack duplicates down the history. An absent reason is
 * treated as startup, which is what older pi builds send.
 */
export function shouldAppendBannerFor(reason: string | undefined): boolean {
  return reason === undefined || reason === "startup" || reason === "new";
}

/**
 * Appends the section for this session, if there is anything to say.
 *
 * Silent without a bound pod: the section reports what the pod holds, and there
 * is nothing to report until `/ingest` has run. Silent too when the pod holds no
 * skills — an empty list under a heading reads as a rendering bug, and there is
 * nothing for the user to act on.
 */
export function appendDustSkillsBanner(pi: ExtensionAPI, cwd: string): void {
  const binding = getPodBinding(cwd);
  if (!binding) return;
  // Discovery stats a whole tree and fingerprinting reads every synced file, so
  // both are skipped outright when the pod has no skills in it.
  if ((binding.skills ?? []).length === 0) return;

  const entries = buildDustSkillsBanner(discoverLocalSkills(cwd), binding);
  if (entries.length === 0) return;

  try {
    pi.appendEntry(DUST_SKILLS_ENTRY, { entries, podName: binding.name } as unknown as Record<string, unknown>);
  } catch (err) {
    // A missing section must never cost the user their session start.
    debugLog("dust:skills", "Could not append the [DustSkills] section", { error: String(err) });
  }
}
