import { describe, expect, it } from "vitest";
import { buildPlaybackSteps } from "./journeyPlayback";
import {
  prepareQuickRecapPlayback,
  quickRecapDigestsForJourney,
  quickRecapStepDurationMs,
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
  it("projects Journey-scoped cover into the first recap chapter without mutating canonical ownership", () => {
    const journey = fixture();
    const digests = quickRecapDigestsForJourney(journey);
    expect(digests.find((digest) => digest.assetId === "cover")?.routePointId).toBe("p0");
    expect(journey.media.find((asset) => asset.id === "cover")?.routePointId).toBeNull();
  });

  it("builds a photo-first playback Journey while preserving soundtrack and route geography", () => {
    const journey = fixture();
    const prepared = prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" });
    expect(prepared).not.toBeNull();
    const projected = prepared!.journey;
    expect(projected.routePoints.map((routePoint) => routePoint.id)).toEqual(["p0", "p1"]);
    expect(projected.media.map((asset) => asset.id)).toContain("soundtrack");
    expect(projected.media.map((asset) => asset.id)).not.toContain("video");
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

  it("fails closed when a Journey has no route-scoped or cover photo for recap", () => {
    const journey = fixture();
    journey.coverMediaAssetId = null;
    journey.media = [media("video", "p0", "video/mp4", 0), media("track", null, "audio/mpeg", 1)];
    expect(prepareQuickRecapPlayback(journey, { generatedAt: "2026-09-02T00:00:00.000Z" })).toBeNull();
  });
});
