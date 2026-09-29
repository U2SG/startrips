import { describe, expect, it } from "vitest";
import {
  applyScopeReorder,
  buildRecordedTrackLodLevels,
  recordedTrackLodConstructionCount,
  recordedTrackSampleTimes,
  recordedTrackVisibleSampleCount,
  deriveJourneyStaySummaries,
  journeyOverviewRoutePointIds,
  groupJourneysByYear,
  isSoundtrackAsset,
  isVisualMediaAsset,
  journeyCover,
  journeySoundtrack,
  journeyVisualMedia,
  resolveRouteProvenance,
  resolveSuggestedRouteDecision,
  sortJourneysChronologically,
  stripMediaExtension,
  toJourneyRoutes,
  validateJourneyFiles,
  validateJourneyInput,
  validateJourneySoundtrack,
} from "./journeyModel";
import type { Journey, JourneyInput, JourneyMediaAsset } from "./types";

describe("recorded track time and reusable LOD", () => {
  it("requires complete monotonic timestamps before treating samples as temporal evidence", () => {
    const sample = (recordedAt?: string | null) => ({ lat: 22, lon: 114, recordedAt });
    const start = "2026-09-01T00:00:00.000Z";
    const end = "2026-09-01T00:00:10.000Z";
    for (const points of [
      [sample(), sample()],
      [sample(start), sample(null), sample(end)],
      [sample(start), sample("invalid")],
      [sample(end), sample(start)],
      [sample(start), sample(start)],
    ]) expect(recordedTrackSampleTimes(points)).toBeNull();
    const times = recordedTrackSampleTimes([sample(start), sample(start), sample(end)])!;
    expect(recordedTrackVisibleSampleCount(times, Date.parse(start) - 1)).toBe(0);
    expect(recordedTrackVisibleSampleCount(times, Date.parse(start))).toBe(2);
    expect(recordedTrackVisibleSampleCount(times, Date.parse(end))).toBe(3);
    expect(recordedTrackVisibleSampleCount(times)).toBe(3);
  });

  it("precomputes four 100k-sample levels once and retains both gap boundaries", () => {
    const points = Array.from({ length: 100_000 }, (_, index) => ({
      lat: 22 + index * 0.000004 + Math.sin(index / 30) * 0.001,
      lon: 114 + index * 0.00002,
    }));
    const before = recordedTrackLodConstructionCount();
    const levels = buildRecordedTrackLodLevels(points);
    expect(levels).toHaveLength(4);
    expect(levels[0].points).toHaveLength(100_000);
    expect(levels.at(-1)!.points.length).toBeLessThan(100_000);
    for (let repeat = 0; repeat < 8; repeat += 1) expect(buildRecordedTrackLodLevels(points)).toBe(levels);
    expect(recordedTrackLodConstructionCount()).toBe(before + 1);
    for (const level of levels) {
      expect(level.points[0]).toBe(points[0]);
      expect(level.points.at(-1)).toBe(points.at(-1));
    }
  });
});

