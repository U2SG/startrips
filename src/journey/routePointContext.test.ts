import { describe, expect, it } from "vitest";
import { sharedJourneyToJourney, type SharedJourney } from "./sharedAtlas";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";
import {
  buildRoutePointContext,
  emptyRoutePointContextSelection,
  requestRoutePointContextSelection,
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
