import type { AutoEditPhotoRole } from "./autoEditPlan";

/**
 * The single place that converts narrative context into milliseconds.
 *
 * Before this module the codebase held four independent timing truths: the live
 * Playback tempo profiles (`journeyPlaybackPlan.ts`), the Quick Recap dwell and
 * camera constants (`autoEditPlan.ts`), the Keepsake desired durations, and the
 * legacy `PLAYBACK_PACING` table (`journeyPlayback.ts`) that Keepsake and the
 * Quick Recap budget still read. The Edit Plan decides what / order / role /
 * camera intent; this resolver decides how long; the Director and the Keepsake
 * renderer only execute.
 *
 * Pure: no React, no I/O, no clock. Target-duration budgeting deliberately
 * stays outside — Quick Recap keeps its greedy selection loop and Keepsake
 * keeps `fitKeepsakeSceneDurations()`. This module answers "how long is this
 * beat", never "how many beats fit".
 *
 * The tables below are seeded from the numbers that play today so that the
 * callers can be switched over one at a time without changing behaviour;
 * `narrativeTiming.test.ts` asserts that equivalence against the original
 * constants rather than against copied literals.
 */

export type NarrativeMode = "full" | "quick-recap" | "keepsake";

/** Identical to `PlaybackTempo` (journeyPlaybackPlan) and `AutoEditTempo` (autoEditPlan). */
export type NarrativeTempo = "fast" | "standard" | "immersive";

export type NarrativeSegmentKind = "intro" | "travel" | "arrival" | "media" | "outro";

export type NarrativeTimingProfile = {
  introMs: number;
  travelBaseMs: number;
  travelPerRadiansMs: number;
  travelMaxMs: number;
  arrivalBaseMs: number;
  arrivalPerNoteCharMs: number;
  arrivalMaxMs: number;
  imageRoleMs: Record<AutoEditPhotoRole, number>;
  videoMs: number;
  outroMs: number;
};

export type NarrativeTimingContext = {
  mode: NarrativeMode;
  tempo: NarrativeTempo;
  segmentKind: NarrativeSegmentKind;
  /** travel only: great-circle distance between the two route points, in radians. */
  routeDistanceRadians?: number;
  /** arrival only: length of the route point's trimmed note. */
  noteLength?: number;
  mediaKind?: "image" | "video";
  mediaRole?: AutoEditPhotoRole;
  /** Video source duration when it is known; absent while analysis is pending. */
  intrinsicDurationMs?: number;
};

const DEFAULT_PHOTO_ROLE: AutoEditPhotoRole = "representative";

/**
 * Full Playback: every field is `PLAYBACK_TEMPO_PROFILES[tempo]` from
 * `journeyPlaybackPlan.ts:25-62`, unchanged. `imageRoleMs.representative` is
 * that profile's `imageMs`, so Full Playback — which never assigns a photo role
 * and therefore takes the default role — keeps exactly today's dwell; the other
 * three roles come from Quick Recap's `IMAGE_DWELL_MS` so that a future
 * role-aware Full Playback has a table to read instead of inventing one.
 */
