import { describe, expect, it } from "vitest";
import {
  applyScopeReorder,
  groupJourneysByYear,
  isSoundtrackAsset,
  isVisualMediaAsset,
  journeyCover,
  journeySoundtrack,
  journeyVisualMedia,
  sortJourneysChronologically,
  stripMediaExtension,
  toJourneyRoutes,
  validateJourneyFiles,
  validateJourneyInput,
  validateJourneySoundtrack,
} from "./journeyModel";
import type { Journey, JourneyInput, JourneyMediaAsset } from "./types";

function input(overrides: Partial<JourneyInput> = {}): JourneyInput {
  return {
    title: "Across the island",
    startedOn: "2026-08-11",
    endedOn: "2026-08-12",
    note: "",
    lightColor: "#f4ce73",
    routePoints: [
      {
        latitude: 1.3521,
        longitude: 103.8198,
        label: "",
        isStop: false,
        occurredAt: null,
      },
    ],
    ...overrides,
  };
}

function journey(id: string, startedOn: string): Journey {
  const createdAt = `${startedOn}T00:00:00Z`;
  return {
    id,
    atlasId: "atlas-1",
    title: id,
    startedOn,
    endedOn: null,
    note: "",
    lightColor: "#f4ce73",
    revision: 1,
    createdByUserId: "user-1",
    createdAt,
    updatedAt: createdAt,
    routePoints: [],
    media: [],
  };
}

