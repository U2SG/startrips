import { journeyVisualMedia } from "./journeyModel";
import type { Journey } from "./types";

export const ROUTE_POINT_LOCATION_PRECISION = "route-point" as const;
export type RoutePointLocationPrecision = typeof ROUTE_POINT_LOCATION_PRECISION;

export type RoutePointContextRouteRef = {
  routePointId: string;
  routePointLabel: string;
  routePointIndex: number;
  isStop: boolean;
};

export type RoutePointContext = {
  journeyId: string;
  journeyTitle: string;
  routePointId: string;
  routePointLabel: string;
  routePointIndex: number;
  routePointCount: number;
  previousRoutePoint: RoutePointContextRouteRef | null;
  nextRoutePoint: RoutePointContextRouteRef | null;
  sameCoordinateRoutePoints: RoutePointContextRouteRef[];
  resolvedDate: string | null;
  notePresent: boolean;
  note: string | null;
  visualMediaCount: number;
  representativeAssetId: string | null;
  location: {
    latitude: number;
    longitude: number;
    precision: RoutePointLocationPrecision;
  };
};

export type RoutePointContextIntent = {
  revision: number;
  journeyId: string;
  routePointId: string;
};

export type RoutePointContextSelection = {
  revision: number;
  intent: RoutePointContextIntent | null;
  context: RoutePointContext | null;
};

export function emptyRoutePointContextSelection(): RoutePointContextSelection {
  return { revision: 0, intent: null, context: null };
}

function routePointRouteRef(
  journey: Journey,
  routePointIndex: number,
): RoutePointContextRouteRef | null {
  const point = journey.routePoints[routePointIndex];
  if (!point) return null;
  return {
    routePointId: point.id,
    routePointLabel: point.label.trim() || `途径点 ${routePointIndex + 1}`,
    routePointIndex,
    isStop: point.isStop,
  };
}

export function buildRoutePointContext(
  journey: Journey,
  routePointId: string,
): RoutePointContext | null {
  const routePointIndex = journey.routePoints.findIndex((point) => point.id === routePointId);
  if (routePointIndex < 0) return null;
  const point = journey.routePoints[routePointIndex];
  const scopedVisualMedia = journeyVisualMedia(journey)
    .filter((asset) => asset.routePointId === routePointId)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const note = point.note?.trim() ? point.note.trim() : null;
  const resolvedDate = point.occurredAt && Number.isFinite(Date.parse(point.occurredAt))
    ? point.occurredAt
    : null;
  // #377/ST-081 owner-approved V1: this is record navigation inside the
  // already-authorized Journey, not Place/visit inference. Only exact canonical
  // coordinate equality joins records; labels and proximity never participate.
  const sameCoordinateRoutePoints = journey.routePoints.flatMap((candidate, index) => {
    if (candidate.latitude !== point.latitude || candidate.longitude !== point.longitude) return [];
    const ref = routePointRouteRef(journey, index);
    return ref ? [ref] : [];
  });

  return {
    journeyId: journey.id,
    journeyTitle: journey.title,
    routePointId: point.id,
    routePointLabel: point.label.trim() || `途径点 ${routePointIndex + 1}`,
    routePointIndex,
    routePointCount: journey.routePoints.length,
    previousRoutePoint: routePointRouteRef(journey, routePointIndex - 1),
    nextRoutePoint: routePointRouteRef(journey, routePointIndex + 1),
    sameCoordinateRoutePoints,
    resolvedDate,
    notePresent: note !== null,
    note,
    visualMediaCount: scopedVisualMedia.length,
    representativeAssetId: scopedVisualMedia[0]?.id ?? null,
    location: {
      latitude: point.latitude,
      longitude: point.longitude,
      precision: ROUTE_POINT_LOCATION_PRECISION,
    },
  };
}

export type RoutePointContextTemporalReveal = {
  journeys: ReadonlyMap<string, number>;
  points: ReadonlyMap<string, number>;
};

export function routePointContextTemporallyVisible(
  journeyId: string,
  routePointIndex: number,
  temporalReveal?: RoutePointContextTemporalReveal,
) {
  if (!temporalReveal) return true;
  const journeyProgress = temporalReveal.journeys.get(journeyId);
  if (journeyProgress !== undefined && journeyProgress <= 0) return false;
  const pointProgress = temporalReveal.points.get(`${journeyId}:${routePointIndex}`);
  return pointProgress === undefined || pointProgress > 0;
}

export function temporallyVisibleRoutePointContextRefs(
  journeyId: string,
  refs: readonly RoutePointContextRouteRef[],
  temporalReveal?: RoutePointContextTemporalReveal,
) {
  return refs.filter((ref) => routePointContextTemporallyVisible(
    journeyId,
    ref.routePointIndex,
    temporalReveal,
  ));
}

export function requestRoutePointContextSelection(
  current: RoutePointContextSelection,
  journeyId: string,
  routePointId: string,
) {
  const intent: RoutePointContextIntent = {
    revision: current.revision + 1,
    journeyId,
    routePointId,
  };
  return {
    intent,
    selection: {
      revision: intent.revision,
      intent,
      context: null,
    } satisfies RoutePointContextSelection,
  };
}

export function resolveRoutePointContextSelection(
  current: RoutePointContextSelection,
  intent: RoutePointContextIntent,
  context: RoutePointContext | null,
): RoutePointContextSelection {
  const active = current.intent;
  if (
    !active
    || active.revision !== intent.revision
    || active.journeyId !== intent.journeyId
    || active.routePointId !== intent.routePointId
  ) {
    return current;
  }
  if (context && (
    context.journeyId !== intent.journeyId
    || context.routePointId !== intent.routePointId
  )) {
    return current;
  }
  return { ...current, context };
}

export function clearRoutePointContextSelection(
  current: RoutePointContextSelection,
): RoutePointContextSelection {
  return { revision: current.revision + 1, intent: null, context: null };
}

export function isCurrentRoutePointContextIntent(
  selection: RoutePointContextSelection,
  intent: RoutePointContextIntent,
) {
  return selection.intent?.revision === intent.revision
    && selection.intent.journeyId === intent.journeyId
    && selection.intent.routePointId === intent.routePointId;
}
