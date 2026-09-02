import {
  buildDeterministicQuickRecapPlan,
  type AutoEditPlanV1,
  type AutoEditTempo,
  type MediaDigestV1,
} from "./autoEditPlan";
import { PLAYBACK_PACING, playbackMediaForPoint, type PlaybackStep } from "./journeyPlayback";
import type { Journey, JourneyMediaAsset } from "./types";

export const QUICK_RECAP_TARGET_MS = 45_000;

export type PreparedQuickRecapPlayback = {
  journey: Journey;
  plan: AutoEditPlanV1;
};

function isImage(asset: JourneyMediaAsset) {
  return asset.mimeType.startsWith("image/");
}

function isAudio(asset: JourneyMediaAsset) {
  return asset.mimeType.startsWith("audio/");
}

function runtimePhotoCandidates(journey: Journey): JourneyMediaAsset[] {
  const firstRoutePointId = journey.routePoints[0]?.id ?? null;
  const coverId = journey.coverMediaAssetId;
  return journey.media
    .filter(isImage)
    .flatMap((asset) => {
      if (asset.id === coverId && firstRoutePointId) {
        // Playback projection only: the explicit Journey cover always opens
        // the recap as the first chapter hero, even when canonical ownership
        // belongs to a later route point. Synthetic ordering is scoped to the
        // projection; persisted ownership/sort order remain untouched.
        return [{ ...asset, routePointId: firstRoutePointId, sortOrder: Number.MIN_SAFE_INTEGER }];
      }
      if (asset.routePointId !== null) return [asset];
      return [];
    })
    .sort((left, right) => {
      if (left.id === coverId && right.id !== coverId) return -1;
      if (right.id === coverId && left.id !== coverId) return 1;
      return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
    });
}

export function quickRecapDigestsForJourney(journey: Journey): MediaDigestV1[] {
  return runtimePhotoCandidates(journey).map((asset, sourceIndex) => ({
    schemaVersion: 1,
    assetId: asset.id,
    journeyId: journey.id,
    routePointId: asset.routePointId,
    sourceRevision: String(journey.revision),
    mediaType: "image",
    mimeType: asset.mimeType,
    sourceIndex,
    intrinsic: {},
    userSignals: {
      isJourneyCover: asset.id === journey.coverMediaAssetId,
      pinnedForRecap: false,
      excludedFromRecap: false,
    },
  }));
}

export function prepareQuickRecapPlayback(
  journey: Journey,
  options: {
    generatedAt: string;
    targetDurationMs?: number;
    tempo?: AutoEditTempo;
  },
): PreparedQuickRecapPlayback | null {
  if (journey.routePoints.length === 0) return null;
  const digests = quickRecapDigestsForJourney(journey);
  if (digests.length === 0) return null;

  const candidateRoutePointIds = journey.routePoints
    .filter((point) => digests.some((digest) => digest.routePointId === point.id))
    .map((point) => point.id);
  if (candidateRoutePointIds.length === 0) return null;

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
  if (plan.plannedDurationMs > chapterBudgetMs) return null;
  const selectedIds = new Set(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId)));
  if (selectedIds.size === 0) return null;
  const plannedRoutePointIds = new Set(plan.chapters.map((chapter) => chapter.routePointId));
  const projectedRoutePoints = journey.routePoints.filter((point) => plannedRoutePointIds.has(point.id));
  if (projectedRoutePoints.length === 0) return null;

  const projectedCandidates = new Map(runtimePhotoCandidates(journey).map((asset) => [asset.id, asset]));
  const projectedMedia = journey.media.flatMap((asset) => {
    if (isAudio(asset)) return [asset];
    if (!selectedIds.has(asset.id)) return [];
    return [projectedCandidates.get(asset.id) ?? asset];
  });

  return {
    plan,
    journey: { ...journey, routePoints: projectedRoutePoints, media: projectedMedia },
  };
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
