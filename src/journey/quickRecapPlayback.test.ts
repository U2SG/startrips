import { describe, expect, it } from "vitest";
import {
  buildPlaybackSteps,
  playbackMediaForPoint,
  playbackStepIdentity,
  routePointAngularDistance,
} from "./journeyPlayback";
import { resolveNarrativeTiming, type NarrativeTempo } from "./narrativeTiming";
import {
  prepareQuickRecapPlayback,
  prepareQuickRecapPlaybackResult,
  quickRecapDigestsForJourney,
  quickRecapStepDurationMs,
  remapPlaybackStepIndex,
  QUICK_RECAP_PENDING_VIDEO_DURATION_MS,
  QUICK_RECAP_TARGET_MS,
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

  it("resolves camera and arrival from route geometry while the plan keeps pinning dwell", () => {
    const prepared = prepareQuickRecapPlayback(fixture(), { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const steps = buildPlaybackSteps(prepared.journey);
    const firstStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 0)!;
    const travel = steps.find((step) => step.kind === "travel")!;
    const secondStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 1)!;
    const firstMedia = steps.find((step) => step.kind === "media" && step.pointIndex === 0)!;
    const legRadians = routePointAngularDistance(
      prepared.journey.routePoints[0],
      prepared.journey.routePoints[1],
    );

    // Point 0 has no leg in front of it, so its folded camera stays at the
    // quick-recap floor and the stop reads floor + note-free arrival.
    expect(quickRecapStepDurationMs(prepared.journey, firstStop, prepared.plan)).toBe(1_800);
    expect(quickRecapStepDurationMs(prepared.journey, secondStop, prepared.plan)).toBe(800);
    // The travelled leg is no longer the frozen flat camera value.
    expect(quickRecapStepDurationMs(prepared.journey, travel, prepared.plan)).toBe(
      resolveNarrativeTiming({
        mode: "quick-recap",
        tempo: "standard",
        segmentKind: "travel",
        routeDistanceRadians: legRadians,
      }),
    );
    expect(quickRecapStepDurationMs(prepared.journey, travel, prepared.plan)).toBeGreaterThan(1_000);
    // Dwell stays the plan's, because the plan's budget was measured with it.
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

  it("keeps a later route point whose only visual media is the video cover", () => {
    const journey = fixture();
    journey.coverMediaAssetId = "p1-video";
    journey.media = [
      media("p0-a", "p0", "image/jpeg", 0),
      media("p1-video", "p1", "video/mp4", 1),
    ];

    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.find((digest) => digest.assetId === "p1-video")?.routePointId).toBe("p1");
    expect(digests.find((digest) => digest.assetId === "p1-video")?.userSignals.isJourneyCover).toBe(true);

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
    expect(prepared.plan.chapters[1]?.items.map((item) => item.assetId)).toEqual(["p1-video"]);
    expect(prepared.journey.media.find((asset) => asset.id === "p1-video")?.routePointId).toBe("p1");
  });

  it("keeps a later route point whose only visual media is the photo cover", () => {
    const journey = fixture();
    journey.coverMediaAssetId = "p1-a";
    journey.media = [
      media("p0-a", "p0", "image/jpeg", 0),
      media("p1-a", "p1", "image/jpeg", 1),
    ];

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
    expect(prepared.plan.chapters[1]?.items.map((item) => item.assetId)).toEqual(["p1-a"]);
    expect(prepared.journey.media.find((asset) => asset.id === "p1-a")?.routePointId).toBe("p1");
  });

  it("still opens the recap with a cover its owning route point can spare", () => {
    const journey = fixture();
    journey.coverMediaAssetId = "p1-a";
    journey.media = [
      media("p0-a", "p0", "image/jpeg", 0),
      media("p1-a", "p1", "image/jpeg", 1),
      media("p1-b", "p1", "image/jpeg", 2),
    ];

    const digests = quickRecapDigestsForJourney(journey);
    expect(digests[0]?.assetId).toBe("p1-a");
    expect(digests.find((digest) => digest.assetId === "p1-a")?.routePointId).toBe("p0");

    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    expect(prepared.plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["p0", "p1"]);
    expect(prepared.plan.chapters[0]?.items[0]?.assetId).toBe("p1-a");
    expect(prepared.plan.chapters[1]?.items.map((item) => item.assetId)).toEqual(["p1-b"]);
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

const TEMPI: NarrativeTempo[] = ["fast", "standard", "immersive"];

function annotatedFixture(): Journey {
  const journey = fixture();
  journey.routePoints = [
    { ...point("p0", 0), note: "抵达第一站的说明文字。" },
    { ...point("p1", 1), note: "一段足够长的到站说明文字，用来验证到站时长随备注长度变化。" },
  ];
  return journey;
}

describe("Quick Recap tempo wiring (S1 PR 4)", () => {
  it("resolves travel and stop differently at every tempo for one fixed plan", () => {
    const journey = annotatedFixture();
    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const steps = buildPlaybackSteps(prepared.journey);
    const travel = steps.find((step) => step.kind === "travel")!;
    const firstStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 0)!;
    const secondStop = steps.find((step) => step.kind === "stop" && step.pointIndex === 1)!;

    const travelMs = TEMPI.map((tempo) => quickRecapStepDurationMs(prepared.journey, travel, prepared.plan, tempo));
    const firstStopMs = TEMPI.map((tempo) => quickRecapStepDurationMs(prepared.journey, firstStop, prepared.plan, tempo));
    const secondStopMs = TEMPI.map((tempo) => quickRecapStepDurationMs(prepared.journey, secondStop, prepared.plan, tempo));

    expect(new Set(travelMs).size).toBe(3);
    expect(new Set(firstStopMs).size).toBe(3);
    expect(new Set(secondStopMs).size).toBe(3);
    // Point 0 has no leg in front of it, so its folded camera is the flat
    // quick-recap floor at every tempo and only its note-aware arrival moves.
    expect(firstStopMs[0]!).toBeLessThan(firstStopMs[1]!);
    expect(firstStopMs[1]!).toBeLessThan(firstStopMs[2]!);
    expect(travelMs[0]!).toBeLessThan(travelMs[1]!);
    expect(travelMs[1]!).toBeLessThan(travelMs[2]!);
    expect(secondStopMs[0]!).toBeLessThan(secondStopMs[1]!);
    expect(secondStopMs[1]!).toBeLessThan(secondStopMs[2]!);
  });

  it("changes media dwell with tempo through the rebuilt plan, not around it", () => {
    const journey = annotatedFixture();
    const dwellMs = TEMPI.map((tempo) => {
      const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z", tempo })!;
      const steps = buildPlaybackSteps(prepared.journey);
      const media = steps.find((step) => step.kind === "media" && step.pointIndex === 0)!;
      return quickRecapStepDurationMs(prepared.journey, media, prepared.plan, tempo);
    });
    expect(new Set(dwellMs).size).toBe(3);
    expect(dwellMs[0]!).toBeLessThan(dwellMs[1]!);
    expect(dwellMs[1]!).toBeLessThan(dwellMs[2]!);
  });

  it("stops pacing a nearby leg like an intercontinental one", () => {
    const nearby = fixture();
    nearby.routePoints = [
      { ...point("p0", 0), latitude: 22.30, longitude: 114.10 },
      { ...point("p1", 1), latitude: 22.32, longitude: 114.13 },
    ];
    const longHaul = fixture();
    longHaul.routePoints = [
      { ...point("p0", 0), latitude: 22.3, longitude: 114.1 },
      { ...point("p1", 1), latitude: 51.5, longitude: -0.13 },
    ];

    const travelMsFor = (journey: Journey) => {
      const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })!;
      const travel = buildPlaybackSteps(prepared.journey).find((step) => step.kind === "travel")!;
      return quickRecapStepDurationMs(prepared.journey, travel, prepared.plan)!;
    };

    expect(travelMsFor(nearby)).toBeLessThan(travelMsFor(longHaul));
  });

  it("budgets the intro and outro it actually spends, per tempo", () => {
    const journey = annotatedFixture();
    const chapterBudgets = TEMPI.map((tempo) => {
      const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z", tempo })!;
      return prepared.plan.targetDurationMs!;
    });
    const expected = TEMPI.map((tempo) => QUICK_RECAP_TARGET_MS
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "intro" })
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "outro" }));
    expect(chapterBudgets).toEqual(expected);
    // `fast` pays less for the two framing beats, so more of the target is left
    // for chapters; the legacy flat 1200 + 1800 could not express that.
    expect(chapterBudgets[0]!).toBeGreaterThan(chapterBudgets[2]!);
  });

  it("rebuilds the plan on a tempo change so the recap keeps its target length", () => {
    const journey = annotatedFixture();
    const plans = TEMPI.map((tempo) => prepareQuickRecapPlayback(journey, {
      generatedAt: "2026-09-02T00:00:00.000Z",
      tempo,
    })!.plan);
    expect(new Set(plans.map((plan) => plan.planId)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.plannedDurationMs)).size).toBe(3);
    for (const [index, tempo] of TEMPI.entries()) {
      expect(plans[index]!.tempo).toBe(tempo);
      expect(plans[index]!.plannedDurationMs).toBeLessThanOrEqual(plans[index]!.targetDurationMs!);
    }
  });
});

