// Automatic road snapping: the server gives each Route Segment road geometry
// by itself, and the candidate editor stays a correction entry. These rules
// are shared by the reconciler, the owner payload and the client status line.
import { routeSegmentSourceKey } from "./journeyModel";
import { haversineDistanceKm } from "./mediaPlacement";
import { routingFailureMessage } from "./routingPreparation";
import type { AutoRouteSegmentStatus, Journey, RoadProfile, RouteSegmentRecord } from "./types";

/** Below this direct distance a segment is snapped on foot, otherwise by car. */
export const AUTO_ROUTE_WALKING_MAX_METERS = 2_000;

type SegmentPoint = { id: string; lat: number; lon: number };

export function autoRouteProfile(from: SegmentPoint, to: SegmentPoint): Extract<RoadProfile, "walking" | "driving"> {
  return haversineDistanceKm(from.lat, from.lon, to.lat, to.lon) * 1_000 < AUTO_ROUTE_WALKING_MAX_METERS
    ? "walking" : "driving";
}

/**
 * "settled": a member decision (confirmed, none, or shape points) or auto
 * geometry; never touched automatically again. "failed": the last attempt
 * failed and is not due for a retry. "pending": owed an attempt.
 */
export function autoRouteSegmentState(record: RouteSegmentRecord | null, nowMs: number): "pending" | "failed" | "settled" {
  if (record && (record.decision !== "open" || record.shapePoints.length > 0)) return "settled";
  const attempt = record?.autoAttempt;
  if (!attempt) return "pending";
  return attempt.retryAt && Date.parse(attempt.retryAt) <= nowMs ? "pending" : "failed";
}

export type AutoRouteSegment = {
  from: SegmentPoint;
  to: SegmentPoint;
  sourceKey: string;
  record: RouteSegmentRecord | null;
  profile: Extract<RoadProfile, "walking" | "driving">;
  state: "pending" | "failed";
};

/** Legs, in route order, that automatic snapping still owes a road, limited to supported profiles. */
export function unsettledAutoRouteSegments(
  points: readonly SegmentPoint[],
  records: readonly RouteSegmentRecord[],
  nowMs: number,
  supports: (profile: RoadProfile) => boolean,
): AutoRouteSegment[] {
  return points.slice(0, -1).flatMap((from, index): AutoRouteSegment[] => {
    const to = points[index + 1];
    const sourceKey = routeSegmentSourceKey(points, index);
    if (!sourceKey) return [];
    const profile = autoRouteProfile(from, to);
    if (!supports(profile)) return [];
    const record = records.find((entry) => entry.sourceKey === sourceKey) ?? null;
    const state = autoRouteSegmentState(record, nowMs);
    return state === "settled" ? [] : [{ from, to, sourceKey, record, profile, state }];
  });
}

export function autoRouteSegmentStatuses(
  points: readonly SegmentPoint[],
  records: readonly RouteSegmentRecord[],
  nowMs: number,
  supports: (profile: RoadProfile) => boolean,
  snappingSourceKey: string | null = null,
): AutoRouteSegmentStatus[] {
  return unsettledAutoRouteSegments(points, records, nowMs, supports).map((segment) => (
    segment.sourceKey === snappingSourceKey ? { sourceKey: segment.sourceKey, state: "snapping" }
      : segment.state === "failed" ? { sourceKey: segment.sourceKey, state: "failed", code: segment.record!.autoAttempt!.code }
        : { sourceKey: segment.sourceKey, state: "pending" }
  ));
}

function journeySourceKeys(journey: Pick<Journey, "routePoints">) {
  const points = journey.routePoints.map((point) => ({ id: point.id, lat: point.latitude, lon: point.longitude }));
  return points.slice(0, -1).map((_, index) => routeSegmentSourceKey(points, index));
}

/** True while a current leg of this Journey is waiting for, or being given, road geometry. */
export function journeyAutoRoutePending(journey: Pick<Journey, "routePoints" | "autoRouteSegments">): boolean {
  if (!journey.autoRouteSegments?.length) return false;
  const current = new Set(journeySourceKeys(journey));
  return journey.autoRouteSegments.some((status) => status.state !== "failed" && current.has(status.sourceKey));
}

/**
 * Takes only segment geometry and status from a refreshed read, and only while
 * both reads describe the same legs; anything else stays with the Journey the
 * Atlas already holds.
 */
export function mergeAutoRouteRefresh(current: Journey, fetched: Journey): Journey {
  if (current.id !== fetched.id
    || JSON.stringify(journeySourceKeys(current)) !== JSON.stringify(journeySourceKeys(fetched))) return current;
  return { ...current, routeSegments: fetched.routeSegments, autoRouteSegments: fetched.autoRouteSegments };
}

/** Editor copy for a segment the server could not snap; the map view shows nothing for it. */
export function autoRouteFailureMessage(code: string): string {
  const reason = routingFailureMessage({ code });
  return reason ? `自动贴合道路未完成：${reason}` : "自动贴合没有找到合适的道路，原路线已保留，可以在这里修正。";
}
