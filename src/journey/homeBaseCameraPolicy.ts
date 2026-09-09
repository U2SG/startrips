import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";
import type { HomeBasePeriod } from "./homeBase";

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
  currentPeriod: HomeBasePeriod | null;
  atlasIsFresh: boolean;
  hasManualCameraInteraction: boolean;
  selectedJourneyId: string | null;
}): HomeBaseCameraIntent | null {
  const period = input.currentPeriod;
  if (!input.atlasIsFresh || input.hasManualCameraInteraction || input.selectedJourneyId !== null) return null;
  if (!period || period.endedOn !== null) return null;
  return {
    kind: "initial-home",
    homeBaseId: period.id,
    latitude: period.latitude,
    longitude: period.longitude,
    anchor: routePointAnchor(period.latitude, period.longitude, GEOGRAPHIC_SURFACE_RADIUS),
  };
}
