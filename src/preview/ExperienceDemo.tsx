import { useEffect, useState } from "react";
import { AtlasViewProvider, GUEST_ATLAS_VIEW_CAPABILITIES, type AtlasMutations, type AtlasView } from "../journey/atlasView";
import { JourneyApiError } from "../journey/journeyApi";
import { LivingAtlasApp } from "../journey/LivingAtlasApp";
import type { Journey, JourneyInput, JourneyMediaAsset } from "../journey/types";
import { usePersistentEarth } from "../scene/LivingAtlasGlobe";
import { demoJourneys, demoMediaUrls } from "./demoJourneys";
import "./experience-demo.css";

// The DEV entry owns an isolated, disposable Atlas. The existing Story controls
// call this adapter exactly as they call owner mutations; every read and write
// stays in this closure, including user-selected files via local object URLs.
function createDemoAtlasSession() {
  let journeys = structuredClone(demoJourneys);
  const localMediaUrls = new Map<string, string>();
  const fail = (code: string, message: string, status = 400): never => {
    throw new JourneyApiError(status, code, message);
  };
  const requireJourney = (id: string) => journeys.find((journey) => journey.id === id)
    ?? fail("JOURNEY_NOT_FOUND", "这段示例旅程已不存在，请重置演示。", 404);
  const requireRoutePoint = (journey: Journey, id: string | null) => {
    if (id !== null && !journey.routePoints.some((point) => point.id === id)) {
      fail("ROUTE_POINT_NOT_FOUND", "目标地点已变化，请重新选择。", 404);
    }
  };
  const orderedMedia = (journey: Journey) => [...journey.media]
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const requireSelection = (journey: Journey, ids: readonly string[]) => {
    const selected = new Set(ids);
    if (!ids.length || selected.size !== ids.length
      || ids.some((id) => !journey.media.some((asset) => asset.id === id))) {
      fail("INVALID_MEDIA_SELECTION", "所选媒体已变化，请重新选择。");
    }
    return selected;
  };
  const save = (journey: Journey, media: JourneyMediaAsset[] = journey.media) => {
    const next = {
      ...journey,
      media: media.map((asset, sortOrder) => ({ ...asset, sortOrder })),
      revision: journey.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    journeys = journeys.map((current) => current.id === next.id ? next : current);
    return structuredClone(next);
  };
  const updateJourney = async (journeyId: string, input: JourneyInput) => {
    const journey = requireJourney(journeyId);
    if (input.revision !== undefined && input.revision !== journey.revision) {
      fail("STALE_REVISION", "这段旅程刚刚更新，请重新打开后再保存。", 409);
    }
    if (input.routePoints.length !== journey.routePoints.length) {
      fail("ROUTE_POINTS_CHANGED", "途径点已变化，请重新打开后再保存。", 409);
    }
    const currentPoints = new Map(journey.routePoints.map((point) => [point.id, point]));
    const nextRoutePoints = input.routePoints.map((point, sortOrder) => {
      const id = point.id ?? "";
      const current = currentPoints.get(id)
        ?? fail("ROUTE_POINT_NOT_FOUND", "目标地点已变化，请重新选择。", 404);
      return {
        ...current,
        ...point,
        id: current.id,
        journeyId: journey.id,
        sortOrder,
        note: point.note ?? null,
      };
    });
    if (new Set(nextRoutePoints.map((point) => point.id)).size !== journey.routePoints.length) {
      fail("ROUTE_POINTS_CHANGED", "途径点已变化，请重新打开后再保存。", 409);
    }
    return save({
      ...journey,
      title: input.title,
      startedOn: input.startedOn,
      endedOn: input.endedOn,
      note: input.note,
      lightColor: input.lightColor,
      lightEffect: input.lightEffect === undefined ? journey.lightEffect : input.lightEffect,
      routePoints: nextRoutePoints,
    }, journey.media);
  };
  const unavailable = async (): Promise<never> => fail(
    "DEMO_ACTION_UNAVAILABLE", "本地演示只开放媒体整理和感想编辑。",
  );
  const mutations: AtlasMutations = {
    updateJourneyNotes: updateJourney,
    deleteJourney: unavailable,
    restoreJourney: unavailable,
    createShare: unavailable,
    listShares: unavailable,
    revokeShare: unavailable,
    deleteMedia: async (assetId) => {
      const journey = journeys.find((current) => current.media.some((asset) => asset.id === assetId))
        ?? fail("MEDIA_NOT_FOUND", "这项媒体已不存在。", 404);
      save({
        ...journey,
        coverMediaAssetId: journey.coverMediaAssetId === assetId ? null : journey.coverMediaAssetId,
      }, orderedMedia(journey).filter((asset) => asset.id !== assetId));
      // Keep the blob alive until reset/unmount so a departing media frame can finish.
    },
    reorderJourneyMedia: async (journeyId, assetIds) => {
      const journey = requireJourney(journeyId);
      const selected = requireSelection(journey, assetIds);
      const byId = new Map(journey.media.map((asset) => [asset.id, asset]));
      // Story supplies all visual media; unlisted soundtrack assets retain order.
      return save(journey, [
        ...assetIds.map((id) => byId.get(id)!),
        ...orderedMedia(journey).filter((asset) => !selected.has(asset.id)),
      ]);
    },
    moveJourneyMedia: async (journeyId, assetIds, routePointId) => {
      const journey = requireJourney(journeyId);
      requireRoutePoint(journey, routePointId);
      const selected = requireSelection(journey, assetIds);
      const ordered = orderedMedia(journey);
      // Match the existing move contract: append in source order and change only
      // chapter ownership. IDs, content, and the explicit journey cover survive.
      return save(journey, [
        ...ordered.filter((asset) => !selected.has(asset.id)),
        ...ordered.filter((asset) => selected.has(asset.id))
          .map((asset) => ({ ...asset, routePointId })),
      ]);
    },
    undoJourneyMediaMove: async (undo) => {
      const journey = requireJourney(undo.journeyId);
      const moved = new Set(undo.assignments.map((assignment) => assignment.assetId));
      const ordered = orderedMedia(journey);
      const expectedOrder = [
        ...undo.assetOrder.filter((id) => !moved.has(id)),
        ...undo.assetOrder.filter((id) => moved.has(id)),
      ];
      const byId = new Map(journey.media.map((asset) => [asset.id, asset]));
      if (!moved.size || moved.size !== undo.assignments.length
        || ordered.length !== expectedOrder.length
        || ordered.some((asset, index) => asset.id !== expectedOrder[index])
        || undo.assignments.some(({ assetId }) => byId.get(assetId)?.routePointId !== undo.expectedRoutePointId)) {
        fail("MEDIA_MOVE_UNDO_STALE", "媒体已再次变化，这次移动不能再撤销。", 409);
      }
      const placements = new Map(undo.assignments.map(({ assetId, routePointId }) => {
        requireRoutePoint(journey, routePointId);
        return [assetId, routePointId] as const;
      }));
      return save(journey, undo.assetOrder.map((id) => ({
        ...byId.get(id)!,
        routePointId: placements.has(id) ? placements.get(id)! : byId.get(id)!.routePointId,
      })));
    },
    setJourneyCover: async (journeyId, coverMediaAssetId) => {
      const journey = requireJourney(journeyId);
      if (coverMediaAssetId !== null) requireSelection(journey, [coverMediaAssetId]);
      return save({ ...journey, coverMediaAssetId }, orderedMedia(journey));
    },
    uploadJourneyMedia: async ({ journeyId, routePointId, files, onProgress }) => {
      const journey = requireJourney(journeyId);
      requireRoutePoint(journey, routePointId ?? null);
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      let uploadedBytes = 0;
      const assets = files.map((file, index): JourneyMediaAsset => {
        const id = crypto.randomUUID();
        localMediaUrls.set(id, URL.createObjectURL(file));
        uploadedBytes += file.size;
        onProgress?.({ fileName: file.name, uploadedBytes, totalBytes });
        return {
          id, journeyId, routePointId: routePointId ?? null,
          storageDriver: "demo", storageKey: `demo/${id}`, fileName: file.name,
          mimeType: file.type, bytes: file.size, sortOrder: journey.media.length + index,
          uploadedByUserId: journey.createdByUserId, createdAt: new Date().toISOString(),
        };
      });
      if (assets.length) save(journey, [...orderedMedia(journey), ...assets]);
      return { uploadedCount: assets.length, mediaErrors: [], assets };
    },
  };
  const dispose = () => {
    for (const url of localMediaUrls.values()) URL.revokeObjectURL(url);
    localMediaUrls.clear();
  };
  const view: AtlasView = {
    capabilities: { ...GUEST_ATLAS_VIEW_CAPABILITIES, canManageMedia: true },
    mutations,
    listJourneys: async () => structuredClone(journeys),
    readMedia: async (assetId) => {
      if (!journeys.some((journey) => journey.media.some((asset) => asset.id === assetId))) {
        fail("MEDIA_NOT_FOUND", "这项示例媒体已不存在。", 404);
      }
      const url = localMediaUrls.get(assetId) ?? demoMediaUrls[assetId];
      if (!url) fail("MEDIA_NOT_FOUND", "这项示例媒体不可用。", 404);
      return { url, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    },
  };
  return {
    view,
    dispose,
    reset: () => { dispose(); journeys = structuredClone(demoJourneys); },
  };
}

export default function ExperienceDemo() {
  const earth = usePersistentEarth();
  const [session] = useState(createDemoAtlasSession);
  const [resetRevision, setResetRevision] = useState(0);
  useEffect(() => { earth.setStage("atlas"); }, [earth]);
  useEffect(() => () => session.dispose(), [session]);

  return (
    <AtlasViewProvider value={session.view}>
      <LivingAtlasApp key={resetRevision} />
      <aside className="experience-demo-notice" aria-label="本地演示说明">
        <span>体验演示</span>
        <small className="experience-demo-notice__hint">打开故事，点击「编辑」可整理媒体和编辑感想。</small>
        <small className="experience-demo-notice__meta">本地插画示例 · 修改仅留在当前页面</small>
        <button className="experience-demo-notice__reset" type="button" onClick={() => {
          session.reset();
          setResetRevision((revision) => revision + 1);
        }}>重置演示</button>
      </aside>
    </AtlasViewProvider>
  );
}
