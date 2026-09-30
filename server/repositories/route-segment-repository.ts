import { and, asc, eq, isNull } from "drizzle-orm";
import { routeSegmentSourceKey } from "../../src/journey/journeyModel";
import type { RouteCandidate, RouteSegmentRecord, RouteShapePoint } from "../../src/journey/types";
import { db } from "../db/client";
import { journeyRoutePoints, journeys } from "../db/app-schema";
import { lockActiveAtlas, lockActiveJourney } from "./journey-repository";
import { RoutingInvalidError } from "../routing/route-candidate-provider";

type SegmentContext = {
  sourceKey: string;
  record: RouteSegmentRecord | null;
  from: { id: string; lat: number; lon: number };
  to: { id: string; lat: number; lon: number };
};

function findSegmentContext(
  points: readonly { id: string; lat: number; lon: number }[],
  records: readonly RouteSegmentRecord[],
  fromId: string,
  toId: string,
): SegmentContext | null {
  const index = points.findIndex((point) => point.id === fromId);
  if (index < 0 || points[index + 1]?.id !== toId) return null;
  const sourceKey = routeSegmentSourceKey(points, index)!;
  return {
    sourceKey,
    record: records.find((record) => record.sourceKey === sourceKey) ?? null,
    from: points[index],
    to: points[index + 1],
  };
}

export async function getRouteSegmentContext(
  journeyId: string,
  atlasId: string,
  fromId: string,
  toId: string,
): Promise<SegmentContext | null> {
  const [journey] = await db.select({ routeSegments: journeys.routeSegments })
    .from(journeys)
    .where(and(eq(journeys.id, journeyId), eq(journeys.atlasId, atlasId), isNull(journeys.deletionStartedAt)))
    .limit(1);
  if (!journey) return null;
  const points = await db.select({ id: journeyRoutePoints.id, lat: journeyRoutePoints.latitude, lon: journeyRoutePoints.longitude })
    .from(journeyRoutePoints)
    .where(eq(journeyRoutePoints.journeyId, journeyId))
    .orderBy(asc(journeyRoutePoints.sortOrder));
  return findSegmentContext(points, journey.routeSegments, fromId, toId);
}

export async function writeRouteSegment(
  journeyId: string,
  atlasId: string,
  fromId: string,
  toId: string,
  input: {
    sourceKey: string;
    expectedRevision: number;
    action: "shape" | "none" | "confirm";
    shapePoints?: RouteShapePoint[];
    candidate?: RouteCandidate;
  },
): Promise<RouteSegmentRecord | null> {
  return db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)
      || !await lockActiveJourney(transaction, journeyId, atlasId)) return null;
    const [journey] = await transaction.select({ routeSegments: journeys.routeSegments })
      .from(journeys)
      .where(eq(journeys.id, journeyId))
      .limit(1);
    if (!journey) return null;
    const points = await transaction
      .select({ id: journeyRoutePoints.id, lat: journeyRoutePoints.latitude, lon: journeyRoutePoints.longitude })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const current = findSegmentContext(points, journey.routeSegments, fromId, toId);
    if (!current) return null;
    if (current.sourceKey !== input.sourceKey || (current.record?.revision ?? 0) !== input.expectedRevision) {
      throw new RoutingInvalidError("ROUTE_SEGMENT_CHANGED", "Route segment changed; reopen it before saving", 409);
    }
    const shapePoints = input.action === "shape" ? input.shapePoints! : current.record?.shapePoints ?? [];
    const record: RouteSegmentRecord = {
      fromRoutePointId: fromId,
      toRoutePointId: toId,
      sourceKey: current.sourceKey,
      revision: input.expectedRevision + 1,
      shapePoints,
      decision: input.action === "confirm" ? "confirmed" : input.action === "none" ? "none" : "open",
      confirmedCandidate: input.action === "confirm" ? input.candidate! : null,
    };
    const records = journey.routeSegments.filter((entry) => entry.sourceKey !== current.sourceKey);
    records.push(record);
    await transaction.update(journeys).set({ routeSegments: records, updatedAt: new Date() })
      .where(eq(journeys.id, journeyId));
    return record;
  });
}
