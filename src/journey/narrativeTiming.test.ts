import { describe, expect, it } from "vitest";
import {
  NARRATIVE_TIMING_PROFILES,
  UNMEASURED_VIDEO_DURATION_MS,
  resolveNarrativeTiming,
  type NarrativeMode,
  type NarrativeSegmentKind,
  type NarrativeTempo,
  type NarrativeTimingContext,
} from "./narrativeTiming";
import {
  AUTO_EDIT_PHOTO_ROLES,
  AUTO_EDIT_TEMPOS,
  type AutoEditPhotoRole,
  type AutoEditTempo,
} from "./autoEditPlan";
import { PLAYBACK_TEMPO_PROFILES } from "./journeyPlaybackPlan";

/**
 * The quick-recap and keepsake numbers, spelled out as literals.
 *
 * They used to be asserted against the constants they were seeded from
 * (`autoEditPlan.ts`'s dwell tables and camera / arrival floors, and the legacy
 * pacing table in `journeyPlayback.ts`). Those are deleted now that the
 * resolver is the only timing truth, so the equivalence anchors become plain
 * expected values: an unintended retune still fails here, it just no longer has
 * a second table to be compared against.
 */
const QUICK_RECAP_IMAGE_DWELL_EXPECTED: Record<AutoEditTempo, Record<AutoEditPhotoRole, number>> = {
  fast: { hero: 2_000, representative: 1_600, supporting: 1_200, burst: 700 },
  standard: { hero: 3_100, representative: 2_500, supporting: 1_800, burst: 900 },
  immersive: { hero: 4_900, representative: 4_100, supporting: 3_000, burst: 1_300 },
};
const QUICK_RECAP_VIDEO_EXPECTED: Record<AutoEditTempo, number> = {
  fast: 2_600,
  standard: 3_500,
  immersive: 4_500,
};
/** The zero-distance / zero-note floors quick recap kept from its flat constants. */
const QUICK_RECAP_CAMERA_FLOOR_MS = 1_000;
const QUICK_RECAP_ARRIVAL_FLOOR_MS = 800;
const KEEPSAKE_EXPECTED = {
  introMs: 1_200,
  travelBaseMs: 900,
  travelPerRadiansMs: 600,
  travelMaxMs: 1_600,
  arrivalBaseMs: 1_500,
  arrivalPerNoteCharMs: 24,
  arrivalMaxMs: 3_000,
  imageMs: 4_500,
  videoMs: 6_000,
  outroMs: 1_800,
} as const;

const MODES: NarrativeMode[] = ["full", "quick-recap", "keepsake"];
const TEMPI: NarrativeTempo[] = ["fast", "standard", "immersive"];
const SEGMENT_KINDS: NarrativeSegmentKind[] = ["intro", "travel", "arrival", "media", "outro"];

/**
 * One representative context per segment kind, carrying non-trivial and
 * deliberately fractional distance/note terms so the clamps and the rounding
 * are actually exercised.
 */
function contextFor(
  mode: NarrativeMode,
  tempo: NarrativeTempo,
  segmentKind: NarrativeSegmentKind,
): NarrativeTimingContext {
  return {
    mode,
    tempo,
    segmentKind,
    routeDistanceRadians: 0.7333,
    noteLength: 17,
    mediaKind: "image",
    mediaRole: "representative",
  };
}