describe("route provenance evidence (#342)", () => {
  it("never upgrades geometry-only evidence into historical route truth", () => {
    expect(resolveRouteProvenance({ geometryPresent: true })).toBe("sparse-relation");
    expect(resolveRouteProvenance({ geometryPresent: true, suggested: true })).toBe("suggested-route");
    expect(resolveRouteProvenance({ geometryPresent: true, userShaped: true })).toBe("user-shaped-route");
  });

  it("promotes a suggestion only after explicit confirmation", () => {
    expect(resolveSuggestedRouteDecision("confirm", "sparse-relation"))
      .toBe("user-confirmed-route");
  });

  it("restores the supplied evidence tier when a suggestion is rejected", () => {
    expect(resolveSuggestedRouteDecision("none-of-these", "sparse-relation"))
      .toBe("sparse-relation");
    expect(resolveSuggestedRouteDecision("none-of-these", "user-shaped-route"))
      .toBe("user-shaped-route");
  });
});

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

  it("derives consecutive stay summaries without creating or merging Route Point identity (#514)", () => {
    const trip = journey("trip", "2026-08-11");
    trip.routePoints = [
      { id: "hotel-a", journeyId: trip.id, sortOrder: 0, latitude: 30.66, longitude: 104.06, label: "Hotel A", isStop: true, occurredAt: null, regionContext: "成都", placeRole: "accommodation", createdAt: trip.createdAt },
      { id: "museum", journeyId: trip.id, sortOrder: 1, latitude: 30.67, longitude: 104.07, label: "Museum", isStop: true, occurredAt: null, regionContext: "成都", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "transit", journeyId: trip.id, sortOrder: 2, latitude: 30.8, longitude: 104.2, label: "", isStop: false, occurredAt: null, regionContext: "成都", placeRole: "pure-transit", createdAt: trip.createdAt },
      { id: "chongqing", journeyId: trip.id, sortOrder: 3, latitude: 29.56, longitude: 106.55, label: "重庆", isStop: true, occurredAt: null, regionContext: "重庆", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "hotel-b", journeyId: trip.id, sortOrder: 4, latitude: 30.65, longitude: 104.08, label: "Hotel B", isStop: true, occurredAt: null, regionContext: "成都", placeRole: "accommodation", createdAt: trip.createdAt },
    ];
    trip.media = [{
      id: "media-1", journeyId: trip.id, routePointId: "museum", storageDriver: "s3", storageKey: "a",
      fileName: "a.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 0, uploadedByUserId: "user-1", createdAt: trip.createdAt,
    }];

    const summaries = deriveJourneyStaySummaries(trip);
    expect(summaries.map((summary) => ({
      label: summary.label,
      anchor: summary.anchorRoutePointId,
      points: summary.routePointIds,
      media: summary.mediaAssetIds,
    }))).toEqual([
      { label: "成都", anchor: "museum", points: ["hotel-a", "museum"], media: ["media-1"] },
      { label: "重庆", anchor: "chongqing", points: ["chongqing"], media: [] },
      { label: "成都", anchor: "hotel-b", points: ["hotel-b"], media: [] },
    ]);
  });

  it("treats an explicitly promoted Stop as a stay even when imported role metadata remains transit (#514)", () => {
    const trip = journey("promoted-stop", "2026-08-11");
    trip.routePoints = [{
      id: "promoted",
      journeyId: trip.id,
      sortOrder: 0,
      latitude: 22.54,
      longitude: 114.05,
      label: "Promoted stop",
      isStop: true,
      occurredAt: null,
      regionContext: "深圳",
      placeRole: "pure-transit",
      createdAt: trip.createdAt,
    }];

    const summaries = deriveJourneyStaySummaries(trip);
    expect(summaries.map((summary) => summary.routePointIds)).toEqual([["promoted"]]);
    expect(journeyOverviewRoutePointIds(trip, summaries)).toEqual(["promoted"]);
  });

  it("lets an explicit non-stop owner override heuristic stay grouping without changing route/media identity (#514)", () => {
    const trip = journey("owned", "2026-08-11");
    trip.routePoints = [
      { id: "stop-a", journeyId: trip.id, sortOrder: 0, latitude: 30.66, longitude: 104.06, label: "Stop A", isStop: true, occurredAt: null, regionContext: "A", createdAt: trip.createdAt },
      { id: "via", journeyId: trip.id, sortOrder: 1, latitude: 30.67, longitude: 104.07, label: "Via", isStop: false, occurredAt: null, regionContext: "B", stayAnchorRoutePointId: "stop-a", createdAt: trip.createdAt },
      { id: "stop-b", journeyId: trip.id, sortOrder: 2, latitude: 31.1, longitude: 105.1, label: "Stop B", isStop: true, occurredAt: null, regionContext: "B", createdAt: trip.createdAt },
    ];
    trip.media = [{
      id: "via-photo", journeyId: trip.id, routePointId: "via", storageDriver: "s3", storageKey: "via",
      fileName: "via.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 0, uploadedByUserId: "user-1", createdAt: trip.createdAt,
    }];
    const beforeRoute = structuredClone(trip.routePoints);
    const beforeMedia = structuredClone(trip.media);

    const summaries = deriveJourneyStaySummaries(trip);
    expect(summaries[0]).toMatchObject({
      anchorRoutePointId: "stop-a",
      routePointIds: ["stop-a", "via"],
      mediaAssetIds: ["via-photo"],
    });
    expect(summaries[1].routePointIds).toEqual(["stop-b"]);
    expect(trip.routePoints).toEqual(beforeRoute);
    expect(trip.media).toEqual(beforeMedia);
  });

  it("keeps unknown/far-apart places separate and filters before stay aggregation (#514)", () => {
    const trip = journey("bounds", "2026-08-11");
    trip.routePoints = [
      { id: "unknown-a", journeyId: trip.id, sortOrder: 0, latitude: 22.54, longitude: 114.05, label: "A", isStop: true, occurredAt: null, createdAt: trip.createdAt },
      { id: "unknown-b", journeyId: trip.id, sortOrder: 1, latitude: 22.55, longitude: 114.06, label: "B", isStop: true, occurredAt: null, createdAt: trip.createdAt },
      { id: "same-name-a", journeyId: trip.id, sortOrder: 2, latitude: 31.23, longitude: 121.47, label: "C", isStop: true, occurredAt: null, regionContext: "同名区域", createdAt: trip.createdAt },
      { id: "same-name-b", journeyId: trip.id, sortOrder: 3, latitude: 39.90, longitude: 116.40, label: "D", isStop: true, occurredAt: null, regionContext: "同名区域", overviewVisibility: "detail", createdAt: trip.createdAt },
    ];

    expect(deriveJourneyStaySummaries(trip).map((summary) => summary.routePointIds)).toEqual([
      ["unknown-a"],
      ["unknown-b"],
      ["same-name-a"],
      ["same-name-b"],
    ]);
    expect(deriveJourneyStaySummaries(trip).at(-1)?.overviewVisible).toBe(false);
    expect(deriveJourneyStaySummaries(trip, { includedRoutePointIds: new Set(["unknown-b", "same-name-a"]) })
      .map((summary) => summary.routePointIds)).toEqual([["unknown-b"], ["same-name-a"]]);
    const noVisibleStays = deriveJourneyStaySummaries(trip, { includedRoutePointIds: new Set() });
    expect(journeyOverviewRoutePointIds(trip, noVisibleStays)).toEqual([]);
  });

  it("preserves explicit child membership while filtering media and authorized route points", () => {
    const trip = journey("via-stay", "2026-08-11");
    trip.routePoints = [
      { id: "stop-a", journeyId: trip.id, sortOrder: 0, latitude: 0, longitude: 0, label: "A", isStop: true, occurredAt: null, regionContext: "A", createdAt: trip.createdAt },
      { id: "shape", journeyId: trip.id, sortOrder: 1, latitude: 0.1, longitude: 0.1, label: "shape", isStop: false, occurredAt: null, regionContext: "A", createdAt: trip.createdAt },
      { id: "child", journeyId: trip.id, sortOrder: 2, latitude: 0.2, longitude: 0.2, label: "child", isStop: false, occurredAt: null, regionContext: "A", stayAnchorRoutePointId: "stop-a", createdAt: trip.createdAt },
      { id: "unknown", journeyId: trip.id, sortOrder: 3, latitude: 0.2, longitude: 0.2, label: "unknown", isStop: false, occurredAt: null, createdAt: trip.createdAt },
      { id: "distant", journeyId: trip.id, sortOrder: 4, latitude: 20, longitude: 20, label: "distant", isStop: false, occurredAt: null, regionContext: "A", createdAt: trip.createdAt },
    ];
    trip.media = ["child", "unknown", "distant"].map((routePointId, sortOrder) => ({
      id: `${routePointId}-photo`, journeyId: trip.id, routePointId, storageDriver: "test", storageKey: routePointId,
      fileName: `${routePointId}.jpg`, mimeType: "image/jpeg", bytes: 1, sortOrder,
      uploadedByUserId: "user-1", createdAt: trip.createdAt,
    }));
    const before = structuredClone(trip);
    expect(deriveJourneyStaySummaries(trip)).toEqual([expect.objectContaining({
      id: `stay:${trip.id}:stop-a`, anchorRoutePointId: "stop-a", routePointIds: ["stop-a", "child"], mediaAssetIds: ["child-photo"],
    })]);
    expect(deriveJourneyStaySummaries(trip, { includedMediaAssetIds: new Set(["unknown-photo"]) })[0])
      .toMatchObject({ routePointIds: ["stop-a", "child"], mediaAssetIds: [] });
    expect(deriveJourneyStaySummaries(trip, { includedRoutePointIds: new Set(["stop-a", "distant"]) })[0].routePointIds).toEqual(["stop-a"]);
    expect(trip).toEqual(before);
  });

  it("keeps the full route/provenance matrix intact while deriving stays (#514)", () => {
    const trip = journey("matrix", "2026-08-11");
    const routePoints = [
      { id: "a-day-1", journeyId: trip.id, sortOrder: 0, latitude: 30.66, longitude: 104.06, label: "A hotel", isStop: true, occurredAt: "2026-08-11T23:30:00Z", regionContext: "A", placeRole: "accommodation", createdAt: trip.createdAt },
      { id: "a-day-2", journeyId: trip.id, sortOrder: 1, latitude: 30.67, longitude: 104.07, label: "A museum", isStop: true, occurredAt: "2026-08-12T00:30:00Z", regionContext: "A", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "b-same-day", journeyId: trip.id, sortOrder: 2, latitude: 29.56, longitude: 106.55, label: "B", isStop: true, occurredAt: "2026-08-12T03:00:00Z", regionContext: "B", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "a-return", journeyId: trip.id, sortOrder: 3, latitude: 30.65, longitude: 104.08, label: "A return", isStop: true, occurredAt: "2026-08-12T08:00:00Z", regionContext: "A", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "same-coordinate-1", journeyId: trip.id, sortOrder: 4, latitude: 22.2855, longitude: 114.1577, label: "C one", isStop: true, occurredAt: null, regionContext: "C", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "same-coordinate-2", journeyId: trip.id, sortOrder: 5, latitude: 22.2855, longitude: 114.1577, label: "C two", isStop: true, occurredAt: null, regionContext: "C", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "same-name-near", journeyId: trip.id, sortOrder: 6, latitude: 31.23, longitude: 121.47, label: "D Shanghai", isStop: true, occurredAt: null, regionContext: "D", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "same-name-far", journeyId: trip.id, sortOrder: 7, latitude: 39.90, longitude: 116.40, label: "D Beijing", isStop: true, occurredAt: null, regionContext: "D", placeRole: "attraction", createdAt: trip.createdAt },
      { id: "hotel-only", journeyId: trip.id, sortOrder: 8, latitude: 35.68, longitude: 139.76, label: "E hotel", isStop: true, occurredAt: null, regionContext: "E", placeRole: "accommodation", createdAt: trip.createdAt },
      { id: "detour", journeyId: trip.id, sortOrder: 9, latitude: 35.70, longitude: 139.80, label: "detour", isStop: false, occurredAt: null, regionContext: "E", placeRole: "pure-transit", createdAt: trip.createdAt },
    ] satisfies Journey["routePoints"];
    trip.routePoints = routePoints;
    trip.media = [
      { id: "a-photo", journeyId: trip.id, routePointId: "a-day-2", storageDriver: "s3", storageKey: "a", fileName: "a.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 0, uploadedByUserId: "user-1", createdAt: trip.createdAt },
      { id: "detour-photo", journeyId: trip.id, routePointId: "detour", storageDriver: "s3", storageKey: "d", fileName: "d.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 1, uploadedByUserId: "user-1", createdAt: trip.createdAt },
    ];
    const routeBefore = structuredClone(trip.routePoints);
    const mediaBefore = structuredClone(trip.media);

    const summaries = deriveJourneyStaySummaries(trip, { includedMediaAssetIds: new Set(["a-photo"]) });

    expect(summaries.map((summary) => summary.routePointIds)).toEqual([
      ["a-day-1", "a-day-2"],
      ["b-same-day"],
      ["a-return"],
      ["same-coordinate-1", "same-coordinate-2"],
      ["same-name-near"],
      ["same-name-far"],
      ["hotel-only"],
    ]);
    expect(summaries[0].mediaAssetIds).toEqual(["a-photo"]);
    expect(summaries.flatMap((summary) => summary.mediaAssetIds)).not.toContain("detour-photo");
    expect(summaries.at(-1)).toMatchObject({ label: "E", anchorRoutePointId: "hotel-only" });
    expect(trip.routePoints).toEqual(routeBefore);
    expect(trip.media).toEqual(mediaBefore);
    expect(trip.routePoints.map((point) => point.id)).toEqual(routeBefore.map((point) => point.id));
    expect(trip.routePoints.find((point) => point.id === "detour")).toMatchObject({
      isStop: false, latitude: 35.70, longitude: 139.80,
    });
  });

  it("keeps zero/one-point and large authorized projections bounded (#514)", () => {
    const empty = journey("empty", "2026-08-11");
    expect(deriveJourneyStaySummaries(empty)).toEqual([]);

    const single = journey("single", "2026-08-11");
    single.routePoints = [{
      id: "only", journeyId: single.id, sortOrder: 0, latitude: 1, longitude: 1, label: "Only",
      isStop: true, occurredAt: null, regionContext: "Only region", createdAt: single.createdAt,
    }];
    expect(deriveJourneyStaySummaries(single)).toEqual([expect.objectContaining({
      routePointIds: ["only"], anchorRoutePointId: "only", mediaAssetIds: [],
    })]);

    const large = journey("large", "2026-08-11");
    large.routePoints = Array.from({ length: 64 }, (_, index) => ({
      id: `p-${index}`, journeyId: large.id, sortOrder: index, latitude: index / 10, longitude: index / 10,
      label: `Point ${index}`, isStop: true, occurredAt: null, regionContext: `Region ${index}`, createdAt: large.createdAt,
    }));
    large.media = Array.from({ length: 512 }, (_, index) => ({
      id: `m-${index}`, journeyId: large.id, routePointId: `p-${index % 64}`, storageDriver: "s3",
      storageKey: `m-${index}`, fileName: `m-${index}.jpg`, mimeType: "image/jpeg", bytes: 1, sortOrder: index,
      uploadedByUserId: "user-1", createdAt: large.createdAt,
    }));
    const authorizedPointIds = new Set(large.routePoints.filter((_, index) => index % 2 === 0).map((point) => point.id));
    const authorizedMediaIds = new Set(large.media.filter((_, index) => index % 4 === 0).map((asset) => asset.id));
    const summaries = deriveJourneyStaySummaries(large, {
      includedRoutePointIds: authorizedPointIds,
      includedMediaAssetIds: authorizedMediaIds,
    });
    expect(summaries).toHaveLength(32);
    expect(summaries.flatMap((summary) => summary.routePointIds)).toHaveLength(32);
    expect(summaries.flatMap((summary) => summary.mediaAssetIds).every((id) => authorizedMediaIds.has(id))).toBe(true);
    expect(summaries.flatMap((summary) => summary.mediaAssetIds)).toHaveLength(128);
  });
  it("adds a presentation-only overview label without replacing the canonical place label (#514)", () => {
    const labeledJourney = journey("overview", "2026-08-11");
    labeledJourney.routePoints = [{
      id: "point-1", journeyId: labeledJourney.id, sortOrder: 0, latitude: 22.5431, longitude: 114.0579,
      label: "具体酒店", isStop: true, occurredAt: null, createdAt: labeledJourney.createdAt,
    }];
    expect(toJourneyRoutes([labeledJourney], new Map([["point-1", "深圳"]]))[0].points[0]).toMatchObject({
      label: "具体酒店",
      overviewLabel: "深圳",
    });
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

  it("accepts route-point notes up to the soft cap and rejects over it (#10)", () => {
    const point = {
      latitude: 31.2304,
      longitude: 121.4737,
      label: "上海",
      isStop: true,
      occurredAt: "2026-08-11T01:00:00Z",
    };
    expect(validateJourneyInput(input({
      routePoints: [{ ...point, note: "那一刻特别安静。" }],
    })).accepted).toBe(true);
    expect(validateJourneyInput(input({
      routePoints: [{ ...point, note: null }],
    })).accepted).toBe(true);
    expect(validateJourneyInput(input({
      routePoints: [{ ...point, note: "x".repeat(500) }],
    })).accepted).toBe(true);
    expect(validateJourneyInput(input({
      routePoints: [{ ...point, note: "x".repeat(501) }],
    })).accepted).toBe(false);
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
