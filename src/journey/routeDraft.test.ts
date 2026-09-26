import { describe, expect, it } from "vitest";
import {
  appendRoutePoint,
  parseCoordinateInput,
  routePointFocusAfterRemoval,
  matchRouteDraftPoints,
  moveRoutePoint,
  removeRoutePoint,
  routeDraftSearchFocus,
  routeDraftToInput,
  suggestPointLabel,
  toggleRouteStop,
  updateRoutePoint,
  type RouteDraftPoint,
} from "./routeDraft";

const beijing: RouteDraftPoint = {
  draftId: "beijing",
  id: "11111111-1111-4111-8111-111111111111",
  latitude: 39.9042,
  longitude: 116.4074,
  label: "Beijing",
  isStop: true,
  occurredAt: null,
};

const ulanBator: RouteDraftPoint = {
  draftId: "ulan-bator",
  latitude: 47.8864,
  longitude: 106.9057,
  label: "Ulaanbaatar",
  isStop: true,
  occurredAt: null,
};

describe("route draft operations", () => {
  it("appends, updates, reorders, toggles, and removes without mutating input", () => {
    const original = [beijing];
    const appended = appendRoutePoint(original, ulanBator);
    const moved = moveRoutePoint(appended, "ulan-bator", -1);
    const updated = updateRoutePoint(moved, "beijing", { label: " Beijing " });
    const toggled = toggleRouteStop(updated, "ulan-bator");
    const removed = removeRoutePoint(toggled, "beijing");

    expect(original).toEqual([beijing]);
    expect(moved.map((point) => point.draftId)).toEqual([
      "ulan-bator",
      "beijing",
    ]);
    expect(routeDraftToInput(updated)[1].label).toBe("Beijing");
    expect(routeDraftToInput(updated)[1].id).toBe(beijing.id);
    expect(toggled[0].isStop).toBe(false);
    expect(removed.map((point) => point.draftId)).toEqual(["ulan-bator"]);
  });

  it("leaves ordering unchanged at either boundary", () => {
    const points = [beijing, ulanBator];
    expect(moveRoutePoint(points, "beijing", -1)).toEqual(points);
    expect(moveRoutePoint(points, "ulan-bator", 1)).toEqual(points);
  });

  it("fills only an empty point label with a reverse-geocoded suggestion", () => {
    const unnamed: RouteDraftPoint = { ...ulanBator, label: "" };
    const named = suggestPointLabel([unnamed, beijing], "ulan-bator", "  Shenzhen ");
    expect(named[0].label).toBe("Shenzhen");
    expect(named[1].label).toBe("Beijing");

    expect(suggestPointLabel([beijing], "beijing", "Tokyo")[0].label).toBe("Beijing");
    expect(suggestPointLabel([unnamed], "missing", "Tokyo")[0].label).toBe("");
    expect(suggestPointLabel([unnamed], "ulan-bator", "   ")[0].label).toBe("");
  });

  it("carries route-point notes through updates and the input payload (#10)", () => {
    const withNote: RouteDraftPoint = {
      ...beijing,
      note: "风很大，只记得那一刻特别安静。",
    };
    const updated = updateRoutePoint([withNote], "beijing", {
      note: "第二次来的时候，已经能认出山脊的轮廓。",
    });
    expect(updated[0].note).toBe("第二次来的时候，已经能认出山脊的轮廓。");

    const cleared = updateRoutePoint([withNote], "beijing", { note: "" });
    expect(cleared[0].note).toBe("");

    // routeDraftToInput spreads the note through, so the whole-list replace
    // never drops it.
    expect(routeDraftToInput([withNote])[0].note).toBe("风很大，只记得那一刻特别安静。");
  });

  it("keeps the current 64-point maximum operable without replacing draft identity", () => {
    const points: RouteDraftPoint[] = Array.from({ length: 64 }, (_, index) => ({
      draftId: `max-${String(index + 1).padStart(2, "0")}`,
      latitude: index / 2,
      longitude: index,
      label: `Point ${index + 1}`,
      note: index === 63 ? "tail" : null,
      isStop: false,
      occurredAt: null,
    }));
    const tail = points[63];
    const moved = moveRoutePoint(points, tail.draftId, -1);

    expect(moved).toHaveLength(64);
    expect(moved[62]).toBe(tail);
    expect(moved[62]).toMatchObject({ draftId: "max-64", note: "tail", isStop: false });
    expect(new Set(moved.map((point) => point.draftId)).size).toBe(64);
  });

  it("matches existing draft Route Points textually in current route order without merging identity", () => {
    const points: RouteDraftPoint[] = [
      { ...beijing, draftId: "record-01", label: "Las Vegas", latitude: 36.1699, longitude: -115.1398, note: "first" },
      { ...ulanBator, draftId: "record-02", label: "LAS VEGAS", latitude: 35.99, longitude: -115.2, note: "second" },
      { ...beijing, draftId: "record-03", label: "Las Vegas North", latitude: 36.3, longitude: -115.12, note: "third" },
      { ...ulanBator, draftId: "record-04", label: "Reno", latitude: 39.5296, longitude: -119.8138 },
    ];

    const matches = matchRouteDraftPoints(points, "  las vegas  ");
    expect(matches.map(({ point, routeIndex }) => ({ draftId: point.draftId, routeIndex }))).toEqual([
      { draftId: "record-01", routeIndex: 0 },
      { draftId: "record-02", routeIndex: 1 },
      { draftId: "record-03", routeIndex: 2 },
    ]);
    expect(matches[0].point.note).toBe("first");
    expect(matches[1].point.latitude).toBe(35.99);

    const reordered = moveRoutePoint(points, "record-02", -1);
    expect(matchRouteDraftPoints(reordered, "Las Vegas").map(({ point }) => point.draftId)).toEqual([
      "record-02",
      "record-01",
      "record-03",
    ]);
    expect(matchRouteDraftPoints(removeRoutePoint(reordered, "record-01"), "Las Vegas").map(({ point }) => point.draftId)).toEqual([
      "record-02",
      "record-03",
    ]);
    expect(matchRouteDraftPoints(points, "l")).toEqual([]);
  });
  it("reorders a 12-record draft by draftId without merging duplicate labels or coordinates", () => {
    const points: RouteDraftPoint[] = Array.from({ length: 12 }, (_, index) => ({
      draftId: `record-${String(index + 1).padStart(2, "0")}`,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      latitude: index === 1 || index === 6 ? 22.543096 : 22 + index / 10,
      longitude: index === 1 || index === 6 ? 114.057865 : 114 + index / 10,
      label: index === 0 || index === 11 ? "Same label" : `Route point ${index + 1}`,
      note: `note-${index + 1}`,
      isStop: index % 2 === 0,
      occurredAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    }));
    const selected = points[2];
    const moved = moveRoutePoint(points, selected.draftId, -1);

    expect(moved[1]).toEqual(selected);
    expect(moved[1]).toBe(selected);
    expect(moved.map((point) => point.draftId)).toHaveLength(12);
    expect(new Set(moved.map((point) => point.draftId)).size).toBe(12);
    expect(moved.filter((point) => point.label === "Same label").map((point) => point.draftId)).toEqual([
      "record-01",
      "record-12",
    ]);
    expect(moved.filter((point) => point.latitude === 22.543096 && point.longitude === 114.057865).map((point) => point.draftId)).toEqual([
      "record-02",
      "record-07",
    ]);
    expect(moved[1]).toMatchObject({
      id: selected.id,
      note: "note-3",
      isStop: true,
      occurredAt: "2026-09-03T08:00:00.000Z",
    });
  });
});