describe("resolveNarrativeTiming", () => {
  it("returns an integer for every mode, tempo and segment kind", () => {
    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        for (const segmentKind of SEGMENT_KINDS) {
          const resolved = resolveNarrativeTiming(contextFor(mode, tempo, segmentKind));
          expect(Number.isInteger(resolved), `${mode}/${tempo}/${segmentKind}`).toBe(true);
          expect(resolved).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("rounds a fractional distance term instead of returning a fraction", () => {
    // 650 + 0.7333 * 450 = 979.985 -> 980, so Math.round is load-bearing here.
    const resolved = resolveNarrativeTiming({
      mode: "full",
      tempo: "standard",
      segmentKind: "travel",
      routeDistanceRadians: 0.7333,
    });
    expect(resolved).toBe(980);
  });

  it("is monotone in tempo for every mode and segment kind", () => {
    for (const mode of MODES) {
      for (const segmentKind of SEGMENT_KINDS) {
        const fast = resolveNarrativeTiming(contextFor(mode, "fast", segmentKind));
        const standard = resolveNarrativeTiming(contextFor(mode, "standard", segmentKind));
        const immersive = resolveNarrativeTiming(contextFor(mode, "immersive", segmentKind));
        // Non-strict: Keepsake is deliberately tempo-flat (D3) and Quick Recap's
        // camera/arrival floors are shared across tempi.
        expect(fast, `${mode}/${segmentKind} fast <= standard`).toBeLessThanOrEqual(standard);
        expect(standard, `${mode}/${segmentKind} standard <= immersive`)
          .toBeLessThanOrEqual(immersive);
      }
    }
  });

  it("is monotone in distance for travel and clamps at the profile maximum", () => {
    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        const profile = NARRATIVE_TIMING_PROFILES[mode][tempo];
        const base = resolveNarrativeTiming({ mode, tempo, segmentKind: "travel" });
        expect(base, `${mode}/${tempo} no distance falls back to the base`)
          .toBe(profile.travelBaseMs);

        let previous = base;
        for (const routeDistanceRadians of [0, 0.25, 0.5, 1, 1.5, 2, Math.PI]) {
          const resolved = resolveNarrativeTiming({
            mode,
            tempo,
            segmentKind: "travel",
            routeDistanceRadians,
          });
          expect(resolved, `${mode}/${tempo} @${routeDistanceRadians}`)
            .toBeGreaterThanOrEqual(previous);
          expect(resolved).toBeLessThanOrEqual(profile.travelMaxMs);
          previous = resolved;
        }

        // Antipodal is the largest real distance; the clamp must bind well before
        // an absurd input.
        expect(
          resolveNarrativeTiming({
            mode,
            tempo,
            segmentKind: "travel",
            routeDistanceRadians: 1_000,
          }),
        ).toBe(profile.travelMaxMs);
      }
    }
  });

  it("is monotone in note length for arrival and clamps at the profile maximum", () => {
    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        const profile = NARRATIVE_TIMING_PROFILES[mode][tempo];
        const base = resolveNarrativeTiming({ mode, tempo, segmentKind: "arrival" });
        expect(base, `${mode}/${tempo} no note falls back to the base`)
          .toBe(profile.arrivalBaseMs);

        let previous = base;
        for (const noteLength of [0, 5, 20, 60, 140]) {
          const resolved = resolveNarrativeTiming({
            mode,
            tempo,
            segmentKind: "arrival",
            noteLength,
          });
          expect(resolved, `${mode}/${tempo} @${noteLength} chars`)
            .toBeGreaterThanOrEqual(previous);
          expect(resolved).toBeLessThanOrEqual(profile.arrivalMaxMs);
          previous = resolved;
        }

        expect(
          resolveNarrativeTiming({ mode, tempo, segmentKind: "arrival", noteLength: 100_000 }),
        ).toBe(profile.arrivalMaxMs);
      }
    }
  });

  it("orders image dwell hero >= representative >= supporting >= burst", () => {
    const roleDuration = (mode: NarrativeMode, tempo: NarrativeTempo, mediaRole: AutoEditPhotoRole) =>
      resolveNarrativeTiming({ mode, tempo, segmentKind: "media", mediaKind: "image", mediaRole });

    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        const hero = roleDuration(mode, tempo, "hero");
        const representative = roleDuration(mode, tempo, "representative");
        const supporting = roleDuration(mode, tempo, "supporting");
        const burst = roleDuration(mode, tempo, "burst");
        expect(hero, `${mode}/${tempo} hero >= representative`)
          .toBeGreaterThanOrEqual(representative);
        expect(representative, `${mode}/${tempo} representative >= supporting`)
          .toBeGreaterThanOrEqual(supporting);
        expect(supporting, `${mode}/${tempo} supporting >= burst`).toBeGreaterThanOrEqual(burst);
      }
    }
  });

  it("treats a role-less image as representative, which is what Full Playback resolves", () => {
    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        expect(
          resolveNarrativeTiming({ mode, tempo, segmentKind: "media", mediaKind: "image" }),
        ).toBe(NARRATIVE_TIMING_PROFILES[mode][tempo].imageRoleMs.representative);
      }
    }
  });

  it("honours min(intrinsic, videoMs) and falls back to videoMs without an intrinsic", () => {
    for (const mode of MODES) {
      for (const tempo of TEMPI) {
        const { videoMs } = NARRATIVE_TIMING_PROFILES[mode][tempo];
        const video = (intrinsicDurationMs?: number) =>
          resolveNarrativeTiming({
            mode,
            tempo,
            segmentKind: "media",
            mediaKind: "video",
            intrinsicDurationMs,
          });

        // A short clip plays whole rather than being padded to the budget.
        expect(video(500), `${mode}/${tempo} short clip`).toBe(500);
        // A long clip is capped at the budget.
        expect(video(videoMs + 10_000), `${mode}/${tempo} long clip`).toBe(videoMs);
        expect(video(videoMs), `${mode}/${tempo} exact clip`).toBe(videoMs);
        // Analysis pending / unusable metadata: the budget, not zero.
        expect(video(undefined), `${mode}/${tempo} unknown clip`).toBe(videoMs);
        expect(video(0), `${mode}/${tempo} zero clip`).toBe(videoMs);
      }
    }
  });
});

