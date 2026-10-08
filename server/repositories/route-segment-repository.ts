import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { autoRouteSegmentState } from "../../src/journey/autoRouteSnapping";
import { routeSegmentSourceKey } from "../../src/journey/journeyModel";
import type { RouteCandidate, RouteSegmentRecord, RouteShapePoint } from "../../src/journey/types";
import { db } from "../db/client";
import { atlases, journeyRoutePoints, journeys } from "../db/app-schema";
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

export const AUTO_ROUTE_SCAN_PAGE_SIZE = 25;

export type AutoRouteJourney = {
  id: string;
  routeSegments: RouteSegmentRecord[];
  points: { id: string; lat: number; lon: number }[];
};

/**
 * One keyset page of active Journeys, oldest first, that may still owe
 * automatic road geometry: fewer settled records than legs. A record is
 * settled by a member decision, auto geometry, or an attempt not yet due.
 * Route edits prune stale records, so every record belongs to a current leg.
 */
export async function listAutoRouteJourneys(
  now: Date,
  // An offset, not a keyset: timestamps are microsecond-precise in the database
  // but not in a JS Date. A row skipped while rows settle is found next pass.
  offset: number,
  limit = AUTO_ROUTE_SCAN_PAGE_SIZE,
): Promise<AutoRouteJourney[]> {
  const legs = sql`(select count(*) from ${journeyRoutePoints} where ${journeyRoutePoints.journeyId} = ${journeys.id}) - 1`;
  const settled = sql`(select count(*) from jsonb_array_elements(${journeys.routeSegments}) as segment
    where segment->>'decision' <> 'open'
      or jsonb_array_length(coalesce(segment->'shapePoints', '[]'::jsonb)) > 0
      or (segment->'autoAttempt' is not null and (segment->'autoAttempt'->>'retryAt' is null
        or segment->'autoAttempt'->>'retryAt' > ${now.toISOString()})))`;
  const rows = await db.select({ id: journeys.id, routeSegments: journeys.routeSegments })
    .from(journeys)
    .innerJoin(atlases, eq(atlases.id, journeys.atlasId))
    .where(and(
      isNull(journeys.deletionStartedAt),
      isNull(atlases.deletionStartedAt),
      sql`${settled} < ${legs}`,
    ))
    .orderBy(asc(journeys.createdAt), asc(journeys.id))
    .limit(limit)
    .offset(offset);
  if (rows.length === 0) return [];
  const points = await db.select({
    journeyId: journeyRoutePoints.journeyId, id: journeyRoutePoints.id,
    lat: journeyRoutePoints.latitude, lon: journeyRoutePoints.longitude,
  })
    .from(journeyRoutePoints)
    .where(inArray(journeyRoutePoints.journeyId, rows.map((row) => row.id)))
    .orderBy(asc(journeyRoutePoints.journeyId), asc(journeyRoutePoints.sortOrder));
  return rows.map((row) => ({
    ...row,
    points: points.filter((point) => point.journeyId === row.id).map(({ id, lat, lon }) => ({ id, lat, lon })),
  }));
}

export type AutoRouteWrite =
  | { kind: "road"; candidate: RouteCandidate }
  | { kind: "attempt"; attempt: NonNullable<RouteSegmentRecord["autoAttempt"]> };

/**
 * Stores automatic snapping output under the same locks and sourceKey /
 * revision guard as member writes. Returns false, without writing, when the
 * segment changed or a member decided it meanwhile. A failed attempt keeps the
 * revision, so a member's open candidate list stays valid.
 */
export async function writeAutoRouteSegment(
  journeyId: string,
  fromId: string,
  toId: string,
  expected: { sourceKey: string; revision: number },
  write: AutoRouteWrite,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const [owner] = await transaction.select({ atlasId: journeys.atlasId }).from(journeys)
      .where(eq(journeys.id, journeyId)).limit(1);
    if (!owner || !await lockActiveAtlas(transaction, owner.atlasId)
      || !await lockActiveJourney(transaction, journeyId, owner.atlasId)) return false;
    const [journey] = await transaction.select({ routeSegments: journeys.routeSegments })
      .from(journeys)
      .where(eq(journeys.id, journeyId))
      .limit(1);
    const points = await transaction
      .select({ id: journeyRoutePoints.id, lat: journeyRoutePoints.latitude, lon: journeyRoutePoints.longitude })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const current = journey ? findSegmentContext(points, journey.routeSegments, fromId, toId) : null;
    const revision = current?.record?.revision ?? 0;
    if (!journey || !current || current.sourceKey !== expected.sourceKey || revision !== expected.revision
      || autoRouteSegmentState(current.record, now.getTime()) !== "pending") return false;
    const base = { fromRoutePointId: fromId, toRoutePointId: toId, sourceKey: current.sourceKey, shapePoints: [] };
    const record: RouteSegmentRecord = write.kind === "road"
      ? { ...base, revision: revision + 1, decision: "confirmed", confirmedCandidate: write.candidate, confirmedBy: "auto" }
      : { ...base, revision, decision: "open", confirmedCandidate: null, autoAttempt: write.attempt };
    // Not a member edit: the Journey's updatedAt stays as the member left it.
    await transaction.update(journeys)
      .set({ routeSegments: [...journey.routeSegments.filter((entry) => entry.sourceKey !== current.sourceKey), record] })
      .where(eq(journeys.id, journeyId));
    return true;
  });
}
