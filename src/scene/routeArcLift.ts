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
/** Residual lift at the end of regional attenuation: a hint, not a hump. */
const ARC_ATTENUATION_FLOOR = 0.06;
/** After regional attenuation, finish flattening onto geography by max zoom. */
const ARC_GEOGRAPHIC_FLATTEN_END_ZOOM = 3.0;

/**
 * Decorative lift never occupies more than this fraction of the smaller
 * viewport edge, so a route cannot become a screen-spanning airborne chord
 * just because the user zoomed in. Expressed against the viewport rather than
 * a pixel literal so a phone gets a proportionally smaller ceiling.
 */
const ARC_SCREEN_LIFT_BUDGET = 0.12;

/**
 * Camera z is 5.4 with a 0.1 near plane. Decorative route vertices must stay
 * comfortably in front of that plane at every zoom. The geographic anchor is
 * now the real surface (#196), so this is purely a safety ceiling for lifted
 * interior arc vertices rather than a second semantic shell.
 */
const ARC_WORLD_RADIUS_BUDGET = 5.02;

/** Never divide by a depth the near plane (0.1) would have clipped anyway. */
const MIN_ARC_DEPTH = 0.2;

/**
 * Pixels per world unit for the route arc, measured at the closest depth a
 * route vertex can occupy rather than at the globe centre. The front of the
 * anchor shell is within half a world unit of the camera at max zoom, so a
 * centre-depth approximation understates the magnification of a camera-facing
 * arc several-fold and would let it exceed the screen ceiling it was measured
 * against.
 */
export function routeArcPixelsPerWorldUnit({
  focalLengthPx,
  cameraDistance,
  anchorRadius,
  globeScale,
}: {
  focalLengthPx: number;
  cameraDistance: number;
  anchorRadius: number;
  globeScale: number;
}) {
  const nearestDepth = Math.max(
    MIN_ARC_DEPTH,
    cameraDistance - anchorRadius * globeScale,
  );
  return focalLengthPx / nearestDepth;
}

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

  const regionalLift = 1 - (1 - ARC_ATTENUATION_FLOOR) * smoothstep(
    ARC_ATTENUATION_START_ZOOM,
    ARC_ATTENUATION_END_ZOOM,
    zoom,
  );
  const geographicFlatten = 1 - smoothstep(
    ARC_ATTENUATION_END_ZOOM,
    ARC_GEOGRAPHIC_FLATTEN_END_ZOOM,
    zoom,
  );
  const semanticLift = regionalLift * geographicFlatten;

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
