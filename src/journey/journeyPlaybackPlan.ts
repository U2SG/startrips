import {
  buildPlaybackSteps,
  meaningfulPlaybackStepIndex,
  meaningfulPlaybackStepIndexes,
  playbackMediaForPoint,
  routePointAngularDistance,
  type PlaybackStep,
} from "./journeyPlayback";
import type { HomeNarrativeContext } from "./homeBasePrelude";
import {
  NARRATIVE_TIMING_PROFILES,
  resolveNarrativeTiming,
  type NarrativeTempo,
  type NarrativeTimingProfile,
} from "./narrativeTiming";
import type { Journey, JourneyMediaAsset } from "./types";

export type PlaybackTempo = NarrativeTempo;

export type PlannedPlaybackSegment = {
  id: string;
  kind: "home-prelude" | "intro" | "travel" | "arrival" | "media" | "home-epilogue" | "outro";
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
  profile: NarrativeTimingProfile,
) {
  const asset = step.kind === "media"
    ? playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex]
    : undefined;
  return playbackStepDuration(journey, step, profile, asset);
}

function playbackStepDuration(
  journey: Journey,
  step: PlaybackStep,
  profile: NarrativeTimingProfile,
  asset: JourneyMediaAsset | undefined,
) {
  switch (step.kind) {
    case "home-prelude":
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
    case "media":
      return asset?.mimeType.startsWith("video/") ? profile.videoMs : profile.imageRoleMs.representative;
    case "home-epilogue":
    case "outro":
      return profile.outroMs;
  }
}

/**
 * An override for one beat's length.
 *
 * Declared here, beside the live duration formula, because both the director and
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
 * The director's timer and `buildPlaybackPlan` share this policy, so a plan-driven
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
  return resolvePlaybackStepDurationWithFallback(
    journey,
    step,
    tempo,
    resolveStepDuration,
    () => playbackStepDurationForTempo(journey, step, NARRATIVE_TIMING_PROFILES.full[tempo]),
  );
}

function resolvePlaybackStepDurationWithFallback(
  journey: Journey,
  step: PlaybackStep,
  tempo: PlaybackTempo,
  resolveStepDuration: PlaybackStepDurationResolver | undefined,
  fallbackDuration: () => number,
): number {
  const overrideDurationMs = resolveStepDuration?.(journey, step, tempo);
  if (overrideDurationMs !== undefined
    && Number.isFinite(overrideDurationMs)
    && overrideDurationMs >= 0) {
    return overrideDurationMs;
  }
  if (step.kind === "home-prelude" || step.kind === "home-epilogue") {
    return resolveNarrativeTiming({ mode: "full", tempo, segmentKind: step.kind });
  }
  return fallbackDuration();
}

type PlaybackSegmentIdentity = Pick<
  PlannedPlaybackSegment,
  "id" | "kind" | "routePointId" | "assetId"
>;

function segmentIdentity(
  journey: Journey,
  step: PlaybackStep,
  stepIndex: number,
  asset: JourneyMediaAsset | undefined,
): PlaybackSegmentIdentity {
  switch (step.kind) {
    case "home-prelude":
      return {
        id: `home-prelude:${step.cameraTarget.homeBaseId}`,
        kind: "home-prelude" as const,
        routePointId: null,
      };
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
      return {
        id: `media:${asset?.id ?? stepIndex}`,
        kind: "media" as const,
        routePointId: point?.id ?? null,
        ...(asset ? { assetId: asset.id } : {}),
      };
    }
    case "home-epilogue":
      return {
        id: `home-epilogue:${step.cameraTarget.homeBaseId}`,
        kind: "home-epilogue" as const,
        routePointId: null,
      };
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
  homeContext?: HomeNarrativeContext | null,
): PlaybackPlan {
  const steps = buildPlaybackSteps(journey, homeContext);
  let cursorMs = 0;
  let currentChapterMedia: readonly JourneyMediaAsset[] = [];
  const segments = steps.map((step, stepIndex) => {
    // Every chapter's stop precedes its media and already owns the sorted list.
    if (step.kind === "stop") currentChapterMedia = step.media;
    const asset = step.kind === "media" ? currentChapterMedia[step.mediaIndex] : undefined;
    const durationMs = resolvePlaybackStepDurationWithFallback(
      journey,
      step,
      tempo,
      resolveStepDuration,
      () => playbackStepDuration(journey, step, NARRATIVE_TIMING_PROFILES.full[tempo], asset),
    );
    const segment: PlannedPlaybackSegment = {
      ...segmentIdentity(journey, step, stepIndex, asset),
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
