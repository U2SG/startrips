import {
  buildPlaybackSteps,
  playbackCameraTargetForStep,
  playbackIntroMedia,
  playbackMediaForPoint,
  stepDurationMs,
  type PlaybackStep,
} from "./journeyPlayback";
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
      role: "intro" | "travel" | "arrival" | "outro";
      pointIndex?: number;
      durationMs: number;
    }
  | {
      kind: "media";
      pointIndex: number | null;
      mediaAssetId: string;
      mediaType: "image" | "video";
      durationMs: number;
    };

export interface KeepsakeRenderManifest {
  version: 1;
  journeyId: string;
  journeyRevision: number;
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

type SceneDraft = (
  | Omit<Extract<KeepsakeScene, { kind: "map" }>, "durationMs">
  | Omit<Extract<KeepsakeScene, { kind: "media" }>, "durationMs">
) & {
  desiredDurationMs: number;
  minimumDurationMs: number;
};

function mediaType(mimeType: string): "image" | "video" {
  return mimeType.startsWith("video/") ? "video" : "image";
}

function sceneForStep(journey: Journey, step: PlaybackStep): SceneDraft[] {
  const desired = stepDurationMs(journey, step);
  const camera = playbackCameraTargetForStep(step);
  switch (step.kind) {
    case "intro":
      return [{
        kind: "map",
        role: "intro",
        desiredDurationMs: desired,
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.intro,
      }];
    case "travel":
      return [{
        kind: "map",
        role: "travel",
        pointIndex: camera?.kind === "point" ? camera.pointIndex : step.to,
        desiredDurationMs: desired,
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.travel,
      }];
    case "stop":
      return [{
        kind: "map",
        role: "arrival",
        pointIndex: step.pointIndex,
        desiredDurationMs: desired,
        minimumDurationMs: KEEPSAKE_MIN_DURATION_MS.stop,
      }];
    case "media": {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      if (!asset) return [];
      const type = mediaType(asset.mimeType);
      return [{
        kind: "media",
        pointIndex: step.pointIndex,
        mediaAssetId: asset.id,
        mediaType: type,
        desiredDurationMs: desired,
        minimumDurationMs: type === "video"
          ? KEEPSAKE_MIN_DURATION_MS.video
          : KEEPSAKE_MIN_DURATION_MS.image,
      }];
    }
    case "outro":
      return [{
        kind: "map",
        role: "outro",
        desiredDurationMs: desired,
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
      mediaAssetId: asset.id,
      mediaType: type,
      desiredDurationMs: type === "video" ? 6000 : 4500,
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
