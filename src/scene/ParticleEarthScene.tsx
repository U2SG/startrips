import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Euler,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { archiveRecords } from "../data/archiveRecords";
import type { GlobeMode } from "../experience/types";
import { getLightEffectPalette } from "../journey/lightEffects";
import {
  audioAtmosphereGains,
  readAudioAtmosphereEnergy,
} from "../motion/audioAtmosphere";
import {
  cityLabelFacingThreshold,
  loadCityTiers,
  resolveCityDisplayName,
  selectCityCandidates,
  type CityPoint,
} from "./cityLabels";
import type { PlaybackTravelChoreography } from "../journey/journeyPlayback";
import { compactMobileLayoutMarker } from "../journey/mobileLayout";
import type { JourneyRoute } from "../journey/types";
import {
  buildArtworkPointPositions,
  buildSeededSpherePoints,
  buildRouteArcLegSamples,
  buildRouteArcSamples,
  buildSphericalRingSegments,
  getSphericalRouteFocus,
  latLonToVector3,
  GEOGRAPHIC_SURFACE_RADIUS,
  ROUTE_ANCHOR_RADIUS,
  routeArcVertexCount,
  routePointAnchor,
  type RouteArcSamples,
  rotationXForLatitude,
  rotationYForLongitude,
  vector3ToLatLon,
} from "./geo";
import {
  resolveRouteArcLift,
  routeArcPixelsPerWorldUnit,
  ROUTE_ARC_HEIGHT_RATIO,
  ROUTE_ARC_SATURATION_ANGLE,
} from "./routeArcLift";
import {
  createAtmosphereMaterial,
  createParticleEarthMaterial,
  PARTICLE_ACTIVE_DIM_POINT_LIMIT,
  PARTICLE_DIM_POINT_LIMIT,
} from "./particleEarthMaterial";
import {
  CoastlineRefinementCache,
  buildRegionalCoastlinePositions,
  resolveCoastlineRefinementRegion,
} from "./coastlineSpatialLod";
import {
  PARTICLE_BASE_LAND_SOURCE,
  PARTICLE_REFINEMENT_CACHE_LIMIT,
  PARTICLE_REFINEMENT_LAND_SOURCE,
  ParticleRefinementBuildGuard,
  buildRegionalLandSample,
  resolveParticleRefinementLod,
  resolveParticleRefinementLodForFrame,
  resolveParticleRefinementRegion,
  shouldCancelPendingRefinementRequest,
  type ParticleRefinementRegion,
  type RegionalLandSample,
} from "./particleSpatialLod";
import { disposeSceneGraph, useThreeScene } from "./useThreeScene";
import {
  resolveGlobeSemanticZoom,
  resolveGlobeSemanticZoomForFrame,
  type GlobeSemanticZoom,
  type GlobeSemanticZoomState,
} from "./semanticZoom";
import { terrainReliefBumpScale, terrainReliefOpacity } from "./terrainRelief";

export const QUALITY_PROFILE = {
  low: { particleCount: 12_000, maxDpr: 1 },
  high: { particleCount: 28_000, maxDpr: Number.POSITIVE_INFINITY },
} as const;

export const MAX_RENDERED_JOURNEYS = 64;
export const MAX_RENDERED_ROUTE_POINTS = 512;
export const MAX_RENDERED_ROUTE_LINE_VERTICES = 8192;
export const MAX_RENDERED_ROUTE_LABELS = 6;
export const MAX_RENDERED_MOBILE_ROUTE_LABELS = 3;
export const CITY_LABEL_BUDGET = 72;
export const MAX_RENDERED_COASTLINE_VERTICES = 20_000;
export const COASTLINE_LOD_VERTEX_BUDGET = { far: 20_000, mid: 32_000, near: 52_000 } as const;
export type CoastlineLod = keyof typeof COASTLINE_LOD_VERTEX_BUDGET;
export const GLOBE_RENDER_ORDER = {
  relief: -1,
  particle: 0,
  coastline: 1,
  signal: 2,
  routeLine: 3,
  routePoint: 4,
  personalPoint: 5,
} as const;
export const GLOBE_DRAG_THRESHOLD_PX = 6;
// The globe is a real sphere: vertical dragging must be able to pass the
// former +/-35 degree clamp and turn it completely over.
export const GLOBE_TILT_LIMIT_RADIANS = Number.POSITIVE_INFINITY;
export const GLOBE_ZOOM_MIN = 0.72;
// #196: geographic annotations now project from the true surface, so zoom can
// no longer magnify a radial offset they never had into screen-space drift.
// The ceiling remains because decorative route lift and the glow still need
// near-plane headroom in front of the camera at z = 5.4.
export const GLOBE_ZOOM_MAX = 3.0;
export const GLOBE_SURFACE_RADIUS = GEOGRAPHIC_SURFACE_RADIUS;
/**
 * #196: the personal glow is a Points sprite drawn against the particle
 * surface it now shares a radius with, so it carries a render-only epsilon to
 * stay off the depth-fighting boundary. It is deliberately far too small to
 * move the projected anchor: the semantic position stays focusSignalAnchor.
 */
const PERSONAL_SIGNAL_RENDER_LIFT = 1 + 1e-4;
export const GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND = (Math.PI * 2) / 180;
export const GLOBE_IDLE_RESUME_DELAY_MS = 20_000;
export const GLOBE_IDLE_RELEASE_BLEND_MS = 2_400;
export const GLOBE_UPRIGHT_ROTATION_X = 0;
export const GLOBE_IDLE_ALIGNMENT_SPEED = (Math.PI * 15) / 180;

export const GLOBE_DRAG_MAPPING_MODE = "projected-surface-linear";
export const GLOBE_MAX_INERTIA_SCREEN_SPEED_PX_PER_SECOND = 640;
const GLOBE_INERTIA_FRICTION = 5.2;
const GLOBE_WHEEL_ZOOM_SPEED = 0.0012;
const JOURNEY_ROUTE_LINE_REFERENCE_SCALE = 1.15;
const JOURNEY_ROUTE_LINE_SCALE_MIN = 0.72;
const JOURNEY_ROUTE_LINE_SCALE_MAX = 2.4;
const JOURNEY_ROUTE_MARKER_SIZE_PX = 15;
const JOURNEY_ROUTE_MARKER_SCALE = JOURNEY_ROUTE_MARKER_SIZE_PX / (3.4 * 2);
const JOURNEY_POINT_TWINKLE_SLOWDOWN = 5;

export function collectJourneyDimDirections(
  routes: readonly JourneyRoute[],
  limit: number,
  temporalReveal?: { points: ReadonlyMap<string, number> },
) {
  if (limit <= 0 || routes.length === 0) return [] as Vector3[];
  const directions: Vector3[] = [];
  const directionIndexByLocation = new Map<string, number>();
  const maxPointCount = routes.reduce(
    (maximum, route) => Math.max(maximum, route.points.length),
    0,
  );
  // Round-robin by point index so one long journey cannot consume the whole
  // GPU uniform budget before the other lit journeys contribute a point.
  for (let pointIndex = 0; pointIndex < maxPointCount; pointIndex += 1) {
    for (const route of routes) {
      const point = route.points[pointIndex];
      if (!point) continue;
      const revealProgress = Math.min(
        1,
        Math.max(0, temporalReveal?.points.get(`${route.id}:${pointIndex}`) ?? 1),
      );
      if (revealProgress <= 0) continue;
      const key = `${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`;
      const existingIndex = directionIndexByLocation.get(key);
      if (existingIndex !== undefined) {
        if (directions[existingIndex].length() < revealProgress) {
          directions[existingIndex]
            .copy(latLonToVector3(point.lat, point.lon, 1).normalize())
            .multiplyScalar(revealProgress);
        }
        continue;
      }
      if (directions.length >= limit) continue;
      directionIndexByLocation.set(key, directions.length);
      directions.push(
        latLonToVector3(point.lat, point.lon, 1)
          .normalize()
          .multiplyScalar(revealProgress),
      );
    }
  }
  return directions;
}

export function clampGlobeTilt(rotation: number) {
  return rotation;
}

export function getShortestRotationDelta(current: number, target: number) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

export function nearestEquivalentRotation(current: number, target: number) {
  return current + getShortestRotationDelta(current, target);
}

export type GlobeFocusIntent = {
  revision: number;
  kind: "point" | "route";
  point: { lat: number; lon: number };
  zoom: number;
  route: JourneyRoute | null;
};

export function resolveGlobeFocusIntent(
  focusPoint: { lat: number; lon: number } | null | undefined,
  focusRoute: JourneyRoute | null | undefined,
  revision: number,
): GlobeFocusIntent | null {
  const routeFrame = getSphericalRouteFocus(focusRoute?.points ?? []);
  if (focusRoute && routeFrame) {
    return {
      revision,
      kind: "route",
      point: routeFrame.center,
      zoom: routeFrame.zoom,
      route: focusRoute,
    };
  }
  return focusPoint
    ? { revision, kind: "point", point: focusPoint, zoom: 1, route: null }
    : null;
}

export function isGlobeUpright(rotation: number, tolerance = 0.002) {
  return Math.abs(getShortestRotationDelta(rotation, GLOBE_UPRIGHT_ROTATION_X))
    <= tolerance;
}

export function advanceGlobeIdleReleasePhase(
  currentPhase: number,
  deltaSeconds: number,
  idleForMs: number,
  hasMomentum: boolean,
  motionDisabled: boolean,
) {
  if (
    motionDisabled
    || hasMomentum
    || idleForMs < GLOBE_IDLE_RESUME_DELAY_MS
  ) {
    return 0;
  }
  const boundedDelta = Math.min(0.05, Math.max(0, deltaSeconds));
  return Math.min(1, currentPhase + (boundedDelta * 1_000) / GLOBE_IDLE_RELEASE_BLEND_MS);
}

export function getGlobeIdleReleaseEase(releasePhase: number) {
  const t = Math.min(1, Math.max(0, releasePhase));
  return t * t * (3 - 2 * t);
}

export function getGlobeIdleAlignmentRotation(
  rotation: number,
  deltaSeconds: number,
  idleForMs: number,
  hasMomentum: boolean,
  motionDisabled: boolean,
  releasePhase = 1,
) {
  if (
    motionDisabled
    || hasMomentum
    || idleForMs < GLOBE_IDLE_RESUME_DELAY_MS
  ) {
    return rotation;
  }
  const remaining = getShortestRotationDelta(rotation, GLOBE_UPRIGHT_ROTATION_X);
  if (Math.abs(remaining) <= 0.0005) return GLOBE_UPRIGHT_ROTATION_X;
  const ease = getGlobeIdleReleaseEase(releasePhase);
  const responseSpeed = Math.abs(remaining) * 1.6;
  const angularSpeed = Math.min(GLOBE_IDLE_ALIGNMENT_SPEED, responseSpeed) * ease;
  const maxStep = angularSpeed * Math.min(0.05, Math.max(0, deltaSeconds));
  if (Math.abs(remaining) <= maxStep) return GLOBE_UPRIGHT_ROTATION_X;
  return rotation + Math.sign(remaining) * maxStep;
}

export function isGlobeDrag(distance: number) {
  return distance >= GLOBE_DRAG_THRESHOLD_PX;
}

export function isPrimaryPointerActivation(
  event: Pick<PointerEvent, "button" | "isPrimary" | "pointerType">,
) {
  return event.isPrimary
    && (event.pointerType !== "mouse" || event.button === 0);
}

export function clampGlobeZoom(zoom: number) {
  return Math.max(GLOBE_ZOOM_MIN, Math.min(GLOBE_ZOOM_MAX, zoom));
}

export function coastlineLodWeights(zoom: number): Record<CoastlineLod, number> {
  return resolveGlobeSemanticZoom({ zoom }).coastlineWeights;
}

export function activeCoastlineLod(zoom: number): CoastlineLod {
  return resolveGlobeSemanticZoom({ zoom }).coastlineLod;
}

export function getProjectedGlobeRadiusPx(
  viewportHeight: number,
  verticalFovRadians: number,
  cameraDistance: number,
  worldRadius: number,
) {
  const focalLengthPx = viewportHeight / (2 * Math.tan(verticalFovRadians / 2));
  const silhouetteDistance = Math.sqrt(Math.max(
    0.000001,
    cameraDistance * cameraDistance - worldRadius * worldRadius,
  ));
  return focalLengthPx * worldRadius / silhouetteDistance;
}

export function getProjectedSurfaceInteractionRadiusPx(
  viewportHeight: number,
  verticalFovRadians: number,
  cameraDistance: number,
  worldRadius: number,
) {
  const focalLengthPx = viewportHeight / (2 * Math.tan(verticalFovRadians / 2));
  // The inspected geography is on the near/front surface. Its screen motion
  // per radian grows faster than the center-plane silhouette as zoom brings
  // that surface toward the camera.
  return focalLengthPx * worldRadius / Math.max(0.25, cameraDistance - worldRadius);
}

type ScreenPoint = { x: number; y: number };

export function projectedRadiusRotationDelta(
  previous: ScreenPoint,
  current: ScreenPoint,
  radius: number,
) {
  const safeRadius = Math.max(1, radius);
  const rotationX = (current.y - previous.y) / safeRadius;
  const rotationY = (current.x - previous.x) / safeRadius;
  return {
    rotationX,
    rotationY,
    angularDelta: Math.hypot(rotationX, rotationY),
  };
}

export function getGlobeInertiaSpeedLimit(interactionRadiusPx: number) {
  return GLOBE_MAX_INERTIA_SCREEN_SPEED_PX_PER_SECOND
    / Math.max(1, interactionRadiusPx);
}

export function shouldRetainGlobeInertia(
  lastSampleAt: number,
  releaseAt: number,
  angularDelta: number,
) {
  return releaseAt - lastSampleAt <= 80 && angularDelta >= 0.0002;
}

export function isReliablePinchAnchor(
  point: ScreenPoint,
  globeCenter: ScreenPoint,
  projectedGlobeRadiusPx: number,
) {
  return Number.isFinite(projectedGlobeRadiusPx)
    && projectedGlobeRadiusPx > 0
    && Math.hypot(point.x - globeCenter.x, point.y - globeCenter.y)
      <= projectedGlobeRadiusPx * 0.98;
}

export function canTrackGlobePointer(activePointerCount: number) {
  return activePointerCount < 2;
}

export function shouldSuppressUntrackedPointerActivation(
  rejectedByGestureCapacity: boolean,
  activePointerCount: number,
) {
  return rejectedByGestureCapacity || activePointerCount > 0;
}

export function shouldRememberUntrackedPointerStart(activePointerCount: number) {
  return activePointerCount > 0;
}

export function rebaseGlobeDragSample(
  pointerId: number,
  pointer: ScreenPoint,
  timeStamp: number,
  alreadyConsumed: boolean,
) {
  return {
    pointerId,
    lastX: pointer.x,
    lastY: pointer.y,
    lastTime: timeStamp,
    travel: alreadyConsumed ? GLOBE_DRAG_THRESHOLD_PX : 0,
    started: alreadyConsumed,
  };
}

export function shouldFocusRevisionOwnState(
  manualFocusRevision: number | null,
  incomingFocusRevision: number,
) {
  return manualFocusRevision === null || incomingFocusRevision > manualFocusRevision;
}

export function shouldApplyFocusIntentRevision(
  activeRevision: number,
  incomingRevision: number,
) {
  return incomingRevision > activeRevision;
}

export function solveScreenAnchorRotation(
  seedRotationX: number,
  seedRotationY: number,
  target: ScreenPoint,
  project: (rotationX: number, rotationY: number) => ScreenPoint,
) {
  let rotationX = seedRotationX;
  let rotationY = seedRotationY;
  const epsilon = 0.0025;
  const tolerancePx = 0.5;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const projected = project(rotationX, rotationY);
    const projectedX = projected.x;
    const projectedY = projected.y;
    const errorX = target.x - projectedX;
    const errorY = target.y - projectedY;
    const errorPx = Math.hypot(errorX, errorY);
    if (errorPx <= tolerancePx) {
      return { x: rotationX, y: rotationY, errorPx, converged: true };
    }
    const deltaX = project(rotationX + epsilon, rotationY);
    const deltaXX = deltaX.x;
    const deltaXY = deltaX.y;
    const deltaY = project(rotationX, rotationY + epsilon);
    const j00 = (deltaXX - projectedX) / epsilon;
    const j10 = (deltaXY - projectedY) / epsilon;
    const j01 = (deltaY.x - projectedX) / epsilon;
    const j11 = (deltaY.y - projectedY) / epsilon;
    const determinant = j00 * j11 - j01 * j10;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.0001) break;
    const stepX = (errorX * j11 - j01 * errorY) / determinant;
    const stepY = (j00 * errorY - errorX * j10) / determinant;
    rotationX += Math.max(-0.35, Math.min(0.35, stepX));
    rotationY += Math.max(-0.35, Math.min(0.35, stepY));
  }
  const projected = project(rotationX, rotationY);
  const errorPx = Math.hypot(target.x - projected.x, target.y - projected.y);
  return {
    x: rotationX,
    y: rotationY,
    errorPx,
    converged: Number.isFinite(errorPx) && errorPx <= tolerancePx,
  };
}

export function getJourneyRouteLineScale(globeScale: number) {
  return Math.max(
    JOURNEY_ROUTE_LINE_SCALE_MIN,
    Math.min(
      JOURNEY_ROUTE_LINE_SCALE_MAX,
      globeScale / JOURNEY_ROUTE_LINE_REFERENCE_SCALE,
    ),
  );
}

export function getGlobeIdleRotationDelta(
  deltaSeconds: number,
  idleForMs: number,
  hasMomentum: boolean,
  motionDisabled: boolean,
  _alignmentComplete = true,
  releasePhase = 1,
) {
  if (
    motionDisabled
    || hasMomentum
    || idleForMs < GLOBE_IDLE_RESUME_DELAY_MS
  ) {
    return 0;
  }
  const boundedDelta = Math.min(0.05, Math.max(0, deltaSeconds));
  const elapsedDelta = Math.min(0.25, Math.max(0, deltaSeconds));
  const ease = getGlobeIdleReleaseEase(releasePhase);
  const blendedDelta = boundedDelta + (elapsedDelta - boundedDelta) * ease;
  return blendedDelta
    * GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND
    * ease;
}

export function isFocusFlightActive(
  pointFocusSettling: boolean,
  routeFocusSettling: boolean,
) {
  return pointFocusSettling || routeFocusSettling;
}

export function isIdleRotationSuppressed(
  dragToRotate: boolean,
  pointFocusSettling: boolean,
  routeFocusSettling: boolean,
) {
  // Programmatic focus is a one-shot flight, not a permanent camera lock.
  // Pause idle rotation only while that flight is actively settling; once the
  // destination arrives, normal self-rotation owns the globe again.
  return !dragToRotate || isFocusFlightActive(pointFocusSettling, routeFocusSettling);
}

export function selectRenderableJourneyRoutes(
  routes: readonly JourneyRoute[],
): JourneyRoute[] {
  const candidates = routes.slice(-MAX_RENDERED_JOURNEYS);
  const selected: JourneyRoute[] = [];
  let pointCount = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const route = candidates[index];
    if (pointCount + route.points.length > MAX_RENDERED_ROUTE_POINTS) continue;
    selected.push(route);
    pointCount += route.points.length;
  }
  return selected.reverse();
}

export function getJourneyRouteVisualState(
  routeId: string,
  activeRouteId?: string | null,
) {
  if (!activeRouteId) return "is-idle";
  return routeId === activeRouteId ? "is-active" : "is-muted";
}

export type RouteFocusPhase = "idle" | "flying" | "settled" | "releasing";

export function getRouteFocusPhase(
  hasRouteFocus: boolean,
  routeFocusSettling: boolean,
  routeFocusZoomResetting: boolean,
): RouteFocusPhase {
  if (hasRouteFocus) return routeFocusSettling ? "flying" : "settled";
  return routeFocusZoomResetting ? "releasing" : "idle";
}

export function isProjectedPointInsideViewport(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return Number.isFinite(x)
    && Number.isFinite(y)
    && width > 0
    && height > 0
    && x >= 0
    && x <= width
    && y >= 0
    && y <= height;
}

export function isLocalPointInsideClipViewport(
  matrixElements: readonly number[],
  x: number,
  y: number,
  z: number,
): boolean {
  if (matrixElements.length < 16) return false;
  const clipX = matrixElements[0] * x
    + matrixElements[4] * y
    + matrixElements[8] * z
    + matrixElements[12];
  const clipY = matrixElements[1] * x
    + matrixElements[5] * y
    + matrixElements[9] * z
    + matrixElements[13];
  const clipZ = matrixElements[2] * x
    + matrixElements[6] * y
    + matrixElements[10] * z
    + matrixElements[14];
  const clipW = matrixElements[3] * x
    + matrixElements[7] * y
    + matrixElements[11] * z
    + matrixElements[15];
  return Number.isFinite(clipX)
    && Number.isFinite(clipY)
    && Number.isFinite(clipZ)
    && Number.isFinite(clipW)
    && clipW > 0
    && clipX >= -clipW
    && clipX <= clipW
    && clipY >= -clipW
    && clipY <= clipW
    && clipZ >= -clipW
    && clipZ <= clipW;
}

export type RouteLabelSafeArea = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type RouteLabelSafeAreaInput = {
  /** Host size in CSS pixels. */
  host: { width: number; height: number };
  /** Atlas header bottom edge, host-relative, or null when there is no header. */
  headerBottom: number | null;
  /** Active journey card bounds, host-relative, or null when no card is on screen. */
  card: { left: number; top: number; right: number; bottom: number } | null;
  /**
   * #194: the product interaction mode is decided once, by the React owner, and
   * handed down. The scene never re-derives it from `window.innerWidth`, so a
   * coarse-pointer landscape phone wider than 760px still lays out as compact.
   */
  compactMobileLayout: boolean;
};

