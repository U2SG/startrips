import {
  buildPlaybackSteps,
  meaningfulPlaybackStepIndex,
  meaningfulPlaybackStepIndexes,
  playbackMediaForPoint,
  routePointAngularDistance,
  type PlaybackStep,
} from "./journeyPlayback";
import type { Journey } from "./types";

export type PlaybackTempo = "fast" | "standard" | "immersive";

export type PlaybackTempoProfile = {
  introMs: number;
  travelBaseMs: number;
  travelPerRadiansMs: number;
  travelMaxMs: number;
  arrivalBaseMs: number;
  arrivalPerNoteCharMs: number;
  arrivalMaxMs: number;
  imageMs: number;
  videoMs: number;
  outroMs: number;
};

export const PLAYBACK_TEMPO_PROFILES: Record<PlaybackTempo, PlaybackTempoProfile> = {
  fast: {
    introMs: 800,
    travelBaseMs: 420,
    travelPerRadiansMs: 300,
    travelMaxMs: 1000,
    arrivalBaseMs: 650,
    arrivalPerNoteCharMs: 10,
    arrivalMaxMs: 1000,
    imageMs: 1700,
    videoMs: 4200,
    outroMs: 1000,
  },
  standard: {
    introMs: 1100,
    travelBaseMs: 650,
    travelPerRadiansMs: 450,
    travelMaxMs: 1400,
    arrivalBaseMs: 950,
    arrivalPerNoteCharMs: 14,
    arrivalMaxMs: 1500,
    imageMs: 2800,
    videoMs: 6000,
    outroMs: 1500,
  },
  immersive: {
    introMs: 1400,
    travelBaseMs: 900,
    travelPerRadiansMs: 650,
    travelMaxMs: 1900,
    arrivalBaseMs: 1500,
    arrivalPerNoteCharMs: 18,
    arrivalMaxMs: 2600,
    imageMs: 4500,
    videoMs: 8000,
    outroMs: 2000,
  },
};

export type PlannedPlaybackSegment = {
  id: string;
  kind: "intro" | "travel" | "arrival" | "media" | "outro";
  /** The index of this beat in `buildPlaybackSteps(journey)` — the same index
   * the director seeks to. The plan describes the beats that actually play. */
  stepIndex: number;
  routePointId: string | null;
  assetId?: string;
  startMs: number;
  durationMs: number;
};

export type PlaybackPlan = {
  tempo: PlaybackTempo;
  segments: PlannedPlaybackSegment[];
  totalDurationMs: number;
  meaningfulStepIndexes: number[];
};

export function playbackStepDurationForTempo(
  journey: Journey,
  step: PlaybackStep,
  profile: PlaybackTempoProfile,
) {
  switch (step.kind) {
    case "intro":
      return profile.introMs;
    case "travel": {
      const to = journey.routePoints[step.to];
      const from = journey.routePoints[Math.max(0, step.to - 1)];
      if (!from || !to) return profile.travelBaseMs;
      return Math.min(
        profile.travelMaxMs,
        profile.travelBaseMs + routePointAngularDistance(from, to) * profile.travelPerRadiansMs,
      );
    }
    case "stop": {
      const point = journey.routePoints[step.pointIndex];
      const noteLength = point?.note?.trim().length ?? 0;
      return Math.min(
        profile.arrivalMaxMs,
        profile.arrivalBaseMs + noteLength * profile.arrivalPerNoteCharMs,
      );
    }
    case "media": {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      return asset?.mimeType.startsWith("video/") ? profile.videoMs : profile.imageMs;
    }
    case "outro":
      return profile.outroMs;
  }
}

/**
 * An override for one beat's length.
 *
 * Declared here, beside the tempo profiles, because both the live director and
 * the elapsed-time plan resolve durations through the same call; the director
 * re-exports the type from its own module for its callers.
 */
export type PlaybackStepDurationResolver = (
  journey: Journey,
  step: PlaybackStep,
  tempo: PlaybackTempo,
) => number | undefined;

/**
 * The single place a beat becomes a number of milliseconds: the injected
 * resolver when it answers with a usable number, the tempo profile otherwise.
 * The director's timer and `buildPlaybackPlan` both call this, so a plan-driven
 * progress bar cannot disagree with the timer that is draining — in Quick Recap
 * the resolver overrides most beats, and a plan that ignored it would place
 * every later beat at the wrong point on the bar.
 */