const FULL_PROFILES: Record<NarrativeTempo, NarrativeTimingProfile> = {
  fast: {
    introMs: 800,
    travelBaseMs: 420,
    travelPerRadiansMs: 300,
    travelMaxMs: 1000,
    arrivalBaseMs: 650,
    arrivalPerNoteCharMs: 10,
    arrivalMaxMs: 1000,
    // representative: PLAYBACK_TEMPO_PROFILES.fast.imageMs; others: IMAGE_DWELL_MS.fast.
    imageRoleMs: { hero: 2_000, representative: 1_700, supporting: 1_200, burst: 700 },
    videoMs: 4_200,
    outroMs: 1_000,
  },
  standard: {
    introMs: 1_100,
    travelBaseMs: 650,
    travelPerRadiansMs: 450,
    travelMaxMs: 1_400,
    arrivalBaseMs: 950,
    arrivalPerNoteCharMs: 14,
    arrivalMaxMs: 1_500,
    // representative: PLAYBACK_TEMPO_PROFILES.standard.imageMs; others: IMAGE_DWELL_MS.standard.
    imageRoleMs: { hero: 3_100, representative: 2_800, supporting: 1_800, burst: 900 },
    videoMs: 6_000,
    outroMs: 1_500,
  },
  immersive: {
    introMs: 1_400,
    travelBaseMs: 900,
    travelPerRadiansMs: 650,
    travelMaxMs: 1_900,
    arrivalBaseMs: 1_500,
    arrivalPerNoteCharMs: 18,
    arrivalMaxMs: 2_600,
    // representative: PLAYBACK_TEMPO_PROFILES.immersive.imageMs; others: IMAGE_DWELL_MS.immersive.
    imageRoleMs: { hero: 4_900, representative: 4_500, supporting: 3_000, burst: 1_300 },
    videoMs: 8_000,
    outroMs: 2_000,
  },
};

/**
 * Quick Recap.
 *
 * - `imageRoleMs` / `videoMs`: `IMAGE_DWELL_MS` / `VIDEO_DWELL_MS`
 *   (`autoEditPlan.ts:106-115`), unchanged — dwell was already tempo-aware.
 * - `travelBaseMs` = `CAMERA_MS` (1000, `autoEditPlan.ts:116`) and
 *   `arrivalBaseMs` = `ARRIVAL_MS` (800, `:117`), which were flat constants. Per
 *   decision D2 they become base values plus distance and note terms, so a
 *   nearby leg and a long-haul leg stop collapsing to one camera duration. The
 *   slopes and the base→max span are Full Playback's, i.e. the same distance and
 *   note sensitivity as live Playback over a different floor; a zero-distance /
 *   zero-note beat therefore still resolves to exactly today's 1000 / 800.
 * - `introMs` / `outroMs`: `PLAYBACK_TEMPO_PROFILES[tempo]` again, because
 *   `quickRecapStepDurationMs()` returns `undefined` for intro and outro
 *   (`quickRecapPlayback.ts:146`) and the director already spends the live
 *   profile's values for those two beats. The legacy 1200/1800 that Quick
 *   Recap's *budget* arithmetic subtracts (`quickRecapPlayback.ts:136`) is not
 *   what plays; PR 4 switches that budget onto this table.
 */
const QUICK_RECAP_PROFILES: Record<NarrativeTempo, NarrativeTimingProfile> = {
  fast: {
    introMs: 800,
    travelBaseMs: 1_000,
    travelPerRadiansMs: 300,
    travelMaxMs: 1_580,
    arrivalBaseMs: 800,
    arrivalPerNoteCharMs: 10,
    arrivalMaxMs: 1_150,
    imageRoleMs: { hero: 2_000, representative: 1_600, supporting: 1_200, burst: 700 },
    videoMs: 2_600,
    outroMs: 1_000,
  },
  standard: {
    introMs: 1_100,
    travelBaseMs: 1_000,
    travelPerRadiansMs: 450,
    travelMaxMs: 1_750,
    arrivalBaseMs: 800,
    arrivalPerNoteCharMs: 14,
    arrivalMaxMs: 1_350,
    imageRoleMs: { hero: 3_100, representative: 2_500, supporting: 1_800, burst: 900 },
    videoMs: 3_500,
    outroMs: 1_500,
  },
  immersive: {
    introMs: 1_400,
    travelBaseMs: 1_000,
    travelPerRadiansMs: 650,
    travelMaxMs: 2_000,
    arrivalBaseMs: 800,
    arrivalPerNoteCharMs: 18,
    arrivalMaxMs: 1_900,
    imageRoleMs: { hero: 4_900, representative: 4_100, supporting: 3_000, burst: 1_300 },
    videoMs: 4_500,
    outroMs: 2_000,
  },
};