export function resolveRouteLabelSafeArea({
  host,
  headerBottom,
  card,
  compactMobileLayout,
}: RouteLabelSafeAreaInput): RouteLabelSafeArea {
  const safeArea: RouteLabelSafeArea = {
    left: 16,
    top: headerBottom !== null
      ? Math.max(16, headerBottom + 10)
      : compactMobileLayout ? 62 : 74,
    right: host.width - 16,
    bottom: host.height - 18,
  };
  if (!card) return safeArea;
  const overlapsHorizontally = card.left < host.width && card.right > 0;
  const overlapsVertically = card.top < host.height && card.bottom > 0;
  if (!overlapsHorizontally || !overlapsVertically) return safeArea;
  if (compactMobileLayout && card.top > 0) {
    safeArea.bottom = Math.min(safeArea.bottom, card.top - 16);
  } else if (!compactMobileLayout && card.left > 0) {
    safeArea.right = Math.min(safeArea.right, card.left - 18);
  }
  return safeArea;
}

export function resolveRouteLabelLimit(compactMobileLayout: boolean) {
  return compactMobileLayout
    ? MAX_RENDERED_MOBILE_ROUTE_LABELS
    : MAX_RENDERED_ROUTE_LABELS;
}

export function selectRouteLabelPointIndexes(
  points: readonly { isStop: boolean; label?: string }[],
  maxLabels = MAX_RENDERED_ROUTE_LABELS,
) {
  if (maxLabels <= 0) return [];
  const candidates = points.flatMap((point, index) => (
    point.label?.trim() && (point.isStop || points.length === 1) ? [index] : []
  ));
  if (candidates.length <= maxLabels) return candidates;
  if (maxLabels === 1) return [candidates[0]];
  return Array.from({ length: maxLabels }, (_, slot) => (
    candidates[Math.round(slot * (candidates.length - 1) / (maxLabels - 1))]
  ));
}

type ProjectedRoutePoint = { x: number; y: number };

export function isSphericalPointVisible(
  camera: Vector3,
  point: Vector3,
  occluderRadius = GLOBE_SURFACE_RADIUS,
) {
  const directionX = point.x - camera.x;
  const directionY = point.y - camera.y;
  const directionZ = point.z - camera.z;
  const directionLengthSquared =
    directionX * directionX
    + directionY * directionY
    + directionZ * directionZ;
  if (directionLengthSquared === 0) return true;
  const closestProgress = -(
    camera.x * directionX
    + camera.y * directionY
    + camera.z * directionZ
  ) / directionLengthSquared;
  if (closestProgress <= 0 || closestProgress >= 1) return true;
  const closestX = camera.x + directionX * closestProgress;
  const closestY = camera.y + directionY * closestProgress;
  const closestZ = camera.z + directionZ * closestProgress;
  return (
    closestX * closestX
    + closestY * closestY
    + closestZ * closestZ
  ) >= occluderRadius * occluderRadius;
}

export type ProjectedRoutePath = {
  d: string;
  /** Projected first Route Point anchor, when the path reaches it unclipped. */
  start: ProjectedRoutePoint | null;
  /** Projected last Route Point anchor, when the path reaches it unclipped. */
  end: ProjectedRoutePoint | null;
};

// #196 review: the probe walk below is a bisection, so the smallest visible
// fraction of a segment it can still resolve is 2^-ITERATIONS. Eight steps
// dropped a straddling segment whose visible part was under ~0.4% of its
// length; twelve costs at most four extra projections on the few segments
// that actually cross the horizon and makes that residue ~0.02%.
const HORIZON_CLIP_ITERATIONS = 12;

/**
 * #193: route geometry is stored as unit directions plus a per-vertex lift, so
 * the world position of a vertex is resolved here with the frame's current
 * lift strength. Endpoints carry lift 0 and therefore project onto the exact
 * Route Point anchor the marker uses.
 *
 * A segment with one endpoint behind the horizon is clipped at the crossing
 * instead of being dropped whole, so a visible Route Point is never left with
 * its route torn off tens of pixels away; the line tapers into the anchor and
 * both disappear together.
 */