export function resolvePlaybackStepDurationMs(
  journey: Journey,
  step: PlaybackStep,
  tempo: PlaybackTempo,
  resolveStepDuration?: PlaybackStepDurationResolver,
): number {
  const overrideDurationMs = resolveStepDuration?.(journey, step, tempo);
  return overrideDurationMs !== undefined
    && Number.isFinite(overrideDurationMs)
    && overrideDurationMs >= 0
    ? overrideDurationMs
    : playbackStepDurationForTempo(journey, step, PLAYBACK_TEMPO_PROFILES[tempo]);
}

type PlaybackSegmentIdentity = Pick<
  PlannedPlaybackSegment,
  "id" | "kind" | "routePointId" | "assetId"
>;

function segmentIdentity(
  journey: Journey,
  step: PlaybackStep,
  stepIndex: number,
): PlaybackSegmentIdentity {
  switch (step.kind) {
    case "intro":
      return { id: "intro", kind: "intro" as const, routePointId: null };
    case "travel": {
      const point = journey.routePoints[step.to];
      return {
        id: `travel:${point?.id ?? step.to}`,
        kind: "travel" as const,
        routePointId: point?.id ?? null,
      };
    }
    case "stop": {
      const point = journey.routePoints[step.pointIndex];
      return {
        id: `arrival:${point?.id ?? step.pointIndex}`,
        kind: "arrival" as const,
        routePointId: point?.id ?? null,
      };
    }
    case "media": {
      const point = journey.routePoints[step.pointIndex];
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      return {
        id: `media:${asset?.id ?? stepIndex}`,
        kind: "media" as const,
        routePointId: point?.id ?? null,
        ...(asset ? { assetId: asset.id } : {}),
      };
    }
    case "outro":
      return { id: "outro", kind: "outro" as const, routePointId: null };
  }
}

/**
 * Playback V2 full-Journey planner.
 *
 * One segment per beat of `buildPlaybackSteps`, in the same order and at the
 * same index, so a segment can be seeked to directly and an elapsed time can be
 * turned into a step index. Tempo changes phase-specific timing rather than
 * multiplying one global speed constant, and an injected resolver overrides a
 * beat exactly as it does for the director's timer.
 */
export function buildPlaybackPlan(
  journey: Journey,
  tempo: PlaybackTempo = "standard",
  resolveStepDuration?: PlaybackStepDurationResolver,
): PlaybackPlan {
  const steps = buildPlaybackSteps(journey);
  let cursorMs = 0;
  const segments = steps.map((step, stepIndex) => {
    const durationMs = resolvePlaybackStepDurationMs(journey, step, tempo, resolveStepDuration);
    const segment: PlannedPlaybackSegment = {
      ...segmentIdentity(journey, step, stepIndex),
      stepIndex,
      startMs: cursorMs,
      durationMs,
    };
    cursorMs += durationMs;
    return segment;
  });
  return {
    tempo,
    segments,
    totalDurationMs: cursorMs,
    meaningfulStepIndexes: meaningfulPlaybackStepIndexes(steps),
  };
}

export function playbackSegmentAtElapsed(
  plan: PlaybackPlan,
  elapsedMs: number,
): PlannedPlaybackSegment | null {
  if (plan.segments.length === 0) return null;
  const clamped = Math.min(Math.max(0, elapsedMs), plan.totalDurationMs);
  return plan.segments.find((segment) => (
    clamped < segment.startMs + segment.durationMs
  )) ?? plan.segments.at(-1)!;
}

export function playbackElapsedForFraction(plan: PlaybackPlan, fraction: number) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return plan.totalDurationMs * clamped;
}

/** The plan's view of next / back. The scan itself lives in `journeyPlayback.ts`
 * and is the same one `playbackReducer` runs, so the timeline and the transport
 * can never disagree about which beats next and back may land on. */
export function nextMeaningfulStepIndex(
  plan: PlaybackPlan,
  currentStepIndex: number,
  direction: 1 | -1,
) {
  return meaningfulPlaybackStepIndex(plan.meaningfulStepIndexes, currentStepIndex, direction);
}
