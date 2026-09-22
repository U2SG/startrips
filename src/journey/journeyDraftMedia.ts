import { isVisualMediaAsset } from "./journeyModel";
import type { JourneyMediaUploadAssignment } from "./journeyMediaUpload";
import type { RouteDraftPoint } from "./routeDraft";
import type { Journey } from "./types";

export type PendingJourneyMedia = {
  file: File;
  routePointDraftId: string | null;
};

export function composerMediaSummary(
  journey: Pick<Journey, "media"> | null | undefined,
  routePoints: readonly Pick<RouteDraftPoint, "id" | "draftId">[],
  mediaFiles: readonly PendingJourneyMedia[],
) {
  type Names = { count: number; preview: string[] };
  const persistedByPoint = new Map<string | null, Names>();
  const pendingByDraft = new Map<string | null, Names>();
  function appendName(groups: Map<string | null, Names>, id: string | null, name: string) {
    let names = groups.get(id);
    if (!names) {
      names = { count: 0, preview: [] };
      groups.set(id, names);
    }
    names.count += 1;
    if (names.preview.length < 2) names.preview.push(name);
  }

  let existingVisualMediaCount = 0;
  for (const media of journey?.media ?? []) {
    if (!isVisualMediaAsset(media)) continue;
    existingVisualMediaCount += 1;
    appendName(persistedByPoint, media.routePointId, media.fileName);
  }
  for (const media of mediaFiles) {
    appendName(pendingByDraft, media.routePointDraftId, media.file.name);
  }

  const byDraftId = new Map<string, { count: number; label: string }>();
  for (const point of routePoints) {
    const persisted = point.id ? persistedByPoint.get(point.id) : undefined;
    const pending = pendingByDraft.get(point.draftId);
    const count = (persisted?.count ?? 0) + (pending?.count ?? 0);
    // Composer preserves model order, followed by the pending file order.
    // Draft ids are separate from persisted ids, including an unsaved point.
    const preview = [...(persisted?.preview ?? []), ...(pending?.preview ?? [])]
      .slice(0, 2).join("、");
    byDraftId.set(point.draftId, {
      count,
      label: count === 0 ? "暂无媒体归属此地点" : `${preview}${count > 2 ? ` 等 ${count} 个` : ""}`,
    });
  }
  return { existingVisualMediaCount, byDraftId };
}

export function resolvePendingMediaUploads(
  mediaFiles: readonly PendingJourneyMedia[],
  routePoints: readonly RouteDraftPoint[],
  journey: Journey,
): JourneyMediaUploadAssignment[] {
  return mediaFiles.map(({ file, routePointDraftId }) => {
    if (!routePointDraftId) return { file };
    const draftIndex = routePoints.findIndex((point) => point.draftId === routePointDraftId);
    const draftPoint = routePoints[draftIndex];
    const persistedPoint = draftPoint?.id
      ? journey.routePoints.find((point) => point.id === draftPoint.id)
      : journey.routePoints.find((point) => point.sortOrder === draftIndex);
    if (!persistedPoint) {
      throw new Error("旅程已保存，但媒体归属无法确认；请重新打开旅程后添加媒体。");
    }
    return { file, routePointId: persistedPoint.id };
  });
}

export function clearRemovedMediaTarget(
  mediaFiles: readonly PendingJourneyMedia[],
  routePointDraftId: string,
): PendingJourneyMedia[] {
  return mediaFiles.map((media) => (
    media.routePointDraftId === routePointDraftId
      ? { ...media, routePointDraftId: null }
      : media
  ));
}
