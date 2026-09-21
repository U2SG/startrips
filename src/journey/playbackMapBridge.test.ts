import { describe, expect, it } from "vitest";
import { buildPlaybackSteps, routePointChapterDensity } from "./journeyPlayback";
import { playbackMapBridgeBoundary, resolvePlaybackMapBridge } from "./playbackMapBridge";
import type { Journey } from "./types";

function fixture(counts: number[]): Journey {
  return {
    id: "bridge", atlasId: "atlas", title: "Bridge", startedOn: "2026-09-21", endedOn: null,
    note: "", lightColor: "#fff", revision: 1, createdByUserId: "owner", createdAt: "", updatedAt: "",
    routePoints: counts.map((_, index) => ({ id: `p${index}`, journeyId: "bridge", sortOrder: index,
      latitude: index, longitude: index, label: `Place ${index}`, isStop: true, occurredAt: null, createdAt: "" })),
    media: counts.flatMap((count, point) => Array.from({ length: count }, (_, index) => ({
      id: `p${point}m${index}`, journeyId: "bridge", routePointId: `p${point}`, storageDriver: "test",
      storageKey: "", fileName: "frame", mimeType: index % 2 ? "video/mp4" : "image/jpeg", bytes: 1,
      sortOrder: index, uploadedByUserId: "owner", createdAt: "",
    }))),
  };
}

describe("Playback map bridge boundaries", () => {
  it.each([0, 1, 2, 3, 4, 10])("bridges only sparse chapter edges (%i media)", (count) => {
    const journey = fixture([count, 0]);
    const steps = buildPlaybackSteps(journey);
    const before = JSON.stringify(steps);
    const bridges = steps.flatMap((step, index) => {
      const bridge = playbackMapBridgeBoundary(journey, steps[index - 1], step);
      return bridge ? [bridge] : [];
    });
    expect(bridges.map((bridge) => bridge.direction)).toEqual(count > 0 && count <= 3
      ? ["map-to-media", "media-to-map"] : []);
    expect(bridges.every((bridge) => bridge.density === routePointChapterDensity(journey, 0))).toBe(true);
    expect(JSON.stringify(steps)).toBe(before);
  });

  it("leaves adjacent media, reverse travel, and non-final media departures alone", () => {
    const journey = fixture([3, 1]);
    expect(playbackMapBridgeBoundary(journey, { kind: "media", pointIndex: 0, mediaIndex: 0 },
      { kind: "media", pointIndex: 0, mediaIndex: 1 })).toBeNull();
    expect(playbackMapBridgeBoundary(journey, { kind: "media", pointIndex: 0, mediaIndex: 0 },
      { kind: "travel", to: 1 })).toBeNull();
    expect(playbackMapBridgeBoundary(journey, { kind: "media", pointIndex: 1, mediaIndex: 0 },
      { kind: "stop", pointIndex: 0, media: [] })).toBeNull();
  });

  it("closes the last chapter against the journey/place surface", () => {
    const journey = fixture([1]);
    expect(playbackMapBridgeBoundary(journey, { kind: "media", pointIndex: 0, mediaIndex: 0 },
      { kind: "outro" })?.direction).toBe("media-to-map");
  });
});

describe("pure bridge geometry", () => {
  const place = { left: 20, top: 10, width: 300, height: 80 };
  const media = { left: 100, top: 200, width: 600, height: 400 };
  it.each(["map-to-media", "media-to-map"] as const)("commits the identical pose for %s with Reduced Motion", (direction) => {
    const boundary = { direction, pointIndex: 0, density: "single" as const };
    const moving = resolvePlaybackMapBridge({ boundary, place, media, reduceMotion: false });
    const quiet = resolvePlaybackMapBridge({ boundary, place, media, reduceMotion: true });
    expect(moving.spatial).toBe(true);
    expect(moving.from).not.toEqual(moving.to);
    expect(quiet.spatial).toBe(false);
    expect(quiet.from).toEqual(moving.to);
    expect(quiet.to).toEqual(moving.to);
  });
  it.each([null, { ...media, width: 0 }, { ...media, top: NaN }, { ...media, height: Infinity }])(
    "falls back quietly for unavailable media geometry", (geometry) => {
      const result = resolvePlaybackMapBridge({ boundary: { direction: "map-to-media", pointIndex: 0, density: "few" },
        place, media: geometry, reduceMotion: false });
      expect(result.spatial).toBe(false);
      expect(result.from).toEqual(result.to);
    },
  );
  it("does not invent a place anchor when the spatial surface is unavailable", () => {
    const result = resolvePlaybackMapBridge({ boundary: { direction: "media-to-map", pointIndex: 0, density: "single" },
      place: null, media, reduceMotion: false });
    expect(result.spatial).toBe(false);
    expect(result.from).toEqual(result.to);
  });
});
