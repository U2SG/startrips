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
 * Narrative/current identity is supplied by the existing time-cursor owner.
 * Presentation never reconstructs it from route order or per-route progress.
 */
export function routePointIsNarrativeCurrent({
  routeId,
  routePointId,
  pointIndex,
  narrativeSelection,
}: {
  routeId: string;
  routePointId?: string;
  pointIndex: number;
  narrativeSelection: RoutePointSelection;
}) {
  return routePointIsSelected({
    routeId,
    routePointId,
    pointIndex,
    selection: narrativeSelection,
  });
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
  isStop,
  selection,
  narrativeSelection,
  temporalReveal,
}: {
  routeId: string;
  routePointId?: string;
  pointIndex: number;
  isStop: boolean;
  selection: RoutePointSelection;
  narrativeSelection: RoutePointSelection;
  temporalReveal: RouteTemporalReveal;
}): RoutePointPresentation {
  const temporalProgress = routePointTemporalProgress(routeId, pointIndex, temporalReveal);
  const narrativeCurrent = temporalProgress > 0 && routePointIsNarrativeCurrent({
    routeId,
    routePointId,
    pointIndex,
    narrativeSelection,
  });
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
  narrativeRouteId,
}: {
  routeId: string;
  selectedRouteId: string | null | undefined;
  narrativeRouteId: string | null | undefined;
}): RoutePointAttentionRole {
  if (routeId === narrativeRouteId) return "narrative-current";
  return routeId === selectedRouteId ? "selected" : "ordinary";
}