describe("Quick Recap step identity across a plan rebuild (S1 PR 4)", () => {
  it("identifies a step by route point or asset, never by index", () => {
    const prepared = prepareQuickRecapPlayback(fixture(), { generatedAt: "2026-09-02T00:00:00.000Z" })!;
    const identities = buildPlaybackSteps(prepared.journey)
      .map((step) => playbackStepIdentity(prepared.journey, step));
    expect(identities[0]).toBe("intro");
    expect(identities.at(-1)).toBe("outro");
    expect(identities).toContain("stop:p0");
    expect(identities).toContain("travel:p1");
    expect(identities.some((identity) => identity.startsWith("media:"))).toBe(true);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("keeps the same step when it survives the rebuild", () => {
    const previous = ["intro", "stop:p0", "media:a", "media:b", "travel:p1", "stop:p1", "outro"];
    const next = ["intro", "stop:p0", "media:a", "travel:p1", "stop:p1", "outro"];
    expect(remapPlaybackStepIndex(previous, next, 2)).toBe(2);
    expect(remapPlaybackStepIndex(previous, next, 5)).toBe(4);
  });

  it("lands on the nearest surviving step, preferring the one just before it", () => {
    const previous = ["intro", "stop:p0", "media:a", "media:b", "travel:p1", "stop:p1", "outro"];
    const next = ["intro", "stop:p0", "media:a", "travel:p1", "stop:p1", "outro"];
    // media:b is gone; the beat just before it survives at index 2.
    expect(remapPlaybackStepIndex(previous, next, 3)).toBe(2);
  });

  it("clamps into the new range when nothing survives", () => {
    expect(remapPlaybackStepIndex(["a", "b", "c"], ["x", "y"], 2)).toBe(1);
    expect(remapPlaybackStepIndex(["a", "b", "c"], [], 2)).toBe(0);
    expect(remapPlaybackStepIndex([], ["x", "y"], 5)).toBe(1);
  });
});