describe("journeyModel", () => {
  it("sorts journeys by start date without mutating input", () => {
    const journeys = [journey("later", "2026-08-11"), journey("first", "2024-01-02")];
    expect(sortJourneysChronologically(journeys).map((item) => item.id)).toEqual([
      "first",
      "later",
    ]);
    expect(journeys.map((item) => item.id)).toEqual(["later", "first"]);
    expect(groupJourneysByYear(journeys).map((group) => group.year)).toEqual([2024, 2026]);
  });

  it("preserves place labels in the globe route projection", () => {
    const labeledJourney = journey("labeled", "2026-08-11");
    labeledJourney.lightEffect = "aurora";
    labeledJourney.routePoints = [{
      id: "point-1",
      journeyId: labeledJourney.id,
      sortOrder: 0,
      latitude: 22.5431,
      longitude: 114.0579,
      label: "Shenzhen",
      isStop: true,
      occurredAt: null,
      createdAt: labeledJourney.createdAt,
    }];
    expect(toJourneyRoutes([labeledJourney])[0].points[0]).toEqual({
      id: "point-1",
      lat: 22.5431,
      lon: 114.0579,
      isStop: true,
      label: "Shenzhen",
    });
    expect(toJourneyRoutes([labeledJourney])[0].lightEffect).toBe("aurora");
  });

  it("accepts a single unnamed point and a multi-city route", () => {
    expect(validateJourneyInput(input()).accepted).toBe(true);
    expect(validateJourneyInput(input({
      routePoints: [
        { latitude: 31.2304, longitude: 121.4737, label: "上海", isStop: true, occurredAt: "2026-08-11T01:00:00Z" },
        { latitude: 30.2741, longitude: 120.1551, label: "", isStop: false, occurredAt: "2026-08-11T05:00:00Z" },
        { latitude: 29.8683, longitude: 121.544, label: "宁波", isStop: true, occurredAt: "2026-08-11T09:00:00Z" },
      ],
    }))).toEqual({ accepted: true, errors: [] });
  });

  it("rejects invalid ranges, unlabeled stops, and reversed point times", () => {
    const result = validateJourneyInput(input({
      endedOn: "2026-08-10",
      routePoints: [
        { latitude: 1, longitude: 1, label: "", isStop: true, occurredAt: "2026-08-11T10:00:00Z" },
        { latitude: 2, longitude: 2, label: "", isStop: false, occurredAt: "2026-08-11T09:00:00Z" },
      ],
    }));
    expect(result.accepted).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it("accepts known effects and rejects unknown effects", () => {
    expect(validateJourneyInput(input({ lightEffect: "nebula" })).accepted).toBe(true);
    expect(validateJourneyInput(input({ lightEffect: "static-glitch" as never })).accepted)
      .toBe(false);
  });

  it("separates visual media from soundtracks and keeps the newest track", () => {
    const asset = (
      id: string,
      mimeType: string,
      sortOrder: number,
    ): JourneyMediaAsset => ({
      id,
      journeyId: "journey-1",
      routePointId: null,
      storageDriver: "test",
      storageKey: `journey-1/${id}`,
      fileName: id,
      mimeType,
      bytes: 128,
      sortOrder,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const mixed = {
      ...journey("mixed", "2026-08-11"),
      media: [
        asset("photo.jpg", "image/jpeg", 0),
        asset("old-track.mp3", "audio/mpeg", 1),
        asset("clip.mp4", "video/mp4", 2),
        asset("new-track.m4a", "audio/mp4", 3),
      ],
    };

    expect(isSoundtrackAsset(asset("t", "audio/ogg", 0))).toBe(true);
    expect(isVisualMediaAsset(asset("p", "image/png", 0))).toBe(true);
    expect(isVisualMediaAsset(asset("t", "audio/wav", 0))).toBe(false);
    expect(journeyVisualMedia(mixed).map((item) => item.id))
      .toEqual(["photo.jpg", "clip.mp4"]);
    expect(journeySoundtrack(mixed)?.id).toBe("new-track.m4a");
    expect(journeySoundtrack(journey("silent", "2026-08-11"))).toBeNull();
  });

  it("accepts one supported soundtrack and rejects the rest", () => {
    expect(validateJourneySoundtrack([
      { name: "night.mp3", type: "audio/mpeg", size: 4_000_000 },
    ])).toEqual({ accepted: true, errors: [] });
    for (const type of ["audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/wav"]) {
      expect(validateJourneySoundtrack([{ name: `track`, type, size: 10 }]).accepted)
        .toBe(true);
    }
    expect(validateJourneySoundtrack([]).accepted).toBe(false);
    expect(validateJourneySoundtrack([
      { name: "a.mp3", type: "audio/mpeg", size: 10 },
      { name: "b.mp3", type: "audio/mpeg", size: 10 },
    ]).accepted).toBe(false);
    expect(validateJourneySoundtrack([
      { name: "clip.mp4", type: "video/mp4", size: 10 },
    ]).accepted).toBe(false);
    expect(validateJourneySoundtrack([
      { name: "empty.mp3", type: "audio/mpeg", size: 0 },
    ]).accepted).toBe(false);
  });

  it("holds the soundtrack size boundary at exactly 100 MB", () => {
    expect(validateJourneySoundtrack([
      { name: "edge.mp3", type: "audio/mpeg", size: 100 * 1024 * 1024 },
    ]).accepted).toBe(true);
    expect(validateJourneySoundtrack([
      { name: "over.mp3", type: "audio/mpeg", size: 100 * 1024 * 1024 + 1 },
    ]).accepted).toBe(false);
  });

  it("keeps audio out of route point media validation", () => {
    expect(validateJourneyFiles([
      { name: "night.mp3", type: "audio/mpeg", size: 10 },
    ]).accepted).toBe(false);
  });

  it("accepts any media count while rejecting invalid files", () => {
    const manyFiles = Array.from({ length: 48 }, (_, index) => ({
      name: `${index}.jpg`,
      type: "image/jpeg",
      size: 10,
    }));
    expect(validateJourneyFiles(manyFiles).accepted).toBe(true);
    const invalid = validateJourneyFiles([
      { name: "empty.jpg", type: "image/jpeg", size: 0 },
      { name: "notes.txt", type: "text/plain", size: 20 },
      { name: "huge.mp4", type: "video/mp4", size: 2_000_000_001 },
    ]);
    expect(invalid.errors).toHaveLength(3);
  });

  it("strips soundtrack extensions from display names (#7)", () => {
    expect(stripMediaExtension("飞云之下 韩红林俊杰.mp3")).toBe("飞云之下 韩红林俊杰");
    expect(stripMediaExtension("night.mp3")).toBe("night");
    expect(stripMediaExtension("rain.m4a")).toBe("rain");
    expect(stripMediaExtension("wind.aac")).toBe("wind");
    expect(stripMediaExtension("sea.ogg")).toBe("sea");
    expect(stripMediaExtension("tide.wav")).toBe("tide");
    expect(stripMediaExtension("tide.wave")).toBe("tide");
    // Non-soundtrack extensions and extension-less names pass through.
    expect(stripMediaExtension("clip.mp4")).toBe("clip.mp4");
    expect(stripMediaExtension("photo.jpg")).toBe("photo.jpg");
    expect(stripMediaExtension("README")).toBe("README");
    // Hidden files keep their leading dot.
    expect(stripMediaExtension(".mp3")).toBe(".mp3");
  });

  it("reorders one scope of visual media without touching other scopes (#12)", () => {
    const base: JourneyMediaAsset = {
      id: "",
      journeyId: "journey-1",
      routePointId: null,
      storageDriver: "test",
      storageKey: "journey-1",
      fileName: "",
      mimeType: "image/jpeg",
      bytes: 128,
      sortOrder: 0,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const media = [
      { ...base, id: "a1", fileName: "a1.jpg", sortOrder: 0, routePointId: "point-a" },
      { ...base, id: "a2", fileName: "a2.jpg", sortOrder: 1, routePointId: "point-a" },
      { ...base, id: "b1", fileName: "b1.jpg", sortOrder: 2, routePointId: "point-b" },
      { ...base, id: "a3", fileName: "a3.jpg", sortOrder: 3, routePointId: "point-a" },
      { ...base, id: "b2", fileName: "b2.jpg", sortOrder: 4, routePointId: "point-b" },
    ] as JourneyMediaAsset[];

    const reordered = applyScopeReorder(media, "point-a", ["a3", "a1", "a2"]);
    // Only point-a's relative order changes; point-b items keep their slots.
    expect(reordered.map((entry) => entry.id)).toEqual([
      "a3", "a1", "b1", "a2", "b2",
    ]);
  });

  it("rejects a scope reorder whose ids do not match the scope (#12)", () => {
    const base: JourneyMediaAsset = {
      id: "",
      journeyId: "journey-1",
      routePointId: null,
      storageDriver: "test",
      storageKey: "journey-1",
      fileName: "",
      mimeType: "image/jpeg",
      bytes: 128,
      sortOrder: 0,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const withPoint = [
      { ...base, id: "a1", fileName: "a1.jpg", sortOrder: 0, routePointId: "point-a" },
      { ...base, id: "a2", fileName: "a2.jpg", sortOrder: 1, routePointId: "point-a" },
    ] as JourneyMediaAsset[];

    // Wrong count, duplicate, and foreign id all fall back to the original.
    expect(applyScopeReorder(withPoint, "point-a", ["a1"])).toEqual(withPoint);
    expect(applyScopeReorder(withPoint, "point-a", ["a1", "a1"])).toEqual(withPoint);
    expect(applyScopeReorder(withPoint, "point-a", ["a1", "other"])).toEqual(withPoint);
  });

  it("keeps journey-scoped reorders separate from route-point scopes (#12)", () => {
    const base: JourneyMediaAsset = {
      id: "",
      journeyId: "journey-1",
      routePointId: null,
      storageDriver: "test",
      storageKey: "journey-1",
      fileName: "",
      mimeType: "image/jpeg",
      bytes: 128,
      sortOrder: 0,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const withScope = [
      { ...base, id: "j1", fileName: "j1.jpg", sortOrder: 0, routePointId: null },
      { ...base, id: "a1", fileName: "a1.jpg", sortOrder: 1, routePointId: "point-a" },
      { ...base, id: "j2", fileName: "j2.jpg", sortOrder: 2, routePointId: null },
    ] as JourneyMediaAsset[];

    const reordered = applyScopeReorder(withScope, null, ["j2", "j1"]);
    expect(reordered.map((entry) => entry.id)).toEqual(["j2", "a1", "j1"]);
  });

  it("falls back from an explicit cover to the first visual media (#14)", () => {
    const base: JourneyMediaAsset = {
      id: "",
      journeyId: "journey-1",
      routePointId: null,
      storageDriver: "test",
      storageKey: "journey-1",
      fileName: "",
      mimeType: "image/jpeg",
      bytes: 128,
      sortOrder: 0,
      uploadedByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const media = [
      { ...base, id: "a1", fileName: "a1.jpg", sortOrder: 0 },
      { ...base, id: "a2", fileName: "a2.jpg", sortOrder: 1 },
      { ...base, id: "track", fileName: "t.mp3", mimeType: "audio/mpeg", sortOrder: 2 },
    ] as JourneyMediaAsset[];

    // No explicit cover -> first visual media (soundtrack skipped).
    expect(journeyCover({ coverMediaAssetId: null, media })?.id).toBe("a1");
    // Explicit cover wins even when it is not first by order.
    expect(journeyCover({ coverMediaAssetId: "a2", media })?.id).toBe("a2");
    // A cover pointing at the soundtrack or a missing asset falls back.
    expect(journeyCover({ coverMediaAssetId: "track", media })?.id).toBe("a1");
    expect(journeyCover({ coverMediaAssetId: "missing", media })?.id).toBe("a1");
  });

  it("returns null cover when a journey has no visual media (#14)", () => {
    expect(journeyCover({ coverMediaAssetId: null, media: [] })).toBeNull();
  });
});
