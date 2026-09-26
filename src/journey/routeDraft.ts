import type { Journey, RoutePointInput } from "./types";

export type GlobePointPick = Pick<RoutePointInput, "latitude" | "longitude">;

export type RouteDraftPoint = RoutePointInput & {
  draftId: string;
};

export type RouteDraftSearchMatch = {
  point: RouteDraftPoint;
  routeIndex: number;
};

function normalizeRouteDraftSearchText(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

export function matchRouteDraftPoints(
  points: readonly RouteDraftPoint[],
  query: string,
): RouteDraftSearchMatch[] {
  const needle = normalizeRouteDraftSearchText(query);
  if (needle.length < 2) return [];

  return points.flatMap((point, routeIndex) => (
    normalizeRouteDraftSearchText(point.label).includes(needle)
      ? [{ point, routeIndex }]
      : []
  ));
}
export function appendRoutePoint(
  points: readonly RouteDraftPoint[],
  point: RouteDraftPoint,
): RouteDraftPoint[] {
  return [...points, point];
}

export function updateRoutePoint(
  points: readonly RouteDraftPoint[],
  draftId: string,
  patch: Partial<RoutePointInput>,
): RouteDraftPoint[] {
  return points.map((point) =>
    point.draftId === draftId ? { ...point, ...patch } : point
  );
}

export function suggestPointLabel(
  points: readonly RouteDraftPoint[],
  draftId: string,
  label: string,
): RouteDraftPoint[] {
  const suggestion = label.trim();
  if (!suggestion) return [...points];
  return points.map((point) =>
    point.draftId === draftId && !point.label.trim()
      ? { ...point, label: suggestion }
      : point
  );
}

export function moveRoutePoint(
  points: readonly RouteDraftPoint[],
  draftId: string,
  direction: -1 | 1,
): RouteDraftPoint[] {
  const index = points.findIndex((point) => point.draftId === draftId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= points.length) return [...points];

  const next = [...points];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeRoutePoint(
  points: readonly RouteDraftPoint[],
  draftId: string,
): RouteDraftPoint[] {
  return points.filter((point) => point.draftId !== draftId);
}

export function toggleRouteStop(
  points: readonly RouteDraftPoint[],
  draftId: string,
): RouteDraftPoint[] {
  return points.map((point) =>
    point.draftId === draftId
      ? { ...point, isStop: !point.isStop }
      : point
  );
}

export function routeDraftToInput(
  points: readonly RouteDraftPoint[],
): RoutePointInput[] {
  return points.map(({ draftId: _draftId, ...point }) => ({
    ...point,
    label: point.label.trim(),
  }));
}

export function routePointFocusAfterRemoval(
  routePoints: readonly RouteDraftPoint[],
  routePointDraftId: string,
): string | null {
  const index = routePoints.findIndex((point) => point.draftId === routePointDraftId);
  if (index < 0) return null;
  return routePoints[index + 1]?.draftId ?? routePoints[index - 1]?.draftId ?? null;
}

/**
 * #546: the place search bias for a Journey being composed. The last Route
 * Point, not a centroid: a Route through Beijing and Shanghai has its centroid
 * in neither city, while the next place is usually added near the last one.
 */
export function routeDraftSearchFocus(
  points: readonly RouteDraftPoint[],
): GlobePointPick | null {
  const last = points.at(-1);
  if (
    !last
    || !Number.isFinite(last.latitude)
    || !Number.isFinite(last.longitude)
  ) {
    return null;
  }
  return { latitude: last.latitude, longitude: last.longitude };
}

export function journeyToDraftPoints(journey: Journey): RouteDraftPoint[] {
  return journey.routePoints.map((point) => ({
    draftId: `saved-${point.id}`,
    id: point.id,
    latitude: point.latitude,
    longitude: point.longitude,
    label: point.label,
    isStop: point.isStop,
    occurredAt: point.occurredAt,
    // #10: echo the existing note back so a whole-list replace never clears
    // it; absent notes stay absent.
    note: point.note ?? null,
  }));
}

export function parseCoordinateInput(
  value: string,
  minimum: number,
  maximum: number,
) {
  const normalized = value.trim();
  if (!normalized) return null;
  const coordinate = Number(normalized);
  return Number.isFinite(coordinate)
    && coordinate >= minimum
    && coordinate <= maximum
    ? coordinate
    : null;
}
