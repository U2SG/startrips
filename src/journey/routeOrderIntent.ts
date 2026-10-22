/**
 * One-sentence Route Point reorder in the Composer: the pure rules around a
 * proposed order. The server proposes; nothing here writes. These helpers
 * decide what the member is shown before applying (which points move, and
 * what the new order would break) and apply only an exact permutation of the
 * draft as it is now.
 */

import {
  ROUTE_POINT_TIME_ORDER_ERROR,
  validateJourneyInput,
} from "./journeyModel";
import {
  routeDraftToInput,
  routePointStayOwnershipTargets,
  type RouteDraftPoint,
} from "./routeDraft";
import type { JourneyInput } from "./types";

/** The server's bounds, mirrored so the input stops there. */
export const MAX_ROUTE_ORDER_TEXT_LENGTH = 200;
export const MAX_ROUTE_ORDER_LABEL_LENGTH = 80;
export const MIN_ROUTE_ORDER_POINTS = 2;
export const MAX_ROUTE_ORDER_POINTS = 64;

/** The label the route list shows for a point, unnamed ones included. */
export function routeOrderDisplayLabel(point: RouteDraftPoint, index: number) {
  return point.label.trim() || `途径点 ${index + 1}`;
}

/** Exactly what is sent: the draft id and the trimmed label, nothing else. */
export function routeOrderIntentPoints(points: readonly RouteDraftPoint[]) {
  return points.map((point) => ({
    id: point.draftId,
    label: point.label.trim().slice(0, MAX_ROUTE_ORDER_LABEL_LENGTH),
  }));
}

export type RouteOrderIntentPoint = ReturnType<typeof routeOrderIntentPoints>[number];

/**
 * Whether `points` would still send exactly `basis`: same drafts, same order,
 * same labels. A proposal read against other labels is void.
 */
export function sameRouteOrderBasis(
  points: readonly RouteDraftPoint[],
  basis: readonly RouteOrderIntentPoint[],
) {
  const current = routeOrderIntentPoints(points);
  return current.length === basis.length
    && current.every((point, index) => point.id === basis[index].id && point.label === basis[index].label);
}

/** Whether `points` are still exactly the drafts `draftIds` was taken from. */
export function sameRouteDraftOrder(
  points: readonly RouteDraftPoint[],
  draftIds: readonly string[],
) {
  return points.length === draftIds.length
    && points.every((point, index) => point.draftId === draftIds[index]);
}

/**
 * The draft in the proposed order, or `null` when `order` is not every draft
 * id exactly once. Points move as whole objects: labels, times, Stops, stay
 * anchors and media targets are untouched.
 */
export function applyRouteOrder(
  points: readonly RouteDraftPoint[],
  order: readonly string[],
): RouteDraftPoint[] | null {
  if (order.length !== points.length) return null;
  const byDraftId = new Map(points.map((point) => [point.draftId, point]));
  const seen = new Set<string>();
  const next: RouteDraftPoint[] = [];
  for (const id of order) {
    const point = byDraftId.get(id);
    if (!point || seen.has(id)) return null;
    seen.add(id);
    next.push(point);
  }
  return next;
}

export type RouteOrderPreviewRow = {
  draftId: string;
  label: string;
  /** 1-based positions. */
  from: number;
  to: number;
  moved: boolean;
};

/** The proposed order, row by row, with each point's old and new position. */
export function routeOrderPreviewRows(
  points: readonly RouteDraftPoint[],
  order: readonly string[],
): RouteOrderPreviewRow[] | null {
  const proposed = applyRouteOrder(points, order);
  if (!proposed) return null;
  const fromByDraftId = new Map(points.map((point, index) => [point.draftId, index + 1]));
  return proposed.map((point, index) => {
    const from = fromByDraftId.get(point.draftId)!;
    return {
      draftId: point.draftId,
      label: routeOrderDisplayLabel(point, from - 1),
      from,
      to: index + 1,
      moved: from !== index + 1,
    };
  });
}

/**
 * What the proposed order would newly break, in words, before it is applied:
 * Route Point times that would go backwards (the save validation's own rule),
 * and stays whose owning Stop would no longer be adjacent. Problems the draft
 * already had are not repeated.
 */
export function routeOrderConsequences(
  input: JourneyInput,
  current: readonly RouteDraftPoint[],
  proposed: readonly RouteDraftPoint[],
): string[] {
  const consequences: string[] = [];
  const timeErrorIn = (points: readonly RouteDraftPoint[]) => validateJourneyInput({
    ...input,
    routePoints: routeDraftToInput(points),
  }).errors.includes(ROUTE_POINT_TIME_ORDER_ERROR);
  if (timeErrorIn(proposed) && !timeErrorIn(current)) {
    consequences.push("按新顺序，途径点的时间会倒退；应用后需要调整时间才能保存。");
  }
  const currentIndexByDraftId = new Map(current.map((point, index) => [point.draftId, index]));
  proposed.forEach((point) => {
    if (!routePointStayOwnershipTargets(proposed, point.draftId).needsCorrection) return;
    if (routePointStayOwnershipTargets(current, point.draftId).needsCorrection) return;
    const label = routeOrderDisplayLabel(point, currentIndexByDraftId.get(point.draftId) ?? 0);
    consequences.push(`「${label}」将不再紧邻它所属的停靠点，应用后需要重新选择停留归属。`);
  });
  return consequences;
}

/**
 * Why a sentence could not be read, by the server's code. Its own messages
 * are English diagnostics, so the member is shown a sentence chosen here, and
 * each says reordering by hand still works.
 */
export function routeOrderErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  switch (code) {
    case "INVALID_ROUTE_ORDER_INTENT":
      return `请用 ${MAX_ROUTE_ORDER_TEXT_LENGTH} 字以内的一句话描述新顺序。`;
    case "INTENT_UNAVAILABLE":
      return "这台服务器暂时不能按一句话调整顺序，请在下面逐个移动。";
    case "INTENT_TIMEOUT":
      return "理解这句话超时了，请重试，或在下面逐个移动。";
    default:
      return "暂时无法理解这句话，请重试，或在下面逐个移动。";
  }
}
