import { describe, expect, it } from "vitest";
import { buildPlaybackSteps, playbackMediaForPoint } from "./journeyPlayback";
import {
  prepareQuickRecapPlayback,
  prepareQuickRecapPlaybackResult,
  quickRecapDigestsForJourney,
  quickRecapStepDurationMs,
  QUICK_RECAP_PENDING_VIDEO_DURATION_MS,
} from "./quickRecapPlayback";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

function point(id: string, sortOrder: number): RoutePoint {
  return {
    id, journeyId: "journey-1", sortOrder, latitude: 22.3 + sortOrder, longitude: 114.1 + sortOrder,
    label: id, isStop: true, occurredAt: null, note: null, createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function media(id: string, routePointId: string | null, mimeType = "image/jpeg", sortOrder = 0): JourneyMediaAsset {
  return {
    id, journeyId: "journey-1", routePointId, storageDriver: "test", storageKey: id, fileName: id,
    mimeType, bytes: 1, sortOrder, uploadedByUserId: "user-1", createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function fixture(): Journey {
  return {
    id: "journey-1", atlasId: "atlas-1", title: "Quick Recap", startedOn: "2026-09-02", endedOn: null, note: "",
    lightColor: "#abcdef", coverMediaAssetId: "cover", revision: 9, createdByUserId: "user-1",
    createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    routePoints: [point("p0", 0), point("p1", 1)],
    media: [
      media("cover", null, "image/jpeg", 0),
      media("p0-a", "p0", "image/jpeg", 1),
      media("p0-b", "p0", "image/jpeg", 2),
      media("p1-a", "p1", "image/jpeg", 3),
      media("video", "p1", "video/mp4", 4),
      media("soundtrack", null, "audio/mpeg", 5),
    ],
  };
}

describe("Quick Recap playback handoff (#127)", () => {
  it("projects Journey-scoped photos into the first playable recap chapter without mutating ownership", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.media = [
      media("intro-a", null, "image/jpeg", 0),
      media("intro-b", null, "image/jpeg", 1),
      media("track", null, "audio/mpeg", 2),
    ];

    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.map((digest) => [digest.assetId, digest.routePointId])).toEqual([
      ["intro-a", "p0"],
      ["intro-b", "p0"],
    ]);

    const prepared = prepareQuickRecapPlaybackResult(journey, { generatedAt: "2026-09-03T00:00:00.000Z" });
    expect(prepared.fallbackReason).toBeNull();
    expect(prepared.playback?.journey.media.find((asset) => asset.id === "intro-a")?.routePointId).toBe("p0");
    expect(journey.media.find((asset) => asset.id === "intro-a")?.routePointId).toBeNull();
  });

  it("projects Journey-scoped cover into the first recap chapter without mutating canonical ownership", () => {
    const journey = fixture();
    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.find((digest) => digest.assetId === "cover")?.routePointId).toBe("p0");
    expect(journey.media.find((asset) => asset.id === "cover")?.routePointId).toBeNull();
  });


  it("promotes an explicit cover from a later route point into the opening recap chapter", () => {
    const journey = fixture();
    journey.media = journey.media.map((asset) => (
      asset.id === "cover" ? { ...asset, routePointId: "p1" } : asset
    ));
    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.find((digest) => digest.assetId === "cover")?.routePointId).toBe("p0");
    expect(journey.media.find((asset) => asset.id === "cover")?.routePointId).toBe("p1");

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.journey.media.find((asset) => asset.id === "cover")?.routePointId).toBe("p0");
  });

  it("puts the explicit cover first in both the plan and projected playback order", () => {
    const journey = fixture();
    journey.media = journey.media.map((asset) => {
      if (asset.id === "cover") return { ...asset, routePointId: "p1", sortOrder: 99 };
      if (asset.id === "p0-a") return { ...asset, sortOrder: 0 };
      return asset;
    });

    const digests = quickRecapDigestsForJourney(journey);
    expect(digests[0]?.assetId).toBe("cover");
    expect(digests[0]?.sourceIndex).toBe(0);

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const openingChapter = prepared.plan.chapters.find((chapter) => chapter.routePointId === "p0")!;
    expect(openingChapter.items[0]?.assetId).toBe("cover");
    expect(playbackMediaForPoint(prepared.journey, 0)[0]?.id).toBe("cover");
    expect(prepared.journey.media.find((asset) => asset.id === "cover")?.sortOrder).toBe(Number.MIN_SAFE_INTEGER);
    expect(journey.media.find((asset) => asset.id === "cover")?.sortOrder).toBe(99);
  });

  it("budgets only route points that can produce recap chapters", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = Array.from({ length: 64 }, (_, index) => point(`p${index}`, index));
    journey.media = [
      ...Array.from({ length: 12 }, (_, index) => media(`p0-${index}`, "p0", "image/jpeg", index)),
      media("track", null, "audio/mpeg", 99),
    ];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared).not.toBeNull();
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0"]);
    expect(prepared.plan.chapters[0]?.items).toHaveLength(12);
    expect(prepared.plan.plannedDurationMs).toBeLessThanOrEqual(42_000);
  });

  it("fails closed with an over-budget reason when mandatory represented chapters cannot fit the recap target", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = Array.from({ length: 9 }, (_, index) => point(`p${index}`, index));
    journey.media = journey.routePoints.map((routePoint, index) => media(`photo-${index}`, routePoint.id, "image/jpeg", index));

    const result = prepareQuickRecapPlaybackResult(journey, { generatedAt: "2026-09-02T00:00:00.000Z" });
    expect(result).toEqual({ playback: null, fallbackReason: "over-budget" });
    expect(prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })).toBeNull();
  });

  it("omits route points that have no recap chapter so empty Full Playback timing cannot leak in", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = Array.from({ length: 64 }, (_, index) => point(`p${index}`, index));
    journey.media = [media("only-photo", "p0", "image/jpeg", 0), media("track", null, "audio/mpeg", 1)];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0"]);
    expect(prepared.journey.routePoints.map((routePoint) => routePoint.id)).toEqual(["p0"]);
    expect(buildPlaybackSteps(prepared.journey).some((step) => step.kind === "travel")).toBe(false);
  });

  it("builds a visual-media playback Journey while preserving soundtrack and route geography", () => {
    const journey = fixture();
    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" });
    expect(prepared).not.toBeNull();
    const projected = prepared!.journey;
    expect(projected.routePoints.map((routePoint) => routePoint.id)).toEqual(["p0", "p1"]);
    expect(projected.media.map((asset) => asset.id)).toContain("soundtrack");
    expect(projected.media.map((asset) => asset.id)).toContain("video");
    expect(projected.media.filter((asset) => asset.mimeType.startsWith("image/")).length).toBeGreaterThan(0);
    expect(journey.media).toHaveLength(6);
  });

  it("uses auto-edit camera, arrival, and photo-role dwell in the live playback step timing", () => {
    const prepared = prepareQuickRecapPlayback(fixture(), { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const steps = buildPlaybackSteps(prepared.journey);
    const firstStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 0)!;
    const travel = steps.find((step) => step.kind === "travel")!;
    const secondStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 1)!;
    const firstMedia = steps.find((step) => step.kind === "media" && step.pointIndex === 0)!;
    expect(quickRecapStepDurationMs(prepared.journey, firstStop, prepared.plan)).toBe(1_800);
    expect(quickRecapStepDurationMs(prepared.journey, travel, prepared.plan)).toBe(1_000);
    expect(quickRecapStepDurationMs(prepared.journey, secondStop, prepared.plan)).toBe(800);
    expect(quickRecapStepDurationMs(prepared.journey, firstMedia, prepared.plan)).toBe(3_100);
  });

  it("fails closed with a no-visual-media reason when a Journey only owns a soundtrack", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.media = [media("track", null, "audio/mpeg", 0), media("track-2", "p0", "audio/mpeg", 1)];
    expect(prepareQuickRecapPlaybackResult(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })).toEqual({
      playback: null,
      fallbackReason: "no-visual-media",
    });
  });
});

