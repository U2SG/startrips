import { describe, expect, it } from "vitest";
import {
  MAX_PREFETCH_ASSETS,
  planPrefetchWindow,
  readyMsAheadForTempo,
} from "./playbackPrefetchPlan";
import { PLAYBACK_TEMPO_PROFILES, type PlaybackTempo } from "./journeyPlaybackPlan";
import { buildPlaybackSteps, playbackMediaForPoint } from "./journeyPlayback";
import { playbackHoldTargetMedia } from "./JourneyPlaybackOverlay";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

type PrefetchStep = { durationMs: number; assetIds: string[] };

function planFor(steps: PrefetchStep[], stepIndex: number, budgetMs: number) {
  return planPrefetchWindow({
    stepCount: steps.length,
    stepIndex,
    budgetMs,
    durationForStep: (index) => steps[index]?.durationMs ?? 0,
    assetIdsForStep: (index) => steps[index]?.assetIds ?? [],
  });
}

/**
 * A Journey of `pointCount` route points, each holding `imagesPerPoint` images,
 * expanded into the same beats Journey Playback plays and timed with the real
 * tempo profile.
 */
function imageJourneySteps(tempo: PlaybackTempo, pointCount: number, imagesPerPoint: number) {
  const profile = PLAYBACK_TEMPO_PROFILES[tempo];
  const steps: PrefetchStep[] = [{ durationMs: profile.introMs, assetIds: [] }];
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    if (pointIndex > 0) steps.push({ durationMs: profile.travelBaseMs, assetIds: [] });
    steps.push({ durationMs: profile.arrivalBaseMs, assetIds: [] });
    for (let imageIndex = 0; imageIndex < imagesPerPoint; imageIndex += 1) {
      steps.push({
        durationMs: profile.imageMs,
        assetIds: [`p${pointIndex}-image${imageIndex}`],
      });
    }
  }
  steps.push({ durationMs: profile.outroMs, assetIds: [] });
  return steps;
}

/** Index of the step showing one asset. */
function mediaStepIndex(steps: PrefetchStep[], assetId: string) {
  return steps.findIndex((step) => step.assetIds.includes(assetId));
}

describe("readyMsAheadForTempo", () => {
  it("prepares farther ahead in time as tempo gets faster", () => {
    expect(readyMsAheadForTempo("fast")).toBeGreaterThan(readyMsAheadForTempo("standard"));
    expect(readyMsAheadForTempo("standard")).toBeGreaterThan(readyMsAheadForTempo("immersive"));
  });

  it("never budgets less than one image beat of the same tempo", () => {
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      expect(readyMsAheadForTempo(tempo))
        .toBeGreaterThanOrEqual(PLAYBACK_TEMPO_PROFILES[tempo].imageMs);
    }
  });
});

