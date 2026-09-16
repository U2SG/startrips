export type RoutePointSemanticRole = "passthrough" | "stop";
export type RoutePointAttentionRole = "ordinary" | "selected" | "narrative-current";

export type RoutePointSelection = {
  journeyId: string;
  routePointId?: string | null;
  pointIndex?: number | null;
} | null | undefined;

export type RouteTemporalReveal = {
  journeys: ReadonlyMap<string, number>;
  points: ReadonlyMap<string, number>;
} | undefined;

/**
 * Consumer contract for the follow-up label slice: labels read this projection
 * (semantic role, attention role and temporal visibility) instead of deriving
 * a second `active` boolean. This helper never owns camera, playback or time.
 */
export type RoutePointPresentation = {
  semanticRole: RoutePointSemanticRole;
  attentionRole: RoutePointAttentionRole;
  temporalVisible: boolean;
  temporalProgress: number;
};

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function routePointTemporalProgress(
  routeId: string,
  pointIndex: number,
  reveal: RouteTemporalReveal,
) {
  const point = reveal?.points.get(`${routeId}:${pointIndex}`);
  if (point !== undefined) return clamp01(point);
  const journey = reveal?.journeys.get(routeId);
  return journey === undefined ? 1 : clamp01(journey);
}

/**
 * The time cursor is the only narrative-progress authority. A route only has a
 * narrative-current Route Point while the cursor is INSIDE that Journey; a
 * fully visited route has no moving/current marker. The current record is the
 * last Route Point that the existing temporal reveal says has started.
 */
export function narrativeCurrentRoutePointIndex(
  routeId: string,
  pointCount: number,
  reveal: RouteTemporalReveal,
) {
  if (!reveal || pointCount <= 0) return null;
  const journeyProgress = clamp01(reveal.journeys.get(routeId) ?? 0);
  if (journeyProgress <= 0 || journeyProgress >= 1) return null;

  let current: number | null = null;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    if (routePointTemporalProgress(routeId, pointIndex, reveal) > 0) current = pointIndex;
  }
  return current;
}

export function routePointIsSelected({
  routeId,
  routePointId,
  pointIndex,
  selection,
}: {
  routeId: string;
  routePointId?: string;
  pointIndex: number;
  selection: RoutePointSelection;
}) {
  if (!selection || selection.journeyId !== routeId) return false;
  if (selection.routePointId && routePointId) return selection.routePointId === routePointId;
  return selection.pointIndex === pointIndex;
}

export function resolveRoutePointPresentation({
  routeId,
  routePointId,
  pointIndex,
  pointCount,
  isStop,
  selection,
  temporalReveal,
}: {
  routeId: string;
  routePointId?: string;
  pointIndex: number;
  pointCount: number;
  isStop: boolean;
  selection: RoutePointSelection;
  temporalReveal: RouteTemporalReveal;
}): RoutePointPresentation {
  const temporalProgress = routePointTemporalProgress(routeId, pointIndex, temporalReveal);
  const narrativeCurrent = narrativeCurrentRoutePointIndex(routeId, pointCount, temporalReveal) === pointIndex;
  const selected = routePointIsSelected({ routeId, routePointId, pointIndex, selection });
  return {
    semanticRole: isStop ? "stop" : "passthrough",
    attentionRole: narrativeCurrent ? "narrative-current" : selected ? "selected" : "ordinary",
    temporalVisible: temporalProgress > 0,
    temporalProgress,
  };
}

export function routePointMarkerRadiusPx(presentation: RoutePointPresentation) {
  if (presentation.attentionRole === "narrative-current") return 3.2;
  if (presentation.attentionRole === "selected") return 3;
  return presentation.semanticRole === "stop" ? 2.55 : 2.1;
}
export function resolveRouteAttentionRole({
  routeId,
  selectedRouteId,
  temporalReveal,
}: {
  routeId: string;
  selectedRouteId: string | null | undefined;
  temporalReveal: RouteTemporalReveal;
}): RoutePointAttentionRole {
  const progress = temporalReveal?.journeys.get(routeId);
  if (progress !== undefined && progress > 0 && progress < 1) return "narrative-current";
  return routeId === selectedRouteId ? "selected" : "ordinary";
}