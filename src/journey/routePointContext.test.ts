import { describe, expect, it } from "vitest";
import { sharedJourneyToJourney, type SharedJourney } from "./sharedAtlas";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";
import {
  buildRoutePointContext,
  emptyRoutePointContextSelection,
  requestRoutePointContextSelection,
  routePointContextTemporallyVisible,
  temporallyVisibleRoutePointContextRefs,
  resolveRoutePointContextSelection,
} from "./routePointContext";

const journeyId = "journey-context";

function point(
  id: string,
  overrides: Partial<RoutePoint> = {},
): RoutePoint {
  return {
    id,
    journeyId,
    sortOrder: 0,
    latitude: 22.2855,
    longitude: 114.1577,
    label: "中环码头",
    isStop: true,
    occurredAt: "2026-04-06T09:30:00.000Z",
    note: null,
    createdAt: "2026-04-06T09:30:00.000Z",
    ...overrides,
  };
}

function asset(
  id: string,
  routePointId: string | null,
  mimeType: string,
  sortOrder: number,
): JourneyMediaAsset {
  return {
    id,
    journeyId,
    routePointId,
    storageDriver: "s3",
    storageKey: id,
    fileName: `${id}.${mimeType.startsWith("video/") ? "mp4" : "jpg"}`,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: "2026-04-06T09:30:00.000Z",
  };
}

function journey(
  routePoints: RoutePoint[],
  media: JourneyMediaAsset[],
): Journey {
  return {
    id: journeyId,
    atlasId: "atlas-1",
    title: "维港的一天",
    startedOn: "2026-04-06",
    endedOn: null,
    note: "",
    lightColor: "#77c8c2",
    revision: 1,
    createdByUserId: "user-1",
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    routePoints,
    media,
  };
}

