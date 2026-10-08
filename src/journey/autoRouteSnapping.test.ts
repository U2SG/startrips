import { describe, expect, it } from "vitest";
import {
  autoRouteFailureMessage,
  autoRouteProfile,
  autoRouteSegmentStatuses,
  autoRouteRefreshDelay,
  mergeAutoRouteRefresh,
} from "./autoRouteSnapping";
import { resolveJourneyRouteSegmentProvenance, routeSegmentSourceKey } from "./journeyModel";
import type { AutoRouteSegmentStatus, Journey, RouteCandidate, RouteSegmentRecord } from "./types";

const points = [
  { id: "a", lat: 0, lon: 0 },
  { id: "b", lat: 0, lon: 0.01 },
  { id: "c", lat: 0, lon: 0.2 },
];
const key = (index: number) => routeSegmentSourceKey(points, index)!;
const candidate = { id: "c1", geometry: [[0, 0], [0.01, 0]] } as unknown as RouteCandidate;
const record = (index: number, overrides: Partial<RouteSegmentRecord>): RouteSegmentRecord => ({
  fromRoutePointId: points[index].id, toRoutePointId: points[index + 1].id, sourceKey: key(index),
  revision: 1, shapePoints: [], decision: "open", confirmedCandidate: null, ...overrides,
});
const now = Date.parse("2026-10-08T00:00:00Z");

function journey(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "j", routePoints: points.map((point) => ({ id: point.id, latitude: point.lat, longitude: point.lon })),
    routeSegments: [], ...overrides,
  } as unknown as Journey;
}

describe("automatic road snapping rules", () => {
  it("walks below 2 km of direct distance and drives otherwise", () => {
    expect(autoRouteProfile(points[0], points[1])).toBe("walking");
    expect(autoRouteProfile(points[1], points[2])).toBe("driving");
  });

  it("reports owed, snapping and failed segments and never member or auto decisions", () => {
    const all = () => true;
    expect(autoRouteSegmentStatuses(points, [], now, all, key(1))).toEqual([
      { sourceKey: key(0), state: "pending" }, { sourceKey: key(1), state: "snapping" },
    ]);
    const decided = [record(0, { decision: "none" }), record(1, { decision: "confirmed", confirmedCandidate: candidate, confirmedBy: "auto" })];
    expect(autoRouteSegmentStatuses(points, decided, now, all)).toEqual([]);
    const failed = [record(0, { autoAttempt: { at: "2026-10-07T00:00:00Z", code: "ROUTING_NO_ROADS" } }),
      record(1, { autoAttempt: { at: "2026-10-07T00:00:00Z", code: "ROUTING_DATA_UNAVAILABLE", retryAt: "2026-10-07T00:15:00Z" } })];
    expect(autoRouteSegmentStatuses(points, failed, now, all)).toEqual([
      { sourceKey: key(0), state: "failed", code: "ROUTING_NO_ROADS" }, { sourceKey: key(1), state: "pending" },
    ]);
    expect(autoRouteSegmentStatuses(points, [], now, (profile) => profile === "walking")).toEqual([{ sourceKey: key(0), state: "pending" }]);
  });

  it("treats automatic geometry as a suggestion, never as a member-confirmed route", () => {
    const route = { points: points.map((point) => ({ ...point, isStop: true })) };
    const confirmed = record(0, { decision: "confirmed", confirmedCandidate: candidate });
    expect(resolveJourneyRouteSegmentProvenance({ ...route, routeSegments: [confirmed] }, 0)).toBe("user-confirmed-route");
    expect(resolveJourneyRouteSegmentProvenance({ ...route, routeSegments: [{ ...confirmed, confirmedBy: "auto" }] }, 0)).toBe("suggested-route");
  });

  it("refreshes every 10 s while pending, at the retry time of a retryable failure, and never for final failures", () => {
    const at = (status: AutoRouteSegmentStatus) => autoRouteRefreshDelay(journey({ autoRouteSegments: [status] }), now);
    expect(autoRouteRefreshDelay(journey(), now)).toBeNull();
    expect(at({ sourceKey: key(1), state: "snapping" })).toBe(10_000);
    expect(at({ sourceKey: "stale", state: "pending" })).toBeNull();
    expect(at({ sourceKey: key(0), state: "failed", code: "ROUTING_NO_ROADS" })).toBeNull();
    const retry = (minutes: number) => ({ sourceKey: key(0), state: "failed" as const, code: "ROUTING_DATA_UNAVAILABLE",
      retryAt: new Date(now + minutes * 60_000).toISOString() });
    expect(at(retry(5))).toBe(5 * 60_000);
    expect(at(retry(0))).toBe(10_000);
    expect(at(retry(60))).toBe(15 * 60_000);
    // The server status carries the retry time of a retryable failure.
    const failed = [record(0, { autoAttempt: { at: "2026-10-08T00:00:00Z", code: "ROUTING_DATA_UNAVAILABLE", retryAt: "2026-10-08T00:15:00Z" } })];
    expect(autoRouteSegmentStatuses(points, failed, now, () => true)[0]).toEqual({
      sourceKey: key(0), state: "failed", code: "ROUTING_DATA_UNAVAILABLE", retryAt: "2026-10-08T00:15:00Z",
    });
  });

  it("merges segment geometry and status per segment from a refresh of the same legs", () => {
    const current = journey({ title: "local" });
    const fetched = journey({ title: "server", routeSegments: [record(0, { revision: 2, decision: "confirmed", confirmedCandidate: candidate, confirmedBy: "auto" })], autoRouteSegments: [] });
    expect(mergeAutoRouteRefresh(current, fetched)).toEqual({ ...current, routeSegments: fetched.routeSegments, autoRouteSegments: [] });
    const moved = journey({ routePoints: [{ id: "a", latitude: 1, longitude: 0 }, ...current.routePoints.slice(1)] as Journey["routePoints"] });
    expect(mergeAutoRouteRefresh(current, moved)).toBe(current);
  });

  it("never lets a read that started before a member save overwrite the newer local record", () => {
    const saved = record(0, { revision: 3, decision: "none" });
    const local = journey({ routeSegments: [saved], autoRouteSegments: [] });
    const older = journey({
      routeSegments: [record(0, { revision: 2, decision: "confirmed", confirmedCandidate: candidate, confirmedBy: "auto" }), record(1, { revision: 1, decision: "none" })],
      autoRouteSegments: [{ sourceKey: key(0), state: "pending" }],
    });
    const merged = mergeAutoRouteRefresh(local, older);
    expect(merged.routeSegments).toEqual([saved, older.routeSegments![1]]);
    expect(merged.autoRouteSegments).toEqual([]);
    // An equal revision never replaces a member decision with an auto/open record either.
    const attempt = record(0, { revision: 3, autoAttempt: { at: "2026-10-08T00:00:00Z", code: "ROUTING_NO_ROADS" } });
    expect(mergeAutoRouteRefresh(local, journey({ routeSegments: [attempt] })).routeSegments).toEqual([saved]);
    // A failed attempt keeps the revision and still replaces a local open record.
    const open = journey({ routeSegments: [record(0, { revision: 3 })] });
    expect(mergeAutoRouteRefresh(open, journey({ routeSegments: [attempt] })).routeSegments).toEqual([attempt]);
  });

  it("explains a failed segment in the editor", () => {
    expect(autoRouteFailureMessage("ROUTING_NO_ROADS")).toMatch(/^自动贴合道路未完成：/);
    expect(autoRouteFailureMessage("ROUTING_NO_CANDIDATE")).toContain("可以在这里修正");
  });
});
