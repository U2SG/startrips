import { buildRoutePointContext, type RoutePointContext } from "./routePointContext";
import type { Journey } from "./types";

export type CrossPointReadingIntent = {
  revision: number;
  journeyId: string;
  sourceRoutePointId: string;
  targetRoutePointId: string;
};

export type CrossPointReadingResolution = {
  intent: CrossPointReadingIntent;
  source: RoutePointContext;
  target: RoutePointContext;
};

export function beginCrossPointReading(
  revision: number,
  source: RoutePointContext,
  targetRoutePointId: string,
): CrossPointReadingIntent {
  return {
    revision,
    journeyId: source.journeyId,
    sourceRoutePointId: source.routePointId,
    targetRoutePointId,
  };
}

export function resolveReadableCrossPointTarget(
  journey: Journey,
  source: RoutePointContext,
  targetRoutePointId: string | null | undefined,
): RoutePointContext | null {
  if (!targetRoutePointId || source.journeyId !== journey.id) return null;
  if (targetRoutePointId === source.routePointId) return null;
  const neighborIds = new Set([
    source.previousRoutePoint?.routePointId,
    source.nextRoutePoint?.routePointId,
  ].filter((value): value is string => Boolean(value)));
  if (!neighborIds.has(targetRoutePointId)) return null;
  const target = buildRoutePointContext(journey, targetRoutePointId);
  if (!target?.notePresent || !target.note) return null;
  return target;
}

export function resolveCrossPointReading(
  intent: CrossPointReadingIntent | null,
  activeJourneyId: string | null,
  sourceContext: RoutePointContext | null,
  journeys: readonly Journey[],
): CrossPointReadingResolution | null {
  if (!intent || !sourceContext) return null;
  if (
    activeJourneyId !== intent.journeyId
    || sourceContext.journeyId !== intent.journeyId
    || sourceContext.routePointId !== intent.sourceRoutePointId
  ) {
    return null;
  }
  const journey = journeys.find((candidate) => candidate.id === intent.journeyId) ?? null;
  if (!journey) return null;
  const source = buildRoutePointContext(journey, intent.sourceRoutePointId);
  if (!source) return null;
  const target = resolveReadableCrossPointTarget(journey, source, intent.targetRoutePointId);
  if (!target) return null;
  return { intent, source, target };
}
