import { describe, expect, it } from "vitest";
import { buildRoutePointContext } from "./routePointContext";
import type { Journey, RoutePoint } from "./types";
import {
  beginCrossPointReading,
  resolveCrossPointReading,
  resolveReadableCrossPointTarget,
} from "./crossPointReading";

const journeyId = "cross-reading-journey";

function point(
  id: string,
  sortOrder: number,
  note: string | null = null,
): RoutePoint {
  return {
    id,
    journeyId,
    sortOrder,
    latitude: 22.28 + sortOrder * 0.01,
    longitude: 114.15 + sortOrder * 0.01,
    label: `Point ${id}`,
    isStop: sortOrder !== 1,
    occurredAt: `2026-04-0${sortOrder + 1}T09:00:00.000Z`,
    note,
    createdAt: `2026-04-0${sortOrder + 1}T09:00:00.000Z`,
  };
}

function journey(routePoints: RoutePoint[]): Journey {
  return {
    id: journeyId,
    atlasId: "atlas",
    title: "Cross-point reading",
    startedOn: "2026-04-01",
    endedOn: "2026-04-03",
    note: "",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    createdByUserId: "user",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
    routePoints,
    media: [],
  };
}

describe("cross-point transient reading", () => {
  const a = point("A", 0, "source A");
  const b = point("B", 1, "target note");
  const c = point("C", 2, "source C");
  const trip = journey([a, b, c]);

  it("preserves the invoking source while resolving the same target from either side", () => {
    const sourceA = buildRoutePointContext(trip, "A");
    const sourceC = buildRoutePointContext(trip, "C");
    expect(sourceA).not.toBeNull();
    expect(sourceC).not.toBeNull();

    const fromA = beginCrossPointReading(1, sourceA!, "B");
    const fromC = beginCrossPointReading(2, sourceC!, "B");

    expect(resolveCrossPointReading(fromA, journeyId, sourceA, [trip])).toMatchObject({
      intent: { sourceRoutePointId: "A", targetRoutePointId: "B" },
      source: { routePointId: "A" },
      target: { routePointId: "B", note: "target note", visualMediaCount: 0 },
    });
    expect(resolveCrossPointReading(fromC, journeyId, sourceC, [trip])).toMatchObject({
      intent: { sourceRoutePointId: "C", targetRoutePointId: "B" },
      source: { routePointId: "C" },
      target: { routePointId: "B", note: "target note", visualMediaCount: 0 },
    });
  });

  it("permits only note-bearing adjacent Route Points from the current context", () => {
    const sourceA = buildRoutePointContext(trip, "A")!;
    expect(resolveReadableCrossPointTarget(trip, sourceA, "B")?.routePointId).toBe("B");
    expect(resolveReadableCrossPointTarget(trip, sourceA, "C")).toBeNull();

    const noNote = journey([a, { ...b, note: null }, c]);
    const noNoteSource = buildRoutePointContext(noNote, "A")!;
    expect(resolveReadableCrossPointTarget(noNote, noNoteSource, "B")).toBeNull();
  });

  it("invalidates transient reading when authorization, source, target, or provenance changes", () => {
    const sourceA = buildRoutePointContext(trip, "A")!;
    const intent = beginCrossPointReading(3, sourceA, "B");

    expect(resolveCrossPointReading(intent, "other-journey", sourceA, [trip])).toBeNull();
    expect(resolveCrossPointReading(intent, journeyId, buildRoutePointContext(trip, "C"), [trip])).toBeNull();

    const targetDeleted = journey([a, c]);
    expect(resolveCrossPointReading(intent, journeyId, sourceA, [targetDeleted])).toBeNull();

    const sourceDeleted = journey([b, c]);
    expect(resolveCrossPointReading(intent, journeyId, sourceA, [sourceDeleted])).toBeNull();

    const noteRemoved = journey([a, { ...b, note: null }, c]);
    expect(resolveCrossPointReading(intent, journeyId, sourceA, [noteRemoved])).toBeNull();
  });
});
