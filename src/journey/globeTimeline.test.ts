import { describe, expect, it } from "vitest";
import {
  buildJourneyTimeline,
  getJourneyTemporalProgress,
  getTemporalProgress,
  resolveRoutePointTimes,
  timelineCursorStops,
} from "./globeTimeline";
import type { Journey, RoutePoint } from "./types";

function point(
  id: string,
  occurredAt: string | null = null,
  sortOrder = Number(id.slice(-1)),
): RoutePoint {
  return {
    id,
    journeyId: "journey-1",
    sortOrder,
    latitude: 0,
    longitude: 0,
    label: id,
    isStop: true,
    occurredAt,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function journey(id: string, startedOn: string, routePoints: RoutePoint[]): Journey {
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
    routePoints,
    media: [],
  };
}

describe("resolveRoutePointTimes (#21)", () => {
  it("uses explicit occurredAt and interpolates the rest evenly", () => {
    const points = [
      point("p0", "2026-08-11T00:00:00Z", 0),
      point("p1", null, 1),
      point("p2", "2026-08-12T00:00:00Z", 2),
      point("p3", null, 3),
    ];
    const trip: Journey = {
      ...journey("j1", "2026-08-11", points),
      endedOn: "2026-08-12",
    };
    const resolved = resolveRoutePointTimes(trip);
    expect(resolved[0].explicit).toBe(true);
    expect(resolved[2].explicit).toBe(true);
    expect(resolved[1].explicit).toBe(false);
    expect(resolved[1].timeMs).toBeGreaterThan(resolved[0].timeMs);
    expect(resolved[1].timeMs).toBeLessThan(resolved[2].timeMs);
    expect(resolved[3].timeMs).toBeGreaterThanOrEqual(resolved[2].timeMs);
  });

  it("handles a single-date journey with no range", () => {
    const resolved = resolveRoutePointTimes(journey("j1", "2026-08-11", [
      point("p0", null, 0),
      point("p1", null, 1),
    ]));
    expect(resolved.every((entry) => Number.isFinite(entry.timeMs))).toBe(true);
  });
});

describe("buildJourneyTimeline (#21)", () => {
  it("normalizes journeys and points into [0, 1] across the span", () => {
    const journeys = [
      journey("a", "2020-01-01", [
        point("a0", "2020-01-01T00:00:00Z", 0),
        point("a1", "2020-01-03T00:00:00Z", 1),
      ]),
      journey("b", "2024-01-01", [
        point("b0", "2024-01-01T00:00:00Z", 0),
      ]),
    ];
    const { entries, minTime, maxTime, undated } = buildJourneyTimeline(journeys);
    expect(undated).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].journeyId).toBe("a");
    expect(entries[0].started).toBeCloseTo(0);
    expect(entries[1].journeyId).toBe("b");
    expect(entries[1].started).toBeCloseTo(1);
    expect(entries[0].points[0].at).toBeCloseTo(0);
    expect(entries[0].points[1].at).toBeCloseTo((Date.parse("2020-01-03T00:00:00Z") - minTime) / (maxTime - minTime));
  });

  it("collects undated journeys separately for the final state", () => {
    const journeys = [
      journey("dated", "2022-01-01", [point("d0", "2022-01-01T00:00:00Z", 0)]),
      { ...journey("nodate", "2022-01-01", []), startedOn: "", endedOn: null },
    ];
    const { entries, undated } = buildJourneyTimeline(journeys);
    expect(entries).toHaveLength(1);
    expect(undated).toHaveLength(1);
    expect(undated[0].id).toBe("nodate");
  });

  it("returns an empty timeline when nothing is dated", () => {
    const { entries, maxTime, minTime, undated } = buildJourneyTimeline([
      { ...journey("x", "2022-01-01", []), startedOn: "" },
    ]);
    expect(entries).toEqual([]);
    expect(undated).toHaveLength(1);
    expect(minTime).toBe(0);
    expect(maxTime).toBe(1);
  });
});

describe("temporal progress (#21)", () => {
  it("hides future points, reveals within the window, keeps visited lit", () => {
    expect(getTemporalProgress(0.5, 0.4)).toBe(0);
    expect(getTemporalProgress(0.5, 0.5)).toBe(1);
    expect(getTemporalProgress(0.5, 0.51)).toBe(1);
    const revealing = getTemporalProgress(0.5, 0.49);
    expect(revealing).toBeGreaterThan(0);
    expect(revealing).toBeLessThan(1);
  });

  it("maps journey progress from start to end", () => {
    expect(getJourneyTemporalProgress({ started: 0.2, ended: 0.6 }, 0.1)).toBe(0);
    expect(getJourneyTemporalProgress({ started: 0.2, ended: 0.6 }, 0.7)).toBe(1);
    expect(getJourneyTemporalProgress({ started: 0.2, ended: 0.6 }, 0.4)).toBeCloseTo(0.5);
  });
});

describe("timelineCursorStops (#21)", () => {
  it("lists every change moment plus the endpoints", () => {
    const entries = [{
      journeyId: "a",
      started: 0.2,
      ended: 0.4,
      points: [
        { pointIndex: 0, at: 0.2, explicit: true },
        { pointIndex: 1, at: 0.3, explicit: true },
      ],
    }];
    expect(timelineCursorStops(entries)).toEqual([0.2, 0.3, 0.4]);
  });

  it("thins dense stops to the budget while keeping endpoints", () => {
    const entries = [{
      journeyId: "a",
      started: 0,
      ended: 1,
      points: Array.from({ length: 400 }, (_, index) => ({
        pointIndex: index,
        at: index / 400,
        explicit: true,
      })),
    }];
    const stops = timelineCursorStops(entries, 32);
    expect(stops.length).toBeLessThanOrEqual(32);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);
  });
});
