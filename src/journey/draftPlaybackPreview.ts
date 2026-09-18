import type { RouteDraftPoint } from "./routeDraft";
import type { Journey, JourneyInput, JourneyRoute, RoutePoint } from "./types";

export const NEW_JOURNEY_DRAFT_PLAYBACK_ID = "draft-route-preview";

export type DraftPlaybackPreviewSnapshot = {
  snapshotRevision: number;
  sourceJourneyId: string | null;
  excludedPendingMediaCount: number;
  journey: Journey;
  route: JourneyRoute;
};

function previewRoutePointId(point: RouteDraftPoint) {
  return point.id ?? `draft-preview-route-point:${point.draftId}`;
}

export function draftPlaybackPreviewOwnerKey(sourceJourneyId: string | null) {
  return sourceJourneyId ?? NEW_JOURNEY_DRAFT_PLAYBACK_ID;
}

export function draftPlaybackPreviewStillOwnsComposer(
  preview: DraftPlaybackPreviewSnapshot | null,
  composerOpen: boolean,
  editingJourneyId: string | null,
) {
  return Boolean(
    preview
    && composerOpen
    && preview.sourceJourneyId === editingJourneyId,
  );
}

export function buildDraftPlaybackPreviewSnapshot({
  sourceJourney,
  input,
  routePoints,
  snapshotRevision,
  excludedPendingMediaCount,
  generatedAt = new Date().toISOString(),
}: {
  sourceJourney: Journey | null;
  input: JourneyInput;
  routePoints: readonly RouteDraftPoint[];
  snapshotRevision: number;
  excludedPendingMediaCount: number;
  generatedAt?: string;
}): DraftPlaybackPreviewSnapshot {
  const journeyId = sourceJourney?.id ?? NEW_JOURNEY_DRAFT_PLAYBACK_ID;
  const previewPoints: RoutePoint[] = routePoints.map((point, sortOrder) => ({
    id: previewRoutePointId(point),
    journeyId,
    sortOrder,
    latitude: point.latitude,
    longitude: point.longitude,
    label: point.label.trim(),
    isStop: point.isStop,
    occurredAt: point.occurredAt ?? null,
    note: point.note ?? null,
    createdAt: sourceJourney?.routePoints.find((candidate) => candidate.id === point.id)?.createdAt
      ?? generatedAt,
  }));
  const livePersistedPointIds = new Set(
    routePoints.flatMap((point) => point.id ? [point.id] : []),
  );
  const media = (sourceJourney?.media ?? []).filter((asset) => (
    asset.routePointId === null || livePersistedPointIds.has(asset.routePointId)
  ));
  const mediaIds = new Set(media.map((asset) => asset.id));
  const journey: Journey = {
    id: journeyId,
    atlasId: sourceJourney?.atlasId ?? "draft-preview-atlas",
    title: input.title,
    startedOn: input.startedOn,
    endedOn: input.endedOn ?? null,
    note: input.note,
    lightColor: input.lightColor,
    lightEffect: input.lightEffect ?? null,
    coverMediaAssetId: sourceJourney?.coverMediaAssetId && mediaIds.has(sourceJourney.coverMediaAssetId)
      ? sourceJourney.coverMediaAssetId
      : null,
    // This remains the persisted revision when one exists. The local draft's
    // independent identity is `snapshotRevision`; preview must never pretend a
    // server write occurred.
    revision: sourceJourney?.revision ?? 0,
    createdByUserId: sourceJourney?.createdByUserId ?? "draft-preview-user",
    createdAt: sourceJourney?.createdAt ?? generatedAt,
    updatedAt: generatedAt,
    routePoints: previewPoints,
    // V1 deliberately includes only media that already belongs to the persisted
    // Journey. Local pending Files have no persisted asset identity and are
    // reported separately instead of being uploaded or impersonated here.
    media,
  };
  return {
    snapshotRevision,
    sourceJourneyId: sourceJourney?.id ?? null,
    excludedPendingMediaCount,
    journey,
    route: {
      id: journeyId,
      color: input.lightColor,
      lightEffect: input.lightEffect ?? null,
      points: previewPoints.map((point) => ({
        id: point.id,
        lat: point.latitude,
        lon: point.longitude,
        isStop: point.isStop,
        label: point.label,
      })),
    },
  };
}