describe("buildRoutePointContext", () => {
  it("projects a photo-only Route Point", () => {
    const target = point("point-photo");
    const context = buildRoutePointContext(journey(
      [target],
      [asset("photo-1", target.id, "image/jpeg", 0), asset("audio-1", null, "audio/mpeg", 1)],
    ), target.id);

    expect(context).toMatchObject({
      journeyId,
      journeyTitle: "维港的一天",
      routePointId: target.id,
      routePointLabel: "中环码头",
      routePointIndex: 0,
      routePointCount: 1,
      resolvedDate: "2026-04-06T09:30:00.000Z",
      notePresent: false,
      visualMediaCount: 1,
      representativeAssetId: "photo-1",
      location: { latitude: 22.2855, longitude: 114.1577, precision: "route-point" },
    });
  });

  it("counts mixed photo and video media without counting soundtrack", () => {
    const target = point("point-mixed");
    const context = buildRoutePointContext(journey(
      [target],
      [
        asset("video-1", target.id, "video/mp4", 2),
        asset("photo-1", target.id, "image/jpeg", 1),
        asset("audio-1", target.id, "audio/mpeg", 0),
      ],
    ), target.id);

    expect(context?.visualMediaCount).toBe(2);
    expect(context?.representativeAssetId).toBe("photo-1");
  });

  it("keeps a text-only Route Point truthful with no fake pending state", () => {
    const target = point("point-text", { note: "这里吹了很久的海风。" });
    const context = buildRoutePointContext(journey([target], []), target.id);

    expect(context).toMatchObject({
      notePresent: true,
      note: "这里吹了很久的海风。",
      visualMediaCount: 0,
      representativeAssetId: null,
    });
    expect(context).not.toHaveProperty("pending");
    expect(context).not.toHaveProperty("loading");
  });

  it("returns an explicit absent date for an undated Route Point", () => {
    const target = point("point-undated", { occurredAt: null });
    expect(buildRoutePointContext(journey([target], []), target.id)?.resolvedDate).toBeNull();
  });

  it("fabricated-capture-location: never promotes Route Point coordinates to asset, road or track claims", () => {
    const target = point("point-location", { latitude: 22.3193, longitude: 114.1694 });
    const context = buildRoutePointContext(journey(
      [target],
      [asset("route-assigned-photo", target.id, "image/jpeg", 0)],
    ), target.id);

    expect(context?.location).toEqual({
      latitude: 22.3193,
      longitude: 114.1694,
      precision: "route-point",
    });
    expect(context).not.toHaveProperty("assetLocation");
    expect(context).not.toHaveProperty("captureCoordinates");
    expect(context).not.toHaveProperty("road");
    expect(context).not.toHaveProperty("track");
  });

  it("derives counts only from the guest-projected Journey supplied to it", () => {
    const shared: SharedJourney = {
      id: journeyId,
      title: "共享维港",
      startedOn: "2026-04-06",
      endedOn: null,
      note: "",
      lightColor: "#77c8c2",
      lightEffect: null,
      coverMediaAssetId: null,
      revision: 1,
      previousJourneyId: null,
      nextJourneyId: null,
      routePoints: [{
        id: "shared-point",
        latitude: 22.2855,
        longitude: 114.1577,
        label: "共享中环",
        isStop: true,
        occurredAt: null,
        note: null,
      }],
      media: [{
        id: "shared-photo",
        routePointId: "shared-point",
        fileName: "shared.jpg",
        mimeType: "image/jpeg",
        bytes: 100,
      }],
    };

    const guestJourney = sharedJourneyToJourney(shared);
    const context = buildRoutePointContext(guestJourney, "shared-point");
    expect(context?.visualMediaCount).toBe(1);
    expect(context?.representativeAssetId).toBe("shared-photo");
  });

  it("keeps exact same-coordinate records distinct and derives route-order neighbours per selected record", () => {
    const routePoints = [
      point("point-01", { sortOrder: 0, label: "起点", latitude: 22.2801, longitude: 114.1501 }),
      point("point-02", { sortOrder: 1, label: "码头 · 早上" }),
      point("point-03", { sortOrder: 2, label: "第三站", latitude: 22.286, longitude: 114.158 }),
      point("point-04", { sortOrder: 3, label: "第四站", latitude: 22.287, longitude: 114.159 }),
      point("point-05", { sortOrder: 4, label: "第五站", latitude: 22.288, longitude: 114.16 }),
      point("point-06", { sortOrder: 5, label: "第六站", latitude: 22.289, longitude: 114.161 }),
      point("point-07", { sortOrder: 6, label: "码头 · 夜里", isStop: false }),
      point("point-08", { sortOrder: 7, label: "终点", latitude: 22.2905, longitude: 114.1625 }),
    ];
    const trip = journey(routePoints, []);

    const second = buildRoutePointContext(trip, "point-02");
    const seventh = buildRoutePointContext(trip, "point-07");

    expect(second?.sameCoordinateRoutePoints.map((entry) => entry.routePointId)).toEqual([
      "point-02",
      "point-07",
    ]);
    expect(second?.previousRoutePoint?.routePointId).toBe("point-01");
    expect(second?.nextRoutePoint?.routePointId).toBe("point-03");
    expect(seventh?.previousRoutePoint?.routePointId).toBe("point-06");
    expect(seventh?.nextRoutePoint?.routePointId).toBe("point-08");
    expect(seventh?.sameCoordinateRoutePoints[1]).toMatchObject({
      routePointId: "point-07",
      routePointIndex: 6,
      isStop: false,
    });
  });

  it("keeps temporally hidden co-located records out of direct context switching", () => {
    const trip = journey([
      point("point-02", { sortOrder: 1, label: "morning" }),
      point("point-07", { sortOrder: 6, label: "night", isStop: false }),
    ], []);
    const context = buildRoutePointContext(trip, "point-02");
    const temporalReveal = {
      journeys: new Map([[trip.id, 1]]),
      points: new Map([
        [`${trip.id}:0`, 1],
        [`${trip.id}:1`, 0],
      ]),
    };

    expect(routePointContextTemporallyVisible(trip.id, 0, temporalReveal)).toBe(true);
    expect(routePointContextTemporallyVisible(trip.id, 1, temporalReveal)).toBe(false);
    expect(routePointContextTemporallyVisible(trip.id, 0, {
      journeys: new Map([[trip.id, 0]]),
      points: new Map([[`${trip.id}:0`, 1]]),
    })).toBe(false);
    expect(temporallyVisibleRoutePointContextRefs(
      trip.id,
      context?.sameCoordinateRoutePoints ?? [],
      temporalReveal,
    ).map((entry) => entry.routePointId)).toEqual(["point-02"]);
    expect(temporallyVisibleRoutePointContextRefs(
      trip.id,
      context?.sameCoordinateRoutePoints ?? [],
      undefined,
    ).map((entry) => entry.routePointId)).toEqual(["point-02", "point-07"]);
  });

  it("uses exact canonical coordinates only, never labels or proximity", () => {
    const target = point("target", { label: "同名" });
    const sameLabelDifferentCoordinate = point("same-label", {
      sortOrder: 1,
      label: "同名",
      latitude: 22.2855001,
    });
    const exactCoordinateDifferentLabel = point("exact-coordinate", {
      sortOrder: 2,
      label: "另一条记录",
      isStop: false,
    });
    const context = buildRoutePointContext(
      journey([target, sameLabelDifferentCoordinate, exactCoordinateDifferentLabel], []),
      target.id,
    );

    expect(context?.sameCoordinateRoutePoints.map((entry) => entry.routePointId)).toEqual([
      "target",
      "exact-coordinate",
    ]);
  });

  it("recomputes same-coordinate grouping and neighbours from the current Route order after reorder/delete", () => {
    const a = point("A", { label: "A", latitude: 22.28, longitude: 114.15 });
    const b = point("B", { label: "B" });
    const c = point("C", { label: "C", latitude: 22.29, longitude: 114.16 });
    const d = point("D", { label: "D", isStop: false });

    const reordered = journey([a, d, c, b], []);
    const afterReorder = buildRoutePointContext(reordered, "B");
    expect(afterReorder?.routePointIndex).toBe(3);
    expect(afterReorder?.previousRoutePoint?.routePointId).toBe("C");
    expect(afterReorder?.nextRoutePoint).toBeNull();
    expect(afterReorder?.sameCoordinateRoutePoints.map((entry) => [entry.routePointId, entry.routePointIndex])).toEqual([
      ["D", 1],
      ["B", 3],
    ]);

    const afterDelete = buildRoutePointContext(journey([a, c, b], []), "B");
    expect(afterDelete?.sameCoordinateRoutePoints.map((entry) => entry.routePointId)).toEqual(["B"]);
    expect(afterDelete?.previousRoutePoint?.routePointId).toBe("C");
  });

  it("keeps unnamed passthrough Route Points valid even when the Journey has no Stops", () => {
    const first = point("pass-1", { label: "", isStop: false });
    const second = point("pass-2", { label: "", isStop: false, sortOrder: 1 });
    const context = buildRoutePointContext(journey([first, second], []), second.id);

    expect(context).toMatchObject({
      routePointId: "pass-2",
      routePointLabel: "途径点 2",
      previousRoutePoint: { routePointId: "pass-1", routePointLabel: "途径点 1", isStop: false },
      nextRoutePoint: null,
    });
    expect(context?.sameCoordinateRoutePoints).toHaveLength(2);
    expect(context?.sameCoordinateRoutePoints.every((entry) => entry.isStop === false)).toBe(true);
  });

  it("groups only records present in the already-authorized guest Journey projection", () => {
    const shared: SharedJourney = {
      id: journeyId,
      title: "共享同坐标路线点",
      startedOn: "2026-04-06",
      endedOn: null,
      note: "",
      lightColor: "#77c8c2",
      lightEffect: null,
      coverMediaAssetId: null,
      revision: 1,
      previousJourneyId: null,
      nextJourneyId: null,
      routePoints: [
        {
          id: "shared-02", latitude: 22.2855, longitude: 114.1577, label: "早上", isStop: true, occurredAt: null, note: null,
        },
        {
          id: "shared-07", latitude: 22.2855, longitude: 114.1577, label: "夜里", isStop: false, occurredAt: null, note: null,
        },
      ],
      media: [],
    };

    const context = buildRoutePointContext(sharedJourneyToJourney(shared), "shared-02");
    expect(context?.sameCoordinateRoutePoints.map((entry) => entry.routePointId)).toEqual([
      "shared-02",
      "shared-07",
    ]);
    expect(context?.sameCoordinateRoutePoints).toHaveLength(2);
  });
});

describe("Route Point context newest-intent resolver", () => {
  it("keeps C as owner when A and B resolve late", () => {
    const trip = journey([
      point("A", { sortOrder: 0, label: "A" }),
      point("B", { sortOrder: 1, label: "B" }),
      point("C", { sortOrder: 2, label: "C" }),
    ], []);
    let selection = emptyRoutePointContextSelection();
    const a = requestRoutePointContextSelection(selection, journeyId, "A");
    selection = a.selection;
    const b = requestRoutePointContextSelection(selection, journeyId, "B");
    selection = b.selection;
    const c = requestRoutePointContextSelection(selection, journeyId, "C");
    selection = c.selection;

    selection = resolveRoutePointContextSelection(selection, a.intent, buildRoutePointContext(trip, "A"));
    selection = resolveRoutePointContextSelection(selection, b.intent, buildRoutePointContext(trip, "B"));
    expect(selection.context).toBeNull();

    selection = resolveRoutePointContextSelection(selection, c.intent, buildRoutePointContext(trip, "C"));
    expect(selection.context?.routePointId).toBe("C");
    expect(selection.intent).toEqual(c.intent);
  });
});
