import {
  buildPlaybackSteps,
  playbackCameraTargetForStep,
  playbackIntroMedia,
  playbackMediaForPoint,
  playbackStoryMedia,
  routePointAngularDistance,
  type PlaybackStep,
} from "./journeyPlayback";
import { resolveNarrativeTiming, type NarrativeTimingContext } from "./narrativeTiming";
import type { Journey } from "./types";

export type KeepsakeDurationPreset = 15 | 30 | 60;
export type KeepsakeAspect = "portrait" | "landscape";

export const KEEPSAKE_OUTPUT = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
} as const;

export const KEEPSAKE_MIN_DURATION_MS = {
  intro: 900,
  travel: 700,
  stop: 900,
  image: 1500,
  video: 1800,
  outro: 1100,
} as const;

export type KeepsakeScene =
  | {
      kind: "map";
      role: "intro" | "outro";
      durationMs: number;
    }
  | {
      kind: "map";
      role: "travel";
      pointIndex: number;
      fromRoutePointId: string;
      toRoutePointId: string;
      durationMs: number;
    }
  | {
      kind: "map";
      role: "arrival";
      pointIndex: number;
      routePointId: string;
      durationMs: number;
    }
  | {
      kind: "media";
      pointIndex: number | null;
      routePointId: string | null;
      mediaAssetId: string;
      mediaType: "image" | "video";
      durationMs: number;
    };

export interface KeepsakeNarrativeSnapshot {
  routePointIds: string[];
  visualMedia: Array<{
    mediaAssetId: string;
    routePointId: string | null;
  }>;
}

export interface KeepsakeRenderManifest {
  version: 1;
  journeyId: string;
  journeyRevision: number;
  narrativeSnapshot: KeepsakeNarrativeSnapshot;
  title: string;
  presetSeconds: KeepsakeDurationPreset;
  aspect: KeepsakeAspect;
  output: { width: number; height: number };
  soundtrack: { mode: "none" };
  privacy: {
    artifactVisibility: "private";
    mediaResolution: "authorized-server-fetch";
  };
  targetDurationMs: number;
  actualDurationMs: number;
  scenes: KeepsakeScene[];
}

type SceneDraftFor<T extends KeepsakeScene> = T extends KeepsakeScene
  ? Omit<T, "durationMs"> & {
      desiredDurationMs: number;
      minimumDurationMs: number;
    }
  : never;

type SceneDraft = SceneDraftFor<KeepsakeScene>;

function mediaType(mimeType: string): "image" | "video" {
  return mimeType.startsWith("video/") ? "video" : "image";
}

/**
 * Keepsake asks the shared resolver how long each beat wants to be. The export
 * keeps its fixed 15/30/60 s presets and offers no tempo control (decision D3),
 * so the mode and tempo are pinned here; the `keepsake` profile is seeded from
 * the legacy `PLAYBACK_PACING` numbers this call replaced, which keeps the
 * switch a no-visual-change refactor. `fitKeepsakeSceneDurations()` still owns
 * the preset fit — the resolver answers "how long is this beat", never "how
 * many beats fit".
 */
function keepsakeDurationMs(
  context: Omit<NarrativeTimingContext, "mode" | "tempo">,
): number {
  return resolveNarrativeTiming({ mode: "keepsake", tempo: "standard", ...context });
}

export function buildKeepsakeNarrativeSnapshot(
  journey: Pick<Journey, "routePoints" | "media">,
): KeepsakeNarrativeSnapshot {
  const playbackJourney = journey as Journey;
  return {
    routePointIds: journey.routePoints.map((point) => point.id),
    visualMedia: playbackStoryMedia(playbackJourney).map((asset) => ({
      mediaAssetId: asset.id,
      routePointId: asset.routePointId,
    })),
  };
}

