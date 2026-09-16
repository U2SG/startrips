import type { RoutePointInput } from "./types";

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
