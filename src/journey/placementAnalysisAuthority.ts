import type { Journey } from "./types";

export type PlacementAnalysisScope = {
  journeyId: string;
  routePointId: string | null;
  journeyMembershipKey: string;
  routePointMembershipKey: string;
  valid: boolean;
};

export type PlacementAnalysisIntent = {
  revision: number;
  scope: PlacementAnalysisScope;
};

export function placementAnalysisScope(
  journeys: readonly Journey[],
  journeyId: string,
  routePointId: string | null,
): PlacementAnalysisScope {
  const current = journeys.find((candidate) => candidate.id === journeyId) ?? null;
  const journeyMembershipKey = journeys.map((candidate) => candidate.id).join("\u001f");
  // Placement can suggest another Journey, so every currently addressable Route
  // Point belongs to the async scope, not only the Story's selected Journey.
  const routePointMembershipKey = journeys
    .map((candidate) => `${candidate.id}:${candidate.routePoints.map((point) => point.id).join(",")}`)
    .join("\u001f");
  return {
    journeyId,
    routePointId,
    journeyMembershipKey,
    routePointMembershipKey,
    valid: Boolean(current && (routePointId === null || current.routePoints.some((point) => point.id === routePointId))),
  };
}

function sameScope(a: PlacementAnalysisScope | null, b: PlacementAnalysisScope) {
  return Boolean(a
    && a.journeyId === b.journeyId
    && a.routePointId === b.routePointId
    && a.journeyMembershipKey === b.journeyMembershipKey
    && a.routePointMembershipKey === b.routePointMembershipKey
    && a.valid === b.valid);
}

export function createPlacementAnalysisAuthority() {
  let revision = 0;
  let disposed = false;
  let currentScope: PlacementAnalysisScope | null = null;

  return {
    syncScope(scope: PlacementAnalysisScope) {
      if (disposed || sameScope(currentScope, scope)) return false;
      revision += 1;
      currentScope = scope;
      return true;
    },
    start(scope: PlacementAnalysisScope): PlacementAnalysisIntent {
      revision += 1;
      currentScope = scope;
      return { revision, scope };
    },
    invalidate(scope: PlacementAnalysisScope | null = currentScope) {
      revision += 1;
      currentScope = scope;
    },
    dispose() {
      disposed = true;
      revision += 1;
      currentScope = null;
    },
    isCurrent(intent: PlacementAnalysisIntent, scope: PlacementAnalysisScope) {
      return !disposed
        && intent.revision === revision
        && intent.scope.valid
        && scope.valid
        && sameScope(intent.scope, scope)
        && sameScope(currentScope, scope);
    },
    revision() { return revision; },
  };
}
