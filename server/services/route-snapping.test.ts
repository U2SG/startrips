import { describe, expect, it, vi } from "vitest";
import type { RouteCandidate, RouteSegmentRecord } from "../../src/journey/types";
import { routeSegmentSourceKey } from "../../src/journey/journeyModel";
import { RoutingGraphError, RoutingPreparingError } from "../routing/route-candidate-provider";
import {
  createRouteSnapper,
  ROUTE_SNAPPING_IDLE_MS,
  ROUTE_SNAPPING_PREPARING_LIMIT_MS,
  ROUTE_SNAPPING_RETRY_MS,
  type RouteSnappingDependencies,
} from "./route-snapping";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// ~11 km apart (driving) and ~0.5 km apart (walking).
const far = [{ id: id(1), lat: 0, lon: 0 }, { id: id(2), lat: 0, lon: 0.1 }];
const near = [{ id: id(3), lat: 0, lon: 0 }, { id: id(4), lat: 0, lon: 0.005 }];
const candidate = { id: "c1", geometry: [[0, 0], [0.1, 0]] } as unknown as RouteCandidate;

function record(points: typeof far, overrides: Partial<RouteSegmentRecord>): RouteSegmentRecord {
  return {
    fromRoutePointId: points[0].id, toRoutePointId: points[1].id, sourceKey: routeSegmentSourceKey(points, 0)!,
    revision: 1, shapePoints: [], decision: "open", confirmedCandidate: null, ...overrides,
  };
}

function setup(journeys: { id: string; routeSegments: RouteSegmentRecord[]; points: typeof far }[], overrides: Partial<RouteSnappingDependencies> = {}) {
  let now = Date.parse("2026-10-08T00:00:00Z");
  const writes: unknown[][] = [];
  const deps: RouteSnappingDependencies = {
    provider: { supports: () => true, candidates: vi.fn(async () => [candidate]) },
    listJourneys: vi.fn(async (_now: Date, offset: number) => journeys.slice(offset, offset + 2)),
    write: vi.fn(async (...args: unknown[]) => { writes.push(args); return true; }),
    now: () => now,
    onTarget: vi.fn(),
    pageSize: 2,
    ...overrides,
  };
  return { deps, writes, snapper: createRouteSnapper(deps), advance: (ms: number) => { now += ms; } };
}

const signal = () => new AbortController().signal;

