import {
  buildPlaybackSteps,
  playbackIntroMedia,
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
  stepIndex: number;
  sourceStepIndex: number;
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

function durationForStep(
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
 * Playback V2 full-Journey planner. Every canonical visual asset remains in
 * the plan; tempo changes phase-specific timing rather than multiplying one
 * global speed constant.
 */
export function buildPlaybackPlan(
  journey: Journey,
  tempo: PlaybackTempo = "standard",
): PlaybackPlan {
  const profile = PLAYBACK_TEMPO_PROFILES[tempo];
  const steps = buildPlaybackSteps(journey);
  const drafts: Array<{
    identity: PlaybackSegmentIdentity;
    durationMs: number;
    sourceStepIndex: number;
  }> = [];
  steps.forEach((step, sourceStepIndex) => {
    drafts.push({
      identity: segmentIdentity(journey, step, sourceStepIndex),
      durationMs: durationForStep(journey, step, profile),
      sourceStepIndex,
    });
    if (step.kind !== "intro") return;
    for (const asset of playbackIntroMedia(journey)) {
      drafts.push({
        identity: {
          id: `media:${asset.id}`,
          kind: "media" as const,
          routePointId: null,
          assetId: asset.id,
        },
        durationMs: asset.mimeType.startsWith("video/") ? profile.videoMs : profile.imageMs,
        sourceStepIndex,
      });
    }
  });

  let cursorMs = 0;
  const segments = drafts.map((draft, stepIndex) => {
    const segment: PlannedPlaybackSegment = {
      ...draft.identity,
      stepIndex,
      sourceStepIndex: draft.sourceStepIndex,
      startMs: cursorMs,
      durationMs: draft.durationMs,
    };
    cursorMs += draft.durationMs;
    return segment;
  });
  return {
    tempo,
    segments,
    totalDurationMs: cursorMs,
    meaningfulStepIndexes: segments
      .filter((segment) => segment.kind !== "travel")
      .map((segment) => segment.stepIndex),
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

export function nextMeaningfulStepIndex(
  plan: PlaybackPlan,
  currentStepIndex: number,
  direction: 1 | -1,
) {
  const indexes = plan.meaningfulStepIndexes;
  if (indexes.length === 0) return currentStepIndex;
  if (direction > 0) {
    return indexes.find((index) => index > currentStepIndex) ?? indexes.at(-1)!;
  }
  return [...indexes].reverse().find((index) => index < currentStepIndex) ?? indexes[0];
}
