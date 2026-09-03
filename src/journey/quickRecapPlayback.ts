import {
  buildDeterministicQuickRecapPlan,
  type AutoEditPlanV1,
  type AutoEditTempo,
  type MediaDigestV1,
} from "./autoEditPlan";
import { PLAYBACK_PACING, playbackMediaForPoint, type PlaybackStep } from "./journeyPlayback";
import { isSoundtrackAsset, isVisualMediaAsset } from "./journeyModel";
import type { Journey, JourneyMediaAsset } from "./types";

export const QUICK_RECAP_TARGET_MS = 45_000;

// #195 Phase 1: no video duration is persisted with a media asset and the
// browser cannot read one synchronously here, so a video digest declares this
// explicit analysis-pending duration instead of an empty `intrinsic`. The
// plan's video eligibility rule rejects an absent, non-finite, or non-positive
// duration, which would delete the route point's only chapter — the regression
// this replaces. Reusing Full Playback's deterministic video duration keeps one
// number for "how long an unmeasured video is worth"; because it exceeds every
// per-tempo video dwell, the planner's own clamp still decides the real length.
export const QUICK_RECAP_PENDING_VIDEO_DURATION_MS = PLAYBACK_PACING.videoMs;

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
  const chapterBudgetMs = Math.max(1, requestedTargetMs - PLAYBACK_PACING.introMs - PLAYBACK_PACING.outroMs);
  const plan = buildDeterministicQuickRecapPlan({
    journeyId: journey.id,
    journeyRevision: String(journey.revision),
    routePointIds: candidateRoutePointIds,
    digests,
    targetDurationMs: chapterBudgetMs,
    tempo: options.tempo ?? "standard",
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

export function quickRecapStepDurationMs(
  journey: Journey,
  step: PlaybackStep,
  plan: AutoEditPlanV1,
): number | undefined {
  if (step.kind === "intro" || step.kind === "outro") return undefined;
  const pointIndex = step.kind === "travel" ? step.to : step.pointIndex;
  const point = journey.routePoints[pointIndex];
  if (!point) return undefined;
  const chapter = plan.chapters.find((candidate) => candidate.routePointId === point.id);
  if (!chapter) return undefined;

  if (step.kind === "travel") return chapter.camera.durationMs;
  if (step.kind === "stop") {
    const firstPointCameraMs = step.pointIndex === 0 ? chapter.camera.durationMs : 0;
    return firstPointCameraMs + (chapter.arrival?.durationMs ?? 0);
  }

  const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
  if (!asset) return undefined;
  const item = chapter.items.find((candidate) => candidate.assetId === asset.id);
  if (!item) return undefined;
  return item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : undefined);
}
