// #19 Journey Playback — a deterministic playback director.
//
// The director is a pure state machine: it never touches the Three scene, the
// DOM, or the audio element. It computes *what phase* playback is in, and the
// UI layer turns those into semantic commands (focus camera, show route
// progress, mount media). How long a phase lasts is not decided here —
// `narrativeTiming.ts` is the single resolver every mode asks. Keeping the
// machine pure makes the chapter order and pause/resume behavior unit-testable.

import type { HomeNarrativeContext, HomeNarrativeCameraTarget } from "./homeBasePrelude";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

export type JourneyPlaybackPhase =
  | { type: "home-prelude"; homeBaseId: string }
  | { type: "intro" }
  | { type: "travel"; from: number; to: number }
  | { type: "stop"; pointIndex: number }
  | { type: "media"; pointIndex: number; mediaIndex: number }
  | { type: "home-epilogue"; homeBaseId: string }
  | { type: "outro" }
  | { type: "completed" }
  | { type: "paused"; previous: JourneyPlaybackPhase };

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
  | { kind: "home-prelude"; cameraTarget: HomeNarrativeCameraTarget }
  | { kind: "intro" }
  | { kind: "travel"; to: number }
  | { kind: "stop"; pointIndex: number; media: JourneyMediaAsset[] }
  | { kind: "media"; pointIndex: number; mediaIndex: number }
  | { kind: "home-epilogue"; cameraTarget: HomeNarrativeCameraTarget }
  | { kind: "outro"; cameraTarget?: HomeNarrativeCameraTarget };

export type PlaybackTravelChoreography = "nearby" | "regional" | "long-haul";

export type PlaybackCameraTarget =
  | { kind: "route" }
  | { kind: "point"; pointIndex: number; choreography?: PlaybackTravelChoreography }
  | HomeNarrativeCameraTarget;

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
    case "home-prelude":
    case "home-epilogue":
      // Home remains camera-only narrative context. The target is carried by the
      // beat itself rather than reinterpreted as a Journey Route Point.
      return step.cameraTarget;
    case "intro":
      return { kind: "route" };
    case "outro":
      // An eligible Home epilogue owns the final life context through the
      // title/date fade and completion. Without Home, preserve route framing.
      return step.cameraTarget ?? { kind: "route" };
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
  if (target.kind === "route") return "route";
  if (target.kind === "home") return `home:${target.homeBaseId}`;
  return `point:${target.pointIndex}`;
}

/**
 * Expand a journey into the ordered playback steps: intro -> for each point
 * (travel + stop + its media) -> outro. Points with no media and no note
 * still get a stop step (a quiet beat), so the route always reads as one
 * continuous narrative.
 */
export function buildPlaybackSteps(
  journey: Journey,
  homeContext?: HomeNarrativeContext | null,
): PlaybackStep[] {
  const steps: PlaybackStep[] = [];
  if (homeContext?.prelude.eligible) {
    steps.push({ kind: "home-prelude", cameraTarget: homeContext.prelude.cameraTarget });
  }
  steps.push({ kind: "intro" });
  for (let pointIndex = 0; pointIndex < journey.routePoints.length; pointIndex += 1) {
    const media = playbackMediaForPoint(journey, pointIndex);
    if (pointIndex > 0) steps.push({ kind: "travel", to: pointIndex });
    steps.push({ kind: "stop", pointIndex, media });
    for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex += 1) {
      steps.push({ kind: "media", pointIndex, mediaIndex });
    }
  }
  const epilogueCameraTarget = homeContext?.epilogue.eligible
    ? homeContext.epilogue.cameraTarget
    : null;
  if (epilogueCameraTarget) {
    steps.push({ kind: "home-epilogue", cameraTarget: epilogueCameraTarget });
  }
  steps.push(epilogueCameraTarget
    ? { kind: "outro", cameraTarget: epilogueCameraTarget }
    : { kind: "outro" });
  return steps;
}

/**
 * A step's narrative identity, stable across a plan rebuild.
 *
 * A step index alone is meaningless once the plan changes: a rebuild at another
 * tempo can select more or fewer assets, so index 7 may be a different beat.
 * Identity is the route point id (travel / stop) or the asset id (media), which
 * survive the rebuild whenever the beat itself does.
 */