describe("Quick Recap visual-media topology (#195)", () => {
  it("keeps a photo-only Journey on the image digest path", () => {
    const journey = fixture();
    journey.media = journey.media.filter((asset) => asset.mimeType.startsWith("image/"));
    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.map((digest) => digest.mediaType)).toEqual(["image", "image", "image", "image"]);
    expect(digests.every((digest) => digest.intrinsic.durationMs === undefined)).toBe(true);

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
    expect(prepared.plan.chapters.flatMap((chapter) => chapter.items).every((item) => (
      item.dwellMs !== undefined && item.trim === undefined
    ))).toBe(true);
  });

  it("keeps a middle route point whose only media is a video", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = [point("p0", 0), point("p1", 1), point("p2", 2)];
    journey.media = [
      media("p0-a", "p0", "image/jpeg", 0),
      media("p1-video", "p1", "video/mp4", 1),
      media("p2-a", "p2", "image/jpeg", 2),
    ];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1", "p2"]);
    expect(prepared.journey.routePoints.map((routePoint) => routePoint.id)).toEqual(["p0", "p1", "p2"]);
    const videoChapter = prepared.plan.chapters.find((chapter) => chapter.routePointId === "p1")!;
    expect(videoChapter.items.map((item) => item.assetId)).toEqual(["p1-video"]);
    expect(videoChapter.items[0]?.selectionReason).toBe("video-highlight");
  });

  it("keeps a video-only destination behind Journey-scoped intro photos", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.media = [
      media("intro-a", null, "image/jpeg", 0),
      media("intro-b", null, "image/jpeg", 1),
      media("destination-video", "p1", "video/quicktime", 2),
      media("track", null, "audio/mpeg", 3),
    ];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
    expect(prepared.plan.chapters[1]?.items.map((item) => item.assetId)).toEqual(["destination-video"]);
  });

  it("prepares a video-only Journey instead of reporting missing visual media", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.media = [
      media("p0-video", "p0", "video/mp4", 0),
      media("p1-video", "p1", "video/webm", 1),
      media("track", null, "audio/mpeg", 2),
    ];

    const result = prepareQuickRecapPlaybackResult(journey, { generatedAt: "2026-09-02T00:00:00.000Z" });
    expect(result.fallbackReason).toBeNull();
    expect(result.playback?.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
  });

  it("gives an unmeasured video a deterministic step duration without dropping other chapters", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = [point("p0", 0), point("p1", 1), point("p2", 2)];
    journey.media = [
      media("p0-a", "p0", "image/jpeg", 0),
      media("p1-video", "p1", "video/mp4", 1),
      media("p2-a", "p2", "image/jpeg", 2),
    ];

    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.find((digest) => digest.assetId === "p1-video")?.intrinsic.durationMs)
      .toBe(QUICK_RECAP_PENDING_VIDEO_DURATION_MS);

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    // Phase 1 keeps the item whole: `inMs` stays 0, so the live <video> still
    // starts from the beginning while the plan carries a bounded budget.
    const videoItem = prepared.plan.chapters.find((chapter) => chapter.routePointId === "p1")!.items[0]!;
    expect(videoItem.trim).toEqual({ inMs: 0, outMs: 3_500 });
    expect(videoItem.dwellMs).toBeUndefined();

    const videoStep = buildPlaybackSteps(prepared.journey)
      .find((step) => step.kind === "media" && step.pointIndex === 1)!;
    expect(quickRecapStepDurationMs(prepared.journey, videoStep, prepared.plan)).toBe(3_500);
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1", "p2"]);
  });

  it("does not let a video displace photos when a route point has plenty", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.routePoints = [point("p0", 0)];
    journey.media = [
      media("p0-video", "p0", "video/mp4", 0),
      ...Array.from({ length: 4 }, (_, index) => media(`p0-photo-${index}`, "p0", "image/jpeg", index + 1)),
    ];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const chapter = prepared.plan.chapters[0]!;
    expect(chapter.items.map((item) => item.assetId)).toEqual([
      "p0-video", "p0-photo-0", "p0-photo-1", "p0-photo-2", "p0-photo-3",
    ]);
    expect(prepared.plan.omittedAssetIds).toEqual([]);
    // Photo roles stay photo-only: the hero of the chapter is still a photo.
    expect(chapter.items.find((item) => item.photoRole === "hero")?.assetId).toBe("p0-photo-0");
    expect(chapter.items.find((item) => item.assetId === "p0-video")?.photoRole).toBeUndefined();
  });
});
