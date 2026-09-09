import { isReadOnlyAtlasView, type AtlasViewCapabilities } from "./atlasView";
import { resolveHomeBaseForDate, type HomeBasePeriod } from "./homeBase";
import { haversineDistanceKm } from "./mediaPlacement";
import type { RoutePoint } from "./types";
import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";

/**
 * #235 V1: Home proximity is a narrative decision, not media-placement
 * confidence. Keep this semantic constant independent even while both happen
 * to be 25 km. The boundary is inclusive: <= 25 km skips the extra Home beat.
 */
export const HOME_PRELUDE_SKIP_RADIUS_KM = 25;

export type HomeNarrativeSkipReason =
  | "guest-view"
  | "unknown-dates"
  | "no-home-base"
  | "no-route-point"
  | "starts-near-home"
  | "ends-near-home"
  | "quick-recap-budget";

export type HomeNarrativeCameraTarget = {
  kind: "home";
  homeBaseId: string;
  latitude: number;
  longitude: number;
  /** Canonical geographic-surface anchor, never a route vertex. */
  anchor: { x: number; y: number; z: number };
};

export type HomeNarrativeBeatDecision =
  | { eligible: true; reason: "eligible"; cameraTarget: HomeNarrativeCameraTarget }
  | { eligible: false; reason: HomeNarrativeSkipReason };

export type HomeNarrativeContext = {
  prelude: HomeNarrativeBeatDecision;
  epilogue: HomeNarrativeBeatDecision;
};

export type ResolveHomeNarrativeContextInput = {
  startedOn: string | null | undefined;
  endedOn: string | null | undefined;
  firstRoutePoint: Pick<RoutePoint, "latitude" | "longitude"> | null | undefined;
  lastRoutePoint: Pick<RoutePoint, "latitude" | "longitude"> | null | undefined;
  periods: readonly HomeBasePeriod[];
  capabilities: AtlasViewCapabilities;
};

function isDeterminateJourneyDate(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function targetFor(period: HomeBasePeriod): HomeNarrativeCameraTarget {
  // #193/#196 own geographic projection. Home context is intentionally not a
  // Route Point, but its camera anchor still lives on that exact same surface.
  const anchor = routePointAnchor(period.latitude, period.longitude, GEOGRAPHIC_SURFACE_RADIUS);
  return {
    kind: "home",
    homeBaseId: period.id,
    latitude: period.latitude,
    longitude: period.longitude,
    anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
  };
}

function nearHome(
  point: Pick<RoutePoint, "latitude" | "longitude">,
  period: HomeBasePeriod,
): boolean {
  return haversineDistanceKm(
    point.latitude,
    point.longitude,
    period.latitude,
    period.longitude,
  ) <= HOME_PRELUDE_SKIP_RADIUS_KM;
}

/**
 * Pure Home narrative eligibility. Historical selection is delegated only to
 * `resolveHomeBaseForDate`; no current clock or inferred route mutation enters
 * this decision. Prelude and epilogue resolve their own historical boundaries;
 * an unknown end date can never borrow the start date and pretend it is the
 * Home that applied when the Journey ended.
 */
export function resolveHomeNarrativeContext(
  input: ResolveHomeNarrativeContextInput,
): HomeNarrativeContext {
  if (isReadOnlyAtlasView(input.capabilities)) {
    return {
      prelude: { eligible: false, reason: "guest-view" },
      epilogue: { eligible: false, reason: "guest-view" },
    };
  }

  if (!isDeterminateJourneyDate(input.startedOn)) {
    return {
      prelude: { eligible: false, reason: "unknown-dates" },
      epilogue: { eligible: false, reason: "unknown-dates" },
    };
  }
  const epilogueDateKnown = isDeterminateJourneyDate(input.endedOn);

  const preludeHome = resolveHomeBaseForDate(input.periods, input.startedOn);
  const epilogueHome = epilogueDateKnown
    ? resolveHomeBaseForDate(input.periods, input.endedOn)
    : null;

  let prelude: HomeNarrativeBeatDecision;
  if (!preludeHome) prelude = { eligible: false, reason: "no-home-base" };
  else if (!input.firstRoutePoint) prelude = { eligible: false, reason: "no-route-point" };
  else if (nearHome(input.firstRoutePoint, preludeHome)) {
    prelude = { eligible: false, reason: "starts-near-home" };
  } else {
    prelude = { eligible: true, reason: "eligible", cameraTarget: targetFor(preludeHome) };
  }

  let epilogue: HomeNarrativeBeatDecision;
  if (!epilogueDateKnown) epilogue = { eligible: false, reason: "unknown-dates" };
  else if (!epilogueHome) epilogue = { eligible: false, reason: "no-home-base" };
  else if (!input.lastRoutePoint) epilogue = { eligible: false, reason: "no-route-point" };
  else if (nearHome(input.lastRoutePoint, epilogueHome)) {
    epilogue = { eligible: false, reason: "ends-near-home" };
  } else {
    epilogue = { eligible: true, reason: "eligible", cameraTarget: targetFor(epilogueHome) };
  }

  return { prelude, epilogue };
}
