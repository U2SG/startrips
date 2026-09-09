import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";
import type { HomeBasePeriod } from "./homeBase";
import { resolveEffectiveCurrentHomeBase } from "./homeBasePresence";

export type HomeBaseCameraIntent = {
  kind: "initial-home";
  homeBaseId: string;
  latitude: number;
  longitude: number;
  anchor: ReturnType<typeof routePointAnchor>;
};

/**
 * #233 camera policy: Home may seed a fresh Atlas once, but it never becomes
 * a recenter force. Manual exploration wins permanently for that Atlas view,
 * and selected Journey focus always outranks Home.
 */
export function resolveHomeBaseCameraIntent(input: {
  periods: readonly HomeBasePeriod[];
  effectiveDate: string;
  atlasIsFresh: boolean;
  hasManualCameraInteraction: boolean;
  selectedJourneyId: string | null;
}): HomeBaseCameraIntent | null {
  if (!input.atlasIsFresh || input.hasManualCameraInteraction || input.selectedJourneyId !== null) return null;
  const period = resolveEffectiveCurrentHomeBase(input.periods, input.effectiveDate);
  if (!period) return null;
  return {
    kind: "initial-home",
    homeBaseId: period.id,
    latitude: period.latitude,
    longitude: period.longitude,
    anchor: routePointAnchor(period.latitude, period.longitude, GEOGRAPHIC_SURFACE_RADIUS),
  };
}