describe("NARRATIVE_TIMING_PROFILES seed equivalence", () => {
  it("reproduces PLAYBACK_TEMPO_PROFILES for the full mode", () => {
    for (const tempo of TEMPI) {
      const seeded = NARRATIVE_TIMING_PROFILES.full[tempo];
      const live = PLAYBACK_TEMPO_PROFILES[tempo];
      expect(seeded.introMs).toBe(live.introMs);
      expect(seeded.travelBaseMs).toBe(live.travelBaseMs);
      expect(seeded.travelPerRadiansMs).toBe(live.travelPerRadiansMs);
      expect(seeded.travelMaxMs).toBe(live.travelMaxMs);
      expect(seeded.arrivalBaseMs).toBe(live.arrivalBaseMs);
      expect(seeded.arrivalPerNoteCharMs).toBe(live.arrivalPerNoteCharMs);
      expect(seeded.arrivalMaxMs).toBe(live.arrivalMaxMs);
      expect(seeded.imageRoleMs.representative).toBe(live.imageMs);
      expect(seeded.videoMs).toBe(live.videoMs);
      expect(seeded.outroMs).toBe(live.outroMs);
    }
  });

  it("resolves the full mode exactly like playbackStepDurationForTempo composes it", () => {
    for (const tempo of TEMPI) {
      const live = PLAYBACK_TEMPO_PROFILES[tempo];
      const routeDistanceRadians = 0.42;
      const noteLength = 33;
      expect(resolveNarrativeTiming({ mode: "full", tempo, segmentKind: "intro" }))
        .toBe(live.introMs);
      expect(resolveNarrativeTiming({ mode: "full", tempo, segmentKind: "outro" }))
        .toBe(live.outroMs);
      expect(
        resolveNarrativeTiming({ mode: "full", tempo, segmentKind: "travel", routeDistanceRadians }),
      ).toBe(
        Math.round(
          Math.min(live.travelMaxMs, live.travelBaseMs + routeDistanceRadians * live.travelPerRadiansMs),
        ),
      );
      expect(
        resolveNarrativeTiming({ mode: "full", tempo, segmentKind: "arrival", noteLength }),
      ).toBe(
        Math.round(
          Math.min(live.arrivalMaxMs, live.arrivalBaseMs + noteLength * live.arrivalPerNoteCharMs),
        ),
      );
    }
  });

  it("keeps the quick recap dwell, camera and arrival numbers", () => {
    for (const tempo of AUTO_EDIT_TEMPOS) {
      for (const mediaRole of AUTO_EDIT_PHOTO_ROLES) {
        expect(
          resolveNarrativeTiming({
            mode: "quick-recap",
            tempo,
            segmentKind: "media",
            mediaKind: "image",
            mediaRole,
          }),
          `${tempo}/${mediaRole}`,
        ).toBe(QUICK_RECAP_IMAGE_DWELL_EXPECTED[tempo][mediaRole]);
      }

      expect(
        resolveNarrativeTiming({
          mode: "quick-recap",
          tempo,
          segmentKind: "media",
          mediaKind: "video",
          intrinsicDurationMs: 60_000,
        }),
        `${tempo} video budget`,
      ).toBe(QUICK_RECAP_VIDEO_EXPECTED[tempo]);

      // Decision D2 keeps the former flat constants as the zero-distance /
      // zero-note floor, so nothing changes for a same-place leg.
      expect(
        resolveNarrativeTiming({
          mode: "quick-recap",
          tempo,
          segmentKind: "travel",
          routeDistanceRadians: 0,
        }),
        `${tempo} zero-distance camera`,
      ).toBe(QUICK_RECAP_CAMERA_FLOOR_MS);
      expect(
        resolveNarrativeTiming({
          mode: "quick-recap",
          tempo,
          segmentKind: "arrival",
          noteLength: 0,
        }),
        `${tempo} zero-note arrival`,
      ).toBe(QUICK_RECAP_ARRIVAL_FLOOR_MS);
    }
  });

  it("makes a nearby and a long-haul quick recap leg differ (decision D2)", () => {
    for (const tempo of TEMPI) {
      const nearby = resolveNarrativeTiming({
        mode: "quick-recap",
        tempo,
        segmentKind: "travel",
        routeDistanceRadians: 0.001,
      });
      const longHaul = resolveNarrativeTiming({
        mode: "quick-recap",
        tempo,
        segmentKind: "travel",
        routeDistanceRadians: 2,
      });
      // A ~6 km leg still resolves to the flat camera duration, give or take
      // the rounding of a sub-millisecond distance term.
      expect(nearby, `${tempo} nearby stays at the floor`)
        .toBeGreaterThanOrEqual(QUICK_RECAP_CAMERA_FLOOR_MS);
      expect(nearby, `${tempo} nearby stays at the floor`)
        .toBeLessThanOrEqual(QUICK_RECAP_CAMERA_FLOOR_MS + 1);
      // An intercontinental leg no longer collapses to the same number.
      expect(longHaul, `${tempo} long haul exceeds the floor`)
        .toBeGreaterThan(QUICK_RECAP_CAMERA_FLOOR_MS + 1);
    }
  });

  it("keeps the keepsake numbers, identically at every tempo (decision D3)", () => {
    for (const tempo of TEMPI) {
      const seeded = NARRATIVE_TIMING_PROFILES.keepsake[tempo];
      expect(seeded.introMs, tempo).toBe(KEEPSAKE_EXPECTED.introMs);
      expect(seeded.travelBaseMs, tempo).toBe(KEEPSAKE_EXPECTED.travelBaseMs);
      expect(seeded.travelPerRadiansMs, tempo).toBe(KEEPSAKE_EXPECTED.travelPerRadiansMs);
      expect(seeded.travelMaxMs, tempo).toBe(KEEPSAKE_EXPECTED.travelMaxMs);
      expect(seeded.arrivalBaseMs, tempo).toBe(KEEPSAKE_EXPECTED.arrivalBaseMs);
      expect(seeded.arrivalPerNoteCharMs, tempo).toBe(KEEPSAKE_EXPECTED.arrivalPerNoteCharMs);
      expect(seeded.arrivalMaxMs, tempo).toBe(KEEPSAKE_EXPECTED.arrivalMaxMs);
      for (const role of AUTO_EDIT_PHOTO_ROLES) {
        expect(seeded.imageRoleMs[role], `${tempo}/${role}`).toBe(KEEPSAKE_EXPECTED.imageMs);
      }
      expect(seeded.videoMs, tempo).toBe(KEEPSAKE_EXPECTED.videoMs);
      expect(seeded.outroMs, tempo).toBe(KEEPSAKE_EXPECTED.outroMs);
    }
  });

  it("keeps the unmeasured video duration above every quick recap video budget", () => {
    for (const tempo of TEMPI) {
      expect(
        UNMEASURED_VIDEO_DURATION_MS,
        `${tempo} video budget`,
      ).toBeGreaterThan(NARRATIVE_TIMING_PROFILES["quick-recap"][tempo].videoMs);
    }
  });
});
