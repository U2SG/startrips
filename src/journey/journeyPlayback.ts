// #19 Journey Playback — a deterministic playback director.
//
// The director is a pure state machine: it never touches the Three scene, the
// DOM, or the audio element. It computes *what phase* playback is in and *for
// how long*, and the UI layer turns those into semantic commands (focus
// camera, show route progress, mount media). Keeping the machine pure makes
// the chapter order, timing mapping, and pause/resume behavior unit-testable.

import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

export type JourneyPlaybackPhase =
  | { type: "intro" }
  | { type: "travel"; from: number; to: number }
  | { type: "stop"; pointIndex: number }
  | { type: "media"; pointIndex: number; mediaIndex: number }
  | { type: "outro" }
  | { type: "paused"; previous: JourneyPlaybackPhase };

// Deterministic pacing (first version; no AI per-content timing).
export const PLAYBACK_PACING = {
  introMs: 1200,
  travelBaseMs: 900,
  travelPerRadiansMs: 600,
  travelMaxMs: 1600,
  stopMinMs: 1500,
  stopPerNoteCharMs: 24,
  stopMaxMs: 3000,
  imageMs: 4500,
  videoMs: 6000,
  outroMs: 1800,
} as const;

export function routePointAngularDistance(
  from: RoutePoint,
  to: RoutePoint,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRadians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function travelDurationMs(from: RoutePoint, to: RoutePoint): number {
  const distance = routePointAngularDistance(from, to);
  const duration = PLAYBACK_PACING.travelBaseMs
    + distance * PLAYBACK_PACING.travelPerRadiansMs;
  return Math.min(PLAYBACK_PACING.travelMaxMs, duration);
}

export function stopDurationMs(point: RoutePoint): number {
  const noteLength = point.note?.trim().length ?? 0;
  const duration = PLAYBACK_PACING.stopMinMs
    + noteLength * PLAYBACK_PACING.stopPerNoteCharMs;
  return Math.min(PLAYBACK_PACING.stopMaxMs, duration);
}

export type PlaybackMediaAvailability = "waiting" | "ready" | "error";
export type PlaybackMediaWaitPolicy = "none" | "decode" | "video-ended";

export function playbackMediaWaitPolicy(
  asset: JourneyMediaAsset | null | undefined,
  availability: PlaybackMediaAvailability,
): PlaybackMediaWaitPolicy {
  if (!asset || availability === "error") return "none";
  if (asset.mimeType.startsWith("video/")) return "video-ended";
  if (asset.mimeType.startsWith("image/") && availability === "waiting") return "decode";
  return "none";
}

export function mediaDurationMs(asset: JourneyMediaAsset): number {
  return asset.mimeType.startsWith("video/")
    ? PLAYBACK_PACING.videoMs
    : PLAYBACK_PACING.imageMs;
}

/**
 * The media of one route point in playback order (visual media only; the
 * soundtrack never enters the chapter stream).
 */
export function playbackMediaForPoint(
  journey: Journey,
  pointIndex: number,
): JourneyMediaAsset[] {
  const point = journey.routePoints[pointIndex];
  if (!point) return [];
  return journey.media
    .filter((asset) => asset.routePointId === point.id)
    .filter((asset) => !asset.mimeType.startsWith("audio/"))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/**
 * The journey-scoped visual media (routePointId null) shown in the intro.
 */
export function playbackIntroMedia(journey: Journey): JourneyMediaAsset[] {
  return journey.media
    .filter((asset) => asset.routePointId === null)
    .filter((asset) => !asset.mimeType.startsWith("audio/"))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/** Canonical Story media order for the whole Journey: intro media first, then
 * each route point's visual media in the same order used by Journey Playback. */
export function playbackStoryMedia(journey: Journey): JourneyMediaAsset[] {
  return [
    ...playbackIntroMedia(journey),
    ...journey.routePoints.flatMap((_, pointIndex) => playbackMediaForPoint(journey, pointIndex)),
  ];
}

/** Story browse scope: null means the aggregate Journey narrative, while a
 * route-point id keeps the existing chapter-only browsing mode. */
export function storyMediaForScope(
  journey: Journey,
  routePointId: string | null,
): JourneyMediaAsset[] {
  if (routePointId === null) return playbackStoryMedia(journey);
  const pointIndex = journey.routePoints.findIndex((point) => point.id === routePointId);
  return pointIndex >= 0 ? playbackMediaForPoint(journey, pointIndex) : [];
}

export type PlaybackStep =
  | { kind: "intro" }
  | { kind: "travel"; to: number }
  | { kind: "stop"; pointIndex: number; media: JourneyMediaAsset[] }
  | { kind: "media"; pointIndex: number; mediaIndex: number }
  | { kind: "outro" };

export type PlaybackTravelChoreography = "nearby" | "regional" | "long-haul";

export type PlaybackCameraTarget =
  | { kind: "route" }
  | { kind: "point"; pointIndex: number; choreography?: PlaybackTravelChoreography };

/**
 * Camera ownership follows the playback chapter, not the entry click:
 * intro/outro frame the whole Journey, while travel/stop/media stay spatially
 * anchored to the relevant route point. Media therefore inherits the stop's
 * point target instead of causing a second camera command.
 */
export function playbackTravelChoreography(
  journey: Journey,
  toPointIndex: number,
): PlaybackTravelChoreography {
  const to = journey.routePoints[toPointIndex];
  const from = journey.routePoints[toPointIndex - 1];
  if (!from || !to) return "regional";
  const degrees = routePointAngularDistance(from, to) * 180 / Math.PI;
  if (degrees < 6) return "nearby";
  if (degrees >= 55) return "long-haul";
  return "regional";
}

export function playbackCameraTargetForStep(
  step: PlaybackStep | undefined,
  journey?: Journey | null,
): PlaybackCameraTarget | null {
  if (!step) return null;
  switch (step.kind) {
    case "intro":
    case "outro":
      return { kind: "route" };
    case "travel":
      return {
        kind: "point",
        pointIndex: step.to,
        choreography: journey ? playbackTravelChoreography(journey, step.to) : undefined,
      };
    case "stop":
    case "media":
      return { kind: "point", pointIndex: step.pointIndex };
  }
}

export function playbackCameraTargetKey(target: PlaybackCameraTarget) {
  return target.kind === "route" ? "route" : `point:${target.pointIndex}`;
}

/**
 * Expand a journey into the ordered playback steps: intro -> for each point
 * (travel + stop + its media) -> outro. Points with no media and no note
 * still get a stop step (a quiet beat), so the route always reads as one
 * continuous narrative.
 */
export function buildPlaybackSteps(journey: Journey): PlaybackStep[] {
  const steps: PlaybackStep[] = [{ kind: "intro" }];
  for (let pointIndex = 0; pointIndex < journey.routePoints.length; pointIndex += 1) {
    const media = playbackMediaForPoint(journey, pointIndex);
    if (pointIndex > 0) steps.push({ kind: "travel", to: pointIndex });
    steps.push({ kind: "stop", pointIndex, media });
    for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex += 1) {
      steps.push({ kind: "media", pointIndex, mediaIndex });
    }
  }
  steps.push({ kind: "outro" });
  return steps;
}

/** Duration of one expanded step. */
export function stepDurationMs(
  journey: Journey,
  step: PlaybackStep,
): number {
  switch (step.kind) {
    case "intro":
      return PLAYBACK_PACING.introMs;
    case "travel": {
      const to = journey.routePoints[step.to];
      const from = journey.routePoints[Math.max(0, step.to - 1)];
      return travelDurationMs(from, to);
    }
    case "stop": {
      const point = journey.routePoints[step.pointIndex];
      return stopDurationMs(point);
    }
    case "media": {
      const point = journey.routePoints[step.pointIndex];
      const media = playbackMediaForPoint(journey, step.pointIndex);
      const asset = media[step.mediaIndex];
      if (!asset) return PLAYBACK_PACING.imageMs;
      return mediaDurationMs(asset);
    }
    case "outro":
      return PLAYBACK_PACING.outroMs;
  }
}

export type PlaybackControl =
  | { type: "advance" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "back" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "seek"; stepIndex: number }
  | { type: "exit" };

export type PlaybackState = {
  stepIndex: number;
  phase: JourneyPlaybackPhase;
  paused: boolean;
};

export function initialPlaybackState(): PlaybackState {
  return { stepIndex: 0, phase: { type: "intro" }, paused: false };
}

export function isMeaningfulPlaybackStep(step: PlaybackStep | undefined): boolean {
  return Boolean(step && step.kind !== "travel");
}

export function nextMeaningfulPlaybackStepIndex(
  steps: readonly PlaybackStep[],
  currentIndex: number,
): number {
  for (let index = Math.max(0, currentIndex + 1); index < steps.length; index += 1) {
    if (isMeaningfulPlaybackStep(steps[index])) return index;
  }
  return Math.min(Math.max(0, currentIndex), Math.max(0, steps.length - 1));
}

export function previousMeaningfulPlaybackStepIndex(
  steps: readonly PlaybackStep[],
  currentIndex: number,
): number {
  for (let index = Math.min(currentIndex - 1, steps.length - 1); index >= 0; index -= 1) {
    if (isMeaningfulPlaybackStep(steps[index])) return index;
  }
  return Math.min(Math.max(0, currentIndex), Math.max(0, steps.length - 1));
}

/**
 * Reduce a playback control against the current step index. Pure: returns the
 * next step index (and pause flag) without touching timers or DOM.
 */
export function playbackReducer(
  journey: Journey,
  state: PlaybackState,
  control: PlaybackControl,
): PlaybackState {
  const steps = buildPlaybackSteps(journey);
  const lastIndex = steps.length - 1;

  switch (control.type) {
    case "pause":
      return state.paused
        ? state
        : { ...state, paused: true, phase: { type: "paused", previous: state.phase } };
    case "resume":
      return state.paused && state.phase.type === "paused"
        ? { ...state, paused: false, phase: state.phase.previous }
        : state;
    case "advance": {
      const next = Math.min(lastIndex, state.stepIndex + 1);
      if (state.paused) return state;
      return { stepIndex: next, phase: phaseForStep(steps[next]), paused: false };
    }
    case "next": {
      if (state.paused) return state;
      const next = nextMeaningfulPlaybackStepIndex(steps, state.stepIndex);
      return { stepIndex: next, phase: phaseForStep(steps[next]), paused: false };
    }
    case "previous": {
      const previous = previousMeaningfulPlaybackStepIndex(steps, state.stepIndex);
      const phase = phaseForStep(steps[previous]);
      return state.paused
        ? { stepIndex: previous, phase: { type: "paused", previous: phase }, paused: true }
        : { stepIndex: previous, phase, paused: false };
    }
    case "back": {
      const previous = Math.max(0, state.stepIndex - 1);
      if (state.paused) return state;
      return { stepIndex: previous, phase: phaseForStep(steps[previous]), paused: false };
    }
    case "seek": {
      const stepIndex = Math.min(lastIndex, Math.max(0, Math.trunc(control.stepIndex)));
      const phase = phaseForStep(steps[stepIndex]);
      return state.paused
        ? { stepIndex, phase: { type: "paused", previous: phase }, paused: true }
        : { stepIndex, phase, paused: false };
    }
    case "exit":
      return state;
  }
}

export function phaseForStep(step: PlaybackStep): JourneyPlaybackPhase {
  switch (step.kind) {
    case "intro":
      return { type: "intro" };
    case "travel":
      return { type: "travel", from: Math.max(0, step.to - 1), to: step.to };
    case "stop":
      return { type: "stop", pointIndex: step.pointIndex };
    case "media":
      return { type: "media", pointIndex: step.pointIndex, mediaIndex: step.mediaIndex };
    case "outro":
      return { type: "outro" };
  }
}
