import { describe, expect, it, vi } from "vitest";
import type { RouteCandidate, RouteSegmentRecord } from "../../src/journey/types";
import { routeSegmentSourceKey } from "../../src/journey/journeyModel";
import { AUTO_ROUTE_SKIPPED_TITLE, type AutoRouteWrite } from "../repositories/route-segment-repository";
import { AUTO_ROUTE_PRIORITY_TTL_MS, autoRoutePriorityJourneyIds, markAutoRoutePriority } from "../routing/auto-route-status";
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

function setup(journeys: { id: string; routeSegments: RouteSegmentRecord[]; points: { id: string; lat: number; lon: number }[] }[], overrides: Partial<RouteSnappingDependencies> = {}) {
  let now = Date.parse("2026-10-08T00:00:00Z");
  const writes: unknown[][] = [];
  const deps: RouteSnappingDependencies = {
    provider: { supports: () => true, candidates: vi.fn(async () => [candidate]) },
    // Like the SQL: the scan pages oldest first; an id list selects in scan order.
    listJourneys: vi.fn(async (_now: Date, offset: number, _limit?: number, ids?: readonly string[]) =>
      ids ? journeys.filter((journey) => ids.includes(journey.id)) : journeys.slice(offset, offset + 2)),
    priorityJourneyIds: () => [],
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

  it("snaps recently seen Journeys first, most recent first, then backfills oldest first", async () => {
    let priority = ["j-new", "j-mid"];
    const { snapper, writes, deps } = setup([
      { id: "j-old", routeSegments: [], points: far },
      { id: "j-mid", routeSegments: [], points: far },
      { id: "j-new", routeSegments: [], points: far },
    ], { priorityJourneyIds: () => priority });
    await snapper.step(signal());
    expect(vi.mocked(deps.listJourneys).mock.calls[0].slice(2)).toEqual([2, ["j-new", "j-mid"]]);
    expect(writes.map(([journeyId]) => journeyId)).toEqual(["j-new"]);
    priority = ["j-mid"];
    await snapper.step(signal());
    priority = [];
    await snapper.step(signal());
    expect(writes.map(([journeyId]) => journeyId)).toEqual(["j-new", "j-mid", "j-old"]);
  });

  it("leaves a backfill graph that is still preparing for priority work, but keeps a priority one", async () => {
    let priority: string[] = [];
    const candidates = vi.fn(async (_request: { coordinates: readonly unknown[] }): Promise<RouteCandidate[]> => {
      throw new RoutingPreparingError("fetching", 2_000);
    });
    const { snapper, deps } = setup([
      { id: "j-old", routeSegments: [], points: far },
      { id: "j-seen", routeSegments: [], points: near },
      { id: "j-later", routeSegments: [], points: far },
    ], { provider: { supports: () => true, candidates }, priorityJourneyIds: () => priority });
    await snapper.step(signal());
    expect(deps.onTarget).toHaveBeenLastCalledWith({ journeyId: "j-old", sourceKey: routeSegmentSourceKey(far, 0) });
    priority = ["j-seen"];
    await snapper.step(signal());
    expect(deps.onTarget).toHaveBeenLastCalledWith({ journeyId: "j-seen", sourceKey: routeSegmentSourceKey(near, 0) });
    // A more recently seen Journey does not interrupt the priority graph being prepared.
    priority = ["j-later", "j-seen"];
    await snapper.step(signal());
    expect(deps.onTarget).toHaveBeenLastCalledWith({ journeyId: "j-seen", sourceKey: routeSegmentSourceKey(near, 0) });
    expect(candidates).toHaveBeenCalledTimes(3);
  });

  it("records a segment beyond the direct distance limit as too large without asking for a graph", async () => {
    const distant = [{ id: id(5), lat: 0, lon: 0 }, { id: id(6), lat: 0, lon: 4 }];
    const { snapper, writes, deps } = setup([{ id: "j", routeSegments: [], points: distant }]);
    await snapper.step(signal());
    expect(deps.provider.candidates).not.toHaveBeenCalled();
    expect((writes[0][4] as { attempt: unknown }).attempt).toEqual({ at: expect.any(String), code: "ROUTING_AREA_TOO_LARGE" });
  });

  it("asks a batching provider once for every pending segment of the target Journey", async () => {
    // Three legs: two driving segments and one beyond the direct limit.
    const points = [
      { id: id(11), lat: 0, lon: 0 }, { id: id(12), lat: 0, lon: 0.1 },
      { id: id(13), lat: 0, lon: 0.2 }, { id: id(14), lat: 0, lon: 4.2 },
    ];
    const results = new Map<number, RouteCandidate[]>();
    const prepareCandidates = vi.fn(async (_requests: readonly { coordinates: readonly { lon: number }[] }[]) => "started" as const);
    const candidates = vi.fn(async (request: { coordinates: readonly { lon: number }[]; background?: boolean }) => {
      const ready = results.get(request.coordinates[0].lon);
      if (!ready) throw new RoutingPreparingError("building", 15_000);
      return ready;
    });
    const journeys = [
      { id: "j-batch", routeSegments: [] as RouteSegmentRecord[], points },
      { id: "j-other", routeSegments: [] as RouteSegmentRecord[], points: far },
    ];
    const { snapper, writes, deps } = setup(journeys, {
      provider: { supports: () => true, candidates, prepareCandidates },
      // Written segments are settled on the next scan, as in the database.
      write: vi.fn(async (...args: unknown[]) => {
        writes.push(args);
        const [journeyId, fromId, toId, expected, write] = args as [string, string, string, { sourceKey: string }, AutoRouteWrite];
        journeys.find((journey) => journey.id === journeyId)!.routeSegments.push({
          fromRoutePointId: fromId, toRoutePointId: toId, sourceKey: expected.sourceKey, revision: 1, shapePoints: [],
          ...(write.kind === "road"
            ? { decision: "confirmed", confirmedCandidate: write.candidate, confirmedBy: "auto" }
            : { decision: "open", confirmedCandidate: null, autoAttempt: write.attempt }),
        });
        return true;
      }),
    });
    expect(await snapper.step(signal())).toBe(15_000);
    expect(prepareCandidates.mock.calls[0][0].map((request) => request.coordinates[0].lon)).toEqual([0, 0.1]);
    expect(candidates).toHaveBeenLastCalledWith(expect.objectContaining({ background: true, alternativesCount: 1, allowFerries: false }));
    results.set(0, [candidate]);
    results.set(0.1, [candidate]);
    for (let step = 0; step < 4; step += 1) await snapper.step(signal());
    expect(writes.map(([journeyId, fromId]) => [journeyId, fromId])).toEqual([
      ["j-batch", id(11)], ["j-batch", id(12)], ["j-batch", id(13)], ["j-other", id(1)]]);
    expect((writes[2][4] as { attempt: { code: string } }).attempt.code).toBe("ROUTING_AREA_TOO_LARGE");
    expect(deps.listJourneys).toHaveBeenCalled();
  });
});