function narrativeSnapshotsEqual(
  left: KeepsakeNarrativeSnapshot,
  right: KeepsakeNarrativeSnapshot,
): boolean {
  if (left.routePointIds.length !== right.routePointIds.length) return false;
  if (left.visualMedia.length !== right.visualMedia.length) return false;
  if (left.routePointIds.some((id, index) => id !== right.routePointIds[index])) return false;
  return left.visualMedia.every((media, index) => (
    media.mediaAssetId === right.visualMedia[index]?.mediaAssetId
    && media.routePointId === right.visualMedia[index]?.routePointId
  ));
}

function sceneForStep(journey: Journey, step: PlaybackStep): SceneDraft[] {
  const camera = playbackCameraTargetForStep(step);
  switch (step.kind) {
    case "intro":
      return [{
        kind: "map",
        role: "intro",
        desiredDurationMs: keepsakeDurationMs({ segmentKind: "intro" }),
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.intro,
      }];
    case "travel": {
      const toPointIndex = camera?.kind === "point" ? camera.pointIndex : step.to;
      const fromPoint = journey.routePoints[Math.max(0, toPointIndex - 1)];
      const toPoint = journey.routePoints[toPointIndex];
      if (!fromPoint || !toPoint) return [];
      return [{
        kind: "map",
        role: "travel",
        pointIndex: toPointIndex,
        fromRoutePointId: fromPoint.id,
        toRoutePointId: toPoint.id,
        desiredDurationMs: keepsakeDurationMs({
          segmentKind: "travel",
          routeDistanceRadians: routePointAngularDistance(fromPoint, toPoint),
        }),
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.travel,
      }];
    }
    case "stop": {
      const point = journey.routePoints[step.pointIndex];
      if (!point) return [];
      return [{
        kind: "map",
        role: "arrival",
        pointIndex: step.pointIndex,
        routePointId: point.id,
        desiredDurationMs: keepsakeDurationMs({
          segmentKind: "arrival",
          noteLength: point.note?.trim().length ?? 0,
        }),
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.stop,
      }];
    }
    case "media": {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      if (!asset) return [];
      const type = mediaType(asset.mimeType);
      const point = journey.routePoints[step.pointIndex];
      if (!point) return [];
      return [{
        kind: "media",
        pointIndex: step.pointIndex,
        routePointId: point.id,
        mediaAssetId: asset.id,
        mediaType: type,
        desiredDurationMs: keepsakeDurationMs({ segmentKind: "media", mediaKind: type }),
        minimumDurationMs: type === "video"
          ? KEEPSAKE_MIN_DURATION_MS.video
          : KEEPSAKE_MIN_DURATION_MS.image,
      }];
    }
    case "outro":
      return [{
        kind: "map",
        role: "outro",
        desiredDurationMs: keepsakeDurationMs({ segmentKind: "outro" }),
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.outro,
      }];
  }
}

/**
 * Fit semantic playback scenes to a preset without deleting chapters. When a
 * content-heavy Journey cannot fit inside 15/30/60 seconds at readable
 * minimums, the keepsake deliberately runs long rather than randomly dropping
 * a stop or media item. Sparse Journeys are stretched proportionally up to the
 * selected target duration.
 */
export function fitKeepsakeSceneDurations(
  scenes: readonly SceneDraft[],
  targetDurationMs: number,
): KeepsakeScene[] {
  const minimumTotal = scenes.reduce((sum, scene) => sum + scene.minimumDurationMs, 0);
  const desiredTotal = scenes.reduce((sum, scene) => sum + scene.desiredDurationMs, 0);
  const actualTarget = Math.max(targetDurationMs, minimumTotal);
  const flexibleTotal = Math.max(0, desiredTotal - minimumTotal);
  const extraBudget = Math.max(0, actualTarget - minimumTotal);

  return scenes.map(({ desiredDurationMs, minimumDurationMs, ...scene }) => {
    const desiredExtra = Math.max(0, desiredDurationMs - minimumDurationMs);
    const allocatedExtra = flexibleTotal > 0
      ? extraBudget * (desiredExtra / flexibleTotal)
      : extraBudget / Math.max(1, scenes.length);
    return {
      ...scene,
      durationMs: Math.round(minimumDurationMs + allocatedExtra),
    } as KeepsakeScene;
  });
}