export function playbackStepIdentity(journey: Journey, step: PlaybackStep): string {
  switch (step.kind) {
    case "home-prelude":
      return `home-prelude:${step.cameraTarget.homeBaseId}`;
    case "intro":
      return "intro";
    case "home-epilogue":
      return `home-epilogue:${step.cameraTarget.homeBaseId}`;
    case "outro":
      return "outro";
    case "travel":
      return `travel:${journey.routePoints[step.to]?.id ?? step.to}`;
    case "stop":
      return `stop:${journey.routePoints[step.pointIndex]?.id ?? step.pointIndex}`;
    case "media": {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      return `media:${asset?.id ?? `${step.pointIndex}:${step.mediaIndex}`}`;
    }
  }
}

export type CommittedPlaybackPosition = {
  journeyId: string;
  routePointId: string | null;
  assetId: string | null;
};

/**
 * Resolve return identity from the step React has already committed. Pending
 * seek targets and camera commands never enter this helper, so they cannot
 * masquerade as something the viewer has actually reached.
 */
export function committedPlaybackPosition(
  journey: Journey,
  committedStep: PlaybackStep | undefined,
): CommittedPlaybackPosition {
  if (!committedStep) {
    return { journeyId: journey.id, routePointId: null, assetId: null };
  }
  switch (committedStep.kind) {
    case "home-prelude":
    case "home-epilogue":
    case "intro":
    case "outro":
      return { journeyId: journey.id, routePointId: null, assetId: null };
    case "travel":
      return {
        journeyId: journey.id,
        routePointId: journey.routePoints[committedStep.to]?.id ?? null,
        assetId: null,
      };
    case "stop":
      return {
        journeyId: journey.id,
        routePointId: journey.routePoints[committedStep.pointIndex]?.id ?? null,
        assetId: null,
      };
    case "media": {
      const routePointId = journey.routePoints[committedStep.pointIndex]?.id ?? null;
      const asset = playbackMediaForPoint(journey, committedStep.pointIndex)[committedStep.mediaIndex];
      return { journeyId: journey.id, routePointId, assetId: asset?.id ?? null };
    }
  }
}

/**
 * Advance the return commit log only when the presentation owner confirms that
 * the current media asset actually owns the visible slot. A failed or stale
 * request therefore leaves the last successfully committed position intact.
 */
export function commitPresentedPlaybackPosition(
  previous: CommittedPlaybackPosition | null,
  journey: Journey,
  committedStep: PlaybackStep | undefined,
  presentedAssetId: string,
): CommittedPlaybackPosition | null {
  if (!committedStep || committedStep.kind !== "media") return previous;
  const next = committedPlaybackPosition(journey, committedStep);
  return next.assetId === presentedAssetId ? next : previous;
}

export type PlaybackControl =
  | { type: "advance" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "back" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "replay" }
  | { type: "seek"; stepIndex: number }
  | { type: "exit" };

export type PlaybackState = {
  stepIndex: number;
  phase: JourneyPlaybackPhase;
  paused: boolean;
};

export function initialPlaybackState(homeContext?: HomeNarrativeContext | null): PlaybackState {
  if (homeContext?.prelude.eligible) {
    return {
      stepIndex: 0,
      phase: { type: "home-prelude", homeBaseId: homeContext.prelude.cameraTarget.homeBaseId },
      paused: false,
    };
  }
  return { stepIndex: 0, phase: { type: "intro" }, paused: false };
}

/** Terminal is a transport state, not an alias for "paused" or "not started". */
export function isPlaybackTerminalState(state: PlaybackState): boolean {
  return state.phase.type === "completed";
}

export function isMeaningfulPlaybackStep(step: PlaybackStep | undefined): boolean {
  return Boolean(step && step.kind !== "travel");
}

/** The indexes of the beats next / back may land on: everything but travel. */
export function meaningfulPlaybackStepIndexes(steps: readonly PlaybackStep[]): number[] {
  return steps.flatMap((step, index) => (isMeaningfulPlaybackStep(step) ? [index] : []));
}