describe("automatic road snapping scope", () => {
  it.each([
    ["Flow QA Journey", true], ["Position QA Journey", true], ["Transit Chapter Probe", true], ["QA", true],
    ["Probe of the north", true], ["South Island", false], ["QAnon", false], ["Probes", false], ["SQA trip", false], ["qa run", false],
  ])("treats %j as a test Journey: %s", (title, skipped) => {
    expect(AUTO_ROUTE_SKIPPED_TITLE.test(title)).toBe(skipped);
  });

  it("keeps recently seen Journeys most recent first, expires them and bounds the set", () => {
    const base = Date.parse("2030-01-01T00:00:00Z");
    markAutoRoutePriority(["p-a", "p-b"], base);
    markAutoRoutePriority(["p-a"], base + 1);
    expect(autoRoutePriorityJourneyIds(base + 2).slice(0, 2)).toEqual(["p-a", "p-b"]);
    expect(autoRoutePriorityJourneyIds(base + 1 + AUTO_ROUTE_PRIORITY_TTL_MS)).toEqual([]);
    markAutoRoutePriority(Array.from({ length: 300 }, (_, index) => `p-${index}`), base);
    markAutoRoutePriority(["p-viewed"], base + 1);
    const ids = autoRoutePriorityJourneyIds(base + 2);
    expect(ids).toHaveLength(256);
    expect(ids[0]).toBe("p-viewed");
    expect(ids).not.toContain("p-0");
  });
});