export function buildKeepsakeRenderManifest(
  journey: Journey,
  presetSeconds: KeepsakeDurationPreset,
  aspect: KeepsakeAspect = "portrait",
): KeepsakeRenderManifest {
  const playbackSteps = buildPlaybackSteps(journey);
  const introMediaDrafts: SceneDraft[] = playbackIntroMedia(journey).map((asset) => {
    const type = mediaType(asset.mimeType);
    return {
      kind: "media",
      pointIndex: null,
      routePointId: null,
      mediaAssetId: asset.id,
      mediaType: type,
      desiredDurationMs: keepsakeDurationMs({ segmentKind: "media", mediaKind: type }),
      minimumDurationMs: type === "video"
        ? KEEPSAKE_MIN_DURATION_MS.video
        : KEEPSAKE_MIN_DURATION_MS.image,
    };
  });
  const drafts = playbackSteps.flatMap((step, stepIndex) => {
    const scenes = sceneForStep(journey, step);
    return stepIndex === 0 ? [...scenes, ...introMediaDrafts] : scenes;
  });
  const targetDurationMs = presetSeconds * 1000;
  const scenes = fitKeepsakeSceneDurations(drafts, targetDurationMs);
  return {
    version: 1,
    journeyId: journey.id,
    journeyRevision: journey.revision,
    narrativeSnapshot: buildKeepsakeNarrativeSnapshot(journey),
    title: journey.title,
    presetSeconds,
    aspect,
    output: { ...KEEPSAKE_OUTPUT[aspect] },
    soundtrack: { mode: "none" },
    privacy: {
      artifactVisibility: "private",
      mediaResolution: "authorized-server-fetch",
    },
    targetDurationMs,
    actualDurationMs: scenes.reduce((sum, scene) => sum + scene.durationMs, 0),
    scenes,
  };
}


export function assertKeepsakeManifestRevision(
  manifest: KeepsakeRenderManifest,
  journey: Pick<Journey, "id" | "revision" | "routePoints" | "media">,
): void {
  if (journey.id !== manifest.journeyId) {
    throw new Error("keepsake_manifest_journey_mismatch");
  }
  if (journey.revision !== manifest.journeyRevision) {
    throw new Error("keepsake_manifest_revision_mismatch");
  }
  const currentNarrative = buildKeepsakeNarrativeSnapshot(journey);
  if (!narrativeSnapshotsEqual(manifest.narrativeSnapshot, currentNarrative)) {
    throw new Error("keepsake_manifest_narrative_mismatch");
  }

  const routePointIds = new Set(journey.routePoints.map((point) => point.id));
  const mediaById = new Map(journey.media.map((asset) => [asset.id, asset]));
  for (const scene of manifest.scenes) {
    if (scene.kind === "media") {
      const asset = mediaById.get(scene.mediaAssetId);
      if (!asset) {
        throw new Error("keepsake_manifest_media_missing");
      }
      if (scene.routePointId !== null && !routePointIds.has(scene.routePointId)) {
        throw new Error("keepsake_manifest_route_point_missing");
      }
      if (asset.routePointId !== scene.routePointId) {
        throw new Error("keepsake_manifest_media_point_mismatch");
      }
      continue;
    }
    if (scene.role === "arrival") {
      if (!routePointIds.has(scene.routePointId)) {
        throw new Error("keepsake_manifest_route_point_missing");
      }
      continue;
    }
    if (scene.role === "travel" && (
      !routePointIds.has(scene.fromRoutePointId)
      || !routePointIds.has(scene.toRoutePointId)
    )) {
      throw new Error("keepsake_manifest_route_point_missing");
    }
  }
}
