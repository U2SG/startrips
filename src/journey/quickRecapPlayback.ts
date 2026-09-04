import {
  buildDeterministicQuickRecapPlan,
  type AutoEditPlanV1,
  type AutoEditTempo,
  type MediaDigestV1,
} from "./autoEditPlan";
import {
  playbackMediaForPoint,
  routePointAngularDistance,
  type PlaybackStep,
} from "./journeyPlayback";
import { isSoundtrackAsset, isVisualMediaAsset } from "./journeyModel";
import { UNMEASURED_VIDEO_DURATION_MS, resolveNarrativeTiming } from "./narrativeTiming";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

export const QUICK_RECAP_TARGET_MS = 45_000;

// #195 Phase 1: no video duration is persisted with a media asset and the
// browser cannot read one synchronously here, so a video digest declares this
// explicit analysis-pending duration instead of an empty `intrinsic`. The
// plan's video eligibility rule rejects an absent, non-finite, or non-positive
// duration, which would delete the route point's only chapter — the regression
// this replaces. The resolver owns the one number for "how long an unmeasured
// video is worth"; because it exceeds every per-tempo video dwell, the
// planner's own clamp still decides the real length.
export const QUICK_RECAP_PENDING_VIDEO_DURATION_MS = UNMEASURED_VIDEO_DURATION_MS;

export type PreparedQuickRecapPlayback = {
  journey: Journey;
  plan: AutoEditPlanV1;
};

export type QuickRecapFallbackReason = "no-visual-media" | "over-budget";

export type QuickRecapPreparationResult =
  | { playback: PreparedQuickRecapPlayback; fallbackReason: null }
  | { playback: null; fallbackReason: QuickRecapFallbackReason };

function visualMediaType(asset: JourneyMediaAsset): "image" | "video" {
  return asset.mimeType.startsWith("video/") ? "video" : "image";
}

// The explicit Journey cover opens the recap as the first chapter hero, but
// only when moving it cannot empty the route point that owns it. When the cover
// is that point's only visual media, relocating it would leave the chapter
// without a single candidate and the route point would disappear from the recap
// — the same topology loss as #195 itself. Such a cover stays where it belongs
// and simply does not open the recap; it still carries the cover user signal,
// so it remains its own chapter's mandatory representative.
function openingCoverAsset(
  journey: Journey,
  visualMedia: readonly JourneyMediaAsset[],
): JourneyMediaAsset | null {
  const firstRoutePointId = journey.routePoints[0]?.id ?? null;
  if (!firstRoutePointId || !journey.coverMediaAssetId) return null;
  const cover = visualMedia.find((asset) => asset.id === journey.coverMediaAssetId);
  if (!cover) return null;
  if (cover.routePointId === null || cover.routePointId === firstRoutePointId) return cover;
  const ownerKeepsVisualMedia = visualMedia.some((asset) => (
    asset.id !== cover.id && asset.routePointId === cover.routePointId
  ));
  return ownerKeepsVisualMedia ? cover : null;
}

// #195: Startrips is photo-first, not photo-only. Every playable visual asset
// is a recap candidate so a route point whose only media is a video keeps its
// chapter; only the soundtrack is excluded, matching Full Playback's chapter
// stream (`playbackMediaForPoint`).
function runtimeVisualCandidates(journey: Journey): JourneyMediaAsset[] {
  const firstRoutePointId = journey.routePoints[0]?.id ?? null;
  const visualMedia = journey.media.filter(isVisualMediaAsset);
  const openingCoverId = openingCoverAsset(journey, visualMedia)?.id ?? null;
  return visualMedia
    .flatMap((asset) => {
      if (asset.id === openingCoverId && firstRoutePointId) {
        // Playback projection only: synthetic ordering is scoped to the
        // projection; persisted ownership/sort order remain untouched.
        return [{ ...asset, routePointId: firstRoutePointId, sortOrder: Number.MIN_SAFE_INTEGER }];
      }
      if (asset.routePointId !== null) return [asset];
      if (firstRoutePointId) {
        // Journey-scoped visual media is a valid presentation scope, but the live
        // Playback step model only renders media inside route-point chapters.
        // Project them into the first playable chapter for Quick Recap only.
        return [{ ...asset, routePointId: firstRoutePointId }];
      }
      return [];
    })
    // Cover-first ordering applies only to a relocated cover. A cover left with
    // its own route point must keep its natural source order, so it cannot be
    // hoisted ahead of the chapters that precede it.
    .sort((left, right) => {
      if (left.id === openingCoverId && right.id !== openingCoverId) return -1;
      if (right.id === openingCoverId && left.id !== openingCoverId) return 1;
      return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
    });
}

