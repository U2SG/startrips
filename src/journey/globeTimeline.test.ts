import { describe, expect, it } from "vitest";
import {
  buildJourneyTimeline,
  cursorForJourney,
  getJourneyTemporalProgress,
  getTemporalProgress,
  resolveJourneyTimelineSelection,
  resolveRoutePointTimes,
  timelineCursorStops,
} from "./globeTimeline";
import {
  cursorForSliderKey,
  formatCursorDate,
  timelineTickLabels,
} from "./GlobeTimeScrubber";
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

  it("normalizes endedOn and occurredAt inside [0, 1] for a single range journey (review P2)", () => {
    // One journey spanning 10 days: previously only startedOn defined the
    // span, so endedOn/occurredAt normalized far beyond 1 and the route
    // stayed partially hidden even at cursor = 1.
    const trip: Journey = {
      ...journey("solo", "2025-01-01", [
        point("p0", "2025-01-01T00:00:00Z", 0),
        point("p1", "2025-01-10T00:00:00Z", 1),
      ]),
      endedOn: "2025-01-10",
    };
    const { entries } = buildJourneyTimeline([trip]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.started).toBeCloseTo(0);
    expect(entry.ended).toBeCloseTo(1);
    for (const point of entry.points) {
      expect(point.at).toBeGreaterThanOrEqual(0);
      expect(point.at).toBeLessThanOrEqual(1);
    }
    // The journey is fully revealed at cursor = 1.
    expect(getJourneyTemporalProgress(entry, 1)).toBe(1);
  });
});

describe("authoritative mobile playback selection", () => {
  const entries = [
    {
      journeyId: "older",
      started: 0.1,
      ended: 0.45,
      points: [
        { pointIndex: 0, at: 0.1, explicit: true },
        { pointIndex: 1, at: 0.35, explicit: true },
      ],
    },
    {
      journeyId: "newer",
      started: 0.6,
      ended: 0.95,
      points: [
        { pointIndex: 0, at: 0.6, explicit: true },
        { pointIndex: 1, at: 0.9, explicit: true },
      ],
    },
  ];

  it("derives journey and route point from one cursor instead of parallel selection state", () => {
    expect(resolveJourneyTimelineSelection(entries, 0.2)).toMatchObject({
      journeyId: "older",
      pointIndex: 0,
    });
    expect(resolveJourneyTimelineSelection(entries, 0.4)).toMatchObject({
      journeyId: "older",
      pointIndex: 1,
    });
    expect(resolveJourneyTimelineSelection(entries, 0.7)).toMatchObject({
      journeyId: "newer",
      pointIndex: 0,
    });
    expect(resolveJourneyTimelineSelection(entries, 0.92)).toMatchObject({
      journeyId: "newer",
      pointIndex: 1,
    });
  });

  it("keeps continuity in the gap between journeys and gives chip/picker a cursor anchor", () => {
    expect(resolveJourneyTimelineSelection(entries, 0.52)?.journeyId).toBe("older");
    expect(cursorForJourney(entries, "older")).toBe(0.35);
    expect(cursorForJourney(entries, "newer")).toBe(0.9);
    expect(cursorForJourney(entries, "missing")).toBeNull();
  });

  it("preserves an explicitly selected journey when journey time ranges overlap", () => {
    const overlapping = [
      {
        journeyId: "older",
        started: 0.1,
        ended: 0.9,
        points: [
          { pointIndex: 0, at: 0.2, explicit: true },
          { pointIndex: 1, at: 0.8, explicit: true },
        ],
      },
      {
        journeyId: "newer",
        started: 0.5,
        ended: 0.7,
        points: [{ pointIndex: 0, at: 0.6, explicit: true }],
      },
    ];
    const olderCursor = cursorForJourney(overlapping, "older");
    expect(olderCursor).toBe(0.8);
    expect(resolveJourneyTimelineSelection(overlapping, olderCursor!)?.journeyId).toBe("newer");
    expect(resolveJourneyTimelineSelection(overlapping, olderCursor!, "older")).toMatchObject({
      journeyId: "older",
      pointIndex: 1,
    });
  });

  it("finds the latest reached point without assuming route-array time order", () => {
    const unsorted = [{
      journeyId: "mixed-times",
      started: 0.1,
      ended: 0.95,
      points: [
        { pointIndex: 0, at: 0.8, explicit: true },
        { pointIndex: 1, at: 0.5, explicit: false },
        { pointIndex: 2, at: 0.9, explicit: true },
      ],
    }];
    expect(resolveJourneyTimelineSelection(unsorted, 0.6)).toMatchObject({
      journeyId: "mixed-times",
      pointIndex: 1,
    });
    expect(cursorForJourney(unsorted, "mixed-times")).toBe(0.9);
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

describe("GlobeTimeScrubber date domain + keyboard (PR #24 P2)", () => {
  const timeDomain = {
    minTime: Date.parse("2031-04-10T00:00:00Z"),
    maxTime: Date.parse("2033-10-20T00:00:00Z"),
  };

  it("formats the slider value from the real timeline domain instead of a fixed year range", () => {
    expect(formatCursorDate(0, timeDomain)).toBe("2031-04-10");
    expect(formatCursorDate(1, timeDomain)).toBe("2033-10-20");
    const ticks = timelineTickLabels(timeDomain);
    expect(ticks[0]).toBe("2031-04-10");
    expect(ticks.at(-1)).toBe("2033-10-20");
    expect(ticks).not.toContain("2019");
  });

  it("supports standard slider keyboard navigation and clamps at the ends", () => {
    expect(cursorForSliderKey("ArrowRight", 0.5)).toBeCloseTo(0.51);
    expect(cursorForSliderKey("ArrowLeft", 0)).toBe(0);
    expect(cursorForSliderKey("ArrowUp", 1)).toBe(1);
    expect(cursorForSliderKey("PageDown", 0.5)).toBeCloseTo(0.4);
    expect(cursorForSliderKey("Home", 0.5)).toBe(0);
    expect(cursorForSliderKey("End", 0.5)).toBe(1);
    expect(cursorForSliderKey("Escape", 0.5)).toBeNull();
  });
});