/**
 * The one implementation of "the next meaningful moment in this direction".
 *
 * It takes the meaningful indexes rather than the steps so the elapsed-time
 * plan (`journeyPlaybackPlan.ts`, which already carries
 * `meaningfulStepIndexes`) and `playbackReducer` share this scan instead of
 * keeping a second copy that can drift from it. Landing on nothing keeps the
 * current beat: reaching the end of the Journey is not a reason to jump.
 */
export function meaningfulPlaybackStepIndex(
  meaningfulStepIndexes: readonly number[],
  currentStepIndex: number,
  direction: 1 | -1,
): number {
  const found = direction > 0
    ? meaningfulStepIndexes.find((index) => index > currentStepIndex)
    : [...meaningfulStepIndexes].reverse().find((index) => index < currentStepIndex);
  if (found !== undefined) return found;
  return Math.min(Math.max(0, currentStepIndex), Math.max(0, meaningfulStepIndexes.at(-1) ?? 0));
}

/**
 * Reduce a playback control against the current step index. Pure: returns the
 * next step index (and pause flag) without touching timers or DOM.
 */
export function playbackReducer(
  journey: Journey,
  state: PlaybackState,
  control: PlaybackControl,
  homeContext?: HomeNarrativeContext | null,
): PlaybackState {
  const steps = buildPlaybackSteps(journey, homeContext);
  const lastIndex = steps.length - 1;

  const stateForStep = (stepIndex: number): PlaybackState => {
    const phase = phaseForStep(steps[stepIndex]);
    return state.paused
      ? { stepIndex, phase: { type: "paused", previous: phase }, paused: true }
      : { stepIndex, phase, paused: false };
  };

  switch (control.type) {
    case "pause":
      return state.paused || isPlaybackTerminalState(state)
        ? state
        : { ...state, paused: true, phase: { type: "paused", previous: state.phase } };
    case "resume":
      return state.paused && state.phase.type === "paused"
        ? { ...state, paused: false, phase: state.phase.previous }
        : state;
    case "advance": {
      if (isPlaybackTerminalState(state)) return state;
      if (state.paused) {
        const next = meaningfulPlaybackStepIndex(
          meaningfulPlaybackStepIndexes(steps),
          state.stepIndex,
          1,
        );
        return stateForStep(next);
      }
      if (state.stepIndex >= lastIndex) {
        return { stepIndex: lastIndex, phase: { type: "completed" }, paused: false };
      }
      return stateForStep(state.stepIndex + 1);
    }
    case "next": {
      if (isPlaybackTerminalState(state)) return state;
      const next = meaningfulPlaybackStepIndex(meaningfulPlaybackStepIndexes(steps), state.stepIndex, 1);
      return stateForStep(next);
    }
    case "previous": {
      const previous = meaningfulPlaybackStepIndex(
        meaningfulPlaybackStepIndexes(steps),
        state.stepIndex,
        -1,
      );
      return stateForStep(previous);
    }
    case "back": {
      const previous = state.paused
        ? meaningfulPlaybackStepIndex(
          meaningfulPlaybackStepIndexes(steps),
          state.stepIndex,
          -1,
        )
        : Math.max(0, state.stepIndex - 1);
      return stateForStep(previous);
    }
    case "replay":
      return initialPlaybackState(homeContext);
    case "seek": {
      const stepIndex = Math.min(lastIndex, Math.max(0, Math.trunc(control.stepIndex)));
      return stateForStep(stepIndex);
    }
    case "exit":
      return state;
  }
}

export function phaseForStep(step: PlaybackStep): JourneyPlaybackPhase {
  switch (step.kind) {
    case "home-prelude":
      return { type: "home-prelude", homeBaseId: step.cameraTarget.homeBaseId };
    case "intro":
      return { type: "intro" };
    case "travel":
      return { type: "travel", from: Math.max(0, step.to - 1), to: step.to };
    case "stop":
      return { type: "stop", pointIndex: step.pointIndex };
    case "media":
      return { type: "media", pointIndex: step.pointIndex, mediaIndex: step.mediaIndex };
    case "home-epilogue":
      return { type: "home-epilogue", homeBaseId: step.cameraTarget.homeBaseId };
    case "outro":
      return { type: "outro" };
  }
}
