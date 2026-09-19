import { describe, expect, it } from "vitest";
import {
  resolvePlaceMediaObservationRect,
  resolvePlaceMediaReturnRoutePointId,
  selectPlaceMediaMarkerAnchor,
  selectPlaceMediaRepresentative,
} from "./placeMediaHandoff";

describe("resolvePlaceMediaObservationRect", () => {
  it("places the frame beside a visible geographic marker while preserving media aspect", () => {
    const rect = resolvePlaceMediaObservationRect(
      { left: 300, top: 200, width: 14, height: 14 },
      { left: 0, top: 0, width: 76, height: 58 },
      { width: 1200, height: 800 },
      false,
    );
    expect(rect).not.toBeNull();
    expect(rect?.left).toBeCloseTo(323);
    expect(rect?.top).toBeCloseTo(167.85);
    expect(rect?.width).toBeCloseTo(102.6);
    expect(rect?.height).toBeCloseTo(78.3);
  });

  it("flips left and clamps inside the viewport near the right edge", () => {
    const rect = resolvePlaceMediaObservationRect(
      { left: 1180, top: 20, width: 14, height: 14 },
      { left: 0, top: 0, width: 200, height: 100 },
      { width: 1200, height: 800 },
      false,
    );
    expect(rect).toEqual({ left: 1059, top: 12, width: 112, height: 56 });
  });

  it("refuses an offscreen or invalid geographic anchor", () => {
    expect(resolvePlaceMediaObservationRect(
      { left: -40, top: 100, width: 10, height: 10 },
      { left: 0, top: 0, width: 76, height: 58 },
      { width: 390, height: 844 },
      true,
    )).toBeNull();
    expect(resolvePlaceMediaObservationRect(
      { left: 100, top: 100, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 58 },
      { width: 390, height: 844 },
      true,
    )).toBeNull();
  });
});


describe("resolvePlaceMediaReturnRoutePointId", () => {
  it("lets the latest same-Journey Story observation supersede the opening point", () => {
    expect(resolvePlaceMediaReturnRoutePointId({
      storyJourneyId: "journey-a",
      activeJourneyId: "journey-a",
      observation: { journeyId: "journey-a", routePointId: "point-b" },
      openingRoutePointId: "point-a",
      currentRoutePointIds: ["point-a", "point-b", "point-c"],
    })).toBe("point-b");
  });

  it("rejects stale observations from another Journey or a removed Route Point", () => {
    expect(resolvePlaceMediaReturnRoutePointId({
      storyJourneyId: "journey-a",
      activeJourneyId: "journey-a",
      observation: { journeyId: "journey-b", routePointId: "point-b" },
      openingRoutePointId: "point-a",
      currentRoutePointIds: ["point-a"],
    })).toBe("point-a");
    expect(resolvePlaceMediaReturnRoutePointId({
      storyJourneyId: "journey-a",
      activeJourneyId: "journey-a",
      observation: { journeyId: "journey-a", routePointId: "point-b" },
      openingRoutePointId: "point-a",
      currentRoutePointIds: ["point-a"],
    })).toBeNull();
  });

  it("rejects return when another Journey owns the Atlas", () => {
    expect(resolvePlaceMediaReturnRoutePointId({
      storyJourneyId: "journey-a",
      activeJourneyId: "journey-b",
      observation: { journeyId: "journey-a", routePointId: "point-a" },
      openingRoutePointId: "point-a",
      currentRoutePointIds: ["point-a"],
    })).toBeNull();
  });
});


describe("selectPlaceMediaMarkerAnchor", () => {
  const rect = { left: 300, top: 200, width: 14, height: 14 };

  it("prefers the settled marker when one is available", () => {
    expect(selectPlaceMediaMarkerAnchor([
      { element: "ramping", settled: false, rect },
      { element: "settled", settled: true, rect },
    ])).toBe("settled");
  });

  it("still anchors on a marker that is only mid-transition at the click instant", () => {
    expect(selectPlaceMediaMarkerAnchor([
      { element: "ramping", settled: false, rect },
    ])).toBe("ramping");
  });

  it("keeps an offscreen anchor so the rect resolver stays the viewport authority", () => {
    expect(selectPlaceMediaMarkerAnchor([
      { element: "offscreen", settled: false, rect: { left: -900, top: -900, width: 14, height: 14 } },
    ])).toBe("offscreen");
  });

  it("refuses a degenerate or non-finite anchor rect", () => {
    expect(selectPlaceMediaMarkerAnchor([
      { element: "collapsed", settled: false, rect: { left: 300, top: 200, width: 0, height: 0 } },
      { element: "unmeasured", settled: true, rect: { left: Number.NaN, top: 200, width: 14, height: 14 } },
    ])).toBeNull();
  });

  it("returns null when the Route Point projects no marker at all", () => {
    expect(selectPlaceMediaMarkerAnchor([])).toBeNull();
  });
});

describe("selectPlaceMediaRepresentative", () => {
  it("prefers a painted element for the requested asset", () => {
    expect(selectPlaceMediaRepresentative([
      { element: "undecoded", assetId: "asset-1", painted: false },
      { element: "painted", assetId: "asset-1", painted: true },
    ], "asset-1")).toBe("painted");
  });

  it("opens on the same asset whose decode has not landed yet", () => {
    expect(selectPlaceMediaRepresentative([
      { element: "undecoded", assetId: "asset-1", painted: false },
    ], "asset-1")).toBe("undecoded");
  });

  it("never substitutes another asset, painted or not", () => {
    expect(selectPlaceMediaRepresentative([
      { element: "other-painted", assetId: "asset-2", painted: true },
    ], "asset-1")).toBeNull();
  });
});