export function quickRecapDigestsForJourney(journey: Journey): MediaDigestV1[] {
  return runtimeVisualCandidates(journey).map<MediaDigestV1>((asset, sourceIndex) => {
    const mediaType = visualMediaType(asset);
    return {
      schemaVersion: 1,
      assetId: asset.id,
      journeyId: journey.id,
      routePointId: asset.routePointId,
      sourceRevision: String(journey.revision),
      mediaType,
      mimeType: asset.mimeType,
      sourceIndex,
      intrinsic: mediaType === "video"
        ? { durationMs: QUICK_RECAP_PENDING_VIDEO_DURATION_MS }
        : {},
      userSignals: {
        isJourneyCover: asset.id === journey.coverMediaAssetId,
        pinnedForRecap: false,
        excludedFromRecap: false,
      },
    };
  });
}

export function prepareQuickRecapPlaybackResult(
  journey: Journey,
  options: {
    generatedAt: string;
    targetDurationMs?: number;
    tempo?: AutoEditTempo;
  },
): QuickRecapPreparationResult {
  if (journey.routePoints.length === 0) return { playback: null, fallbackReason: "no-visual-media" };
  const digests = quickRecapDigestsForJourney(journey);
  if (digests.length === 0) return { playback: null, fallbackReason: "no-visual-media" };

  const candidateRoutePointIds = journey.routePoints
    .filter((point) => digests.some((digest) => digest.routePointId === point.id))
    .map((point) => point.id);
  if (candidateRoutePointIds.length === 0) return { playback: null, fallbackReason: "no-visual-media" };

  const requestedTargetMs = options.targetDurationMs ?? QUICK_RECAP_TARGET_MS;
  const tempo = options.tempo ?? "standard";
  // The recap's chapter budget is what is left of the target once the intro and
  // outro beats are paid for. Those two are the only beats the director still
  // times itself (`quickRecapStepDurationMs` returns undefined for them), so the
  // budget must subtract the numbers that actually play — the resolver's
  // per-tempo intro/outro — instead of the flat 1200 + 1800 the deleted legacy
  // pacing table carried, which no mode has spent since the tempo profiles
  // landed.
  const chapterBudgetMs = Math.max(
    1,
    requestedTargetMs
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "intro" })
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "outro" }),
  );
  const plan = buildDeterministicQuickRecapPlan({
    journeyId: journey.id,
    journeyRevision: String(journey.revision),
    routePointIds: candidateRoutePointIds,
    digests,
    targetDurationMs: chapterBudgetMs,
    tempo,
    generatedAt: options.generatedAt,
  });
  if (plan.plannedDurationMs > chapterBudgetMs) return { playback: null, fallbackReason: "over-budget" };
  const selectedIds = new Set(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId)));
  if (selectedIds.size === 0) return { playback: null, fallbackReason: "no-visual-media" };
  const plannedRoutePointIds = new Set(plan.chapters.map((chapter) => chapter.routePointId));
  const projectedRoutePoints = journey.routePoints.filter((point) => plannedRoutePointIds.has(point.id));
  if (projectedRoutePoints.length === 0) return { playback: null, fallbackReason: "no-visual-media" };

  const projectedCandidates = new Map(runtimeVisualCandidates(journey).map((asset) => [asset.id, asset]));
  const projectedMedia = journey.media.flatMap((asset) => {
    if (isSoundtrackAsset(asset)) return [asset];
    if (!selectedIds.has(asset.id)) return [];
    return [projectedCandidates.get(asset.id) ?? asset];
  });

  return {
    fallbackReason: null,
    playback: {
      plan,
      journey: { ...journey, routePoints: projectedRoutePoints, media: projectedMedia },
    },
  };
}

export function prepareQuickRecapPlayback(
  journey: Journey,
  options: {
    generatedAt: string;
    targetDurationMs?: number;
    tempo?: AutoEditTempo;
  },
): PreparedQuickRecapPlayback | null {
  return prepareQuickRecapPlaybackResult(journey, options).playback;
}

function noteLengthFor(point: RoutePoint) {
  return point.note?.trim().length ?? 0;
}

