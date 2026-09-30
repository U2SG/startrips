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
  const removed = points.find((point) => point.draftId === draftId);
  const removedId = removed?.id ?? null;
  return points
    .filter((point) => point.draftId !== draftId)
    .map((point) => removedId && point.stayAnchorRoutePointId === removedId
      ? { ...point, stayAnchorRoutePointId: null }
      : point);
}

export function toggleRouteStop(
  points: readonly RouteDraftPoint[],
  draftId: string,
): RouteDraftPoint[] {
  const toggled = points.find((point) => point.draftId === draftId);
  if (!toggled) return [...points];
  const becomingStop = !toggled.isStop;
  return points.map((point) => {
    if (point.draftId === draftId) {
      return {
        ...point,
        isStop: becomingStop,
        // Stops are roots, never children. Demotion also drops any stale self
        // membership rather than carrying hidden ownership through the edit.
        stayAnchorRoutePointId: null,
      };
    }
    // If a target Stop is demoted, truthfully clear children that pointed at
    // that exact canonical id. Reorder never enters this path, so it cannot
    // silently retarget a child to whichever Stop became adjacent.
    if (!becomingStop && toggled.id && point.stayAnchorRoutePointId === toggled.id) {
      return { ...point, stayAnchorRoutePointId: null };
    }
    return point;
  });
}

export type RoutePointStayOwnershipTargets = {
  previous: RouteDraftPoint | null;
  next: RouteDraftPoint | null;
  current: RouteDraftPoint | null;
  needsCorrection: boolean;
};

export function routePointStayOwnershipTargets(
  points: readonly RouteDraftPoint[],
  draftId: string,
): RoutePointStayOwnershipTargets {
  const index = points.findIndex((point) => point.draftId === draftId);
  const point = index >= 0 ? points[index] : null;
  if (!point || point.isStop) {
    return { previous: null, next: null, current: null, needsCorrection: false };
  }
  let previous: RouteDraftPoint | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (points[cursor].isStop) {
      previous = points[cursor];
      break;
    }
  }
  let next: RouteDraftPoint | null = null;
  for (let cursor = index + 1; cursor < points.length; cursor += 1) {
    if (points[cursor].isStop) {
      next = points[cursor];
      break;
    }
  }
  const current = point.stayAnchorRoutePointId
    ? points.find((candidate) => candidate.id === point.stayAnchorRoutePointId) ?? null
    : null;
  const currentIsAdjacent = Boolean(
    current
    && (current.draftId === previous?.draftId || current.draftId === next?.draftId),
  );
  return {
    previous,
    next,
    current,
    needsCorrection: Boolean(point.stayAnchorRoutePointId) && !currentIsAdjacent,
  };
}

export function newCanonicalRoutePointId() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Stable Route Point ownership requires UUID support");
  return id;
}

export function setRoutePointStayAnchor(
  points: readonly RouteDraftPoint[],
  childDraftId: string,
  targetDraftId: string | null,
): RouteDraftPoint[] {
  const child = points.find((point) => point.draftId === childDraftId);
  if (!child || child.isStop) return [...points];
  if (targetDraftId === null) {
    return points.map((point) => point.draftId === childDraftId
      ? { ...point, stayAnchorRoutePointId: null }
      : point);
  }
  const targets = routePointStayOwnershipTargets(points, childDraftId);
  const target = [targets.previous, targets.next]
    .find((candidate) => candidate?.draftId === targetDraftId) ?? null;
  if (!target?.isStop) return [...points];
  const targetId = target.id ?? newCanonicalRoutePointId();
  return points.map((point) => {
    if (point.draftId === target.draftId && !point.id) return { ...point, id: targetId };
    if (point.draftId === childDraftId) return { ...point, stayAnchorRoutePointId: targetId };
    return point;
  });
}

export function routeDraftToInput(
  points: readonly RouteDraftPoint[],
): RoutePointInput[] {
  return points.map(({ draftId: _draftId, ...point }) => ({
    ...point,
    label: point.label.trim(),
    regionContext: point.regionContext === undefined
      ? undefined
      : point.regionContext?.trim() || null,
  }));
}

/** The media attributes the Composer keeps beside a not-yet-uploaded File. */
export type RouteDraftMediaRef = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  routePointDraftId: string | null;
};

/**
 * #586: a stable fingerprint of everything the Composer would persist.
 *
 * The Composer asks this before honouring a close, to decide whether the member
 * would silently lose work. Identity alone is not enough, and that is the whole
 * point of this helper: editing an *existing* Route Point's Place Label, note,
 * coordinates, Stop flag, or stay ownership leaves its `draftId` untouched, so
 * a guard built on draft ids — or on the media count — stays silent through an
 * edit that the next save would have written. Both of those comparisons miss a
 * real loss and both were live.
 *
 * So fingerprint exactly what `routeDraftToInput` persists, in payload order,
 * plus the media ownership that decides which Route Point each file belongs to.
 * Missing optional fields are normalised to `null` so that "absent" and
 * "explicitly null" cannot disagree.
 */
export function routeDraftFingerprint(
  points: readonly RouteDraftPoint[],
  media: readonly RouteDraftMediaRef[],
): string {
  return JSON.stringify([
    points.map((point) => [
      point.draftId,
      point.latitude,
      point.longitude,
      point.label,
      point.isStop,
      point.occurredAt ?? null,
      point.note ?? null,
      point.regionContext ?? null,
      point.placeRole ?? null,
      point.overviewVisibility ?? null,
      point.stayAnchorRoutePointId ?? null,
      point.id ?? null,
    ]),
    media.map((item) => [
      item.name,
      item.size,
      item.type,
      item.lastModified,
      item.routePointDraftId,
    ]),
  ]);
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
    // #514 presentation evidence follows the stable Route Point through the
    // same draft/save path; absent legacy values remain absent.
    regionContext: point.regionContext ?? null,
    placeRole: point.placeRole ?? null,
    overviewVisibility: point.overviewVisibility ?? null,
    stayAnchorRoutePointId: point.stayAnchorRoutePointId ?? null,
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