export function buildProjectedRoutePath(
  samples: RouteArcSamples,
  projectPoint: (
    x: number,
    y: number,
    z: number,
    target: ProjectedRoutePoint,
  ) => boolean,
  world: { radius: number; liftScale: number },
): ProjectedRoutePath {
  const { directions, lifts } = samples;
  const start = { x: 0, y: 0 };
  const end = { x: 0, y: 0 };
  const probe = { x: 0, y: 0 };
  const crossing = { x: 0, y: 0 };
  const commands: string[] = [];
  let previousEndX = Number.NaN;
  let previousEndY = Number.NaN;
  let pathStart: ProjectedRoutePoint | null = null;
  let pathEnd: ProjectedRoutePoint | null = null;

  const moveTo = (point: ProjectedRoutePoint) => {
    if (
      !Number.isFinite(previousEndX)
      || Math.abs(previousEndX - point.x) > 0.11
      || Math.abs(previousEndY - point.y) > 0.11
    ) {
      commands.push(`M${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
    }
  };
  const lineTo = (point: ProjectedRoutePoint) => {
    commands.push(`L${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
  };

  const vertexCount = lifts.length;
  for (let vertex = 0; vertex + 1 < vertexCount; vertex += 2) {
    const startRadius = world.radius * (1 + lifts[vertex] * world.liftScale);
    const endRadius = world.radius * (1 + lifts[vertex + 1] * world.liftScale);
    const startOffset = vertex * 3;
    const endOffset = startOffset + 3;
    const startWorldX = directions[startOffset] * startRadius;
    const startWorldY = directions[startOffset + 1] * startRadius;
    const startWorldZ = directions[startOffset + 2] * startRadius;
    const endWorldX = directions[endOffset] * endRadius;
    const endWorldY = directions[endOffset + 1] * endRadius;
    const endWorldZ = directions[endOffset + 2] * endRadius;

    const startVisible = projectPoint(startWorldX, startWorldY, startWorldZ, start);
    const endVisible = projectPoint(endWorldX, endWorldY, endWorldZ, end);

    if (startVisible && vertex === 0) pathStart = { x: start.x, y: start.y };
    if (endVisible && vertex + 2 >= vertexCount) pathEnd = { x: end.x, y: end.y };

    if (startVisible && endVisible) {
      moveTo(start);
      lineTo(end);
      previousEndX = end.x;
      previousEndY = end.y;
      continue;
    }

    // One end is behind the horizon (or past a clip plane): walk the arc to
    // the crossing so the visible side still reaches its Route Point anchor.
    //
    // #196 review: the probe follows the SPHERICAL path, not the straight
    // chord between the two vertices. Now that a zero-lift Route Point sits on
    // the occluding surface itself rather than on a shell above it, every
    // interior point of that chord is a secant and dips below the occluder, so
    // a chord probe reported the crossing up to ~5 degrees PAST the true limb
    // and drew the line into the globe's own silhouette. Renormalising the
    // interpolated direction keeps each probe on the arc the route actually
    // occupies, which is where the visible portion ends.
    let crossingFound = false;
    if (startVisible !== endVisible) {
      let low = 0;
      let high = 1;
      for (let step = 0; step < HORIZON_CLIP_ITERATIONS; step += 1) {
        const middle = (low + high) / 2;
        const progress = startVisible ? middle : 1 - middle;
        const probeDirectionX =
          directions[startOffset] + (directions[endOffset] - directions[startOffset]) * progress;
        const probeDirectionY =
          directions[startOffset + 1]
          + (directions[endOffset + 1] - directions[startOffset + 1]) * progress;
        const probeDirectionZ =
          directions[startOffset + 2]
          + (directions[endOffset + 2] - directions[startOffset + 2]) * progress;
        const probeDirectionLength = Math.hypot(
          probeDirectionX,
          probeDirectionY,
          probeDirectionZ,
        );
        // Both directions are unit vectors a fraction of a degree apart, so
        // their interpolation is never near zero length and needs no guard.
        const probeRadius =
          (startRadius + (endRadius - startRadius) * progress) / probeDirectionLength;
        const visible = projectPoint(
          probeDirectionX * probeRadius,
          probeDirectionY * probeRadius,
          probeDirectionZ * probeRadius,
          probe,
        );
        if (visible) {
          crossingFound = true;
          crossing.x = probe.x;
          crossing.y = probe.y;
          low = middle;
        } else {
          high = middle;
        }
      }
    }

    if (crossingFound && startVisible) {
      moveTo(start);
      lineTo(crossing);
    } else if (crossingFound) {
      previousEndX = Number.NaN;
      previousEndY = Number.NaN;
      moveTo(crossing);
      lineTo(end);
      previousEndX = end.x;
      previousEndY = end.y;
      continue;
    }

    previousEndX = Number.NaN;
    previousEndY = Number.NaN;
  }

  return { d: commands.join(""), start: pathStart, end: pathEnd };
}

export type JourneyConnectorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type FocusViewportChrome = {
  left?: JourneyConnectorRect | null;
  right?: JourneyConnectorRect | null;
  top?: JourneyConnectorRect | null;
  bottom?: JourneyConnectorRect | null;
};

export function focusViewportCenter(
  scene: { width: number; height: number },
  chrome: FocusViewportChrome = {},
) {
  const left = Math.min(scene.width, Math.max(0, chrome.left?.right ?? 0));
  const right = Math.max(left, Math.min(scene.width, chrome.right?.left ?? scene.width));
  const top = Math.min(scene.height, Math.max(0, chrome.top?.bottom ?? 0));
  const bottom = Math.max(top, Math.min(scene.height, chrome.bottom?.top ?? scene.height));
  return {
    x: left + (right - left) / 2,
    y: top + (bottom - top) / 2,
  };
}

// #219: the focus signal marks a selected Route Point, so it occupies the one
// canonical Route Point anchor instead of a radius of its own. Sharing the
// anchor is what makes the signal, the journey connector that terminates on it
// and the Route Point marker resolve to the same screen pixel at every zoom.
export function focusSignalAnchor(
  point: { lat: number; lon: number } | null | undefined,
  fallback: { lat: number; lon: number },
) {
  return routePointAnchor(point?.lat ?? fallback.lat, point?.lon ?? fallback.lon);
}

// The active journey card is docked to the right on wide layouts and becomes a
// bottom sheet on compact ones, so the connector leaves from a different edge.
export function journeyConnectorAnchor(
  card: JourneyConnectorRect,
  compact: boolean,
) {
  return compact
    ? { x: (card.left + card.right) / 2, y: card.top }
    : { x: card.left, y: (card.top + card.bottom) / 2 };
}

function connectorCoordinate(value: number) {
  return Number(value.toFixed(1));
}

export function buildJourneyConnectorPath(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  compact: boolean,
) {
  const anchorX = connectorCoordinate(anchor.x);
  const anchorY = connectorCoordinate(anchor.y);
  const pointX = connectorCoordinate(point.x);
  const pointY = connectorCoordinate(point.y);
  // Too little room for an elbow reads as a kink, so stay straight instead.
  if (Math.abs(pointX - anchorX) < 14 || Math.abs(pointY - anchorY) < 14) {
    return `M${anchorX} ${anchorY}L${pointX} ${pointY}`;
  }
  if (compact) {
    const bendY = connectorCoordinate(anchor.y + (point.y - anchor.y) * 0.45);
    return `M${anchorX} ${anchorY}V${bendY}H${pointX}V${pointY}`;
  }
  const bendX = connectorCoordinate(anchor.x + (point.x - anchor.x) * 0.45);
  return `M${anchorX} ${anchorY}H${bendX}V${pointY}H${pointX}`;
}

// Returns an empty path whenever the line cannot truthfully connect the card to
// the geographic point, so the scene never shows a decorative stub.
export function buildJourneyConnector({
  card,
  point,
  scene,
  compact,
  padding = 8,
}: {
  card: JourneyConnectorRect | null;
  point: { x: number; y: number } | null;
  scene: { width: number; height: number };
  compact: boolean;
  padding?: number;
}) {
  if (!card || !point) return "";
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return "";
  if (
    point.x < 0
    || point.y < 0
    || point.x > scene.width
    || point.y > scene.height
  ) {
    return "";
  }
  if (
    point.x >= card.left - padding
    && point.x <= card.right + padding
    && point.y >= card.top - padding
    && point.y <= card.bottom + padding
  ) {
    return "";
  }
  return buildJourneyConnectorPath(
    journeyConnectorAnchor(card, compact),
    point,
    compact,
  );
}

type ProjectedRouteLabelBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function routeLabelBoxesOverlap(
  left: ProjectedRouteLabelBox,
  right: ProjectedRouteLabelBox,
  padding = 8,
) {
  return !(
    left.right + padding < right.left
    || right.right + padding < left.left
    || left.bottom + padding < right.top
    || right.bottom + padding < left.top
  );
}

function routeLabelCharacterWidth(character: string) {
  return /^[\x20-\x7e]$/.test(character) ? 6.5 : 11.5;
}

function buildRoutePointStarPoints(
  centerX: number,
  centerY: number,
  outerRadius = 2.8,
  innerRadius = 1.18,
) {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI / 5);
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    return `${(centerX + Math.cos(angle) * radius).toFixed(2)},${(centerY + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ");
}

function buildRoutePointFlagPath(
  centerX: number,
  centerY: number,
  scale = 1,
) {
  const point = (x: number, y: number) =>
    `${(centerX + x * scale).toFixed(2)} ${(centerY + y * scale).toFixed(2)}`;
  return [
    `M ${point(-0.55, 3.35)}`,
    `L ${point(0.45, 3.35)}`,
    `L ${point(0.45, -2.75)}`,
    `C ${point(1.55, -3.35)} ${point(2.65, -3.05)} ${point(3.45, -2.2)}`,
    `C ${point(2.65, -1.25)} ${point(1.55, -0.75)} ${point(0.45, -1.25)}`,
    `L ${point(0.45, 3.35)}`,
    `L ${point(-0.55, 3.35)}`,
    "Z",
  ].join(" ");
}

/** Approximate rendered width of a city label (8px font, letter-spacing). */
function estimateCityLabelWidth(label: string) {
  let width = 0;
  for (const character of label.trim()) {
    width += /^[\x20-\x7e]$/.test(character) ? 5.2 : 9;
  }
  return Math.max(10, width);
}

function formatRouteLabel(label: string) {
  let width = 0;
  let result = "";
  for (const character of label.trim()) {
    const nextWidth = routeLabelCharacterWidth(character) + (result ? 0.9 : 0);
    if (width + nextWidth > 172) return `${result}…`;
    result += character;
    width += nextWidth;
  }
  return result;
}

function estimateRouteLabelWidth(label: string) {
  const width = [...label].reduce((total, character, index) => (
    total + routeLabelCharacterWidth(character) + (index > 0 ? 0.9 : 0)
  ), 0);
  return Math.min(184, Math.max(42, width));
}

export const GLOBE_MODE_CONFIG: Record<
  GlobeMode,
  {
    x: number;
    y: number;
    scale: number;
    burst: number;
    particleOpacity: number;
    shellOpacity: number;
    haloOpacity: number;
    surfaceOpacity: number;
    signalOpacity: number;
    clusterOpacity: number;
    personalOpacity: number;
    rotationY: number;
    wireOpacity: number;
    coastlineOpacity: number;
  }
> = {
  particleSphere: {
    x: 0.05,
    y: 0.04,
    scale: 0.93,
    burst: 0,
    particleOpacity: 0.12,
    shellOpacity: 1,
    haloOpacity: 0.55,
    surfaceOpacity: 0,
    signalOpacity: 0.8,
    clusterOpacity: 0,
    personalOpacity: 0.72,
    rotationY: 0,
    wireOpacity: 0.025,
    coastlineOpacity: 0.12,
  },
  archiveBurst: {
    x: 0.25,
    y: 0.02,
    scale: 0.98,
    burst: 0.15,
    particleOpacity: 0.66,
    shellOpacity: 0.18,
    haloOpacity: 0.03,
    surfaceOpacity: 0,
    signalOpacity: 1,
    clusterOpacity: 0.16,
    personalOpacity: 1,
    rotationY: -1.92,
    wireOpacity: 0.022,
    coastlineOpacity: 0.18,
  },
  surfaceEarth: {
    x: 0.12,
    y: -0.12,
    scale: 1.15,
    burst: 0,
    particleOpacity: 0.025,
    shellOpacity: 0.005,
    haloOpacity: 0,
    surfaceOpacity: 1,
    signalOpacity: 0.16,
    clusterOpacity: 0,
    personalOpacity: 0,
    rotationY: -1.92,
    wireOpacity: 0,
    coastlineOpacity: 0.42,
  },
  focusPoint: {
    x: 0.7,
    y: -0.23,
    scale: 1.15,
    burst: 0,
    particleOpacity: 0.62,
    shellOpacity: 0.18,
    haloOpacity: 0.05,
    surfaceOpacity: 0.22,
    signalOpacity: 0.72,
    clusterOpacity: 0,
    personalOpacity: 1,
    rotationY: -1.57,
    wireOpacity: 0.018,
    coastlineOpacity: 0.3,
  },
};

interface ParticleEarthSceneProps {
  mode: GlobeMode;
  quality?: keyof typeof QUALITY_PROFILE;
  focusPoint?: { lat: number; lon: number } | null;
  focusRoute?: JourneyRoute | null;
  focusRevision?: number;
  focusFlightProfile?: PlaybackTravelChoreography;
  focusColor?: string;
  centerFocusPoint?: boolean;
  onFocusPointActivate?: () => void;
  journeyRoutes?: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  onJourneyRouteActivate?: (id: string) => void;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  // #21: per-journey temporal reveal progress (0 = future, 1 = visited).
  // When provided, route groups and points fade in with the time cursor.
  // Points are keyed by `${journeyId}:${pointIndex}` for one-stop-at-a-time
  // reveal (review P2: a whole-route fade was not the #21 experience).
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  };
  showArchiveSignals?: boolean;
  onReady?: () => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  dragToRotate?: boolean;
  wheelToZoom?: boolean;
  reduceMotion?: boolean;
  rotationYOverride?: number;
  /**
   * #194: the one product-level compact/mobile decision, made by the React
   * owner from `useCompactMobileLayout()`. The scene must not infer it.
   */
  compactMobileLayout?: boolean;
}

interface LandGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

interface LandFeatureCollection {
  features: Array<{ geometry: LandGeometry | null }>;
}

interface ParticleLandMask {
  mask: Uint8ClampedArray;
  rings: number[][][];
  width: number;
  height: number;
  vectorScale: string;
}

interface ParticleRefinementLayer {
  cacheKey: string;
  region: ParticleRefinementRegion;
  particleCap: number;
  sampleCount: number;
  geometry: BufferGeometry;
  material: ReturnType<typeof createParticleEarthMaterial>;
  points: Points;
}

export function createRetryableParticleResourceLoader<T>(
  load: () => Promise<T | null>,
  {
    retryDelayMs = 5_000,
    now = Date.now,
  }: {
    retryDelayMs?: number;
    now?: () => number;
  } = {},
): () => Promise<T | null> {
  let current: Promise<T | null> | null = null;
  let retryAt: number | null = null;
  return () => {
    if (current && retryAt !== null && now() >= retryAt) {
      current = null;
      retryAt = null;
    }
    if (current) return current;
    const request: Promise<T | null> = Promise.resolve()
      .then(load)
      .catch(() => null)
      .then((value) => {
        if (value === null && current === request) {
          retryAt = now() + retryDelayMs;
        }
        return value;
      });
    current = request;
    return request;
  };
}

export function releaseFailedParticleRefinementRequest({
  requestedCacheKey,
  failedCacheKey,
  requestIsCurrent,
}: {
  requestedCacheKey: string | null;
  failedCacheKey: string;
  requestIsCurrent: boolean;
}) {
  return requestIsCurrent && requestedCacheKey === failedCacheKey
    ? null
    : requestedCacheKey;
}

function unwrapRing(ring: number[][], width: number) {
  const points: Array<[number, number]> = [];
  let previousX: number | null = null;
  let offset = 0;

  ring.forEach(([lon, lat]) => {
    let x = ((lon + 180) / 360) * width + offset;
    if (previousX !== null && x - previousX > width / 2) {
      offset -= width;
      x -= width;
    } else if (previousX !== null && previousX - x > width / 2) {
      offset += width;
      x += width;
    }
    points.push([x, ((90 - lat) / 180) * (width / 2)]);
    previousX = x;
  });

  return points;
}

function drawPolygonMask(
  context: CanvasRenderingContext2D,
  polygon: number[][][],
  width: number,
) {
  for (const shift of [-width, 0, width]) {
    context.beginPath();
    polygon.forEach((ring) => {
      const points = unwrapRing(ring, width);
      points.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(x + shift, y);
        else context.lineTo(x + shift, y);
      });
      context.closePath();
    });
    context.fill("evenodd");
  }
}

async function buildParticleLandMask(source: {
  path: string;
  vectorScale: string;
  maskWidth: number;
  maskHeight: number;
}, retainRings = true) {
  const { maskWidth: width, maskHeight: height, path, vectorScale } = source;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  const response = await fetch(path);
  if (!response.ok) return null;
  const collection = (await response.json()) as LandFeatureCollection;
  const rings: number[][][] = [];
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fff";

  collection.features.forEach(({ geometry }) => {
    if (!geometry) return;
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates as number[][][]]
        : (geometry.coordinates as number[][][][]);
    polygons.forEach((polygon) => {
      drawPolygonMask(context, polygon, width);
      if (retainRings) rings.push(...polygon);
    });
  });
  return {
    mask: context.getImageData(0, 0, width, height).data,
    rings,
    width,
    height,
    vectorScale,
  };
}

const loadParticleLandMask = createRetryableParticleResourceLoader(
  () => buildParticleLandMask(PARTICLE_BASE_LAND_SOURCE),
);

const loadParticleRefinementLandMask = createRetryableParticleResourceLoader(
  () => buildParticleLandMask(PARTICLE_REFINEMENT_LAND_SOURCE, false),
);

function isParticleLand(source: ParticleLandMask, lat: number, lon: number) {
  const longitudeUnit = (((lon + 180) % 360) + 360) % 360 / 360;
  const x = Math.min(source.width - 1, Math.floor(longitudeUnit * source.width));
  const y = Math.min(
    source.height - 1,
    Math.max(0, Math.floor(((90 - lat) / 180) * source.height)),
  );
  return source.mask[(y * source.width + x) * 4 + 3] >= 128;
}

async function buildLandVisualData(count: number) {
  const source = await loadParticleLandMask();
  if (!source) {
    return {
      particlePositions: buildSeededSpherePoints(count, 1908),
      coastlinePositions: new Float32Array(),
      detailedCoastlinePositions: { mid: new Float32Array(), near: new Float32Array() },
      landSourceAvailable: false,
    };
  }

  const points = new Float32Array(count * 3);
  let accepted = 0;

  for (let attempt = 1; accepted < count && attempt < count * 80; attempt += 1) {
    const longitudeUnit = (attempt * 0.7548776662466927 + 0.1387) % 1;
    const latitudeUnit = (attempt * 0.5698402909980532 + 0.4173) % 1;
    const lon = longitudeUnit * 360 - 180;
    const sphereY = latitudeUnit * 2 - 1;
    const lat = (Math.asin(sphereY) * 180) / Math.PI;
    if (!isParticleLand(source, lat, lon)) continue;
    latLonToVector3(lat, lon, 1.39).toArray(points, accepted * 3);
    accepted += 1;
  }

  if (accepted < count) {
    const fallback = buildSeededSpherePoints(count - accepted, 7201);
    for (let index = 0; index < fallback.length; index += 1) {
      points[accepted * 3 + index] = fallback[index] * 1.39;
    }
  }

  return {
    particlePositions: points,
    coastlinePositions: buildSphericalRingSegments(
      source.rings,
      1.405,
      MAX_RENDERED_COASTLINE_VERTICES,
    ),
    detailedCoastlinePositions: {
      mid: buildSphericalRingSegments(source.rings, 1.405, COASTLINE_LOD_VERTEX_BUDGET.mid),
      near: buildSphericalRingSegments(source.rings, 1.405, COASTLINE_LOD_VERTEX_BUDGET.near),
    },
    landSourceAvailable: true,
  };
}

async function loadDetailedCoastlineData() {
  try {
    const response = await fetch("/earth/ne_50m_land.geojson");
    if (!response.ok) return null;
    const collection = (await response.json()) as LandFeatureCollection;
    const rings: number[][][] = [];
    collection.features.forEach(({ geometry }) => {
      if (!geometry) return;
      const polygons = geometry.type === "Polygon"
        ? [geometry.coordinates as number[][][]]
        : (geometry.coordinates as number[][][][]);
      polygons.forEach((polygon) => rings.push(...polygon));
    });
    return {
      rings,
      mid: buildSphericalRingSegments(rings, 1.405, COASTLINE_LOD_VERTEX_BUDGET.mid),
    };
  } catch {
    return null;
  }
}

function createBurstTargets(source: Float32Array) {
  const targets = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const pointIndex = index / 3;
    const spread = 1.02 + ((pointIndex * 16807) % 997) / 997 * 0.28;
    const verticalDrift = Math.sin(pointIndex * 0.127) * 0.07;
    targets[index] = source[index] * spread;
    targets[index + 1] = source[index + 1] * spread + verticalDrift;
    targets[index + 2] = source[index + 2] * spread;
  }
  return targets;
}

function buildRegionalClusterPositions(
  count: number,
  center: { lat: number; lon: number },
  spread: { lat: number; lon: number },
) {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radial = Math.sqrt((index * 0.6180339887498948 + 0.27) % 1);
    const angle = ((index * 0.414213562373095 + 0.61) % 1) * Math.PI * 2;
    const lat = center.lat + Math.sin(angle) * radial * spread.lat * 0.5;
    const lon = center.lon + Math.cos(angle) * radial * spread.lon * 0.5;
    const radius = 1.405 + ((index * 31) % 17) * 0.002;
    latLonToVector3(lat, lon, radius).toArray(positions, index * 3);
  }
  return positions;
}

function damp(current: number, target: number, delta: number, speed = 5.5) {
  return current + (target - current) * (1 - Math.exp(-speed * delta));
}

export function ParticleEarthScene({
  mode,
  quality = "low",
  focusPoint,
  focusRoute,
  focusRevision = 0,
  focusFlightProfile,
  focusColor,
  centerFocusPoint = false,
  onFocusPointActivate,
  journeyRoutes = [],
  activeJourneyRouteId,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  temporalReveal,
  showArchiveSignals = true,
  onReady,
  onGlobePointPick,
  dragToRotate = false,
  wheelToZoom = true,
  reduceMotion = false,
  compactMobileLayout = false,
  rotationYOverride,
}: ParticleEarthSceneProps) {
  const [ready, setReady] = useState(false);
  const latestMode = useRef(mode);
  const latestQuality = useRef(quality);
  const latestFocusPoint = useRef(focusPoint);
  const latestFocusRoute = useRef(focusRoute);
  const latestFocusRevision = useRef(focusRevision);
  const latestFocusFlightProfile = useRef(focusFlightProfile);
  const latestFocusColor = useRef(focusColor);
  const latestCenterFocusPoint = useRef(centerFocusPoint);
  const latestOnFocusPointActivate = useRef(onFocusPointActivate);
  const latestJourneyRoutes = useRef(journeyRoutes);
  const latestActiveJourneyRouteId = useRef(activeJourneyRouteId);
  const latestOnJourneyRouteActivate = useRef(onJourneyRouteActivate);
  const latestOnJourneyRoutePointActivate = useRef(onJourneyRoutePointActivate);
  const latestTemporalReveal = useRef(temporalReveal);
  const latestOnReady = useRef(onReady);
  const latestOnGlobePointPick = useRef(onGlobePointPick);
  const latestDragToRotate = useRef(dragToRotate);
  const latestWheelToZoom = useRef(wheelToZoom);
  const latestRotationYOverride = useRef(rotationYOverride);
  const latestCompactMobileLayout = useRef(compactMobileLayout);
  latestMode.current = mode;
  latestQuality.current = quality;
  latestFocusPoint.current = focusPoint;
  latestFocusRoute.current = focusRoute;
  latestFocusRevision.current = focusRevision;
  latestFocusFlightProfile.current = focusFlightProfile;
  latestFocusColor.current = focusColor;
  latestCenterFocusPoint.current = centerFocusPoint;
  latestOnFocusPointActivate.current = onFocusPointActivate;
  latestJourneyRoutes.current = journeyRoutes;
  latestActiveJourneyRouteId.current = activeJourneyRouteId;
  latestOnJourneyRouteActivate.current = onJourneyRouteActivate;
  latestOnJourneyRoutePointActivate.current = onJourneyRoutePointActivate;
  latestTemporalReveal.current = temporalReveal;
  latestOnReady.current = onReady;
  latestOnGlobePointPick.current = onGlobePointPick;
  latestDragToRotate.current = dragToRotate;
  latestWheelToZoom.current = wheelToZoom;
  latestRotationYOverride.current = rotationYOverride;
  latestCompactMobileLayout.current = compactMobileLayout;

  const { hostRef, controllerRef } = useThreeScene((host) => {
    let disposed = false;
    let animationFrame = 0;
    let lastTime = performance.now();
    let currentMode = latestMode.current;
    let currentQuality = latestQuality.current;
    let currentCompactMobileLayout = latestCompactMobileLayout.current;
    let qualityBuildRevision = 0;
    const targetSize = new Vector2();
    const scene = new Scene();
    const camera = new PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    const sampledFocusCenter = new Vector2();
    let focusViewportSampledAt = 0;

    const visibleElementRect = (element: HTMLElement | null): JourneyConnectorRect | null => {
      if (!element?.isConnected) return null;
      const style = window.getComputedStyle(element);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || Number.parseFloat(style.opacity || "1") <= 0.01
      ) return null;
      const hostBounds = host.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      return {
        left: bounds.left - hostBounds.left,
        top: bounds.top - hostBounds.top,
        right: bounds.right - hostBounds.left,
        bottom: bounds.bottom - hostBounds.top,
      };
    };

    const sampleFocusViewport = (force: boolean) => {
      const now = performance.now();
      if (!force && now - focusViewportSampledAt < 100) return;
      focusViewportSampledAt = now;
      const atlas = host.closest<HTMLElement>(".living-atlas");
      const useFullViewport = atlas?.dataset.globeFocus === "on"
        || atlas?.classList.contains("is-playback");
      const mobile = atlas?.dataset.mobileV2 === "on";
      const chrome: FocusViewportChrome = useFullViewport
        ? {}
        : mobile
          ? {
            top: visibleElementRect(atlas?.querySelector<HTMLElement>(".mobile-v2__header") ?? null),
            bottom: visibleElementRect(atlas?.querySelector<HTMLElement>(".mobile-v2__chrome") ?? null),
          }
          : {
            left: visibleElementRect(atlas?.querySelector<HTMLElement>(".living-atlas__journey-rail") ?? null),
            right: visibleElementRect(atlas?.querySelector<HTMLElement>(".living-atlas__active") ?? null),
          };
      const center = focusViewportCenter(
        { width: targetSize.x, height: targetSize.y },
        chrome,
      );
      sampledFocusCenter.set(center.x, center.y);
      host.dataset.focusViewportCenterX = center.x.toFixed(1);
      host.dataset.focusViewportCenterY = center.y.toFixed(1);
    };
    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
      premultipliedAlpha: false,
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(new Color(0x020807), 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PROFILE[currentQuality].maxDpr));
    renderer.domElement.dataset.threeScene = "particle-earth";
    host.dataset.quality = currentQuality;
    host.appendChild(renderer.domElement);
    const routeVectorLayer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    routeVectorLayer.classList.add("particle-earth-route-layer");
    routeVectorLayer.setAttribute("aria-hidden", "true");
    routeVectorLayer.setAttribute("focusable", "false");
    routeVectorLayer.setAttribute("preserveAspectRatio", "none");
    routeVectorLayer.style.opacity = "0";
    host.appendChild(routeVectorLayer);
    const cityVectorLayer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    cityVectorLayer.classList.add("particle-earth-city-layer");
    cityVectorLayer.setAttribute("aria-hidden", "true");
    cityVectorLayer.setAttribute("focusable", "false");
    cityVectorLayer.setAttribute("preserveAspectRatio", "none");
    host.appendChild(cityVectorLayer);
    const debugWindow = window as Window & {
      __particleEarthDebug?: () => {
        canvases: number;
        geometries: number;
        textures: number;
        mode: GlobeMode;
        rotationX: number;
        rotationY: number;
        idleReleasePhase: number;
        positionX: number;
        positionY: number;
        zoom: number;
        scale: number;
        projectedGlobeCenterPx: { x: number; y: number };
        projectedGlobeRadiusPx: number;
        effectiveDragRadiansPerPixel: number;
        dragMappingMode: typeof GLOBE_DRAG_MAPPING_MODE;
        pinchAnchor: { lat: number; lon: number } | null;
        pinchAnchorErrorPx: number | null;
        angularDeltaPerSample: { x: number; y: number; total: number };
        dragAngularDisplacement: { x: number; y: number; total: number };
        manualFocusOwner: boolean;
        quality: keyof typeof QUALITY_PROFILE;
        pixelRatio: number;
        particleCount: number;
        particleBaseCount: number;
        particleRefinementCount: number;
        particleRefinementCap: number;
        particleRefinementRegion: ParticleRefinementRegion | null;
        particleRefinementBuild: string;
        particleLandSource: string;
        semanticLod: GlobeSemanticZoom;
        semanticLodProgress: number;
        coastlineVertices: number;
      };
    };
    debugWindow.__particleEarthDebug = () => ({
      canvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      mode: currentMode,
      rotationX: globe.rotation.x,
      rotationY: globe.rotation.y,
      idleReleasePhase,
      positionX: globe.position.x,
      positionY: globe.position.y,
      zoom: interactiveZoom,
      scale: globe.scale.x,
      projectedGlobeCenterPx: { ...readInteractionGeometry().center },
      projectedGlobeRadiusPx: readInteractionGeometry().projectedRadiusPx,
      effectiveDragRadiansPerPixel: 1 / readInteractionGeometry().interactionRadiusPx,
      dragMappingMode: GLOBE_DRAG_MAPPING_MODE,
      pinchAnchor: pinchAnchor ? { ...pinchAnchor } : null,
      pinchAnchorErrorPx,
      angularDeltaPerSample: { ...lastGestureAngularDelta },
      dragAngularDisplacement: { ...dragAngularDisplacement },
      manualFocusOwner: manualFocusRevision !== null,
      quality: currentQuality,
      pixelRatio: renderer.getPixelRatio(),
      particleCount: particleGeometry?.getAttribute("position")?.count ?? 0,
      particleBaseCount: particleGeometry?.getAttribute("position")?.count ?? 0,
      particleRefinementCount: activeRefinementLayer
        ? Math.min(activeRefinementLayer.sampleCount, currentParticleLod.activeCount)
        : 0,
      particleRefinementCap: currentParticleLod.particleCap,
      particleRefinementRegion: activeRefinementLayer?.region ?? null,
      particleRefinementBuild: refinementBuildState,
      particleLandSource: landSourceDebug,
      semanticLod: currentParticleLod.level,
      semanticLodProgress: currentParticleLod.refinementProgress,
      coastlineVertices: coastlineGeometry.getAttribute("position")?.count ?? 0,
    });

    scene.add(new AmbientLight(0x69736f, 0.72));
    const keyLight = new DirectionalLight(0xe3eee8, 1.9);
    keyLight.position.set(2.8, 2.4, 4);
    scene.add(keyLight);

    const globe = new Group();
    globe.rotation.set(
      0.08,
      latestRotationYOverride.current ?? GLOBE_MODE_CONFIG[currentMode].rotationY,
      -0.03,
    );
    scene.add(globe);
    const focusProjectionEuler = new Euler();
    const focusProjectionWorld = new Vector3();
    const focusProjectionScreen = new Vector2();
    const projectFocusPointForRotation = (
      point: { lat: number; lon: number },
      rotationX: number,
      rotationY: number,
      scale: number,
      positionX: number,
      positionY: number,
      targetScreen: Vector2,
      pointRadius = ROUTE_ANCHOR_RADIUS,
    ) => {
      focusProjectionWorld
        .copy(latLonToVector3(point.lat, point.lon, pointRadius))
        .applyEuler(focusProjectionEuler.set(rotationX, rotationY, globe.rotation.z))
        .multiplyScalar(scale);
      focusProjectionWorld.x += positionX;
      focusProjectionWorld.y += positionY;
      focusProjectionWorld.z += globe.position.z;
      focusProjectionWorld.project(camera);
      return targetScreen.set(
        ((focusProjectionWorld.x + 1) * targetSize.x) / 2,
        ((1 - focusProjectionWorld.y) * targetSize.y) / 2,
      );
    };
    const solveFocusRotationForViewport = (
      point: { lat: number; lon: number },
      seedRotationX: number,
      seedRotationY: number,
      scale: number,
      positionX: number,
      positionY: number,
      targetScreen: ScreenPoint = sampledFocusCenter,
      pointRadius = ROUTE_ANCHOR_RADIUS,
    ) => {
      return solveScreenAnchorRotation(
        seedRotationX,
        seedRotationY,
        targetScreen,
        (rotationX, rotationY) => projectFocusPointForRotation(
          point,
          rotationX,
          rotationY,
          scale,
          positionX,
          positionY,
          focusProjectionScreen,
          pointRadius,
        ),
      );
    };
    const recordFocusArrival = (
      point: { lat: number; lon: number },
      rotationX: number,
      rotationY: number,
      scale: number,
      positionX: number,
      positionY: number,
    ) => {
      const projected = projectFocusPointForRotation(
        point,
        rotationX,
        rotationY,
        scale,
        positionX,
        positionY,
        focusProjectionScreen,
      );
      host.dataset.focusArrivalX = projected.x.toFixed(2);
      host.dataset.focusArrivalY = projected.y.toFixed(2);
      host.dataset.focusArrivalCenterX = sampledFocusCenter.x.toFixed(2);
      host.dataset.focusArrivalCenterY = sampledFocusCenter.y.toFixed(2);
    };
    let baseRotationY = globe.rotation.y;
    let interactiveRotationX = globe.rotation.x;
    let interactiveRotationY = 0;
    let interactiveZoom = 1;
    let currentParticleLod = resolveParticleRefinementLod(
      interactiveZoom,
      currentQuality,
    );
    let rotationVelocityX = 0;
    let rotationVelocityY = 0;
    let lastGestureAngularDelta = { x: 0, y: 0, total: 0 };
    let dragAngularDisplacement = { x: 0, y: 0, total: 0 };
    let pinchAnchor: { lat: number; lon: number } | null = null;
    let pinchAnchorErrorPx: number | null = null;
    let manualFocusRevision: number | null = null;
    let idleReleasePhase = 0;
    let lastGlobeInteractionAt = performance.now();
    let routeFocusFrame = getSphericalRouteFocus(latestFocusRoute.current?.points ?? []);
    let routeFocusSettling = false;
    let pointFocusSettling = false;
    let activeFocusRevision = Number.NEGATIVE_INFINITY;
    let focusTarget: {
      point: { lat: number; lon: number };
      rotationX: number;
      rotationY: number;
      zoom: number;
      screenX: number;
      screenY: number;
    } | null = null;
    let routeFocusZoomResetting = false;
    const interactionWorldCenter = new Vector3();
    const interactionGeometry = {
      center: { x: 0, y: 0 },
      projectedRadiusPx: 1,
      interactionRadiusPx: 1,
    };
    const readInteractionGeometry = (scale = globe.scale.x) => {
      interactionWorldCenter.copy(globe.position).project(camera);
      interactionGeometry.center.x = ((interactionWorldCenter.x + 1) * targetSize.x) / 2;
      interactionGeometry.center.y = ((1 - interactionWorldCenter.y) * targetSize.y) / 2;
      const cameraDistance = Math.abs(camera.position.z - globe.position.z);
      const worldRadius = GLOBE_SURFACE_RADIUS * scale;
      const fovRadians = (camera.fov * Math.PI) / 180;
      interactionGeometry.projectedRadiusPx = getProjectedGlobeRadiusPx(
        targetSize.y,
        fovRadians,
        cameraDistance,
        worldRadius,
      );
      interactionGeometry.interactionRadiusPx = getProjectedSurfaceInteractionRadiusPx(
        targetSize.y,
        fovRadians,
        cameraDistance,
        worldRadius,
      );
      return interactionGeometry;
    };
    const syncRouteFocusPhase = () => {
      host.dataset.routeFocusPhase = getRouteFocusPhase(
        Boolean(routeFocusFrame),
        routeFocusSettling,
        routeFocusZoomResetting,
      );
    };
    syncRouteFocusPhase();

    const sphereGeometry = new SphereGeometry(GLOBE_SURFACE_RADIUS, 64, 40);
    const surfaceMaterial = new MeshPhongMaterial({
      color: 0xd1d7d4,
      emissive: 0x010403,
      shininess: 1,
      transparent: true,
      opacity: 0,
    });
    const surface = new Mesh(sphereGeometry, surfaceMaterial);
    globe.add(surface);

    const reliefExperimentEnabled = new URLSearchParams(window.location.search)
      .get("terrainRelief") === "1";
    host.dataset.reliefExperiment = reliefExperimentEnabled ? "on" : "off";
    const reliefMaterial = new MeshPhongMaterial({
      color: 0x07100f,
      emissive: 0x010302,
      shininess: 0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const reliefSupport = new Mesh(sphereGeometry, reliefMaterial);
    reliefSupport.scale.setScalar(1.0015);
    reliefSupport.renderOrder = GLOBE_RENDER_ORDER.relief;
    reliefSupport.visible = false;
    globe.add(reliefSupport);

    const wireMaterial = new MeshBasicMaterial({
      color: 0x54ddd4,
      transparent: true,
      opacity: 0.035,
      wireframe: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const wire = new Mesh(sphereGeometry, wireMaterial);
    wire.scale.setScalar(1.006);
    globe.add(wire);

    let coastlineGeometry = new BufferGeometry();
    const coastlineMaterial = new LineBasicMaterial({
      blending: AdditiveBlending,
      color: 0x7af4ed,
      depthTest: true,
      depthWrite: false,
      opacity: 0,
      transparent: true,
    });
    const coastlines = new LineSegments(coastlineGeometry, coastlineMaterial);
    coastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    globe.add(coastlines);
    let midCoastlineGeometry = new BufferGeometry();
    let nearCoastlineGeometry = new BufferGeometry();
    const midCoastlineMaterial = coastlineMaterial.clone();
    const nearCoastlineMaterial = coastlineMaterial.clone();
    const midCoastlines = new LineSegments(midCoastlineGeometry, midCoastlineMaterial);
    const nearCoastlines = new LineSegments(nearCoastlineGeometry, nearCoastlineMaterial);
    midCoastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    nearCoastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    globe.add(midCoastlines, nearCoastlines);

    const atmosphereMaterial = createAtmosphereMaterial();
    const atmosphere = new Mesh(sphereGeometry, atmosphereMaterial);
    atmosphere.scale.setScalar(1.07);
    globe.add(atmosphere);

    const archiveMaterial = showArchiveSignals
      ? createParticleEarthMaterial({
          color: 0xd9fffb,
          opacity: 0.9,
          size: 45,
        })
      : null;
    if (archiveMaterial) {
      const archiveGeometry = new BufferGeometry();
      const archivePositions = buildArtworkPointPositions(archiveRecords, 1.43);
      archiveGeometry.setAttribute("position", new BufferAttribute(archivePositions, 3));
      archiveGeometry.setAttribute("targetPosition", new BufferAttribute(archivePositions.slice(), 3));
      const archiveSignals = new Points(archiveGeometry, archiveMaterial);
      archiveSignals.renderOrder = GLOBE_RENDER_ORDER.signal;
      globe.add(archiveSignals);
    }

    const clusterGeometry = new BufferGeometry();
    const clusterPositions = buildRegionalClusterPositions(
      920,
      { lat: 40, lon: 65 },
      { lat: 24, lon: 24 },
    );
    clusterGeometry.setAttribute("position", new BufferAttribute(clusterPositions, 3));
    clusterGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(clusterPositions.slice(), 3),
    );
    const clusterMaterial = createParticleEarthMaterial({
      color: 0xf19cff,
      opacity: 0,
      size: 28,
    });
    const archiveCluster = new Points(clusterGeometry, clusterMaterial);
    archiveCluster.renderOrder = GLOBE_RENDER_ORDER.signal;
    globe.add(archiveCluster);

    const particleDimmingMaterials: Array<ReturnType<typeof createParticleEarthMaterial>> = [];
    let particleDimmingActiveRouteId: string | null | undefined;
    let particleActiveDimStrengthTarget = 0;
    const syncParticleDimming = (
      routes: readonly JourneyRoute[],
      activeRouteId: string | null | undefined,
      temporalReveal = latestTemporalReveal.current,
    ) => {
      const allDirections = collectJourneyDimDirections(
        routes,
        PARTICLE_DIM_POINT_LIMIT,
        temporalReveal,
      );
      const activeRoute = routes.find((route) => route.id === activeRouteId);
      const activeDirections = collectJourneyDimDirections(
        activeRoute ? [activeRoute] : [],
        PARTICLE_ACTIVE_DIM_POINT_LIMIT,
        temporalReveal,
      );
      const activeRouteChanged = particleDimmingActiveRouteId !== activeRouteId;
      particleDimmingActiveRouteId = activeRouteId;
      particleActiveDimStrengthTarget = activeDirections.length > 0 ? 1 : 0;
      for (const material of particleDimmingMaterials) {
        const dimUniforms = material.uniforms;
        const dimPoints = dimUniforms.uDimPoints.value as Vector3[];
        const activeDimPoints = dimUniforms.uActiveDimPoints.value as Vector3[];
        allDirections.forEach((direction, index) => dimPoints[index].copy(direction));
        activeDirections.forEach((direction, index) => activeDimPoints[index].copy(direction));
        dimUniforms.uDimPointCount.value = allDirections.length;
        dimUniforms.uActiveDimPointCount.value = activeDirections.length;
        if (activeRouteChanged) dimUniforms.uActiveDimStrength.value = 0;
      }
      host.dataset.particleDimPointCount = String(allDirections.length);
      host.dataset.particleActiveDimPointCount = String(activeDirections.length);
    };

    const cyanClusterGeometry = new BufferGeometry();
    const cyanClusterPositions = buildRegionalClusterPositions(
      620,
      { lat: 28, lon: 55 },
      { lat: 38, lon: 36 },
    );
    cyanClusterGeometry.setAttribute(
      "position",
      new BufferAttribute(cyanClusterPositions, 3),
    );
    cyanClusterGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(cyanClusterPositions.slice(), 3),
    );
    const cyanClusterMaterial = createParticleEarthMaterial({
      color: 0xa9fff4,
      opacity: 0,
      size: 22,
    });
    const cyanArchiveCluster = new Points(cyanClusterGeometry, cyanClusterMaterial);
    cyanArchiveCluster.renderOrder = GLOBE_RENDER_ORDER.signal;
    globe.add(cyanArchiveCluster);

    const shellGeometry = new BufferGeometry();
    const shellPositions = buildSeededSpherePoints(3_200, 2087);
    for (let index = 0; index < shellPositions.length; index += 1) {
      shellPositions[index] *= 1.405;
    }
    shellGeometry.setAttribute("position", new BufferAttribute(shellPositions, 3));
    shellGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(shellPositions.slice(), 3),
    );
    const shellMaterial = createParticleEarthMaterial({
      color: 0xa8f6f3,
      opacity: 0.15,
      size: 8,
    });
    const particleShell = new Points(shellGeometry, shellMaterial);
    globe.add(particleShell);

    const haloGeometry = new BufferGeometry();
    const haloPositions = buildSeededSpherePoints(1_100, 9917);
    for (let index = 0; index < haloPositions.length; index += 3) {
      const pointIndex = index / 3;
      const radius = 1.44 + ((pointIndex * 37) % 101) / 101 * 0.34;
      haloPositions[index] *= radius;
      haloPositions[index + 1] *= radius;
      haloPositions[index + 2] *= radius;
    }
    haloGeometry.setAttribute("position", new BufferAttribute(haloPositions, 3));
    haloGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(haloPositions.slice(), 3),
    );
    const haloMaterial = createParticleEarthMaterial({
      color: 0x7ae9e2,
      opacity: 0,
      size: 10,
    });
    const particleHalo = new Points(haloGeometry, haloMaterial);
    globe.add(particleHalo);

    // These are ambient cyan/green background layers. Route markers and the
    // personal/journey signal use separate materials and intentionally stay
    // bright, so the hierarchy changes without punching a dark hole in them.
    particleDimmingMaterials.push(cyanClusterMaterial, shellMaterial, haloMaterial);
    syncParticleDimming(latestJourneyRoutes.current, latestActiveJourneyRouteId.current);

    const personalGeometry = new BufferGeometry();
    const initialFallback =
      currentMode === "archiveBurst"
        ? { lat: -10, lon: -180 }
        : { lat: 34.0522, lon: -118.2437 };
    const personalPosition = focusSignalAnchor(
      latestFocusPoint.current,
      initialFallback,
    ).multiplyScalar(PERSONAL_SIGNAL_RENDER_LIFT);
    const personalPositions = new Float32Array(personalPosition.toArray());
    personalGeometry.setAttribute("position", new BufferAttribute(personalPositions, 3));
    personalGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(personalPositions.slice(), 3),
    );
    const personalMaterial = createParticleEarthMaterial({
      color: 0xffdc72,
      opacity: 0,
      size: 58,
      radialPulseScale: 0,
    });
    personalMaterial.uniforms.uColor.value.set(
      latestFocusColor.current ?? 0xffdc72,
    );
    host.dataset.focusColor = `#${personalMaterial.uniforms.uColor.value.getHexString()}`;
    const personalSignal = new Points(personalGeometry, personalMaterial);
    personalSignal.renderOrder = GLOBE_RENDER_ORDER.personalPoint;
    globe.add(personalSignal);
    const personalScreenPosition = new Vector3();

    let routePointGeometry = new BufferGeometry();
    const routePointMaterial = new PointsMaterial({
      colorWrite: false,
      depthWrite: false,
      size: 0.09,
      sizeAttenuation: true,
    });
    const routePointSignals = new Points(routePointGeometry, routePointMaterial);
    routePointSignals.renderOrder = GLOBE_RENDER_ORDER.routePoint;
    globe.add(routePointSignals);
    type RouteVectorLabel = {
      element: SVGGElement;
      leader: SVGPathElement;
      text: SVGTextElement;
      width: number;
      priority: number;
      pointIndex: number;
    };
    type RouteVectorEntry = {
      routeId: string;
      color: string;
      group: SVGGElement;
      samples: RouteArcSamples;
      // #21 review: one SVG path per leg (point i -> i+1), so a rewind can
      // reveal the trail leg by leg; `toPointIndex` is the leg's destination
      // route-point index used to drive its temporal reveal.
      legs: Array<{
        path: SVGPathElement;
        toPointIndex: number;
        samples: RouteArcSamples;
      }>;
      glowPath: SVGPathElement;
      corePath: SVGPathElement;
      flowPath: SVGPathElement;
      strandPaths: [SVGPathElement, SVGPathElement];
      fadeGradient: SVGLinearGradientElement;
      points: Array<{
        element: SVGCircleElement | SVGPathElement | SVGPolygonElement;
        ring?: SVGCircleElement;
        position: Vector3;
        label?: RouteVectorLabel;
        // #21: the route point's index inside its journey, for per-point
        // temporal reveal ("one stop lights up at a time").
        routePointIndex: number;
      }>;
    };
    let routeVectorEntries: RouteVectorEntry[] = [];
    let routeVectorOpacity = 0;
    const sceneToken = Math.random().toString(36).slice(2, 8);
    const routeCameraPosition = new Vector3();
    const routeLocalPoint = new Vector3();
    const routeScreenPoint = new Vector3();
    const routeProjectedPoint = { x: 0, y: 0 };
    const cityClipMatrix = new Matrix4();
    const isCityCandidateInsideViewport = (city: CityPoint) => {
      const x = city.direction[0] * ROUTE_ANCHOR_RADIUS;
      const y = city.direction[1] * ROUTE_ANCHOR_RADIUS;
      const z = city.direction[2] * ROUTE_ANCHOR_RADIUS;
      routeLocalPoint.set(x, y, z);
      if (!isSphericalPointVisible(routeCameraPosition, routeLocalPoint)) return false;
      return isLocalPointInsideClipViewport(cityClipMatrix.elements, x, y, z);
    };
    // Slots 10..13 carry the active card's bounds so a still globe still
    // redraws the connector when the card moves or the layout changes; the
    // last slot carries the frame's route arc lift (#193).
    const lastRouteProjectionState = new Float64Array(15).fill(Number.NaN);
    let routeProjectionRevision = 0;
    let renderedRouteProjectionRevision = -1;
    const journeyConnectorPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    journeyConnectorPath.classList.add("particle-earth-journey-connector");
    journeyConnectorPath.setAttribute("aria-hidden", "true");
    journeyConnectorPath.setAttribute("fill", "none");
    let journeyConnectorCard: HTMLElement | null = null;
    let journeyConnectorCardRect: JourneyConnectorRect | null = null;
    let journeyConnectorSampledAt = 0;
    let journeyPointTargets: Array<{ journeyId: string; routePointId?: string }> = [];
    const routeLabelSafeArea = {
      left: 16,
      top: 74,
      right: 16,
      bottom: 18,
    };

    const updateRouteLabelSafeArea = () => {
      const hostBounds = host.getBoundingClientRect();
      const atlas = host.closest(".living-atlas")
        ?? document.querySelector(".living-atlas");
      const headerBounds = atlas
        ?.querySelector(".living-atlas__header")
        ?.getBoundingClientRect();
      const cardBounds = atlas
        ?.querySelector(".living-atlas__active")
        ?.getBoundingClientRect();
      // This function only measures the DOM; the layout rules themselves live
      // in the pure `resolveRouteLabelSafeArea` so they can be tested without
      // a viewport, and so #194's compact flag has exactly one source.
      Object.assign(routeLabelSafeArea, resolveRouteLabelSafeArea({
        host: { width: hostBounds.width, height: hostBounds.height },
        headerBottom: headerBounds
          ? headerBounds.bottom - hostBounds.top
          : null,
        card: cardBounds
          ? {
            left: cardBounds.left - hostBounds.left,
            top: cardBounds.top - hostBounds.top,
            right: cardBounds.right - hostBounds.left,
            bottom: cardBounds.bottom - hostBounds.top,
          }
          : null,
        compactMobileLayout: currentCompactMobileLayout,
      }));
    };

    const applyJourneyRoutes = (routes: readonly JourneyRoute[]) => {
      const visibleRoutes = selectRenderableJourneyRoutes(routes);
      const pointCount = visibleRoutes.reduce(
        (total, route) => total + route.points.length,
        0,
      );
      const pointPositions = new Float32Array(pointCount * 3);
      const pointTargets: Array<{ journeyId: string; routePointId?: string }> = [];
      let pointIndex = 0;
      let routeVertexCount = 0;
      let routeLabelCount = 0;

      routeVectorLayer.replaceChildren();
      routeVectorEntries = [];
      routeProjectionRevision += 1;
      const routeDefs = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "defs",
      );
      routeVectorLayer.appendChild(routeDefs);

      visibleRoutes.forEach((route, routeIndex) => {
        const group = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "g",
        );
        group.classList.add(
          "particle-earth-route",
          getJourneyRouteVisualState(route.id, latestActiveJourneyRouteId.current),
          "is-style-strands",
        );
        group.style.color = route.color;
        group.dataset.journeyRoute = route.id;
        group.dataset.lightEffect = route.lightEffect ?? "none";
        // #21: the time cursor drives a route's presence. 0 = future
        // (hidden), 0..1 = being revealed, 1 = visited. The CSS fades the
        // whole trail via --journey-temporal-progress; per-point progress is
        // applied by setTemporalReveal on the element level.
        const reveal = latestTemporalReveal.current?.journeys.get(route.id);
        if (reveal !== undefined) {
          group.style.setProperty("--journey-temporal-progress", reveal.toFixed(3));
          group.dataset.temporalReveal = reveal.toFixed(3);
        }
        const glowPath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        glowPath.classList.add("particle-earth-route__glow");
        const corePath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        corePath.classList.add("particle-earth-route__core");
        // ML-08 Spatial Particle Bridge: a light pulse travels along the
        // active route from its origin toward its destination.
        const flowPath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        flowPath.classList.add("particle-earth-route__flow");
        // Strands: two interlaced thread layers that flow along the route at
        // different speeds and dash rhythms, over a gradient core.
        const strandPaths: [SVGPathElement, SVGPathElement] = [
          document.createElementNS("http://www.w3.org/2000/svg", "path"),
          document.createElementNS("http://www.w3.org/2000/svg", "path"),
        ];
        strandPaths[0].classList.add("particle-earth-route__strand-a");
        strandPaths[1].classList.add("particle-earth-route__strand-b");
        strandPaths.forEach((strand) => {
          strand.setAttribute(
            "stroke",
            `url(#route-fade-${sceneToken}-${routeIndex})`,
          );
        });
        // The stroke fades toward the destination; the gradient is a
        // per-route user-space gradient whose endpoints follow the projected
        // origin and destination each projection pass.
        const fadeGradient = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "linearGradient",
        );
        fadeGradient.id = `route-fade-${sceneToken}-${routeIndex}`;
        fadeGradient.setAttribute("gradientUnits", "userSpaceOnUse");
        const palette = getLightEffectPalette(route.lightEffect, route.color);
        const gradientStops = palette.length === 1
          ? [
            { offset: "0%", color: palette[0], stopOpacity: "1" },
            { offset: "68%", color: palette[0], stopOpacity: "0.72" },
            { offset: "100%", color: palette[0], stopOpacity: "0" },
          ]
          : palette.map((color, paletteIndex) => ({
            offset: `${Math.round((paletteIndex / (palette.length - 1)) * 100)}%`,
            color,
            stopOpacity: paletteIndex === palette.length - 1
              ? "0"
              : String(1 - (paletteIndex / (palette.length - 1)) * 0.42),
          }));
        for (const { offset, color, stopOpacity } of gradientStops) {
          const stop = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "stop",
          );
          stop.setAttribute("offset", offset);
          stop.setAttribute("stop-color", color);
          stop.setAttribute("stop-opacity", stopOpacity);
          fadeGradient.appendChild(stop);
        }
        routeDefs.appendChild(fadeGradient);
        const gradientReference = `url(#${fadeGradient.id})`;
        glowPath.setAttribute("stroke", gradientReference);
        corePath.setAttribute("stroke", gradientReference);
        group.append(glowPath, corePath, ...strandPaths, flowPath);
        const vectorPoints: RouteVectorEntry["points"] = [];
        const routeLabelIndexes = route.id === latestActiveJourneyRouteId.current
          ? selectRouteLabelPointIndexes(route.points)
          : [];
        const routeLabelIndexSet = new Set(routeLabelIndexes);
        const routeLabelElements: SVGGElement[] = [];

        route.points.forEach((point, routePointIndex) => {
          // #193: the canonical Route Point anchor. The marker, the point
          // sprite, the label and both ends of the route line all read it,
          // so nothing can drift away from the line at high zoom.
          const position = routePointAnchor(point.lat, point.lon);
          position.toArray(
            pointPositions,
            pointIndex * 3,
          );
          pointTargets.push({ journeyId: route.id, routePointId: point.id });
          pointIndex += 1;

          const roleClass = routePointIndex === 0
            ? "particle-earth-route__point--origin"
            : routePointIndex === route.points.length - 1
              ? "particle-earth-route__point--destination"
              : point.isStop
                ? "particle-earth-route__point--stop"
                : "particle-earth-route__point--transit";
          const isOriginPoint = roleClass === "particle-earth-route__point--origin";
          const isDestinationPoint = roleClass === "particle-earth-route__point--destination";
          const isWaypoint = !isOriginPoint && !isDestinationPoint;
          const element = document.createElementNS(
            "http://www.w3.org/2000/svg",
            isDestinationPoint ? "polygon" : isWaypoint ? "path" : "circle",
          ) as SVGCircleElement | SVGPathElement | SVGPolygonElement;
          element.classList.add(
            "particle-earth-route__point",
            roleClass,
          );
          const twinkleOffset = (routeIndex * 0.83 + routePointIndex * 0.47) % 4.6;
          const twinkleDuration = (
            isWaypoint
              ? 1.8 + ((routeIndex * 7 + routePointIndex * 3) % 5) * 0.18
              : 3.2 + ((routeIndex * 7 + routePointIndex * 3) % 6) * 0.31
          ) * JOURNEY_POINT_TWINKLE_SLOWDOWN;
          element.style.setProperty("--journey-twinkle-delay", `${-twinkleOffset.toFixed(2)}s`);
          element.style.setProperty("--journey-twinkle-duration", `${twinkleDuration.toFixed(2)}s`);
          if (isDestinationPoint) {
            element.setAttribute(
              "points",
              buildRoutePointStarPoints(
                0,
                0,
                3.6 * JOURNEY_ROUTE_MARKER_SCALE,
                1.52 * JOURNEY_ROUTE_MARKER_SCALE,
              ),
            );
          } else if (isWaypoint) {
            element.setAttribute(
              "d",
              buildRoutePointFlagPath(0, 0, JOURNEY_ROUTE_MARKER_SCALE),
            );
          } else {
            element.setAttribute(
              "r",
              String(3.4 * JOURNEY_ROUTE_MARKER_SCALE),
            );
          }
          group.appendChild(element);
          let ring: SVGCircleElement | undefined;
          if (
            (point.isStop || routePointIndex === route.points.length - 1)
            && route.id === latestActiveJourneyRouteId.current
          ) {
            // ML-09 Geographic Cluster Bloom: a restrained breathing ring on
            // the stops (and final point) of the active journey.
            ring = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "circle",
            );
            ring.classList.add("particle-earth-route__point-ring");
            ring.setAttribute(
              "r",
              String(3.2 * JOURNEY_ROUTE_MARKER_SCALE),
            );
            ring.style.setProperty("--journey-pulse-delay", `${-twinkleOffset.toFixed(2)}s`);
            group.appendChild(ring);
          }
          let label: RouteVectorLabel | undefined;
          if (routeLabelIndexSet.has(routePointIndex) && point.label?.trim()) {
            const labelElement = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "g",
            );
            labelElement.classList.add("particle-earth-route__label");
            const leader = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "path",
            );
            leader.classList.add("particle-earth-route__leader");
            const text = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "text",
            );
            const displayLabel = formatRouteLabel(point.label);
            text.textContent = displayLabel;
            labelElement.setAttribute("data-route-label", displayLabel);
            labelElement.append(leader, text);
            routeLabelElements.push(labelElement);
            label = {
              element: labelElement,
              leader,
              text,
              width: estimateRouteLabelWidth(displayLabel),
              priority: routePointIndex === routeLabelIndexes[0]
                || routePointIndex === routeLabelIndexes.at(-1)
                ? 2
                : 1,
              pointIndex: routePointIndex,
            };
            routeLabelCount += 1;
          }
          vectorPoints.push({ element, ring, position, label, routePointIndex });
        });
        group.append(...routeLabelElements);

        const remainingVertices = MAX_RENDERED_ROUTE_LINE_VERTICES
          - routeVertexCount;
        // #15: long legs lift off the surface as a natural spatial arc
        // (great circle + altitude hump); short legs hug the globe. The
        // hump scales nonlinearly with angular distance and is clamped.
        const routeSamples = buildRouteArcSamples(
          route.points,
          Math.PI / 96,
          remainingVertices,
          {
            arcHeightRatio: ROUTE_ARC_HEIGHT_RATIO,
            arcSaturationAngle: ROUTE_ARC_SATURATION_ANGLE,
          },
        );
        routeVertexCount += routeArcVertexCount(routeSamples);
        // #21 review: build one path per leg so the rewind reveals the trail
        // stop by stop. Each leg path reuses the core gradient stroke and is
        // faded by its destination point's temporal progress.
        const legSamples = buildRouteArcLegSamples(
          route.points,
          Math.PI / 96,
          Math.min(remainingVertices, 2048),
          {
            arcHeightRatio: ROUTE_ARC_HEIGHT_RATIO,
            arcSaturationAngle: ROUTE_ARC_SATURATION_ANGLE,
          },
        );
        const legs = legSamples.map((leg, legIndex) => {
          const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          path.classList.add("particle-earth-route__leg");
          path.setAttribute("stroke", gradientReference);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");
          group.appendChild(path);
          return { path, toPointIndex: legIndex + 1, samples: leg };
        });
        routeVectorLayer.appendChild(group);
        routeVectorEntries.push({
          routeId: route.id,
          color: route.color,
          group,
          samples: routeSamples,
          legs,
          glowPath,
          corePath,
          flowPath,
          strandPaths,
          fadeGradient,
          points: vectorPoints,
        });
      });

      const nextPointGeometry = new BufferGeometry();
      nextPointGeometry.setAttribute(
        "position",
        new BufferAttribute(pointPositions, 3),
      );
      if (pointCount > 0) nextPointGeometry.computeBoundingSphere();
      const previousPointGeometry = routePointGeometry;
      routePointGeometry = nextPointGeometry;
      routePointSignals.geometry = routePointGeometry;
      previousPointGeometry.dispose();
      journeyPointTargets = pointTargets;
      host.dataset.journeyRouteCount = String(visibleRoutes.length);
      host.dataset.journeyRoutePointCount = String(pointCount);
      host.dataset.journeyRouteVectorVertices = String(routeVertexCount);
      host.dataset.journeyRouteLabelCount = String(routeLabelCount);
      host.dataset.journeyRouteOverflow = String(routes.length - visibleRoutes.length);
      host.dataset.routeStyle = "strands";
      // Rebuilding the layer clears its children, so the connector is put back
      // last and therefore stays above the route strands.
      routeVectorLayer.appendChild(journeyConnectorPath);
      updateRouteLabelSafeArea();
    };


    const projectRoutePoint = (
      x: number,
      y: number,
      z: number,
      target: ProjectedRoutePoint,
    ) => {
      routeLocalPoint.set(x, y, z);
      if (!isSphericalPointVisible(routeCameraPosition, routeLocalPoint)) return false;
      routeScreenPoint
        .copy(routeLocalPoint)
        .applyMatrix4(globe.matrixWorld)
        .project(camera);
      if (
        !Number.isFinite(routeScreenPoint.x)
        || !Number.isFinite(routeScreenPoint.y)
        || routeScreenPoint.z < -1
        || routeScreenPoint.z > 1
      ) {
        return false;
      }
      target.x = ((routeScreenPoint.x + 1) * targetSize.x) / 2;
      target.y = ((1 - routeScreenPoint.y) * targetSize.y) / 2;
      return true;
    };

    // ML-09 city labels: GeoNames cities15000 with containment-aware zoom —
    // capitals/province seats first, prefecture cities next, then counties
    // and towns; all labels are clickable for point picking.
    let cityTierData: { cities: CityPoint[] } | null = null;
    let lastCityTier: "capitals" | "prefectures" | "all" | null = null;
    let semanticZoomState: GlobeSemanticZoomState = resolveGlobeSemanticZoom({ zoom: interactiveZoom, qualityProfile: currentQuality });
    const activePointers = new Map<number, { x: number; y: number }>();
    let wheelInteractionUntil = 0;
    const rejectedPointerIds = new Set<number>();
    const cityLabelPool: Array<{
      element: SVGTextElement;
      city: CityPoint | null;
    }> = [];
    const ensureCityLabel = (index: number) => {
      if (index < cityLabelPool.length) return cityLabelPool[index];
      if (cityLabelPool.length >= CITY_LABEL_BUDGET) return null;
      const entry = {
        element: document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text",
        ),
        city: null as CityPoint | null,
      };
      entry.element.classList.add("particle-earth-city");
      entry.element.addEventListener("pointerup", (event) => {
        event.stopPropagation();
        const rejectedByGestureCapacity = rejectedPointerIds.delete(event.pointerId);
        if (shouldSuppressUntrackedPointerActivation(
          rejectedByGestureCapacity,
          activePointers.size,
        )) {
          return;
        }
        const pick = latestOnGlobePointPick.current;
        if (entry.city && pick) {
          pick({
            latitude: entry.city.latitude,
            longitude: entry.city.longitude,
          });
        }
      });
      cityVectorLayer.appendChild(entry.element);
      cityLabelPool.push(entry);
      return entry;
    };
    void loadCityTiers().then((tiers) => {
      cityTierData = tiers;
      // City data usually arrives after the intro/focus animation has already
      // settled, when projection states no longer change and the city block
      // would otherwise never run. Force one full refresh so labels appear.
      routeProjectionRevision += 1;
    }).catch(() => undefined);

    // Reading the card's box is a layout read, so it is sampled at 10 Hz while
    // the globe is still and refreshed immediately whenever projection changes.
    const sampleJourneyConnectorCard = (force: boolean) => {
      const now = performance.now();
      if (!force && now - journeyConnectorSampledAt < 100) return;
      journeyConnectorSampledAt = now;
      if (!journeyConnectorCard?.isConnected) {
        journeyConnectorCard = document.querySelector<HTMLElement>(
          ".living-atlas__active",
        );
      }
      if (!journeyConnectorCard) {
        journeyConnectorCardRect = null;
        return;
      }
      journeyConnectorCardRect = visibleElementRect(journeyConnectorCard);
    };

    const updateJourneyConnector = () => {
      let path = "";
      if (journeyConnectorCardRect && latestFocusPoint.current) {
        const focusAnchor = latLonToVector3(
          latestFocusPoint.current.lat,
          latestFocusPoint.current.lon,
          GLOBE_SURFACE_RADIUS,
        );
        const visible = projectRoutePoint(
          focusAnchor.x,
          focusAnchor.y,
          focusAnchor.z,
          routeProjectedPoint,
        );
        if (visible) {
          path = buildJourneyConnector({
            card: journeyConnectorCardRect,
            point: routeProjectedPoint,
            scene: { width: targetSize.x, height: targetSize.y },
            compact: currentCompactMobileLayout,
          });
        }
      }
      journeyConnectorPath.setAttribute("d", path);
      if (path) {
        journeyConnectorPath.style.removeProperty("display");
        journeyConnectorPath.setAttribute(
          "stroke",
          `#${personalMaterial.uniforms.uColor.value.getHexString()}`,
        );
        host.dataset.journeyConnector = "on";
        host.dataset.journeyConnectorEndX = routeProjectedPoint.x.toFixed(1);
        host.dataset.journeyConnectorEndY = routeProjectedPoint.y.toFixed(1);
      } else {
        journeyConnectorPath.style.display = "none";
        host.dataset.journeyConnector = "off";
        delete host.dataset.journeyConnectorEndX;
        delete host.dataset.journeyConnectorEndY;
      }
    };

    const updateRouteVectorLayer = () => {
      if (routeVectorOpacity <= 0.01) return;
      sampleJourneyConnectorCard(false);
      const cardRect = journeyConnectorCardRect;
      const projectionState = [
        globe.position.x,
        globe.position.y,
        globe.scale.x,
        globe.rotation.x,
        globe.rotation.y,
        targetSize.x,
        targetSize.y,
        camera.aspect,
        window.innerWidth,
        cardRect ? 1 : 0,
        cardRect?.left ?? 0,
        cardRect?.top ?? 0,
        cardRect?.right ?? 0,
        cardRect?.bottom ?? 0,
      ];
      const pixelsPerWorldUnit = routeArcPixelsPerWorldUnit({
        focalLengthPx: targetSize.y / (2 * Math.tan((camera.fov * Math.PI) / 360)),
        cameraDistance: Math.abs(camera.position.z - globe.position.z),
        anchorRadius: ROUTE_ANCHOR_RADIUS,
        globeScale: globe.scale.x,
      });
      // #193: decorative altitude is resolved per frame from the geometry's
      // stored per-vertex lift, so semantic zoom can flatten the arc without
      // rebuilding a single route.
      const arcLift = resolveRouteArcLift({
        // Derived from the rendered scale rather than the zoom target, so the
        // attenuation curve and the two ceilings always describe the same
        // frame while a wheel step is still interpolating.
        zoom: globe.scale.x / GLOBE_MODE_CONFIG[currentMode].scale,
        globeScale: globe.scale.x,
        anchorRadius: ROUTE_ANCHOR_RADIUS,
        pixelsPerWorldUnit,
        viewportMinPx: Math.min(targetSize.x, targetSize.y),
        semanticZoom: semanticZoomState.state,
      });
      projectionState.push(arcLift.liftScale);
      const projectionChanged = projectionState.some((value, index) => (
        Math.abs(value - lastRouteProjectionState[index]) > 0.00001
      ));
      if (
        !projectionChanged
        && renderedRouteProjectionRevision === routeProjectionRevision
      ) {
        return;
      }
      lastRouteProjectionState.set(projectionState);
      renderedRouteProjectionRevision = routeProjectionRevision;
      camera.updateMatrixWorld();
      globe.updateWorldMatrix(true, false);
      globe.worldToLocal(routeCameraPosition.copy(camera.position));

      const labelBoxes: ProjectedRouteLabelBox[] = [];
      const labelLimit = resolveRouteLabelLimit(currentCompactMobileLayout);
      let visibleLabelCount = 0;
      const routeLineScale = getJourneyRouteLineScale(globe.scale.x);

      const arcWorld = {
        radius: ROUTE_ANCHOR_RADIUS,
        liftScale: arcLift.liftScale,
      };
      let routeEndpointMaxErrorPx = 0;

      routeVectorEntries.forEach((entry) => {
        entry.group.style.setProperty("--journey-route-scale", routeLineScale.toFixed(3));
        const path = buildProjectedRoutePath(
          entry.samples,
          projectRoutePoint,
          arcWorld,
        );
        entry.glowPath.setAttribute("d", path.d);
        entry.corePath.setAttribute("d", path.d);
        entry.flowPath.setAttribute("d", path.d);
        entry.strandPaths[0].setAttribute("d", path.d);
        entry.strandPaths[1].setAttribute("d", path.d);
        // #21 review: each leg projects independently so rewind reveal works
        // per leg (the whole-route paths above stay for the static look).
        // #193: a leg's projected ends are kept so the rendered line can be
        // measured against the rendered marker below.
        const projectedLegEnds: Array<
          [pointIndex: number, point: ProjectedRoutePoint]
        > = [];
        for (const leg of entry.legs) {
          const legPath = buildProjectedRoutePath(
            leg.samples,
            projectRoutePoint,
            arcWorld,
          );
          leg.path.setAttribute("d", legPath.d);
          if (legPath.start) {
            projectedLegEnds.push([leg.toPointIndex - 1, legPath.start]);
          }
          if (legPath.end) projectedLegEnds.push([leg.toPointIndex, legPath.end]);
        }
        const projectedMarkers = new Map<number, ProjectedRoutePoint>();
        const labelCandidates: Array<{
          label: RouteVectorLabel;
          x: number;
          y: number;
        }> = [];
        entry.points.forEach(({ element, ring, position, label, routePointIndex }) => {
          if (!projectRoutePoint(
            position.x,
            position.y,
            position.z,
            routeProjectedPoint,
          )) {
            element.style.display = "none";
            if (ring) ring.style.display = "none";
            if (label) label.element.style.display = "none";
            return;
          }
          element.style.removeProperty("display");
          if (element.tagName === "polygon") {
            element.setAttribute(
              "points",
              buildRoutePointStarPoints(
                routeProjectedPoint.x,
                routeProjectedPoint.y,
                3.6 * JOURNEY_ROUTE_MARKER_SCALE,
                1.52 * JOURNEY_ROUTE_MARKER_SCALE,
              ),
            );
          } else if (element.tagName === "path") {
            element.setAttribute(
              "d",
              buildRoutePointFlagPath(
                routeProjectedPoint.x,
                routeProjectedPoint.y,
                JOURNEY_ROUTE_MARKER_SCALE,
              ),
            );
          } else {
            element.setAttribute("cx", routeProjectedPoint.x.toFixed(1));
            element.setAttribute("cy", routeProjectedPoint.y.toFixed(1));
          }
          if (ring) {
            ring.style.removeProperty("display");
            ring.setAttribute("cx", routeProjectedPoint.x.toFixed(1));
            ring.setAttribute("cy", routeProjectedPoint.y.toFixed(1));
          }
          projectedMarkers.set(routePointIndex, {
            x: routeProjectedPoint.x,
            y: routeProjectedPoint.y,
          });
          // #193: the anchor this marker graphic was drawn around, so QA can
          // measure the rendered route line against the rendered Route Point.
          element.dataset.anchorX = routeProjectedPoint.x.toFixed(2);
          element.dataset.anchorY = routeProjectedPoint.y.toFixed(2);
          element.dataset.routePointIndex = String(routePointIndex);
          if (label) {
            labelCandidates.push({
              label,
              x: routeProjectedPoint.x,
              y: routeProjectedPoint.y,
            });
          }
        });

        // #193 read-back guard: compare the rendered line end against the
        // rendered marker for every Route Point where both are on screen. It
        // reads 0 while both derive from the one anchor and goes non-zero the
        // moment some layer picks a radius of its own again.
        for (const [pointIndex, projectedEnd] of projectedLegEnds) {
          const marker = projectedMarkers.get(pointIndex);
          if (!marker) continue;
          routeEndpointMaxErrorPx = Math.max(
            routeEndpointMaxErrorPx,
            Math.hypot(projectedEnd.x - marker.x, projectedEnd.y - marker.y),
          );
        }

        labelCandidates
          .sort((left, right) => (
            right.label.priority - left.label.priority
            || left.label.pointIndex - right.label.pointIndex
          ))
          .forEach(({ label, x, y }) => {
            if (
              visibleLabelCount >= labelLimit
              || x < 0
              || x > targetSize.x
              || y < 0
              || y > targetSize.y
            ) {
              label.element.style.display = "none";
              return;
            }
            const preferredHorizontal = x + label.width + 38 <= routeLabelSafeArea.right
              ? 1
              : -1;
            const preferredVertical = y - 34 >= routeLabelSafeArea.top ? -1 : 1;
            const directions = [
              [preferredHorizontal, preferredVertical],
              [preferredHorizontal, -preferredVertical],
              [-preferredHorizontal, preferredVertical],
              [-preferredHorizontal, -preferredVertical],
            ];
            let placement: {
              box: ProjectedRouteLabelBox;
              horizontal: number;
              vertical: number;
              textX: number;
              textY: number;
            } | null = null;
            for (const [horizontal, vertical] of directions) {
              const textX = x + horizontal * 24;
              const textY = y + vertical * 22 + (vertical > 0 ? 5 : 0);
              const box = {
                left: horizontal > 0 ? textX : textX - label.width,
                top: textY - 13,
                right: horizontal > 0 ? textX + label.width : textX,
                bottom: textY + 4,
              };
              if (
                box.left < routeLabelSafeArea.left
                || box.right > routeLabelSafeArea.right
                || box.top < routeLabelSafeArea.top
                || box.bottom > routeLabelSafeArea.bottom
                || labelBoxes.some((candidate) => routeLabelBoxesOverlap(candidate, box))
              ) {
                continue;
              }
              placement = { box, horizontal, vertical, textX, textY };
              break;
            }
            if (!placement) {
              label.element.style.display = "none";
              return;
            }

            const elbowX = x + placement.horizontal * 10;
            const elbowY = y + placement.vertical * 10;
            const leaderEndX = placement.textX - placement.horizontal * 5;
            const leaderEndY = placement.textY - 4;
            label.leader.setAttribute(
              "d",
              `M${x.toFixed(1)} ${y.toFixed(1)}`
                + `L${elbowX.toFixed(1)} ${elbowY.toFixed(1)}`
                + `L${leaderEndX.toFixed(1)} ${leaderEndY.toFixed(1)}`,
            );
            label.text.setAttribute("x", placement.textX.toFixed(1));
            label.text.setAttribute("y", placement.textY.toFixed(1));
            label.text.setAttribute(
              "text-anchor",
              placement.horizontal > 0 ? "start" : "end",
            );
            label.element.style.removeProperty("display");
            labelBoxes.push(placement.box);
            visibleLabelCount += 1;
          });

        // Keep the per-route fade gradient pointing from the projected
        // origin toward the projected destination so ribbon/neon strokes
        // fade along the actual travel direction as the globe rotates.
        const origin = entry.points[0];
        const destination = entry.points[entry.points.length - 1];
        if (
          origin
          && destination
          && projectRoutePoint(
            origin.position.x,
            origin.position.y,
            origin.position.z,
            routeProjectedPoint,
          )
        ) {
          const originX = routeProjectedPoint.x;
          const originY = routeProjectedPoint.y;
          if (projectRoutePoint(
            destination.position.x,
            destination.position.y,
            destination.position.z,
            routeProjectedPoint,
          )) {
            entry.fadeGradient.setAttribute("x1", originX.toFixed(1));
            entry.fadeGradient.setAttribute("y1", originY.toFixed(1));
            entry.fadeGradient.setAttribute("x2", routeProjectedPoint.x.toFixed(1));
            entry.fadeGradient.setAttribute("y2", routeProjectedPoint.y.toFixed(1));
          }
        }
      });
      // #193 QA instrumentation: the arc profile, the decorative altitude the
      // frame actually drew, the screen ceiling it was measured against, and
      // the endpoint read-back guard.
      host.dataset.routeArcProfile = arcLift.profile;
      host.dataset.routeArcLift = arcLift.liftScale.toFixed(4);
      host.dataset.routeArcLiftPx = arcLift.screenLiftPx.toFixed(2);
      host.dataset.routeArcLiftCapPx = arcLift.screenLiftCapPx.toFixed(2);
      host.dataset.routeEndpointMaxErrorPx = routeEndpointMaxErrorPx.toFixed(3);
      host.dataset.cityLabelAnchorRadius = ROUTE_ANCHOR_RADIUS.toFixed(3);
      host.dataset.geographicSurfaceRadius = GLOBE_SURFACE_RADIUS.toFixed(3);
      host.dataset.journeyRouteVisibleLabelCount = String(visibleLabelCount);
      host.dataset.journeyRouteLabelSafeRight = routeLabelSafeArea.right.toFixed(1);
      host.dataset.journeyRouteLabelSafeBottom = routeLabelSafeArea.bottom.toFixed(1);

      if (cityTierData) {
        // Containment-aware zoom: national/provincial capitals while distant,
        // add prefecture cities when zoomed in, then every county/town city.
        const scale = globe.scale.x;
        const tier = semanticZoomState.cityTier;
        // Snapshot persistence before a tier reset hides the current pool, so
        // crossing capitals -> prefectures -> all does not throw away label
        // hysteresis exactly at the zoom boundary.
        const persistentCities = new Set(
          cityLabelPool
            .filter((entry) => {
              const city = entry.city;
              if (!city || entry.element.style.display === "none") return false;
              const vector = routePointAnchor(city.latitude, city.longitude);
              if (!projectRoutePoint(vector.x, vector.y, vector.z, routeProjectedPoint)) {
                return false;
              }
              return isProjectedPointInsideViewport(
                routeProjectedPoint.x,
                routeProjectedPoint.y,
                targetSize.x,
                targetSize.y,
              );
            })
            .map((entry) => entry.city!),
        );
        if (tier !== lastCityTier) {
          lastCityTier = tier;
          for (const entry of cityLabelPool) {
            entry.element.style.display = "none";
          }
        }
        // Keep the angular coverage stable as zoom increases. Magnification
        // creates more screen-space room, while the tier only adds lower-rank
        // places; the candidate set therefore grows monotonically instead of
        // losing nearby context at close zoom. Previously visible labels get a
        // modest persistence bonus so tiny wheel/rotation deltas do not churn
        // dense metro labels, while route labels still win every collision.
        const facingThreshold = cityLabelFacingThreshold(scale);
        const maxRank = tier === "capitals" ? 1 : tier === "prefectures" ? 2 : 3;
        // Precompute local -> clip once for this projection state. The regional
        // all-tier scan can contain ~15k cities; a scalar clip/frustum check
        // keeps that scan cheap, while full camera projection remains bounded
        // to the <=72 retained labels below (plus the <=72 persistence snapshot).
        cityClipMatrix
          .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
          .multiply(globe.matrixWorld);
        const cities = selectCityCandidates(
          cityTierData.cities,
          [routeCameraPosition.x, routeCameraPosition.y, routeCameraPosition.z],
          facingThreshold,
          CITY_LABEL_BUDGET,
          maxRank,
          persistentCities,
          isCityCandidateInsideViewport,
        );
        // Labels must never overlap each other or route labels: place in
        // view-center order and skip any label whose box collides.
        // #16: the displayed label resolves through the data pipeline
        // (Chinese cities show their localized name, others fall back).
        const cityLabelLocale = "zh-CN";
        const cityBoxes: ProjectedRouteLabelBox[] = [];
        let visibleCityCount = 0;
        for (let index = 0; index < cities.length; index += 1) {
          if (visibleCityCount >= CITY_LABEL_BUDGET) break;
          const city = cities[index];
          const displayName = resolveCityDisplayName(city, cityLabelLocale);
          const entry = ensureCityLabel(index);
          if (!entry) break;
          const vector = routePointAnchor(city.latitude, city.longitude);
          if (!projectRoutePoint(
            vector.x,
            vector.y,
            vector.z,
            routeProjectedPoint,
          ) || !isProjectedPointInsideViewport(
            routeProjectedPoint.x,
            routeProjectedPoint.y,
            targetSize.x,
            targetSize.y,
          )) {
            entry.element.style.display = "none";
            entry.city = null;
            continue;
          }
          const textX = routeProjectedPoint.x + 6;
          const textY = routeProjectedPoint.y - 5;
          const box = {
            left: textX,
            top: textY - 9,
            right: textX + estimateCityLabelWidth(displayName),
            bottom: textY + 2,
          };
          if (
            cityBoxes.some((candidate) => routeLabelBoxesOverlap(candidate, box, 4))
            || labelBoxes.some((candidate) => routeLabelBoxesOverlap(candidate, box, 4))
          ) {
            entry.element.style.display = "none";
            entry.city = null;
            continue;
          }
          cityBoxes.push(box);
          entry.element.style.removeProperty("display");
          entry.element.setAttribute("x", textX.toFixed(1));
          entry.element.setAttribute("y", textY.toFixed(1));
          // #196: x/y above are the typography position, i.e. the anchor plus
          // the screen-space readability offset. The anchor itself is what
          // claims a latitude/longitude, so it is published separately -
          // exactly as a Route Point marker does - and QA measures that rather
          // than glyph bounds.
          entry.element.dataset.anchorX = routeProjectedPoint.x.toFixed(2);
          entry.element.dataset.anchorY = routeProjectedPoint.y.toFixed(2);
          entry.element.dataset.cityLat = city.latitude.toFixed(4);
          entry.element.dataset.cityLon = city.longitude.toFixed(4);
          entry.element.textContent = displayName;
          entry.city = city;
          visibleCityCount += 1;
        }
        for (let index = cities.length; index < cityLabelPool.length; index += 1) {
          cityLabelPool[index].element.style.display = "none";
          cityLabelPool[index].city = null;
        }
        host.dataset.journeyCityLabelCount = String(visibleCityCount);
      }

      updateJourneyConnector();
    };

    const personalRaycaster = new Raycaster();
    personalRaycaster.params.Points = { threshold: 0.18 };
    const personalPointer = new Vector2();
    const activatePointerTarget = (event: PointerEvent) => {
      const canPickGlobe = Boolean(latestOnGlobePointPick.current);
      const canActivateJourney = Boolean(
        journeyPointTargets.length > 0
        && (
          latestOnJourneyRouteActivate.current
          || latestOnJourneyRoutePointActivate.current
        ),
      );
      if (
        !canPickGlobe
        &&
        !canActivateJourney
        && (
          currentMode !== "focusPoint"
          || !latestCenterFocusPoint.current
          || !latestOnFocusPointActivate.current
        )
      ) {
        return;
      }
      const bounds = renderer.domElement.getBoundingClientRect();
      personalPointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      personalRaycaster.setFromCamera(personalPointer, camera);
      if (canPickGlobe) {
        const [intersection] = personalRaycaster.intersectObject(surface, false);
        if (!intersection) return;
        const picked = vector3ToLatLon(
          globe.worldToLocal(intersection.point.clone()),
        );
        latestOnGlobePointPick.current?.({
          latitude: picked.lat,
          longitude: picked.lon,
        });
        return;
      }
      if (canActivateJourney) {
        camera.updateMatrixWorld();
        globe.updateWorldMatrix(true, false);
        globe.worldToLocal(routeCameraPosition.copy(camera.position));
        const positions = routePointSignals.geometry.getAttribute("position") as
          | BufferAttribute
          | undefined;
        const intersection = personalRaycaster
          .intersectObject(routePointSignals, false)
          .find((candidate) => {
            if (candidate.index === undefined || !positions) return false;
            routeLocalPoint.fromBufferAttribute(positions, candidate.index);
            return isSphericalPointVisible(routeCameraPosition, routeLocalPoint);
          });
        const target = intersection?.index === undefined
          ? undefined
          : journeyPointTargets[intersection.index];
        if (target?.routePointId && latestOnJourneyRoutePointActivate.current) {
          latestOnJourneyRoutePointActivate.current(
            target.journeyId,
            target.routePointId,
          );
          return;
        }
        if (target) {
          latestOnJourneyRouteActivate.current?.(target.journeyId);
          return;
        }
      }
      if (personalRaycaster.intersectObject(personalSignal, false).length > 0) {
        latestOnFocusPointActivate.current?.();
      }
    };
    const interactionRaycaster = new Raycaster();
    const interactionPointer = new Vector2();
    const interactionAnchorScreen = new Vector2();
    const toScenePoint = (point: ScreenPoint) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      return { x: point.x - bounds.left, y: point.y - bounds.top };
    };
    const resolveSurfaceAnchor = (point: ScreenPoint) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      interactionPointer.set(
        ((point.x - bounds.left) / bounds.width) * 2 - 1,
        -((point.y - bounds.top) / bounds.height) * 2 + 1,
      );
      camera.updateMatrixWorld(true);
      globe.updateWorldMatrix(true, false);
      interactionRaycaster.setFromCamera(interactionPointer, camera);
      const [intersection] = interactionRaycaster.intersectObject(surface, false);
      if (!intersection) return null;
      return vector3ToLatLon(globe.worldToLocal(intersection.point.clone()));
    };
    const claimManualInteraction = () => {
      manualFocusRevision = latestFocusRevision.current;
      pointFocusSettling = false;
      routeFocusSettling = false;
      focusTarget = null;
      routeFocusZoomResetting = false;
      syncRouteFocusPhase();
      lastGlobeInteractionAt = performance.now();
      rotationVelocityX = 0;
      rotationVelocityY = 0;
    };
    const applyAnchoredZoom = (
      nextZoom: number,
      anchor: { lat: number; lon: number } | null,
      targetScreen: ScreenPoint,
    ) => {
      const clampedZoom = clampGlobeZoom(nextZoom);
      if (Math.abs(clampedZoom - interactiveZoom) < 0.000001) {
        return anchor !== null;
      }
      const target = GLOBE_MODE_CONFIG[currentMode];
      const nextScale = target.scale * clampedZoom;
      const geometry = readInteractionGeometry(nextScale);
      let anchored = false;
      pinchAnchorErrorPx = null;
      const previousRotationX = interactiveRotationX;
      const previousRotationY = interactiveRotationY;
      if (
        anchor
        && isReliablePinchAnchor(targetScreen, geometry.center, geometry.projectedRadiusPx)
      ) {
        const solved = solveFocusRotationForViewport(
          anchor,
          interactiveRotationX,
          baseRotationY + interactiveRotationY,
          nextScale,
          globe.position.x,
          globe.position.y,
          targetScreen,
          GLOBE_SURFACE_RADIUS,
        );
        pinchAnchorErrorPx = solved.errorPx;
        if (solved.converged && solved.errorPx <= 1) {
          interactiveRotationX = clampGlobeTilt(solved.x);
          interactiveRotationY = solved.y - baseRotationY;
          anchored = true;
        }
      }
      lastGestureAngularDelta = {
        x: interactiveRotationX - previousRotationX,
        y: interactiveRotationY - previousRotationY,
        total: Math.hypot(
          interactiveRotationX - previousRotationX,
          interactiveRotationY - previousRotationY,
        ),
      };
      interactiveZoom = clampedZoom;
      // Direct manipulation owns the transform immediately; frame damping is
      // appropriate for programmed flights, not geometry under the fingers.
      globe.scale.setScalar(nextScale);
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      routeProjectionRevision += 1;
      return anchored;
    };
    let dragPointerId: number | null = null;
    let dragLastX = 0;
    let dragLastY = 0;
    let dragLastTime = 0;
    let dragTravel = 0;
    let dragStarted = false;
    let gestureConsumed = false;
    let pinchDistance = 0;

    const currentPinchDistance = () => {
      const [first, second] = [...activePointers.values()];
      return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
    };
    const currentPinchCentroid = () => {
      const [first, second] = [...activePointers.values()];
      return first && second
        ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
        : null;
    };

    const clearDragState = () => {
      dragPointerId = null;
      dragTravel = 0;
      dragStarted = false;
      gestureConsumed = false;
      pinchDistance = 0;
      pinchAnchor = null;
      pinchAnchorErrorPx = null;
      delete host.dataset.dragging;
    };

    const beginRotationFrom = (
      pointerId: number,
      pointer: { x: number; y: number },
      timeStamp: number,
      alreadyConsumed = false,
    ) => {
      const rebased = rebaseGlobeDragSample(
        pointerId,
        pointer,
        timeStamp,
        alreadyConsumed,
      );
      dragPointerId = rebased.pointerId;
      dragLastX = rebased.lastX;
      dragLastY = rebased.lastY;
      dragLastTime = rebased.lastTime;
      dragTravel = rebased.travel;
      dragStarted = rebased.started;
      lastGestureAngularDelta = { x: 0, y: 0, total: 0 };
      dragAngularDisplacement = { x: 0, y: 0, total: 0 };
    };

    const onCityLayerPointerDown = (event: PointerEvent) => {
      if (
        !latestDragToRotate.current
        || (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }
      // City labels live in a sibling SVG, so contacts that begin there never
      // pass through the canvas pointerdown handler. Once another globe contact is
      // already tracked, remember this sibling-layer contact for its full
      // lifecycle so it can never turn into a delayed city tap after the tracked
      // pointer lifts. Zero-pointer city taps remain ordinary activations.
      if (shouldRememberUntrackedPointerStart(activePointers.size)) {
        rejectedPointerIds.add(event.pointerId);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        !latestDragToRotate.current
        || (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }
      if (!canTrackGlobePointer(activePointers.size)) {
        rejectedPointerIds.add(event.pointerId);
        renderer.domElement.setPointerCapture?.(event.pointerId);
        return;
      }
      rejectedPointerIds.delete(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      claimManualInteraction();
      renderer.domElement.setPointerCapture?.(event.pointerId);
      if (activePointers.size === 1) {
        beginRotationFrom(
          event.pointerId,
          { x: event.clientX, y: event.clientY },
          event.timeStamp,
        );
      } else if (activePointers.size === 2) {
        gestureConsumed = true;
        dragStarted = true;
        dragPointerId = null;
        pinchDistance = currentPinchDistance();
        const centroid = currentPinchCentroid();
        pinchAnchor = centroid ? resolveSurfaceAnchor(centroid) : null;
        pinchAnchorErrorPx = null;
        host.dataset.dragging = "true";
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.size >= 2) {
        event.preventDefault();
        const nextDistance = currentPinchDistance();
        const centroid = currentPinchCentroid();
        if (pinchDistance > 0 && nextDistance > 0) {
          const targetScreen = centroid ? toScenePoint(centroid) : null;
          const anchored = targetScreen
            ? applyAnchoredZoom(
              interactiveZoom * (nextDistance / pinchDistance),
              pinchAnchor,
              targetScreen,
            )
            : false;
          if (pinchAnchor && !anchored) pinchAnchor = null;
        }
        pinchDistance = nextDistance;
        gestureConsumed = true;
        dragStarted = true;
        host.dataset.dragging = "true";
        return;
      }
      if (event.pointerId !== dragPointerId) return;
      const deltaX = event.clientX - dragLastX;
      const deltaY = event.clientY - dragLastY;
      const elapsed = Math.max(
        0.008,
        Math.min(0.064, (event.timeStamp - dragLastTime) / 1000),
      );
      dragLastX = event.clientX;
      dragLastY = event.clientY;
      dragLastTime = event.timeStamp;
      dragTravel += Math.hypot(deltaX, deltaY);
      if (!dragStarted && isGlobeDrag(dragTravel)) {
        dragStarted = true;
        gestureConsumed = true;
        host.dataset.dragging = "true";
      }
      if (!dragStarted) return;

      event.preventDefault();
      lastGlobeInteractionAt = performance.now();
      const geometry = readInteractionGeometry();
      const previous = toScenePoint({ x: event.clientX - deltaX, y: event.clientY - deltaY });
      const current = toScenePoint({ x: event.clientX, y: event.clientY });
      const rotationDelta = projectedRadiusRotationDelta(
        previous,
        current,
        geometry.interactionRadiusPx,
      );
      const rotationDeltaX = rotationDelta.rotationX;
      const rotationDeltaY = rotationDelta.rotationY;
      lastGestureAngularDelta = {
        x: rotationDeltaX,
        y: rotationDeltaY,
        total: Math.hypot(rotationDeltaX, rotationDeltaY),
      };
      dragAngularDisplacement.x += rotationDeltaX;
      dragAngularDisplacement.y += rotationDeltaY;
      dragAngularDisplacement.total = Math.hypot(
        dragAngularDisplacement.x,
        dragAngularDisplacement.y,
      );
      interactiveRotationX = clampGlobeTilt(interactiveRotationX + rotationDeltaX);
      interactiveRotationY += rotationDeltaY;
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      routeProjectionRevision += 1;
      const nextVelocityX = rotationDeltaX / elapsed;
      const nextVelocityY = rotationDeltaY / elapsed;
      const speed = Math.hypot(nextVelocityX, nextVelocityY);
      const speedLimit = getGlobeInertiaSpeedLimit(geometry.interactionRadiusPx);
      const velocityScale = speed > speedLimit ? speedLimit / speed : 1;
      rotationVelocityX = nextVelocityX * velocityScale;
      rotationVelocityY = nextVelocityY * velocityScale;
    };

    const finishPointer = (event: PointerEvent, allowActivation: boolean) => {
      if (!activePointers.has(event.pointerId)) return;
      const wasGesture = gestureConsumed || dragStarted || activePointers.size > 1;
      activePointers.delete(event.pointerId);
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) {
        renderer.domElement.releasePointerCapture?.(event.pointerId);
      }
      if (activePointers.size === 1) {
        const [remainingId, remainingPointer] = [...activePointers.entries()][0];
        gestureConsumed = wasGesture;
        pinchDistance = 0;
        pinchAnchor = null;
        pinchAnchorErrorPx = null;
        beginRotationFrom(
          remainingId,
          remainingPointer,
          event.timeStamp,
          wasGesture,
        );
        return;
      }

      if (
        !wasGesture
        || reduceMotion
        || !shouldRetainGlobeInertia(
          dragLastTime,
          event.timeStamp,
          lastGestureAngularDelta.total,
        )
      ) {
        rotationVelocityX = 0;
        rotationVelocityY = 0;
      }
      lastGlobeInteractionAt = performance.now();
      clearDragState();
      if (allowActivation && !wasGesture) activatePointerTarget(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (activePointers.has(event.pointerId)) {
        finishPointer(event, isPrimaryPointerActivation(event));
        return;
      }
      const rejectedByGestureCapacity = rejectedPointerIds.delete(event.pointerId);
      if (
        isPrimaryPointerActivation(event)
        && !shouldSuppressUntrackedPointerActivation(
          rejectedByGestureCapacity,
          activePointers.size,
        )
      ) {
        activatePointerTarget(event);
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (rejectedPointerIds.delete(event.pointerId)) return;
      finishPointer(event, false);
    };
    const onRejectedPointerLifecycleEnd = (event: PointerEvent) => {
      rejectedPointerIds.delete(event.pointerId);
    };
    const onLostPointerCapture = (event: PointerEvent) => {
      rejectedPointerIds.delete(event.pointerId);
      if (!activePointers.has(event.pointerId)) return;
      activePointers.delete(event.pointerId);
      rotationVelocityX = 0;
      rotationVelocityY = 0;
      if (activePointers.size === 0) {
        clearDragState();
      } else {
        pinchAnchor = null;
        pinchAnchorErrorPx = null;
        const [remainingId, remainingPointer] = [...activePointers.entries()][0];
        gestureConsumed = true;
        beginRotationFrom(remainingId, remainingPointer, event.timeStamp, true);
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!latestDragToRotate.current || !latestWheelToZoom.current) return;
      event.preventDefault();
      const focusedAnchor = manualFocusRevision === null
        ? routeFocusFrame?.center ?? latestFocusPoint.current ?? null
        : null;
      const cursor = { x: event.clientX, y: event.clientY };
      const anchor = focusedAnchor ?? resolveSurfaceAnchor(cursor);
      const targetScreen = focusedAnchor
        ? (() => {
          const projected = projectFocusPointForRotation(
            focusedAnchor,
            globe.rotation.x,
            globe.rotation.y,
            globe.scale.x,
            globe.position.x,
            globe.position.y,
            interactionAnchorScreen,
          );
          return { x: projected.x, y: projected.y };
        })()
        : toScenePoint(cursor);
      claimManualInteraction();
      wheelInteractionUntil = performance.now() + 180;
      // Stay in the particle globe at maximum zoom so cities stay pickable;
      // entering the real map is an explicit button choice.
      applyAnchoredZoom(
        interactiveZoom * Math.exp(-event.deltaY * GLOBE_WHEEL_ZOOM_SPEED),
        anchor,
        targetScreen,
      );
      pinchAnchorErrorPx = null;
    };

    cityVectorLayer.addEventListener("pointerdown", onCityLayerPointerDown);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("lostpointercapture", onLostPointerCapture);
    window.addEventListener("pointerup", onRejectedPointerLifecycleEnd);
    window.addEventListener("pointercancel", onRejectedPointerLifecycleEnd);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    let particleMaterial = createParticleEarthMaterial({
      color: 0x61e4dc,
      opacity: 0,
      size: 8.8,
    });
    particleDimmingMaterials.push(particleMaterial);
    syncParticleDimming(latestJourneyRoutes.current, latestActiveJourneyRouteId.current);
    let particleGeometry: BufferGeometry | null = null;
    let particles: Points | null = null;
    let landVisualReady = false;
    let baseCoastlineSourceAvailable = false;
    const refinementBuildGuard = new ParticleRefinementBuildGuard();
    refinementBuildGuard.setVisible(!document.hidden);
    const refinementCache = new Map<
      string,
      {
        region: ParticleRefinementRegion;
        particleCap: number;
        sample: RegionalLandSample;
      }
    >();
    const refinementViewPosition = new Vector3();
    let activeRefinementLayer: ParticleRefinementLayer | null = null;
    let departingRefinementLayer: ParticleRefinementLayer | null = null;
    let requestedRefinementCacheKey: string | null = null;
    let lastRefinementViewSampleAt = Number.NEGATIVE_INFINITY;
    let refinementBuildState = document.hidden ? "paused" : "idle";
    let landSourceDebug = "loading:ne_110m_land.geojson@110m";
    const coastlineRefinementCache = new CoastlineRefinementCache();
    const coastlineViewPosition = new Vector3();
    let detailedCoastlineRings: number[][][] = [];
    let detailedMidCoastlineReady = false;
    let activeCoastlineRegionKey: string | null = null;
    let coastlineRefinementState = document.hidden ? "paused" : "fallback";
    let lastCoastlineRefinementSampleAt = Number.NEGATIVE_INFINITY;

    const removeParticleDimmingMaterial = (
      material: ReturnType<typeof createParticleEarthMaterial>,
    ) => {
      const index = particleDimmingMaterials.indexOf(material);
      if (index >= 0) particleDimmingMaterials.splice(index, 1);
    };

    const disposeRefinementLayer = (layer: ParticleRefinementLayer | null) => {
      if (!layer) return;
      globe.remove(layer.points);
      removeParticleDimmingMaterial(layer.material);
      layer.geometry.dispose();
      layer.material.dispose();
    };

    const cacheRefinementSample = (
      cacheKey: string,
      region: ParticleRefinementRegion,
      particleCap: number,
      sample: RegionalLandSample,
    ) => {
      refinementCache.delete(cacheKey);
      refinementCache.set(cacheKey, { region, particleCap, sample });
      while (refinementCache.size > PARTICLE_REFINEMENT_CACHE_LIMIT) {
        const oldestKey = refinementCache.keys().next().value;
        if (typeof oldestKey !== "string") break;
        refinementCache.delete(oldestKey);
      }
    };

    const readCachedRefinement = (cacheKey: string) => {
      const cached = refinementCache.get(cacheKey);
      if (!cached) return null;
      refinementCache.delete(cacheKey);
      refinementCache.set(cacheKey, cached);
      return cached;
    };

    const applyRefinementSample = (
      cacheKey: string,
      region: ParticleRefinementRegion,
      particleCap: number,
      sample: RegionalLandSample,
    ) => {
      if (activeRefinementLayer?.cacheKey === cacheKey) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(sample.positions, 3));
      geometry.setAttribute(
        "targetPosition",
        new BufferAttribute(createBurstTargets(sample.positions), 3),
      );
      geometry.setAttribute(
        "lodThreshold",
        new BufferAttribute(sample.lodThresholds, 1),
      );
      if (sample.positions.length > 0) geometry.computeBoundingSphere();
      const material = createParticleEarthMaterial({
        color: 0x74eee6,
        opacity: 0,
        size: 7.2,
        spatialLod: true,
      });
      material.uniforms.uViewportHeight.value = targetSize.y;
      const points = new Points(geometry, material);
      globe.add(points);
      particleDimmingMaterials.push(material);
      syncParticleDimming(
        latestJourneyRoutes.current,
        latestActiveJourneyRouteId.current,
      );

      const previousActive = activeRefinementLayer;
      const previousDeparting = departingRefinementLayer;
      if (previousActive && previousDeparting) {
        const activeOpacity = previousActive.material.uniforms.uOpacity.value as number;
        const departingOpacity = previousDeparting.material.uniforms.uOpacity.value as number;
        if (activeOpacity >= departingOpacity) {
          disposeRefinementLayer(previousDeparting);
          departingRefinementLayer = previousActive;
        } else {
          disposeRefinementLayer(previousActive);
          departingRefinementLayer = previousDeparting;
        }
      } else {
        departingRefinementLayer = previousActive ?? previousDeparting;
      }
      activeRefinementLayer = {
        cacheKey,
        region,
        particleCap,
        sampleCount: sample.positions.length / 3,
        geometry,
        material,
        points,
      };
      refinementBuildState = "ready";
    };

    const yieldRefinementBuild = () => new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    const requestRefinementRegion = (region: ParticleRefinementRegion) => {
      const qualityAtRequest = currentQuality;
      const particleCap = currentParticleLod.particleCap;
      const cacheKey = `${qualityAtRequest}:${region.key}`;
      if (activeRefinementLayer?.cacheKey === cacheKey) {
        if (shouldCancelPendingRefinementRequest({
          activeCacheKey: activeRefinementLayer.cacheKey,
          requestedCacheKey: requestedRefinementCacheKey,
          targetCacheKey: cacheKey,
        })) {
          refinementBuildGuard.invalidate();
          requestedRefinementCacheKey = null;
        }
        refinementBuildState = "ready";
        return;
      }
      if (requestedRefinementCacheKey === cacheKey) return;
      requestedRefinementCacheKey = cacheKey;
      const ticket = refinementBuildGuard.request(cacheKey);
      const cached = readCachedRefinement(cacheKey);
      if (cached) {
        refinementBuildState = "cached";
        if (refinementBuildGuard.isCurrent(ticket)) {
          applyRefinementSample(
            cacheKey,
            cached.region,
            cached.particleCap,
            cached.sample,
          );
        }
        return;
      }

      refinementBuildState = "building";
      void (async () => {
        const source = await loadParticleRefinementLandMask();
        const requestIsCurrent = refinementBuildGuard.isCurrent(ticket);
        if (
          !source
          || currentQuality !== qualityAtRequest
          || !requestIsCurrent
        ) {
          if (!source) {
            requestedRefinementCacheKey = releaseFailedParticleRefinementRequest({
              requestedCacheKey: requestedRefinementCacheKey,
              failedCacheKey: cacheKey,
              requestIsCurrent,
            });
          }
          if (requestIsCurrent) {
            refinementBuildState = source ? "cancelled" : "source-unavailable";
          }
          return;
        }
        const sample = await buildRegionalLandSample({
          region,
          count: particleCap,
          isLand: (lat, lon) => isParticleLand(source, lat, lon),
          shouldContinue: () => (
            currentQuality === qualityAtRequest
            && refinementBuildGuard.isCurrent(ticket)
          ),
          yieldControl: yieldRefinementBuild,
        });
        if (!sample || !refinementBuildGuard.isCurrent(ticket)) return;
        cacheRefinementSample(cacheKey, region, particleCap, sample);
        applyRefinementSample(cacheKey, region, particleCap, sample);
      })();
    };

    const applyNearCoastlinePositions = (positions: Float32Array, regionKey: string, terminalState: "ready" | "cached" = "ready") => {
      const nextGeometry = new BufferGeometry();
      nextGeometry.setAttribute("position", new BufferAttribute(positions, 3));
      if (positions.length > 0) nextGeometry.computeBoundingSphere();
      const previous = nearCoastlineGeometry;
      nearCoastlineGeometry = nextGeometry;
      nearCoastlines.geometry = nextGeometry;
      previous.dispose();
      activeCoastlineRegionKey = regionKey;
      coastlineRefinementState = terminalState;
    };

    const requestCoastlineRefinement = (viewCenter: { lat: number; lon: number }) => {
      if (detailedCoastlineRings.length === 0 || document.hidden) return;
      const region = resolveCoastlineRefinementRegion(viewCenter);
      const cacheKey = `${currentQuality}:${region.key}`;
      if (activeCoastlineRegionKey === cacheKey) return;
      const cached = coastlineRefinementCache.get(cacheKey);
      if (cached) {
        applyNearCoastlinePositions(cached, cacheKey, "cached");
        return;
      }
      coastlineRefinementState = "building";
      const positions = buildRegionalCoastlinePositions({
        rings: detailedCoastlineRings,
        region,
        quality: currentQuality,
      });
      coastlineRefinementCache.set(cacheKey, positions);
      applyNearCoastlinePositions(positions, cacheKey);
    };

    const updateCoastlineRefinement = (now: number) => {
      if (semanticZoomState.coastlineWeights.near <= 0.001) return;
      if (isFocusFlightActive(pointFocusSettling, routeFocusSettling)) {
        coastlineRefinementState = "deferred-flight";
        return;
      }
      if (activePointers.size > 0 || rotationVelocityX !== 0 || rotationVelocityY !== 0 || now < wheelInteractionUntil) {
        coastlineRefinementState = "deferred-interaction";
        return;
      }
      if (document.hidden || now - lastCoastlineRefinementSampleAt < 200) return;
      lastCoastlineRefinementSampleAt = now;
      camera.updateMatrixWorld();
      globe.updateWorldMatrix(true, false);
      globe.worldToLocal(coastlineViewPosition.copy(camera.position));
      requestCoastlineRefinement(vector3ToLatLon(coastlineViewPosition));
    };

    let reliefTextureReady = false;
    host.dataset.reliefTexture = reliefExperimentEnabled ? "loading" : "disabled";
    const reliefTexture = reliefExperimentEnabled
      ? new TextureLoader().load(
          "/earth/natural-earth-shaded-relief-2048.jpg",
          (loadedTexture) => {
            reliefMaterial.bumpMap = loadedTexture;
            reliefMaterial.needsUpdate = true;
            reliefTextureReady = true;
            host.dataset.reliefTexture = "ready";
          },
          undefined,
          () => {
            reliefTextureReady = false;
            host.dataset.reliefTexture = "unavailable";
          },
        )
      : null;

    const texture = new TextureLoader().load(
      "/earth/nasa-earth-with-clouds-2048.jpg",
      (loadedTexture) => {
        loadedTexture.colorSpace = SRGBColorSpace;
        surfaceMaterial.map = loadedTexture;
        surfaceMaterial.needsUpdate = true;
      },
    );

    const applyFocusPoint = (point: { lat: number; lon: number } | null | undefined) => {
      const fallback =
        currentMode === "archiveBurst"
          ? { lat: -10, lon: -180 }
          : { lat: 34.0522, lon: -118.2437 };
      const vector = focusSignalAnchor(point, fallback)
        .multiplyScalar(PERSONAL_SIGNAL_RENDER_LIFT);
      const attribute = personalGeometry.getAttribute("position") as BufferAttribute;
      attribute.setXYZ(0, vector.x, vector.y, vector.z);
      attribute.needsUpdate = true;
      const targetAttribute = personalGeometry.getAttribute("targetPosition") as BufferAttribute;
      targetAttribute.setXYZ(0, vector.x, vector.y, vector.z);
      targetAttribute.needsUpdate = true;
    };

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      targetSize.set(Math.max(1, bounds.width), Math.max(1, bounds.height));
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, QUALITY_PROFILE[currentQuality].maxDpr),
      );
      renderer.setSize(targetSize.x, targetSize.y, false);
      routeVectorLayer.setAttribute(
        "viewBox",
        `0 0 ${targetSize.x} ${targetSize.y}`,
      );
      cityVectorLayer.setAttribute(
        "viewBox",
        `0 0 ${targetSize.x} ${targetSize.y}`,
      );
      updateRouteLabelSafeArea();
      // A layout change moves the card as well as the scene, so the connector
      // is re-measured and redrawn on the same frame.
      sampleJourneyConnectorCard(true);
      routeProjectionRevision += 1;
      camera.aspect = targetSize.x / targetSize.y;
      camera.updateProjectionMatrix();
      sampleFocusViewport(true);
      particleMaterial.uniforms.uViewportHeight.value = targetSize.y;
      if (archiveMaterial) archiveMaterial.uniforms.uViewportHeight.value = targetSize.y;
      clusterMaterial.uniforms.uViewportHeight.value = targetSize.y;
      cyanClusterMaterial.uniforms.uViewportHeight.value = targetSize.y;
      shellMaterial.uniforms.uViewportHeight.value = targetSize.y;
      haloMaterial.uniforms.uViewportHeight.value = targetSize.y;
      personalMaterial.uniforms.uViewportHeight.value = targetSize.y;
      if (activeRefinementLayer) {
        activeRefinementLayer.material.uniforms.uViewportHeight.value = targetSize.y;
      }
      if (departingRefinementLayer) {
        departingRefinementLayer.material.uniforms.uViewportHeight.value = targetSize.y;
      }
    };

    const rebuildLandVisualData = async (nextQuality: keyof typeof QUALITY_PROFILE) => {
      const revision = ++qualityBuildRevision;
      const {
        particlePositions,
        coastlinePositions,
        detailedCoastlinePositions,
        landSourceAvailable,
      } = await buildLandVisualData(QUALITY_PROFILE[nextQuality].particleCount);
      if (disposed || revision !== qualityBuildRevision || currentQuality !== nextQuality) return;

      const nextParticleGeometry = new BufferGeometry();
      nextParticleGeometry.setAttribute("position", new BufferAttribute(particlePositions, 3));
      nextParticleGeometry.setAttribute(
        "targetPosition",
        new BufferAttribute(createBurstTargets(particlePositions), 3),
      );
      if (particles) {
        const previousGeometry = particleGeometry;
        particles.geometry = nextParticleGeometry;
        particleGeometry = nextParticleGeometry;
        previousGeometry?.dispose();
      } else {
        particleGeometry = nextParticleGeometry;
        particles = new Points(particleGeometry, particleMaterial);
        particles.renderOrder = GLOBE_RENDER_ORDER.particle;
        globe.add(particles);
      }

      const nextCoastlineGeometry = new BufferGeometry();
      nextCoastlineGeometry.setAttribute("position", new BufferAttribute(coastlinePositions, 3));
      if (coastlinePositions.length > 0) nextCoastlineGeometry.computeBoundingSphere();
      const previousCoastlineGeometry = coastlineGeometry;
      coastlineGeometry = nextCoastlineGeometry;
      coastlines.geometry = coastlineGeometry;
      previousCoastlineGeometry.dispose();
      const applyDetailedCoastlinePositions = (positionsByLod: { mid: Float32Array; near: Float32Array }) => {
        for (const [lod, positions] of Object.entries(positionsByLod) as ["mid" | "near", Float32Array][]) {
          const nextGeometry = new BufferGeometry();
          nextGeometry.setAttribute("position", new BufferAttribute(positions, 3));
          if (positions.length > 0) nextGeometry.computeBoundingSphere();
          if (lod === "mid") {
            const previous = midCoastlineGeometry; midCoastlineGeometry = nextGeometry; midCoastlines.geometry = nextGeometry; previous.dispose();
          } else {
            const previous = nearCoastlineGeometry; nearCoastlineGeometry = nextGeometry; nearCoastlines.geometry = nextGeometry; previous.dispose();
          }
        }
      };
      applyDetailedCoastlinePositions(detailedCoastlinePositions);
      detailedMidCoastlineReady = false;

      host.dataset.quality = nextQuality;
      host.dataset.particleCount = String(particlePositions.length / 3);
      host.dataset.particleBaseCount = String(particlePositions.length / 3);
      host.dataset.coastlineVertices = String(coastlinePositions.length / 3);
      baseCoastlineSourceAvailable = landSourceAvailable;
      landSourceDebug = landSourceAvailable
        ? "base=ne_110m_land.geojson@110m;mask=720x360;refinement=ne_50m_land.geojson@50m;mask=1440x720"
        : "fallback-seeded-sphere;refinement=unavailable";
      host.dataset.particleLandSource = landSourceDebug;
      if (!landVisualReady) {
        landVisualReady = true;
        setReady(true);
        latestOnReady.current?.();
      }

      void loadDetailedCoastlineData().then((detailed) => {
        if (!detailed || disposed || revision !== qualityBuildRevision || currentQuality !== nextQuality) return;
        detailedCoastlineRings = detailed.rings;
        applyDetailedCoastlinePositions({ mid: detailed.mid, near: nearCoastlineGeometry.getAttribute("position")
          ? new Float32Array((nearCoastlineGeometry.getAttribute("position") as BufferAttribute).array as ArrayLike<number>)
          : new Float32Array() });
        detailedMidCoastlineReady = true;
        activeCoastlineRegionKey = null;
        coastlineRefinementState = "idle";
      });
    };

    const applyQuality = (nextQuality: keyof typeof QUALITY_PROFILE) => {
      if (currentQuality === nextQuality && landVisualReady) return;
      currentQuality = nextQuality;
      host.dataset.quality = nextQuality;
      refinementBuildGuard.invalidate();
      requestedRefinementCacheKey = null;
      refinementBuildState = document.hidden ? "paused" : "idle";
      resize();
      void rebuildLandVisualData(nextQuality);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener("resize", resize);
    resize();

    const updateParticleLodDebug = () => {
      const refinementCount = activeRefinementLayer
        ? Math.min(activeRefinementLayer.sampleCount, currentParticleLod.activeCount)
        : 0;
      const setDebugValue = (key: keyof DOMStringMap, value: string) => {
        if (host.dataset[key] !== value) host.dataset[key] = value;
      };
      setDebugValue("particleLod", currentParticleLod.level);
      setDebugValue(
        "particleLodProgress",
        currentParticleLod.refinementProgress.toFixed(3),
      );
      setDebugValue("particleRefinementCount", String(refinementCount));
      setDebugValue("particleRefinementCap", String(currentParticleLod.particleCap));
      setDebugValue("particleRefinementBuild", refinementBuildState);
      if (activeRefinementLayer) {
        setDebugValue("particleRefinementRegion", activeRefinementLayer.region.key);
        setDebugValue(
          "particleRefinementRegionLat",
          String(activeRefinementLayer.region.center.lat),
        );
        setDebugValue(
          "particleRefinementRegionLon",
          String(activeRefinementLayer.region.center.lon),
        );
        setDebugValue(
          "particleRefinementRegionRadius",
          String(activeRefinementLayer.region.radiusDegrees),
        );
      } else {
        if (host.dataset.particleRefinementRegion !== undefined) {
          delete host.dataset.particleRefinementRegion;
          delete host.dataset.particleRefinementRegionLat;
          delete host.dataset.particleRefinementRegionLon;
          delete host.dataset.particleRefinementRegionRadius;
        }
      }
    };

    const updateParticleRefinement = (now: number) => {
      const refinementFocusFlightActive = isFocusFlightActive(
        pointFocusSettling,
        routeFocusSettling,
      );
      currentParticleLod = resolveParticleRefinementLodForFrame({
        zoom: interactiveZoom,
        quality: currentQuality,
        current: currentParticleLod,
        focusFlightActive: refinementFocusFlightActive,
      });
      if (refinementFocusFlightActive) {
        if (requestedRefinementCacheKey !== null) {
          refinementBuildGuard.invalidate();
          requestedRefinementCacheKey = null;
          refinementBuildState = activeRefinementLayer ? "ready" : "idle";
        }
        updateParticleLodDebug();
        return;
      }
      if (currentParticleLod.activeCount === 0) {
        if (requestedRefinementCacheKey !== null) {
          refinementBuildGuard.invalidate();
          requestedRefinementCacheKey = null;
          refinementBuildState = "idle";
        }
        updateParticleLodDebug();
        return;
      }
      if (
        document.hidden
        || now - lastRefinementViewSampleAt < 160
      ) {
        updateParticleLodDebug();
        return;
      }
      lastRefinementViewSampleAt = now;
      camera.updateMatrixWorld();
      globe.updateWorldMatrix(true, false);
      globe.worldToLocal(refinementViewPosition.copy(camera.position));
      const viewCenter = vector3ToLatLon(refinementViewPosition);
      requestRefinementRegion(resolveParticleRefinementRegion(viewCenter));
      updateParticleLodDebug();
    };

    const render = (now: number) => {
      if (disposed) return;
      const elapsedDelta = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
      const delta = Math.min(0.05, elapsedDelta);
      lastTime = now;
      const target = GLOBE_MODE_CONFIG[currentMode];
      const audioEnergy = reduceMotion
        ? { low: 0, mid: 0, high: 0, overall: 0 }
        : readAudioAtmosphereEnergy();
      // #20: restrained energy mapping. Even at full energy the environment
      // only gains 12–15%, so it feels alive rather than becoming a visualizer.
      const audioGain = audioAtmosphereGains(audioEnergy);
      const spatialFocusPoint = focusTarget?.point ?? routeFocusFrame?.center ?? latestFocusPoint.current;
      const focusSolverOwnsState = manualFocusRevision === null;
      const focusFlightActive = Boolean(
        focusSolverOwnsState
        &&
        currentMode === "focusPoint"
        && latestCenterFocusPoint.current
        && spatialFocusPoint
        && isFocusFlightActive(pointFocusSettling, routeFocusSettling),
      );
      let targetRotationX = focusSolverOwnsState && focusTarget
        ? focusTarget.rotationX
        : focusSolverOwnsState && spatialFocusPoint
          ? rotationXForLatitude(spatialFocusPoint.lat)
        : interactiveRotationX;
      let targetBaseRotationY = focusSolverOwnsState && focusTarget
        ? focusTarget.rotationY
        : focusSolverOwnsState && spatialFocusPoint
          ? rotationYForLongitude(spatialFocusPoint.lon)
        : manualFocusRevision !== null
          ? baseRotationY
          : latestRotationYOverride.current ?? target.rotationY;
      if (import.meta.env.DEV && focusFlightActive && focusTarget) {
        host.dataset.focusFlightCurrentRotationX = interactiveRotationX.toFixed(6);
        host.dataset.focusFlightCurrentRotationY = baseRotationY.toFixed(6);
        host.dataset.focusSignedDeltaX = getShortestRotationDelta(
          interactiveRotationX,
          focusTarget.rotationX,
        ).toFixed(6);
        host.dataset.focusSignedDeltaY = getShortestRotationDelta(
          baseRotationY,
          focusTarget.rotationY,
        ).toFixed(6);
      }
      const snap = reduceMotion ? 1 : 0;
      const flightSpeed = latestFocusFlightProfile.current === "nearby"
        ? 7.2
        : latestFocusFlightProfile.current === "long-haul"
          ? 4.4
          : 5.5;
      const interpolate = (value: number, next: number) =>
        snap ? next : damp(value, next, delta, focusFlightActive ? flightSpeed : 5.5);
      let focusSettledThisFrame = false;
      for (const material of particleDimmingMaterials) {
        material.uniforms.uActiveDimStrength.value = interpolate(
          material.uniforms.uActiveDimStrength.value,
          particleActiveDimStrengthTarget,
        );
      }

      if (
        pointFocusSettling
        && !routeFocusFrame
        && spatialFocusPoint
        && activePointers.size === 0
      ) {
        interactiveRotationX = interpolate(interactiveRotationX, targetRotationX);
        interactiveRotationY = interpolate(interactiveRotationY, 0);
        if (latestFocusFlightProfile.current) {
          interactiveZoom = interpolate(interactiveZoom, 1);
        }
        if (
          Math.abs(getShortestRotationDelta(interactiveRotationX, targetRotationX)) < 0.002
          && Math.abs(interactiveRotationY) < 0.002
          && Math.abs(getShortestRotationDelta(baseRotationY, targetBaseRotationY)) < 0.003
          && (!latestFocusFlightProfile.current || Math.abs(interactiveZoom - 1) < 0.003)
          && Math.abs(globe.scale.x - target.scale * interactiveZoom) < 0.003
        ) {
          interactiveRotationX = targetRotationX;
          interactiveRotationY = 0;
          recordFocusArrival(
            spatialFocusPoint,
            targetRotationX,
            targetBaseRotationY,
            target.scale * interactiveZoom,
            target.x,
            target.y,
          );
          focusSettledThisFrame = true;
          pointFocusSettling = false;
          if (import.meta.env.DEV) {
            host.dataset.focusSettleCount = String(
              Number(host.dataset.focusSettleCount ?? 0) + 1,
            );
          }
          // Hold the arrival composition for a full inactivity window. Any
          // later user interaction refreshes the same timer before release.
          lastGlobeInteractionAt = now;
        }
      }

      if (routeFocusSettling && routeFocusFrame && activePointers.size === 0) {
        interactiveRotationX = interpolate(interactiveRotationX, targetRotationX);
        interactiveRotationY = interpolate(interactiveRotationY, 0);
        interactiveZoom = interpolate(interactiveZoom, routeFocusFrame.zoom);
        if (
          Math.abs(getShortestRotationDelta(interactiveRotationX, targetRotationX)) < 0.002
          && Math.abs(interactiveRotationY) < 0.002
          && Math.abs(interactiveZoom - routeFocusFrame.zoom) < 0.003
          && Math.abs(getShortestRotationDelta(baseRotationY, targetBaseRotationY)) < 0.003
          && Math.abs(globe.scale.x - target.scale * routeFocusFrame.zoom) < 0.003
        ) {
          interactiveRotationX = targetRotationX;
          interactiveRotationY = 0;
          interactiveZoom = routeFocusFrame.zoom;
          recordFocusArrival(
            routeFocusFrame.center,
            targetRotationX,
            targetBaseRotationY,
            target.scale * routeFocusFrame.zoom,
            target.x,
            target.y,
          );
          focusSettledThisFrame = true;
          routeFocusSettling = false;
          if (import.meta.env.DEV) {
            host.dataset.focusSettleCount = String(
              Number(host.dataset.focusSettleCount ?? 0) + 1,
            );
          }
          lastGlobeInteractionAt = now;
          syncRouteFocusPhase();
        }
      }

      if (routeFocusZoomResetting && activePointers.size === 0) {
        interactiveZoom = interpolate(interactiveZoom, 1);
        if (Math.abs(interactiveZoom - 1) < 0.003) {
          interactiveZoom = 1;
          routeFocusZoomResetting = false;
          syncRouteFocusPhase();
        }
      }

      globe.scale.setScalar(interpolate(globe.scale.x, target.scale * interactiveZoom));
      baseRotationY = interpolate(baseRotationY, targetBaseRotationY);
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      // Journey selection rotates (and may zoom) the globe, but never translates
      // its screen position. The globe's x/y belongs to the layout/mode only.
      globe.position.x = interpolate(globe.position.x, target.x);
      globe.position.y = interpolate(globe.position.y, target.y);
      if (activePointers.size === 0 && !reduceMotion && !focusSettledThisFrame) {
        interactiveRotationX = clampGlobeTilt(
          interactiveRotationX + rotationVelocityX * delta,
        );
        interactiveRotationY += rotationVelocityY * delta;
        const inertia = Math.exp(-GLOBE_INERTIA_FRICTION * delta);
        rotationVelocityX *= inertia;
        rotationVelocityY *= inertia;
        if (Math.abs(rotationVelocityX) < 0.001) rotationVelocityX = 0;
        if (Math.abs(rotationVelocityY) < 0.001) rotationVelocityY = 0;
        const hasMomentum = rotationVelocityX !== 0 || rotationVelocityY !== 0;
        const idleForMs = now - lastGlobeInteractionAt;
        const motionDisabled = isIdleRotationSuppressed(
          latestDragToRotate.current,
          pointFocusSettling,
          routeFocusSettling,
        );
        idleReleasePhase = advanceGlobeIdleReleasePhase(
          idleReleasePhase,
          delta,
          idleForMs,
          hasMomentum,
          motionDisabled,
        );
        interactiveRotationX = getGlobeIdleAlignmentRotation(
          interactiveRotationX,
          delta,
          idleForMs,
          hasMomentum,
          motionDisabled,
          idleReleasePhase,
        );
        interactiveRotationY += getGlobeIdleRotationDelta(
          elapsedDelta,
          idleForMs,
          hasMomentum,
          motionDisabled,
          isGlobeUpright(interactiveRotationX),
          idleReleasePhase,
        );
      }
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      updateParticleRefinement(now);
      particleMaterial.uniforms.uMorph.value = interpolate(
        particleMaterial.uniforms.uMorph.value,
        target.burst,
      );
      particleMaterial.uniforms.uOpacity.value = interpolate(
        particleMaterial.uniforms.uOpacity.value,
        target.particleOpacity,
      );
      const blendRefinement = (value: number, next: number) => (
        snap ? next : damp(value, next, delta, 7.5)
      );
      if (activeRefinementLayer) {
        const refinementOpacity = currentParticleLod.activeCount > 0
          ? target.particleOpacity * 0.5
          : 0;
        activeRefinementLayer.material.uniforms.uMorph.value = interpolate(
          activeRefinementLayer.material.uniforms.uMorph.value,
          target.burst,
        );
        activeRefinementLayer.material.uniforms.uOpacity.value = blendRefinement(
          activeRefinementLayer.material.uniforms.uOpacity.value,
          refinementOpacity,
        );
        activeRefinementLayer.material.uniforms.uLodProgress.value = blendRefinement(
          activeRefinementLayer.material.uniforms.uLodProgress.value,
          Math.min(
            1,
            currentParticleLod.activeCount / activeRefinementLayer.particleCap,
          ),
        );
      }
      if (departingRefinementLayer) {
        departingRefinementLayer.material.uniforms.uOpacity.value = blendRefinement(
          departingRefinementLayer.material.uniforms.uOpacity.value,
          0,
        );
        if (departingRefinementLayer.material.uniforms.uOpacity.value < 0.005) {
          disposeRefinementLayer(departingRefinementLayer);
          departingRefinementLayer = null;
        }
      }
      surfaceMaterial.opacity = interpolate(surfaceMaterial.opacity, target.surfaceOpacity);
      const reliefModeWeight = !reliefExperimentEnabled
        ? 0
        : currentMode === "surfaceEarth"
          ? 0
          : currentMode === "archiveBurst"
            ? 0.35
            : 1;
      const reliefOpacity = terrainReliefOpacity(interactiveZoom, currentQuality) * reliefModeWeight;
      reliefMaterial.opacity = interpolate(reliefMaterial.opacity, reliefOpacity);
      reliefMaterial.bumpScale = terrainReliefBumpScale(interactiveZoom, currentQuality);
      reliefSupport.visible = reliefExperimentEnabled
        && reliefTextureReady
        && reliefMaterial.opacity > 0.001;
      host.dataset.reliefOpacity = reliefMaterial.opacity.toFixed(4);
      host.dataset.reliefBumpScale = reliefMaterial.bumpScale.toFixed(4);
      if (archiveMaterial) {
        archiveMaterial.uniforms.uOpacity.value = interpolate(
          archiveMaterial.uniforms.uOpacity.value,
          target.signalOpacity,
        );
      }
      clusterMaterial.uniforms.uOpacity.value = interpolate(
        clusterMaterial.uniforms.uOpacity.value,
        target.clusterOpacity * 0.68,
      );
      cyanClusterMaterial.uniforms.uOpacity.value = interpolate(
        cyanClusterMaterial.uniforms.uOpacity.value,
        target.clusterOpacity,
      );
      shellMaterial.uniforms.uOpacity.value = interpolate(
        shellMaterial.uniforms.uOpacity.value,
        Math.min(1, target.shellOpacity * audioGain.ambient),
      );
      haloMaterial.uniforms.uOpacity.value = interpolate(
        haloMaterial.uniforms.uOpacity.value,
        Math.min(1, target.haloOpacity * audioGain.halo),
      );
      personalMaterial.uniforms.uOpacity.value = interpolate(
        personalMaterial.uniforms.uOpacity.value,
        target.personalOpacity,
      );
      personalMaterial.uniforms.uPointSize.value = interpolate(
        personalMaterial.uniforms.uPointSize.value,
        currentMode === "particleSphere" ? 46 : 58,
      );
      const routeOpacity = currentMode === "surfaceEarth"
        ? 0
        : currentMode === "focusPoint"
          ? 0.96
          : 0.66;
      routeVectorOpacity = interpolate(routeVectorOpacity, routeOpacity);
      routeVectorLayer.style.opacity = String(routeVectorOpacity);
      routeVectorLayer.style.setProperty("--audio-route-energy", audioGain.route.toFixed(3));
      const baseAtmosphereOpacity = currentMode === "surfaceEarth"
        ? 0.05
        : currentMode === "particleSphere"
          ? 0.5
          : 0.36;
      atmosphereMaterial.uniforms.uOpacity.value = interpolate(
        atmosphereMaterial.uniforms.uOpacity.value,
        Math.min(1, baseAtmosphereOpacity * audioGain.ambient),
      );
      wireMaterial.opacity = interpolate(wireMaterial.opacity, target.wireOpacity);
      semanticZoomState = resolveGlobeSemanticZoomForFrame({
        zoom: interactiveZoom,
        current: semanticZoomState,
        qualityProfile: currentQuality,
        focusFlightActive: routeFocusSettling,
      });
      host.dataset.semanticZoom = semanticZoomState.state;
      host.dataset.cityLod = semanticZoomState.cityTier;
      updateCoastlineRefinement(now);
      const coastlineWeights = semanticZoomState.coastlineWeights;
      const coastlineLod = semanticZoomState.coastlineLod;
      coastlineMaterial.opacity = interpolate(coastlineMaterial.opacity, target.coastlineOpacity * coastlineWeights.far);
      midCoastlineMaterial.opacity = interpolate(midCoastlineMaterial.opacity, target.coastlineOpacity * coastlineWeights.mid);
      nearCoastlineMaterial.opacity = interpolate(nearCoastlineMaterial.opacity, target.coastlineOpacity * coastlineWeights.near);
      coastlines.visible = coastlineWeights.far > 0.001 || coastlineMaterial.opacity > 0.001;
      midCoastlines.visible = coastlineWeights.mid > 0.001 || midCoastlineMaterial.opacity > 0.001;
      nearCoastlines.visible = coastlineWeights.near > 0.001 || nearCoastlineMaterial.opacity > 0.001;
      host.dataset.coastlineLod = coastlineLod;
      host.dataset.coastlineVertices = String((coastlineLod === "far" ? coastlineGeometry : coastlineLod === "mid" ? midCoastlineGeometry : nearCoastlineGeometry).getAttribute("position")?.count ?? 0);
      host.dataset.coastlineSource = coastlineLod === "far"
        ? (baseCoastlineSourceAvailable ? "110m-global" : "unavailable")
        : coastlineLod === "mid"
          ? (detailedMidCoastlineReady ? "50m-global" : baseCoastlineSourceAvailable ? "110m-global-fallback" : "unavailable")
          : activeCoastlineRegionKey ? "50m-regional-foundation" : baseCoastlineSourceAvailable ? "110m-global-fallback" : "unavailable";
      host.dataset.coastlineActiveChunks = activeCoastlineRegionKey ?? "";
      host.dataset.coastlineCacheChunks = String(coastlineRefinementCache.size);
      host.dataset.coastlineRefinement = coastlineRefinementState;
      // Keep the particle world alive while idle without involving React's
      // render cycle. Reduced-motion resolves to a stable final frame.
      const motionTime = reduceMotion ? 0 : now / 1000;
      particleMaterial.uniforms.uTime.value = motionTime;
      if (activeRefinementLayer) {
        activeRefinementLayer.material.uniforms.uTime.value = motionTime;
      }
      if (departingRefinementLayer) {
        departingRefinementLayer.material.uniforms.uTime.value = motionTime;
      }
      if (archiveMaterial) archiveMaterial.uniforms.uTime.value = motionTime;
      clusterMaterial.uniforms.uTime.value = motionTime;
      cyanClusterMaterial.uniforms.uTime.value = motionTime;
      shellMaterial.uniforms.uTime.value = motionTime;
      haloMaterial.uniforms.uTime.value = motionTime;
      personalMaterial.uniforms.uTime.value = motionTime;

      updateRouteVectorLayer();

      if (latestCenterFocusPoint.current && spatialFocusPoint) {
        const focusScreen = projectFocusPointForRotation(
          spatialFocusPoint,
          globe.rotation.x,
          globe.rotation.y,
          globe.scale.x,
          globe.position.x,
          globe.position.y,
          focusProjectionScreen,
        );
        host.dataset.focusTargetX = focusScreen.x.toFixed(2);
        host.dataset.focusTargetY = focusScreen.y.toFixed(2);
      } else {
        delete host.dataset.focusTargetX;
        delete host.dataset.focusTargetY;
      }

      if (latestCenterFocusPoint.current && latestFocusPoint.current) {
        personalScreenPosition.copy(latLonToVector3(
          latestFocusPoint.current.lat,
          latestFocusPoint.current.lon,
          GLOBE_SURFACE_RADIUS,
        ));
        globe.localToWorld(personalScreenPosition);
        personalScreenPosition.project(camera);
        host.dataset.personalPointX = String(
          ((personalScreenPosition.x + 1) * targetSize.x) / 2,
        );
        host.dataset.personalPointY = String(
          ((1 - personalScreenPosition.y) * targetSize.y) / 2,
        );
      }

      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        refinementBuildGuard.setVisible(false);
        requestedRefinementCacheKey = null;
        refinementBuildState = "paused";
        cancelAnimationFrame(animationFrame);
      } else {
        refinementBuildGuard.setVisible(true);
        requestedRefinementCacheKey = null;
        refinementBuildState = "idle";
        lastRefinementViewSampleAt = Number.NEGATIVE_INFINITY;
        lastTime = performance.now();
        animationFrame = requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    void rebuildLandVisualData(currentQuality);

    applyFocusPoint(latestFocusPoint.current);
    applyJourneyRoutes(latestJourneyRoutes.current);
    animationFrame = requestAnimationFrame(render);

    return {
      setQuality(nextQuality: keyof typeof QUALITY_PROFILE) {
        applyQuality(nextQuality);
      },
      setMode(nextMode: GlobeMode) {
        currentMode = nextMode;
        if (!latestFocusPoint.current) {
          applyFocusPoint(
            nextMode === "archiveBurst" ? { lat: -10, lon: -180 } : null,
          );
        }
      },
      setFocusIntent(intent: GlobeFocusIntent | null) {
        const revision = intent?.revision ?? latestFocusRevision.current;
        if (!shouldApplyFocusIntentRevision(activeFocusRevision, revision)) return;
        const focusOwnsState = shouldFocusRevisionOwnState(
          manualFocusRevision,
          revision,
        );
        if (!focusOwnsState) return;
        activeFocusRevision = revision;
        const hadRouteFocus = Boolean(routeFocusFrame);
        routeFocusFrame = getSphericalRouteFocus(intent?.route?.points ?? []);
        const point = intent?.point ?? null;
        if (focusOwnsState) {
          manualFocusRevision = null;
        }
        if (
          focusOwnsState
          &&
          latestDragToRotate.current
          && latestCenterFocusPoint.current
          && intent
        ) {
          interactiveRotationY = 0;
          if (latestFocusFlightProfile.current === "long-haul") {
            interactiveZoom = Math.min(interactiveZoom, 0.78);
          } else if (latestFocusFlightProfile.current === "regional") {
            interactiveZoom = Math.min(interactiveZoom, 0.9);
          }
          rotationVelocityX = 0;
          rotationVelocityY = 0;
          lastGlobeInteractionAt = performance.now();
        }
        pointFocusSettling = Boolean(intent?.kind === "point");
        routeFocusSettling = Boolean(intent?.kind === "route" && routeFocusFrame);
        routeFocusZoomResetting = hadRouteFocus && !routeFocusFrame;
        applyFocusPoint(point);
        if (intent) {
          sampleFocusViewport(true);
          const target = GLOBE_MODE_CONFIG[currentMode];
          const solved = solveFocusRotationForViewport(
            intent.point,
            rotationXForLatitude(intent.point.lat),
            rotationYForLongitude(intent.point.lon),
            target.scale * intent.zoom,
            target.x,
            target.y,
          );
          host.dataset.focusArrivalErrorPx = solved.errorPx.toFixed(2);
          focusTarget = {
            point: intent.point,
            rotationX: nearestEquivalentRotation(interactiveRotationX, solved.x),
            rotationY: nearestEquivalentRotation(baseRotationY, solved.y),
            zoom: intent.zoom,
            screenX: sampledFocusCenter.x,
            screenY: sampledFocusCenter.y,
          };
          interactiveRotationY = 0;
          rotationVelocityX = 0;
          rotationVelocityY = 0;
          lastGlobeInteractionAt = performance.now();
          if (import.meta.env.DEV) {
            host.dataset.focusRevision = String(revision);
            host.dataset.focusIntentKind = intent.kind;
            host.dataset.focusIntentSource = latestFocusFlightProfile.current
              ? "playback"
              : intent.kind === "route" ? "journey" : "route-point";
            host.dataset.focusTargetLat = String(intent.point.lat);
            host.dataset.focusTargetLon = String(intent.point.lon);
            host.dataset.focusTargetRotationX = String(focusTarget.rotationX);
            host.dataset.focusTargetRotationY = String(focusTarget.rotationY);
            host.dataset.focusTargetZoom = String(intent.zoom);
            host.dataset.focusTargetScreenX = String(focusTarget.screenX);
            host.dataset.focusTargetScreenY = String(focusTarget.screenY);
            host.dataset.focusFlightStartRotationX = String(interactiveRotationX);
            host.dataset.focusFlightStartRotationY = String(baseRotationY);
            host.dataset.focusReplanCount = "0";
            host.dataset.focusSettleCount = "0";
          }
        } else {
          focusTarget = null;
        }
        syncRouteFocusPhase();
        // Two journeys can share a rotation target, so the connector cannot
        // rely on the globe transform alone to notice a new focus point.
        routeProjectionRevision += 1;
        if (routeFocusFrame) {
          host.dataset.routeFocusLat = String(routeFocusFrame.center.lat);
          host.dataset.routeFocusLon = String(routeFocusFrame.center.lon);
          host.dataset.routeFocusZoom = String(routeFocusFrame.zoom);
        } else if (!routeFocusFrame) {
          if (routeFocusZoomResetting) {
            syncRouteFocusPhase();
            rotationVelocityX = 0;
            rotationVelocityY = 0;
            lastGlobeInteractionAt = performance.now();
          } else {
            syncRouteFocusPhase();
          }
          delete host.dataset.routeFocusLat;
          delete host.dataset.routeFocusLon;
          delete host.dataset.routeFocusZoom;
        }
      },
      setCompactMobileLayout(compact: boolean) {
        if (currentCompactMobileLayout === compact) return;
        currentCompactMobileLayout = compact;
        updateRouteLabelSafeArea();
        // An orientation flip can cross the shared query without changing the
        // canvas size, so the projection cache has to be invalidated by hand or
        // the labels keep the previous mode's layout until the next real move.
        routeProjectionRevision += 1;
      },
      setFocusColor(color: string | undefined) {
        personalMaterial.uniforms.uColor.value.set(color ?? 0xffdc72);
        host.dataset.focusColor = `#${personalMaterial.uniforms.uColor.value.getHexString()}`;
        routeProjectionRevision += 1;
      },
      setJourneyRoutes(
        routes: readonly JourneyRoute[],
        activeRouteId: string | null | undefined,
      ) {
        latestActiveJourneyRouteId.current = activeRouteId;
        syncParticleDimming(routes, activeRouteId);
        applyJourneyRoutes(routes);
      },
      // #21: update per-route AND per-point temporal reveal without rebuilding
      // the layer, so the time cursor does not restart route animations.
      // Review P2: points light up one stop at a time (route progress still
      // fades the whole trail); a journey/point absent from the maps (or an
      // undefined map after leaving focus mode) RESETS to full visibility so
      // rewind state never leaks into the normal home view.
      setTemporalReveal(reveal?: {
        journeys: ReadonlyMap<string, number>;
        points: ReadonlyMap<string, number>;
      }) {
        syncParticleDimming(
          latestJourneyRoutes.current,
          latestActiveJourneyRouteId.current,
          reveal,
        );
        for (const entry of routeVectorEntries) {
          const progress = reveal?.journeys.get(entry.routeId);
          if (progress === undefined) {
            entry.group.style.removeProperty("--journey-temporal-progress");
            delete entry.group.dataset.temporalReveal;
          } else {
            entry.group.style.setProperty("--journey-temporal-progress", progress.toFixed(3));
            entry.group.dataset.temporalReveal = progress.toFixed(3);
          }
          for (const point of entry.points) {
            const pointProgress = reveal?.points.get(
              `${entry.routeId}:${point.routePointIndex}`,
            );
            if (pointProgress === undefined) {
              point.element.style.removeProperty("--journey-point-temporal-progress");
              delete point.element.dataset.temporalReveal;
            } else {
              point.element.style.setProperty(
                "--journey-point-temporal-progress",
                pointProgress.toFixed(3),
              );
              point.element.dataset.temporalReveal = pointProgress.toFixed(3);
            }
          }
          // #21 review: each leg's visibility follows its destination point's
          // progress — the trail literally grows stop by stop.
          for (const leg of entry.legs) {
            const legProgress = reveal?.points.get(
              `${entry.routeId}:${leg.toPointIndex}`,
            );
            if (legProgress === undefined) {
              leg.path.style.removeProperty("opacity");
              delete leg.path.dataset.temporalReveal;
            } else {
              leg.path.style.opacity = legProgress.toFixed(3);
              leg.path.dataset.temporalReveal = legProgress.toFixed(3);
            }
          }
        }
      },
      dispose() {
        disposed = true;
        refinementBuildGuard.dispose();
        cancelAnimationFrame(animationFrame);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resizeObserver.disconnect();
        window.removeEventListener("resize", resize);
        cityVectorLayer.removeEventListener("pointerdown", onCityLayerPointerDown);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
        renderer.domElement.removeEventListener("lostpointercapture", onLostPointerCapture);
        window.removeEventListener("pointerup", onRejectedPointerLifecycleEnd);
        window.removeEventListener("pointercancel", onRejectedPointerLifecycleEnd);
        renderer.domElement.removeEventListener("wheel", onWheel);
        reliefTexture?.dispose();
        reliefMaterial.dispose();
        texture.dispose();
        disposeRefinementLayer(departingRefinementLayer);
        departingRefinementLayer = null;
        disposeRefinementLayer(activeRefinementLayer);
        activeRefinementLayer = null;
        refinementCache.clear();
        coastlineRefinementCache.clear();
        if (particles) globe.remove(particles);
        if (particleGeometry) particleGeometry.dispose();
        particleMaterial.dispose();
        disposeSceneGraph(scene);
        renderer.dispose();
        renderer.forceContextLoss();
        routeVectorLayer.remove();
        cityVectorLayer.remove();
        renderer.domElement.remove();
        Reflect.deleteProperty(debugWindow, "__particleEarthDebug");
      },
    };
  });

  useEffect(() => {
    controllerRef.current?.setQuality(quality);
  }, [controllerRef, quality]);

  useEffect(() => {
    controllerRef.current?.setMode(mode);
  }, [controllerRef, mode]);

  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setFocusIntent(
      resolveGlobeFocusIntent(focusPoint, focusRoute, focusRevision),
    );
  }, [controllerRef, focusPoint?.lat, focusPoint?.lon, focusRevision, focusRoute, ready]);

  useEffect(() => {
    controllerRef.current?.setFocusColor(focusColor);
  }, [controllerRef, focusColor]);

  useEffect(() => {
    controllerRef.current?.setCompactMobileLayout(compactMobileLayout);
  }, [compactMobileLayout, controllerRef]);

  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setJourneyRoutes(journeyRoutes, activeJourneyRouteId);
  }, [activeJourneyRouteId, controllerRef, journeyRoutes, ready]);

  useEffect(() => {
    if (!ready) return;
    // Review P2: also called with `undefined` so leaving focus mode resets
    // every route's temporal reveal to full visibility.
    controllerRef.current?.setTemporalReveal(temporalReveal);
  }, [controllerRef, ready, temporalReveal]);

  return (
    <div
      ref={hostRef}
      className="particle-earth-scene"
      // #194: the overlays this scene draws are styled from the injected
      // product mode, so app.css keys off this instead of a breakpoint.
      data-mobile-v2={compactMobileLayoutMarker(compactMobileLayout)}
      data-scene-ready={ready ? "true" : "false"}
      data-personal-point-interactive={
        centerFocusPoint && onFocusPointActivate ? "true" : "false"
      }
      data-journey-routes-interactive={
        onJourneyRouteActivate || onJourneyRoutePointActivate ? "true" : "false"
      }
      data-globe-point-pick={onGlobePointPick ? "true" : "false"}
      data-drag-rotation={dragToRotate ? "true" : "false"}
      data-wheel-zoom={wheelToZoom ? "true" : "false"}
      aria-label="由世界陆地轮廓与艺术信号组成的粒子地球"
      role="img"
    />
  );
}
