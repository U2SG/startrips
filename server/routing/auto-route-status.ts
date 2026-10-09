import { autoRouteSegmentStatuses } from "../../src/journey/autoRouteSnapping";
import type { AutoRouteSegmentStatus, RoadProfile, RouteSegmentRecord } from "../../src/journey/types";
import { serverConfig } from "../config";
import { routingProvider } from "./routing-provider";

// The one segment the reconciler is working on, process-wide. It is shown as
// "snapping"; everything else is derived from the stored records.
let snapping: { journeyId: string; sourceKey: string } | null = null;

export function setAutoRouteSnappingTarget(target: { journeyId: string; sourceKey: string } | null) {
  snapping = target;
}

/** A Journey a member read or edited this long ago still goes before the backfill. */
export const AUTO_ROUTE_PRIORITY_TTL_MS = 30 * 60_000;
const AUTO_ROUTE_PRIORITY_MAX = 256;
// Journey id -> last read or edit, in that order (single API process).
const prioritySeen = new Map<string, number>();

/** Marks Journeys a member is looking at or editing, so their segments are snapped first. */
export function markAutoRoutePriority(journeyIds: readonly string[], nowMs = Date.now()) {
  for (const id of journeyIds) {
    prioritySeen.delete(id);
    prioritySeen.set(id, nowMs);
  }
  // Oldest first in insertion order, so the bound drops the least recently seen.
  for (const id of prioritySeen.keys()) {
    if (prioritySeen.size <= AUTO_ROUTE_PRIORITY_MAX) break;
    prioritySeen.delete(id);
  }
}

/** Priority Journeys seen within the TTL, most recently seen first. */
export function autoRoutePriorityJourneyIds(nowMs = Date.now()): string[] {
  const ids: string[] = [];
  for (const [id, seenAt] of prioritySeen) {
    if (nowMs - seenAt >= AUTO_ROUTE_PRIORITY_TTL_MS) prioritySeen.delete(id);
    else ids.push(id);
  }
  return ids.reverse();
}

/** Automatic snapping runs only with a road profile it uses; otherwise nothing is pending. */
export function autoRouteSnappingEnabled(
  supports: (profile: RoadProfile) => boolean = routingProvider.supports,
  enabled = serverConfig.routingAutoSnappingEnabled,
) {
  return enabled && (supports("driving") || supports("walking"));
}

/** Adds owner-facing automatic snapping status to a Journey read; unchanged when snapping is off. */
export function withAutoRouteStatus<T extends {
  id: string;
  routePoints: readonly { id: string; latitude: number; longitude: number }[];
  routeSegments: readonly RouteSegmentRecord[];
}>(journey: T, nowMs = Date.now()): T & { autoRouteSegments?: AutoRouteSegmentStatus[] } {
  if (!autoRouteSnappingEnabled()) return journey;
  const points = journey.routePoints.map((point) => ({ id: point.id, lat: point.latitude, lon: point.longitude }));
  return {
    ...journey,
    autoRouteSegments: autoRouteSegmentStatuses(points, journey.routeSegments, nowMs, routingProvider.supports,
      snapping?.journeyId === journey.id ? snapping.sourceKey : null),
  };
}