describe("route draft editor input and focus", () => {
  it("does not silently turn an empty coordinate into zero", () => {
    expect(parseCoordinateInput("", -90, 90)).toBeNull();
    expect(parseCoordinateInput("   ", -180, 180)).toBeNull();
    expect(parseCoordinateInput("0", -90, 90)).toBe(0);
    expect(parseCoordinateInput("22.543096", -90, 90)).toBe(22.543096);
    expect(parseCoordinateInput("-90", -90, 90)).toBe(-90);
    expect(parseCoordinateInput("180", -180, 180)).toBe(180);
    expect(parseCoordinateInput("90.000001", -90, 90)).toBeNull();
    expect(parseCoordinateInput("-180.000001", -180, 180)).toBeNull();
  });

  it("chooses a deterministic surviving draftId for focus after delete", () => {
    const points = [
      { draftId: "point-a", latitude: 1, longitude: 1, label: "A", isStop: true, occurredAt: null },
      { draftId: "point-b", latitude: 2, longitude: 2, label: "B", isStop: true, occurredAt: null },
      { draftId: "point-c", latitude: 3, longitude: 3, label: "C", isStop: true, occurredAt: null },
    ] satisfies RouteDraftPoint[];

    expect(routePointFocusAfterRemoval(points, "point-b")).toBe("point-c");
    expect(routePointFocusAfterRemoval(points, "point-c")).toBe("point-b");
    expect(routePointFocusAfterRemoval([points[0]], "point-a")).toBeNull();
    expect(routePointFocusAfterRemoval(points, "missing")).toBeNull();
  });
});

describe("route draft search focus", () => {
  it("biases place search towards the last Route Point, not a centroid", () => {
    expect(routeDraftSearchFocus([beijing, ulanBator])).toEqual({
      latitude: 47.8864,
      longitude: 106.9057,
    });
    expect(routeDraftSearchFocus([ulanBator, beijing])).toEqual({
      latitude: 39.9042,
      longitude: 116.4074,
    });
  });

  it("sends no bias for an empty Route", () => {
    expect(routeDraftSearchFocus([])).toBeNull();
  });
});