describe("automatic road snapping", () => {
  it("skips member decisions and snaps the oldest owed segment by distance profile, without ferries", async () => {
    const decided = [
      { id: "j-confirmed", routeSegments: [record(far, { decision: "confirmed", confirmedCandidate: candidate })], points: far },
      { id: "j-none", routeSegments: [record(far, { decision: "none" })], points: far },
      { id: "j-shaped", routeSegments: [record(far, { shapePoints: [{ id: id(9), lat: 0.01, lon: 0.05 }] })], points: far },
    ];
    const { snapper, deps, writes } = setup([...decided, { id: "j-walk", routeSegments: [], points: near }, { id: "j-drive", routeSegments: [], points: far }]);
    await snapper.step(signal());
    expect(deps.provider.candidates).toHaveBeenCalledWith(expect.objectContaining({
      coordinates: [near[0], near[1]], profile: "walking", allowFerries: false, alternativesCount: 1,
    }));
    expect(writes[0].slice(0, 5)).toEqual(["j-walk", id(3), id(4),
      { sourceKey: routeSegmentSourceKey(near, 0), revision: 0 }, { kind: "road", candidate }]);
    expect(deps.onTarget).toHaveBeenLastCalledWith(null);
  });

  it("idles when nothing is owed and skips profiles the provider does not support", async () => {
    const { snapper, deps } = setup([{ id: "j", routeSegments: [], points: far }], {
      provider: { supports: (profile) => profile === "walking", candidates: vi.fn(async () => []) },
    });
    expect(await snapper.step(signal())).toBe(ROUTE_SNAPPING_IDLE_MS);
    expect(deps.provider.candidates).not.toHaveBeenCalled();
  });

  it("resumes the scan past rows owing only unsupported legs and wraps to the start", async () => {
    const ineligible = Array.from({ length: 81 }, (_, index) => ({ id: `walk-${index}`, routeSegments: [], points: near }));
    const { snapper, deps, writes } = setup([...ineligible, { id: "j-drive", routeSegments: [], points: far }], {
      provider: { supports: (profile) => profile === "driving", candidates: vi.fn(async () => [candidate]) },
    });
    // The bounded first pass stops inside the ineligible rows ...
    await snapper.step(signal());
    expect(writes).toHaveLength(0);
    // ... and the next pass continues there instead of starting over.
    await snapper.step(signal());
    expect(writes[0][0]).toBe("j-drive");
    expect(vi.mocked(deps.listJourneys).mock.calls.slice(40).map(([, offset]) => offset)[0]).toBe(80);
  });

  it("keeps one preparing segment until its graph is ready, then gives up after the preparing limit", async () => {
    const candidates = vi.fn(async (_request: { coordinates: readonly unknown[] }): Promise<RouteCandidate[]> => {
      throw new RoutingPreparingError("fetching", 2_000);
    });
    const { snapper, deps, writes, advance } = setup([
      { id: "j1", routeSegments: [], points: far },
      { id: "j2", routeSegments: [], points: far },
    ], { provider: { supports: () => true, candidates } });
    expect(await snapper.step(signal())).toBe(2_000);
    expect(deps.onTarget).toHaveBeenLastCalledWith({ journeyId: "j1", sourceKey: routeSegmentSourceKey(far, 0) });
    advance(5_000);
    await snapper.step(signal());
    // The same target is revisited without re-scanning, so no second graph is asked for.
    expect(deps.listJourneys).toHaveBeenCalledTimes(1);
    expect(candidates.mock.calls.every(([request]) => request.coordinates[0] === far[0])).toBe(true);
    advance(ROUTE_SNAPPING_PREPARING_LIMIT_MS);
    await snapper.step(signal());
    expect(writes[0][0]).toBe("j1");
    expect(writes[0][4]).toMatchObject({ kind: "attempt", attempt: { code: "ROUTING_PREPARING_TIMEOUT", retryAt: expect.any(String) } });
  });

  it("backs off unavailable data for 15 minutes and does not retry final failures", async () => {
    for (const [error, code, retries] of [
      [new RoutingGraphError("ROUTING_DATA_UNAVAILABLE", "x"), "ROUTING_DATA_UNAVAILABLE", true],
      [new RoutingGraphError("ROUTING_NO_ROADS", "x"), "ROUTING_NO_ROADS", false],
      [new RoutingGraphError("ROUTING_AREA_TOO_LARGE", "x"), "ROUTING_AREA_TOO_LARGE", false],
    ] as const) {
      const { snapper, writes, deps } = setup([{ id: "j", routeSegments: [], points: far }], {
        provider: { supports: () => true, candidates: vi.fn(async () => { throw error; }) },
      });
      await snapper.step(signal());
      const attempt = (writes[0][4] as { attempt: { at: string; code: string; retryAt?: string } }).attempt;
      expect(attempt.code).toBe(code);
      expect(attempt.retryAt ? Date.parse(attempt.retryAt) - Date.parse(attempt.at) : null).toBe(retries ? ROUTE_SNAPPING_RETRY_MS : null);
      expect(deps.onTarget).toHaveBeenLastCalledWith(null);
    }
    const { snapper, writes } = setup([{ id: "j", routeSegments: [], points: far }], {
      provider: { supports: () => true, candidates: vi.fn(async () => []) },
    });
    await snapper.step(signal());
    expect((writes[0][4] as { attempt: { code: string; retryAt?: string } }).attempt).toEqual({ at: expect.any(String), code: "ROUTING_NO_CANDIDATE" });
  });

  it("revisits an attempt only once it is due, and never re-picks a segment whose write was refused", async () => {
    const due = record(far, { revision: 2, autoAttempt: { at: "2026-10-07T00:00:00Z", code: "ROUTING_DATA_UNAVAILABLE", retryAt: "2026-10-07T23:00:00Z" } });
    const waiting = record(near, { autoAttempt: { at: "2026-10-08T00:00:00Z", code: "ROUTING_DATA_UNAVAILABLE", retryAt: "2026-10-08T00:15:00Z" } });
    const { snapper, writes, deps } = setup([
      { id: "j-waiting", routeSegments: [waiting], points: near },
      { id: "j-due", routeSegments: [due], points: far },
    ], { write: vi.fn(async (...args: unknown[]) => { writes.push(args); return false; }) });
    await snapper.step(signal());
    expect(writes[0].slice(0, 4)).toEqual(["j-due", id(1), id(2), { sourceKey: due.sourceKey, revision: 2 }]);
    expect(await snapper.step(signal())).toBe(ROUTE_SNAPPING_IDLE_MS);
    expect(deps.provider.candidates).toHaveBeenCalledTimes(1);
  });
});
