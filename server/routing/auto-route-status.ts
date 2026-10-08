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
