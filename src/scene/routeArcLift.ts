import type { GlobeSemanticZoom } from "./semanticZoom";

/**
 * #193: how much decorative altitude a Journey route carries at the current
 * zoom. Semantic zoom means the closer a viewer gets, the more geographic the
 * route becomes: cinematic at global, restrained at regional, surface-hugging
 * at near, effectively flat at max zoom.
 */
export type RouteArcProfile = "global" | "regional" | "near";

/** #15 arc strength at global view; the value the attenuation scales down. */
export const ROUTE_ARC_HEIGHT_RATIO = 0.22;
export const ROUTE_ARC_SATURATION_ANGLE = Math.PI / 3;

/** Zoom range over which the cinematic arc attenuates toward geographic. */
const ARC_ATTENUATION_START_ZOOM = 1;
const ARC_ATTENUATION_END_ZOOM = 2.55;
/** Residual lift at the end of the attenuation range: a hint, not a hump. */
const ARC_ATTENUATION_FLOOR = 0.06;

/**
 * Decorative lift never occupies more than this fraction of the smaller
 * viewport edge, so a route cannot become a screen-spanning airborne chord
 * just because the user zoomed in. Expressed against the viewport rather than
 * a pixel literal so a phone gets a proportionally smaller ceiling.
 */
const ARC_SCREEN_LIFT_BUDGET = 0.12;

/**
 * Camera z is 5.4 with a 0.1 near plane, and the label shell already sits at
 * 1.46 * 1.15 * zoom - about 5.10 world units at max zoom, the documented
 * ceiling in ParticleEarthScene. A lifted vertex above that budget is clipped
 * by the near plane, which is how a lifted arc used to tear apart at high
 * zoom, so the lift is capped by the remaining radial headroom.
 */
const ARC_WORLD_RADIUS_BUDGET = 5.02;

export type RouteArcLift = {
  /** 0..1 multiplier applied to the per-vertex lift stored in the geometry. */
  liftScale: number;
  profile: RouteArcProfile;
  /** Peak decorative altitude in world units at the current globe scale. */
  worldLiftAtScale: number;
  /** Peak decorative altitude in CSS pixels once projected. */
  screenLiftPx: number;
  /** The screen ceiling the lift was measured against. */
  screenLiftCapPx: number;
};

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function resolveRouteArcProfile(
  semanticZoom: GlobeSemanticZoom,
): RouteArcProfile {
  if (semanticZoom === "local") return "near";
  if (semanticZoom === "regional") return "regional";
  return "global";
}

/**
 * The lift strength for one frame. Every term is continuous in zoom and the
 * result is their minimum, so a continuous wheel zoom changes route shape
 * smoothly and no tier boundary can pop. The profile label is descriptive and
 * follows the hysteretic semantic zoom state; it never feeds the geometry.
 */
export function resolveRouteArcLift({
  zoom,
  globeScale,
  anchorRadius,
  pixelsPerWorldUnit,
  viewportMinPx,
  semanticZoom,
  arcHeightRatio = ROUTE_ARC_HEIGHT_RATIO,
}: {
  zoom: number;
  globeScale: number;
  anchorRadius: number;
  pixelsPerWorldUnit: number;
  viewportMinPx: number;
  semanticZoom: GlobeSemanticZoom;
  arcHeightRatio?: number;
}): RouteArcLift {
  const profile = resolveRouteArcProfile(semanticZoom);
  const screenLiftCapPx = Math.max(0, ARC_SCREEN_LIFT_BUDGET * viewportMinPx);
  const peakWorldLiftPerUnitScale = anchorRadius * arcHeightRatio * globeScale;
  const empty: RouteArcLift = {
    liftScale: 0,
    profile,
    worldLiftAtScale: 0,
    screenLiftPx: 0,
    screenLiftCapPx,
  };
  if (
    !Number.isFinite(zoom)
    || !Number.isFinite(globeScale)
    || peakWorldLiftPerUnitScale <= 0
  ) {
    return empty;
  }

  const semanticLift = 1 - (1 - ARC_ATTENUATION_FLOOR) * smoothstep(
    ARC_ATTENUATION_START_ZOOM,
    ARC_ATTENUATION_END_ZOOM,
    zoom,
  );

  const anchorExtent = anchorRadius * globeScale;
  const radialHeadroom = ARC_WORLD_RADIUS_BUDGET - anchorExtent;
  const radialLift = radialHeadroom <= 0
    ? 0
    : radialHeadroom / peakWorldLiftPerUnitScale;

  const projectedPeakPx = peakWorldLiftPerUnitScale
    * Math.max(0, pixelsPerWorldUnit);
  const screenLift = projectedPeakPx > 0
    ? screenLiftCapPx / projectedPeakPx
    : 1;

  const liftScale = Math.max(
    0,
    Math.min(1, semanticLift, radialLift, screenLift),
  );
  const worldLiftAtScale = peakWorldLiftPerUnitScale * liftScale;

  return {
    liftScale,
    profile,
    worldLiftAtScale,
    screenLiftPx: worldLiftAtScale * Math.max(0, pixelsPerWorldUnit),
    screenLiftCapPx,
  };
}