/**
 * How long one Quick Recap beat lasts at the runtime tempo.
 *
 * The Edit Plan stays the source of *what* plays and in what order: a step
 * whose route point has no chapter, or whose asset the plan did not select,
 * still resolves to `undefined` and falls through to Full Playback's timing.
 * What the plan no longer decides is *how long*. Travel and arrival used to be
 * read straight out of the frozen plan, where they were one flat camera and one
 * flat arrival value per route point, planned once at `standard` for the whole
 * session; they now go through `resolveNarrativeTiming` with the real route
 * geometry and note length, so the recap answers the tempo control and a nearby
 * leg stops being paced like an intercontinental one (decisions D1 and D2).
 *
 * Media dwell stays pinned by the plan, because the plan's greedy selection
 * budget was measured against exactly those milliseconds; overriding it here
 * would spend a length the budget never booked. Dwell is already tempo-aware
 * and a tempo change rebuilds the plan, so it follows tempo through the plan
 * rather than around it. The resolver only supplies a dwell the plan left
 * unpinned.
 *
 * `intro` / `outro` return `undefined` on purpose: the director spends the live
 * tempo profile for those two beats, and `prepareQuickRecapPlaybackResult`
 * budgets against the same numbers.
 */
export function quickRecapStepDurationMs(
  journey: Journey,
  step: PlaybackStep,
  plan: AutoEditPlanV1,
  tempo: AutoEditTempo = "standard",
): number | undefined {
  if (step.kind === "intro" || step.kind === "outro") return undefined;
  const pointIndex = step.kind === "travel" ? step.to : step.pointIndex;
  const point = journey.routePoints[pointIndex];
  if (!point) return undefined;
  const chapter = plan.chapters.find((candidate) => candidate.routePointId === point.id);
  if (!chapter) return undefined;

  const cameraMs = (index: number) => {
    const from = journey.routePoints[index - 1];
    const to = journey.routePoints[index];
    return resolveNarrativeTiming({
      mode: "quick-recap",
      tempo,
      segmentKind: "travel",
      // The first route point has no leg to fly, so it resolves to the floor.
      routeDistanceRadians: from && to ? routePointAngularDistance(from, to) : undefined,
    });
  };

  if (step.kind === "travel") return cameraMs(step.to);
  if (step.kind === "stop") {
    // Point 0 has no travel step in front of it, so its chapter camera is paid
    // for inside the stop — the same fold the frozen-plan reader performed.
    const firstPointCameraMs = step.pointIndex === 0 ? cameraMs(0) : 0;
    if (!chapter.arrival) return firstPointCameraMs;
    return firstPointCameraMs + resolveNarrativeTiming({
      mode: "quick-recap",
      tempo,
      segmentKind: "arrival",
      noteLength: noteLengthFor(point),
    });
  }

  const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
  if (!asset) return undefined;
  const item = chapter.items.find((candidate) => candidate.assetId === asset.id);
  if (!item) return undefined;
  if (item.dwellMs !== undefined) return item.dwellMs;
  if (item.trim) return item.trim.outMs - item.trim.inMs;
  return resolveNarrativeTiming({
    mode: "quick-recap",
    tempo,
    segmentKind: "media",
    mediaKind: visualMediaType(asset),
    mediaRole: item.photoRole,
  });
}

/**
 * Where playback lands after a Quick Recap plan rebuild.
 *
 * The rule: keep the same step when it survives the rebuild; otherwise land on
 * the nearest surviving step, searching backwards before forwards so a dropped
 * beat rewinds slightly instead of skipping content the viewer has not seen. If
 * nothing survives, clamp the old index into the new range.
 */
export function remapPlaybackStepIndex(
  previousIdentities: readonly string[],
  nextIdentities: readonly string[],
  stepIndex: number,
): number {
  if (nextIdentities.length === 0) return 0;
  const clampedNext = Math.min(Math.max(0, stepIndex), nextIdentities.length - 1);
  if (previousIdentities.length === 0) return clampedNext;
  const from = Math.min(Math.max(0, stepIndex), previousIdentities.length - 1);
  for (let offset = 0; offset < previousIdentities.length; offset += 1) {
    const candidates = offset === 0 ? [from] : [from - offset, from + offset];
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= previousIdentities.length) continue;
      const found = nextIdentities.indexOf(previousIdentities[candidate]);
      if (found >= 0) return found;
    }
  }
  return clampedNext;
}