/**
 * Keepsake: every tempo carries the legacy `PLAYBACK_PACING` numbers
 * (`journeyPlayback.ts:20-31`) that `stepDurationMs()` feeds to `sceneForStep()`
 * today, so switching Keepsake onto the resolver is a provable no-visual-change
 * refactor and `journeyKeepsake.test.ts` fixtures stay byte-identical. Per
 * decision D3 the export keeps its fixed 15/30/60 s presets and no tempo
 * control, so the three rows are deliberately identical — Keepsake reads the
 * `standard` row and tempo for Keepsake is a later product question. All four
 * photo roles share `PLAYBACK_PACING.imageMs` because Keepsake assigns no role
 * in phase 1.
 */
const KEEPSAKE_PROFILE: NarrativeTimingProfile = {
  introMs: 1_200,
  travelBaseMs: 900,
  travelPerRadiansMs: 600,
  travelMaxMs: 1_600,
  // PLAYBACK_PACING's arrival terms are named stopMinMs / stopPerNoteCharMs / stopMaxMs.
  arrivalBaseMs: 1_500,
  arrivalPerNoteCharMs: 24,
  arrivalMaxMs: 3_000,
  imageRoleMs: { hero: 4_500, representative: 4_500, supporting: 4_500, burst: 4_500 },
  videoMs: 6_000,
  outroMs: 1_800,
};

const KEEPSAKE_PROFILES: Record<NarrativeTempo, NarrativeTimingProfile> = {
  fast: KEEPSAKE_PROFILE,
  standard: KEEPSAKE_PROFILE,
  immersive: KEEPSAKE_PROFILE,
};

/** Per-mode profile table, exported for budgeting and for prefetch (#197). */
export const NARRATIVE_TIMING_PROFILES: Record<
  NarrativeMode,
  Record<NarrativeTempo, NarrativeTimingProfile>
> = {
  full: FULL_PROFILES,
  "quick-recap": QUICK_RECAP_PROFILES,
  keepsake: KEEPSAKE_PROFILES,
};

function nonNegativeTerm(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function mediaDurationMsFor(profile: NarrativeTimingProfile, context: NarrativeTimingContext) {
  if (context.mediaKind === "video") {
    const intrinsic = context.intrinsicDurationMs;
    // An unknown or non-positive source duration falls back to the profile
    // budget rather than to zero: in `full` mode the resolved number is only
    // the failure path anyway, because #163 gives a healthy video's completion
    // to the media element's `ended` event.
    if (intrinsic === undefined || !Number.isFinite(intrinsic) || intrinsic <= 0) {
      return profile.videoMs;
    }
    return Math.min(intrinsic, profile.videoMs);
  }
  return profile.imageRoleMs[context.mediaRole ?? DEFAULT_PHOTO_ROLE];
}

function narrativeDurationMs(profile: NarrativeTimingProfile, context: NarrativeTimingContext) {
  switch (context.segmentKind) {
    case "intro":
      return profile.introMs;
    case "outro":
      return profile.outroMs;
    case "travel":
      return Math.min(
        profile.travelMaxMs,
        profile.travelBaseMs
          + nonNegativeTerm(context.routeDistanceRadians) * profile.travelPerRadiansMs,
      );
    case "arrival":
      return Math.min(
        profile.arrivalMaxMs,
        profile.arrivalBaseMs + nonNegativeTerm(context.noteLength) * profile.arrivalPerNoteCharMs,
      );
    case "media":
      return mediaDurationMsFor(profile, context);
  }
}

/**
 * How long this narrative beat lasts, in whole milliseconds.
 *
 * Always an integer `>= 0`: `validateAutoEditPlanV1` asserts that a plan's
 * recomputed duration equals `plannedDurationMs` exactly, so a fractional
 * result would make a valid plan unverifiable.
 */
export function resolveNarrativeTiming(context: NarrativeTimingContext): number {
  const profile = NARRATIVE_TIMING_PROFILES[context.mode][context.tempo];
  return Math.max(0, Math.round(narrativeDurationMs(profile, context)));
}