describe("planPrefetchWindow", () => {
  it("grows the asset window from immersive through standard to fast", () => {
    const [immersive, standard, fast] = (["immersive", "standard", "fast"] as const).map(
      (tempo) => {
        const steps = imageJourneySteps(tempo, 5, 12);
        const stepIndex = mediaStepIndex(steps, "p2-image0");
        return planFor(steps, stepIndex, readyMsAheadForTempo(tempo)).assetIds.length;
      },
    );
    expect(standard).toBeGreaterThan(immersive);
    expect(fast).toBeGreaterThan(standard);
    // immersive keeps at least the pre-#197 current + next floor.
    expect(immersive).toBeGreaterThanOrEqual(2);
  });

  it("never spends more than the budget once the next displayed asset is reached", () => {
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const steps = imageJourneySteps(tempo, 5, 12);
      const budgetMs = readyMsAheadForTempo(tempo);
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const window = planFor(steps, stepIndex, budgetMs);
        const firstAssetAhead = steps.findIndex(
          (step, index) => index > stepIndex && step.assetIds.length > 0,
        );
        if (window.coveredDurationMs > budgetMs) {
          // The single documented exception: the beats leading to the next
          // asset cost more than the whole budget, and that asset is still
          // prepared because the director holds on it.
          expect(window.lastStepIndex).toBe(firstAssetAhead);
          continue;
        }
        expect(window.coveredDurationMs).toBeLessThanOrEqual(budgetMs);
      }
    }
  });

  it("keeps a window inside the budget while a chapter's own images run", () => {
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const steps = imageJourneySteps(tempo, 5, 12);
      const budgetMs = readyMsAheadForTempo(tempo);
      // The first image of a 12-image chapter: every step ahead in the budget
      // is another image of the same chapter, so no boundary beat intervenes.
      const stepIndex = mediaStepIndex(steps, "p2-image0");
      const window = planFor(steps, stepIndex, budgetMs);
      expect(window.coveredDurationMs).toBeLessThanOrEqual(budgetMs);
      expect(window.coveredDurationMs + PLAYBACK_TEMPO_PROFILES[tempo].imageMs)
        .toBeGreaterThan(budgetMs);
    }
  });

  it("stays bounded on a 60-image Journey at the fastest tempo", () => {
    const steps = imageJourneySteps("fast", 5, 12);
    expect(steps.filter((step) => step.assetIds.length > 0)).toHaveLength(60);
    const widest = Math.max(...steps.map(
      (_, stepIndex) => planFor(steps, stepIndex, readyMsAheadForTempo("fast")).assetIds.length,
    ));
    expect(widest).toBe(5);
    expect(widest).toBeLessThanOrEqual(MAX_PREFETCH_ASSETS);
  });

  it("caps the window when the steps ahead carry no duration to spend", () => {
    const steps: PrefetchStep[] = Array.from(
      { length: 60 },
      (_, index) => ({ durationMs: 0, assetIds: [`image${index}`] }),
    );
    expect(planFor(steps, 0, 7_300).assetIds).toHaveLength(MAX_PREFETCH_ASSETS);
  });

  it("derives a window after a seek only from the new index", () => {
    const steps = imageJourneySteps("fast", 5, 12);
    const budgetMs = readyMsAheadForTempo("fast");
    const seekTargetIndex = mediaStepIndex(steps, "p3-image4");
    const afterSeek = planFor(steps, seekTargetIndex, budgetMs);
    expect(afterSeek.assetIds[0]).toBe("p3-image4");
    for (const assetId of afterSeek.assetIds) {
      expect(mediaStepIndex(steps, assetId)).toBeGreaterThanOrEqual(seekTargetIndex);
    }
    // The same index always produces the same window, whatever preceded it.
    expect(afterSeek).toEqual(planFor(steps, seekTargetIndex, budgetMs));
  });

  it("spends a video step's resolved duration rather than an image beat", () => {
    const profile = PLAYBACK_TEMPO_PROFILES.fast;
    const steps: PrefetchStep[] = [
      { durationMs: profile.arrivalBaseMs, assetIds: [] },
      ...Array.from({ length: 4 }, (_, index) => ({
        durationMs: profile.videoMs,
        assetIds: [`video${index}`],
      })),
    ];
    const videoWindow = planFor(steps, 1, readyMsAheadForTempo("fast"));
    expect(videoWindow.assetIds).toEqual(["video0", "video1"]);
    expect(videoWindow.coveredDurationMs).toBe(profile.videoMs);
    // The same beats timed as images would have fitted more assets.
    const asImages = steps.map((step) => ({
      ...step,
      durationMs: step.assetIds.length > 0 ? profile.imageMs : step.durationMs,
    }));
    expect(planFor(asImages, 1, readyMsAheadForTempo("fast")).assetIds.length)
      .toBeGreaterThan(videoWindow.assetIds.length);
  });

  it("reaches the next displayed asset even when it costs more than the budget", () => {
    const steps: PrefetchStep[] = [
      { durationMs: 0, assetIds: [] },
      { durationMs: 9_000, assetIds: ["video0"] },
      { durationMs: 1_700, assetIds: ["image0"] },
    ];
    const window = planFor(steps, 0, 1_000);
    expect(window.assetIds).toEqual(["video0"]);
    expect(window.lastStepIndex).toBe(1);
  });

  it("returns nothing for an index outside the plan", () => {
    const steps = imageJourneySteps("standard", 1, 3);
    expect(planFor(steps, steps.length, 6_200).assetIds).toEqual([]);
    expect(planFor(steps, -1, 6_200).assetIds).toEqual([]);
  });
});

function routePoint(id: string, sortOrder: number): RoutePoint {
  return {
    id,
    journeyId: "journey-1",
    sortOrder,
    latitude: 22.3,
    longitude: 114.1 + sortOrder,
    label: id,
    isStop: true,
    occurredAt: null,
    note: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function mediaAsset(
  id: string,
  routePointId: string | null,
  mimeType: string,
  sortOrder: number,
): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-1",
    routePointId,
    storageDriver: "test",
    storageKey: id,
    fileName: id,
    mimeType,
    bytes: 1,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

/** One route point whose media starts with two videos before the first image. */
function videoFirstJourney(): Journey {
  return {
    id: "journey-1",
    atlasId: "atlas-1",
    title: "Video first",
    startedOn: "2026-09-01",
    endedOn: null,
    note: "",
    lightColor: "#fff",
    revision: 1,
    createdByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    routePoints: [routePoint("p0", 0)],
    media: [
      mediaAsset("v0", "p0", "video/mp4", 0),
      mediaAsset("v1", "p0", "video/mp4", 1),
      mediaAsset("i0", "p0", "image/jpeg", 2),
    ],
  };
}

describe("playbackHoldTargetMedia", () => {
  it("names the image a stop phase waits to decode, past any leading video", () => {
    const journey = videoFirstJourney();
    const stop = buildPlaybackSteps(journey).find((step) => step.kind === "stop");
    expect(playbackHoldTargetMedia(journey, stop)?.id).toBe("i0");
  });

  it("names a media step's own asset", () => {
    const journey = videoFirstJourney();
    const mediaStep = buildPlaybackSteps(journey).filter((step) => step.kind === "media")[1];
    expect(playbackHoldTargetMedia(journey, mediaStep)?.id).toBe("v1");
  });

  it("names nothing for a chapter without an image", () => {
    const journey = videoFirstJourney();
    journey.media = journey.media.filter((asset) => asset.mimeType.startsWith("video/"));
    const stop = buildPlaybackSteps(journey).find((step) => step.kind === "stop");
    expect(playbackMediaForPoint(journey, 0)).toHaveLength(2);
    expect(playbackHoldTargetMedia(journey, stop)).toBeNull();
  });
});
