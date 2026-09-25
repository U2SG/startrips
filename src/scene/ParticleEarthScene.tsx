import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  LinearFilter,
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
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLOBE_MODE_CONFIG, type GlobeMode } from "./globeMode";
import { getLightEffectPalette } from "../journey/lightEffects";
import {
  audioAtmosphereGains,
  readAudioAtmosphereEnergy,
} from "../motion/audioAtmosphere";
import { motionTokens } from "../motion/tokens";
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
import type { HomeBasePresenceDrawable, ProjectedHomeBasePresence } from "./homeBasePresenceLayer";
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
  resolveRouteAttentionRole,
  resolveRoutePointPresentation,
  routePointMarkerRadiusPx,
  type RoutePointPresentation,
  type RoutePointSelection,
} from "./routePresentation";
import {
  arbitrateRouteLabels,
  isCoincidentLabelAnchor,
  isPlaceLabelRedundant,
  normalizeLabelIdentity,
  routeLabelPositionRole,
  selectEvictableRouteLabel,
  type PlacedRouteLabel,
  type RouteLabelCandidate,
  type RouteLabelPositionRole,
} from "./labelArbitration";
import {
  resolveRouteArcLift,
  routeArcPixelsPerWorldUnit,
  ROUTE_ARC_HEIGHT_RATIO,
  ROUTE_ARC_SATURATION_ANGLE,
} from "./routeArcLift";
import {
  canTrackGlobePointer,
  clampGlobeZoom,
  getGlobeInertiaSpeedLimit,
  isGlobeDrag,
  isPrimaryPointerActivation,
  isReliablePinchAnchor,
  projectedRadiusRotationDelta,
  rebaseGlobeDragSample,
  shouldRememberUntrackedPointerStart,
  shouldRetainGlobeInertia,
  shouldSuppressUntrackedPointerActivation,
  type ScreenPoint,
} from "./globePointerIntent";
import {
  createAtmosphereMaterial,
  createParticleEarthMaterial,
  PARTICLE_ACTIVE_DIM_POINT_LIMIT,
  PARTICLE_DIM_POINT_LIMIT,
} from "./particleEarthMaterial";
import {
  COASTLINE_SPATIAL_CACHE_LIMIT,
  RefinementCache,
  buildRegionalCoastlinePositions,
  resolveCoastlineRefinementRegion,
} from "./coastlineSpatialLod";
import {
  COASTLINE_LOCAL_CACHE_LIMIT,
  COASTLINE_LOCAL_MANIFEST_PATH,
  buildLocalCoastlinePositions,
  mergeRegionalAndLocalCoastlinePositions,
  isLocalCoastlineTarget,
  resolveCoastlineInspectionTarget,
  resolveLocalCoastlineCell,
  shouldUseCoastlineFocusTarget,
  resolveLocalCoastlineChunkIds,
  type CoastlineInspectionTarget,
  type CoastlineLocalChunk,
  type CoastlineLocalManifest,
} from "./coastlineLocalLod";
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
import {
  composeGlobeModelMatrix,
  createGeoProjectionFrame,
  isLocalPointInsideClipViewport,
  isSphericalPointVisible,
  projectGeographicAnchor,
  projectGeographicAnchorToViewport,
  projectLocalPoint,
  projectLocalPointToViewport,
  updateGeoProjectionFrame,
  type GeoProjectionFrame,
} from "./projection";
import type { ParticleAnchorFrame } from "./detailedEarthModel";
import { QUALITY_PROFILE, resolveRenderBudget, type ResolvedRenderBudget } from "./renderBudget";
import {
  globeRenderStateRunsScene,
  resolveGlobeRenderState,
  type GlobeRenderState,
  type GlobeVisibilityInput,
} from "./globeVisibility";
import { disposeSceneGraph, useThreeScene } from "./useThreeScene";
import {
  resolveGlobeSemanticZoom,
  resolveGlobeSemanticZoomForFrame,
  type GlobeSemanticZoom,
  type GlobeSemanticZoomState,
  type SemanticZoomSnapshot,
} from "./semanticZoom";
import {
  terrainParticleReliefEmphasis,
  terrainReliefBumpScale,
  terrainReliefOpacity,
} from "./terrainRelief";
import {
  buildVisitedImprintField,
  encodeVisitedImprintTexture,
  visitedImprintFieldsEqual,
  visitedImprintZoomAttenuation,
  type VisitedImprintField,
} from "./visitedImprint";

export type ParticleEarthBackend = "webgl2" | "unavailable";

function particleEarthQaFailureMode(mode: "no-webgl" | "renderer-throw") {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("qaParticleEarthFailure") === mode;
}

export function canCreateParticleEarthWebGlContext() {
  if (particleEarthQaFailureMode("no-webgl")) return false;
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    const available = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return available;
  } catch {
    return false;
  }
}

export function createParticleEarthRenderer(
  rendererFactory: () => WebGLRenderer = () => new WebGLRenderer({
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
    premultipliedAlpha: false,
  }),
  capabilityProbe: () => boolean = canCreateParticleEarthWebGlContext,
): WebGLRenderer | null {
  if (!capabilityProbe()) return null;
  try {
    if (particleEarthQaFailureMode("renderer-throw")) {
      throw new Error("Forced Particle Earth renderer construction failure");
    }
    return rendererFactory();
  } catch {
    return null;
  }
}

export const MAX_RENDERED_JOURNEYS = 64;
export const MAX_RENDERED_ROUTE_POINTS = 512;
export const MAX_RENDERED_ROUTE_LINE_VERTICES = 8192;
const EMPTY_ARCHIVE_POINTS: Parameters<typeof buildArtworkPointPositions>[0] = [];

export type AttentionParticleLayerId =
  | "base-particle-surface"
  | "spatial-lod-refinement"
  | "archive-signal"
  | "archive-cluster"
  | "cyan-cluster"
  | "particle-shell"
  | "particle-halo"
  | "personal-focus-signal";

export type AttentionParticleLayerMeasurement = {
  id: AttentionParticleLayerId;
  present: boolean;
  authoredCssSizePx: number | null;
  shaderPixelRatio: number | null;
  resolvedCssOpticalSizePx: number | null;
  opacity: number;
  strongGlow: boolean;
};

function roundAttentionMetric(value: number, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * ST-037 observes the existing #243 CSS-pixel contract without retuning it.
 * `uPointSize` is authored in CSS px, while the ACTUAL shader uniform
 * `uPixelRatio` is populated by ParticleEarthMaterial.onBeforeRender. Dividing
 * the shader-scaled input back by renderer DPR yields the CSS optical contract
 * that should stay invariant across DPR. If onBeforeRender stops updating the
 * uniform, this resolved value immediately drifts instead of echoing authored
 * input and falsely passing QA. The shader's multiplication by `uPixelRatio` is
 * independently locked by particleEarthMaterial.test.ts.
 */
export function resolveAttentionLayerMeasurement({
  id,
  present,
  authoredCssSizePx,
  shaderPixelRatio,
  opacity,
  rendererDpr,
}: {
  id: AttentionParticleLayerId;
  present: boolean;
  authoredCssSizePx: number | null;
  shaderPixelRatio: number | null;
  opacity: number;
  rendererDpr: number;
}): AttentionParticleLayerMeasurement {
  const authored = present && authoredCssSizePx !== null
    ? roundAttentionMetric(authoredCssSizePx, 3)
    : null;
  const shaderRatio = present && shaderPixelRatio !== null
    ? roundAttentionMetric(shaderPixelRatio, 4)
    : null;
  const resolvedOpacity = present ? roundAttentionMetric(opacity) : 0;
  const resolvedCssOpticalSizePx = authored === null
    || shaderRatio === null
    || !(rendererDpr > 0)
    ? null
    : roundAttentionMetric((authored * shaderRatio) / rendererDpr, 3);
  return {
    id,
    present,
    authoredCssSizePx: authored,
    shaderPixelRatio: shaderRatio,
    resolvedCssOpticalSizePx,
    opacity: resolvedOpacity,
    strongGlow: present && resolvedOpacity >= motionTokens.glow.coreOpacity,
  };
}

/**
 * #242 review: the line-vertex pool is shared by every visible route, and it
 * used to be spent front to back. A curvature-aware sample count asks for
 * several times as many vertices per leg as the old angular rule, so the FIRST
 * long route could consume nearly the whole pool and leave the routes after it
 * as single-segment traces or nothing at all - a dense multi-Journey overview
 * would lose its later Journeys to whichever one happened to be drawn first.
 *
 * Each route takes an equal share of whatever is still unspent, so a route that
 * needs less than its share leaves the surplus to the ones after it and no
 * route can starve the rest.
 *
 * Two reservations keep an equal share from becoming a different unfairness.
 * `ownMinimum` is the vertices this route needs to pass through every one of
 * its Route Points at one straight segment per leg - its topology floor, which
 * is never traded away, because a route drawn without a stored Route Point is a
 * lie about the Journey rather than a lower-quality picture of it.
 * `reservedForOthers` is the same floor summed over the routes still to come,
 * held back so an early route's fair share cannot consume the minimum a later
 * one needs. `selectRenderableJourneyRoutes` caps the rendered point total at
 * MAX_RENDERED_ROUTE_POINTS, so those floors sum to well under the pool and
 * every rendered route is guaranteed its complete topology.
 */
export function resolveRouteVertexShare(
  spentVertices: number,
  routesRemaining: number,
  ownMinimum = 0,
  reservedForOthers = 0,
) {
  const unspent = Math.max(0, MAX_RENDERED_ROUTE_LINE_VERTICES - spentVertices);
  const shareable = Math.max(0, unspent - reservedForOthers);
  return Math.max(
    Math.min(ownMinimum, unspent),
    Math.floor(shareable / Math.max(1, routesRemaining)),
  );
}

export const MAX_RENDERED_ROUTE_LABELS = 6;
/**
 * #374: label elements prepared for the chosen Journey. Attention moves without
 * rebuilding this layer, so the pool is wider than the rendered budget while
 * staying bounded; the per-frame arbitration still renders at most
 * `resolveRouteLabelLimit(...)` of them.
 */
export const MAX_ROUTE_LABEL_CANDIDATES = 24;
export const MAX_RENDERED_MOBILE_ROUTE_LABELS = 3;
export const CITY_LABEL_BUDGET = 72;
export const MAX_RENDERED_COASTLINE_VERTICES = 20_000;
export const COASTLINE_LOD_VERTEX_BUDGET = { far: 20_000, mid: 32_000, near: 52_000 } as const;
/**
 * #237 Phase A - the coastline reads above the particle surface through DEPTH,
 * not through a larger radius.
 *
 * The coastline now shares GEOGRAPHIC_SURFACE_RADIUS with the surface sphere it
 * is drawn against, and that sphere writes depth on every frame (its material
 * is transparent but `depthWrite` is on, which is what hides the far side of
 * the planet). A 64x40 SphereGeometry is INSCRIBED in the sphere it
 * approximates, so a coastline vertex on the analytic radius is at worst
 * coplanar with it and never inside it; with the default LEQUAL depth function
 * that already passes. "At worst coplanar" is decided by float noise though,
 * so an explicit bias is what turns a coin flip along the mesh's own vertices
 * into a guarantee.
 *
 * The bias is applied to CLIP-SPACE Z ONLY, scaled by the clip W so it is a
 * constant offset in normalised device coordinates at any distance. Clip x, y
 * and w are untouched, so the projected screen position of a coastline vertex
 * is bit-for-bit the position the shared projection frame computes for the same
 * latitude/longitude - which is the whole point of the change. An eye-space
 * offset would have been wrong here: moving z in eye space changes w, and
 * therefore moves x and y on screen.
 *
 * The bias tapers with how directly the vertex faces the camera. At the limb it
 * falls to zero and on the far side it is clamped away entirely, so the near
 * side gets its guarantee while the far side stays occluded by exactly the same
 * depth test as before.
 */
export const COASTLINE_DEPTH_POLICY = {
  depthTest: true,
  depthWrite: false,
  /**
   * In NDC units. The worst case it has to clear is the sagitta of the
   * surface mesh's own tessellation - about 0.0027 globe-local units at the
   * widest 64x40 quad - which reaches roughly 0.0011 NDC at maximum zoom.
   */
  ndcDepthBias: 0.0035,
} as const;

/**
 * The largest distance, in globe-local units, by which the inscribed
 * SphereGeometry falls inside the analytic sphere the geographic layers use.
 * Documented as a number because it is what sizes ndcDepthBias.
 */
export const SURFACE_TESSELLATION_SAGITTA =
  GEOGRAPHIC_SURFACE_RADIUS * (1 - Math.cos(Math.PI / 64));

export function createCoastlineMaterial() {
  const material = new LineBasicMaterial({
    blending: AdditiveBlending,
    color: 0x7af4ed,
    depthTest: COASTLINE_DEPTH_POLICY.depthTest,
    depthWrite: COASTLINE_DEPTH_POLICY.depthWrite,
    opacity: 0,
    transparent: true,
  });
  material.onBeforeCompile = applyCoastlineDepthBias;
  return material;
}

/** Exported for assertion: the patch may move clip z and nothing else. */
export const COASTLINE_DEPTH_BIAS_CHUNK = `
  vec3 coastlineNormal = normalize(position);
  vec3 coastlineWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 coastlineWorldNormal = normalize(mat3(modelMatrix) * coastlineNormal);
  float coastlineFacing = clamp(
    dot(coastlineWorldNormal, normalize(cameraPosition - coastlineWorld)),
    0.0,
    1.0
  );
  gl_Position.z -= ${COASTLINE_DEPTH_POLICY.ndcDepthBias.toFixed(5)} * coastlineFacing * gl_Position.w;
`;

export function applyCoastlineDepthBias(shader: { vertexShader: string }) {
  shader.vertexShader = shader.vertexShader.replace(
    "#include <fog_vertex>",
    `#include <fog_vertex>
${COASTLINE_DEPTH_BIAS_CHUNK}`,
  );
}

export const GLOBE_RENDER_ORDER = {
  relief: -1,
  particle: 0,
  coastline: 1,
  signal: 2,
  routeLine: 3,
  routePoint: 4,
  personalPoint: 5,
} as const;
// The globe is a real sphere: vertical dragging must be able to pass the
// former +/-35 degree clamp and turn it completely over.
export const GLOBE_TILT_LIMIT_RADIANS = Number.POSITIVE_INFINITY;
export const GLOBE_SURFACE_RADIUS = GEOGRAPHIC_SURFACE_RADIUS;

export function cityPointCoordinates(city: Pick<CityPoint, "latitude" | "longitude"> | null) {
  return city ? { latitude: city.latitude, longitude: city.longitude } : null;
}

type JourneyPointPointerTarget = {
  journeyId: string;
  routePointId?: string;
  routePointIndex: number;
};

export function journeyRoutePointTargetEligible(
  target: JourneyPointPointerTarget | null | undefined,
  activeJourneyRouteId: string | null | undefined,
  routePointActivationEnabled: boolean,
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  },
) {
  if (!target) return false;
  if (
    target.routePointId
    && routePointActivationEnabled
    && target.journeyId !== activeJourneyRouteId
  ) return false;
  const journeyReveal = temporalReveal?.journeys.get(target.journeyId);
  if (journeyReveal !== undefined && journeyReveal <= 0) return false;
  const pointReveal = temporalReveal?.points.get(
    `${target.journeyId}:${target.routePointIndex}`,
  );
  return pointReveal === undefined || pointReveal > 0;
}

export function selectHomeBasePointerTarget(
  frames: readonly ProjectedHomeBasePresence[],
  descriptors: readonly Pick<HomeBasePresenceDrawable, "periodId" | "touchTargetPx">[],
  clientX: number,
  clientY: number,
): string | null {
  // Home markers paint in descriptor order, so reverse traversal matches the
  // visual stack: current/period-context markers painted last win over older
  // historical traces at the same geographic anchor.
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame?.visible) continue;
    const descriptor = descriptors.find((candidate) => candidate.periodId === frame.periodId);
    if (!descriptor) continue;
    const halfTarget = descriptor.touchTargetPx / 2;
    if (Math.abs(clientX - frame.x) <= halfTarget && Math.abs(clientY - frame.y) <= halfTarget) {
      return frame.periodId;
    }
  }
  return null;
}
// #252: the latitude step the local geographic scale is measured over. Small
// enough that the projection is locally linear across it, large enough that the
// difference is far above the 0.01px the anchor is published at.
const ANCHOR_SCALE_PROBE_DEG = 0.05;
// The personal signal is geographic, so its position stays on the canonical
// surface. Readability priority is clip-space only, owned by its material.
const PERSONAL_SIGNAL_CLIP_DEPTH_BIAS = 0.0015;
export const GLOBE_IDLE_ROTATION_RADIANS_PER_SECOND = (Math.PI * 2) / 180;
export const GLOBE_IDLE_RESUME_DELAY_MS = 20_000;
export const GLOBE_IDLE_RELEASE_BLEND_MS = 2_400;
export const GLOBE_UPRIGHT_ROTATION_X = 0;
export const GLOBE_IDLE_ALIGNMENT_SPEED = (Math.PI * 15) / 180;

export const GLOBE_DRAG_MAPPING_MODE = "projected-surface-linear";
const GLOBE_INERTIA_FRICTION = 5.2;
const GLOBE_WHEEL_ZOOM_SPEED = 0.0012;
const JOURNEY_ROUTE_LINE_REFERENCE_SCALE = 1.15;
const JOURNEY_ROUTE_LINE_SCALE_MIN = 0.72;
const JOURNEY_ROUTE_LINE_SCALE_MAX = 2.4;

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

/**
 * The geographic anchor the particle renderer is actually holding for a Dive.
 * The orientation-only initial camera anchor owns the fresh Atlas before any
 * semantic Journey focus; once it retires, route fitting then point focus own it.
 */
export function resolveParticleDiveAnchor(
  routeFocusFrame: { center: { lat: number; lon: number } } | null | undefined,
  focusPoint: { lat: number; lon: number } | null | undefined,
  initialCameraAnchor?: { lat: number; lon: number } | null,
) {
  return initialCameraAnchor ?? routeFocusFrame?.center ?? focusPoint ?? null;
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

export function earthDiveDirectManipulationOwnsCamera(input: {
  overlapActive: boolean;
  activePointerCount: number;
  now: number;
  wheelInteractionUntil: number;
}) {
  return input.overlapActive
    && (input.activePointerCount > 0 || input.now < input.wheelInteractionUntil);
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

interface ParticleEarthSceneProps {
  mode: GlobeMode;
  quality?: keyof typeof QUALITY_PROFILE;
  focusPoint?: { lat: number; lon: number } | null;
  focusRoute?: JourneyRoute | null;
  /** Orientation-only seed; it does not create a focus signal or route owner. */
  initialCameraAnchor?: { lat: number; lon: number } | null;
  focusRevision?: number;
  /** Playback may retain the chapter while the viewer owns the camera. */
  focusEnabled?: boolean;
  focusFlightProfile?: PlaybackTravelChoreography;
  focusColor?: string;
  centerFocusPoint?: boolean;
  onFocusPointActivate?: () => void;
  journeyRoutes?: readonly JourneyRoute[];
  /** #514: marker/hit disclosure; omitted by non-Atlas callers to keep their full route presentation. */
  visibleRoutePointIds?: ReadonlySet<string>;
  activeJourneyRouteId?: string | null;
  selectedJourneyRoutePoint?: RoutePointSelection;
  narrativeJourneyRoutePoint?: RoutePointSelection;
  onJourneyRouteActivate?: (id: string) => void;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  /** A primary non-gesture click on the globe surface that hit no personal target. */
  onGlobeBlankActivate?: () => void;
  onHomeBaseActivate?: (periodId: string) => void;
  // #21: per-journey temporal reveal progress (0 = future, 1 = visited).
  // When provided, route groups and points fade in with the time cursor.
  // Points are keyed by `${journeyId}:${pointIndex}` for one-stop-at-a-time
  // reveal (review P2: a whole-route fade was not the #21 experience).
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  };
  showArchiveSignals?: boolean;
  /** Static signal coordinates supplied by the legacy or QA scene owner. */
  archivePoints?: Parameters<typeof buildArtworkPointPositions>[0];
  onReady?: () => void;
  onBackendChange?: (backend: ParticleEarthBackend) => void;
  /**
   * #252: the scene owns the camera, so it is the only place that can report
   * where the semantic-zoom authority currently stands. It publishes that
   * authority's own snapshot and never a raw camera value, so a React owner
   * cannot start classifying zoom on its own.
   */
  onSemanticZoomSnapshot?: (snapshot: SemanticZoomSnapshot) => void;
  /**
   * #252 section 2: what this renderer is showing at the focused place, in
   * viewport CSS pixels - where the anchor projects and how many pixels a
   * degree of latitude spans there. The Dive's detail surface solves its own
   * camera to these, which is the only way the two renderers can be known to
   * agree in screen space rather than assumed to.
   */
  onParticleAnchorFrame?: (frame: ParticleAnchorFrame | null) => void;
  /** ST-056: resolved Home descriptors use this scene's canonical projection frame. */
  homeBasePresence?: readonly HomeBasePresenceDrawable[];
  onHomeBasePresenceFrame?: (frame: readonly ProjectedHomeBasePresence[]) => void;
  /** First real wheel/drag/touch camera claim; programmatic focus never calls this. */
  onManualCameraInteraction?: () => void;
  /** The active focus revision reached its rendered geographic target. */
  onFocusSettled?: (revision: number) => void;
  /**
   * #252: a camera hand-back. When a detail owner relinquishes the Semantic
   * Earth Dive it asks the particle camera to stand where the zoom authority
   * says the band reopens, so the two surfaces do not disagree about where the
   * user is. The revision is what makes it an event rather than a value.
   */
  zoomIntent?: {
    zoom: number;
    revision: number;
    /** Optional geographic center used when another renderer hands the camera back. */
    center?: { lat: number; lon: number };
  };
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  dragToRotate?: boolean;
  wheelToZoom?: boolean;
  /** Hold the particle camera on the exact Semantic Earth Dive handoff frame
   * while the detail renderer owns camera/input. */
  cameraHold?: boolean;
  reduceMotion?: boolean;
  rotationYOverride?: number;
  /**
   * #194: the one product-level compact/mobile decision, made by the React
   * owner from `useCompactMobileLayout()`. The scene must not infer it.
   */
  compactMobileLayout?: boolean;
  /** #247: product-state visibility input; never inferred from per-frame DOM rectangles. */
  visibilityHint?: {
    opaqueMediaCover: boolean;
    coverTransitionActive: boolean;
    earthDiveOverlapActive?: boolean;
  };
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
      GEOGRAPHIC_SURFACE_RADIUS,
      MAX_RENDERED_COASTLINE_VERTICES,
    ),
    detailedCoastlinePositions: {
      mid: buildSphericalRingSegments(
        source.rings,
        GEOGRAPHIC_SURFACE_RADIUS,
        COASTLINE_LOD_VERTEX_BUDGET.mid,
      ),
      near: buildSphericalRingSegments(
        source.rings,
        GEOGRAPHIC_SURFACE_RADIUS,
        COASTLINE_LOD_VERTEX_BUDGET.near,
      ),
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
      mid: buildSphericalRingSegments(
        rings,
        GEOGRAPHIC_SURFACE_RADIUS,
        COASTLINE_LOD_VERTEX_BUDGET.mid,
      ),
    };
  } catch {
    return null;
  }
}

const loadLocalCoastlineManifest = createRetryableParticleResourceLoader(
  async (): Promise<CoastlineLocalManifest | null> => {
    const response = await fetch(COASTLINE_LOCAL_MANIFEST_PATH);
    if (!response.ok) return null;
    const manifest = await response.json() as CoastlineLocalManifest;
    return manifest.version === 1 && manifest.source?.scale === "10m" ? manifest : null;
  },
);

async function loadLocalCoastlineChunk(
  entry: { id: string; path: string },
): Promise<CoastlineLocalChunk | null> {
  try {
    const response = await fetch(`/earth/coastline-10m/${entry.path}`);
    if (!response.ok) return null;
    const chunk = await response.json() as CoastlineLocalChunk;
    return chunk.version === 1 && chunk.id === entry.id && chunk.sourceScale === "10m"
      ? chunk
      : null;
  } catch {
    return null;
  }
}

function createPositionGeometry(positions: Float32Array, targetPositions?: Float32Array) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  if (targetPositions) {
    geometry.setAttribute("targetPosition", new BufferAttribute(targetPositions, 3));
  }
  return geometry;
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
    // #237: the archive cluster is decoration, not a geographic reference
    // layer - nothing reads a latitude/longitude off it - so it keeps its own
    // jittered shell rather than joining GEOGRAPHIC_SURFACE_RADIUS.
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
  initialCameraAnchor,
  focusRevision = 0,
  focusEnabled = true,
  focusFlightProfile,
  focusColor,
  centerFocusPoint = false,
  onFocusPointActivate,
  journeyRoutes = [],
  visibleRoutePointIds,
  activeJourneyRouteId,
  selectedJourneyRoutePoint,
  narrativeJourneyRoutePoint,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobeBlankActivate,
  onHomeBaseActivate,
  temporalReveal,
  showArchiveSignals = true,
  archivePoints = EMPTY_ARCHIVE_POINTS,
  onReady,
  onBackendChange,
  onSemanticZoomSnapshot,
  onParticleAnchorFrame,
  homeBasePresence = [],
  onHomeBasePresenceFrame,
  onManualCameraInteraction,
  onFocusSettled,
  zoomIntent,
  onGlobePointPick,
  dragToRotate = false,
  wheelToZoom = true,
  cameraHold = false,
  reduceMotion = false,
  compactMobileLayout = false,
  visibilityHint = { opaqueMediaCover: false, coverTransitionActive: false },
  rotationYOverride,
}: ParticleEarthSceneProps) {
  const [ready, setReady] = useState(false);
  const latestMode = useRef(mode);
  const latestQuality = useRef(quality);
  const latestFocusPoint = useRef(focusPoint);
  const latestFocusRoute = useRef(focusRoute);
  const latestInitialCameraAnchor = useRef(initialCameraAnchor);
  const latestFocusRevision = useRef(focusRevision);
  const latestFocusFlightProfile = useRef(focusFlightProfile);
  const latestFocusColor = useRef(focusColor);
  const latestCenterFocusPoint = useRef(centerFocusPoint);
  const latestOnFocusPointActivate = useRef(onFocusPointActivate);
  const latestJourneyRoutes = useRef(journeyRoutes);
  const latestVisibleRoutePointIds = useRef(visibleRoutePointIds);
  const latestActiveJourneyRouteId = useRef(activeJourneyRouteId);
  const latestSelectedJourneyRoutePoint = useRef(selectedJourneyRoutePoint);
  const latestNarrativeJourneyRoutePoint = useRef(narrativeJourneyRoutePoint);
  const latestOnJourneyRouteActivate = useRef(onJourneyRouteActivate);
  const latestOnJourneyRoutePointActivate = useRef(onJourneyRoutePointActivate);
  const latestOnGlobeBlankActivate = useRef(onGlobeBlankActivate);
  const latestOnHomeBaseActivate = useRef(onHomeBaseActivate);
  const latestTemporalReveal = useRef(temporalReveal);
  const latestOnReady = useRef(onReady);
  const latestOnBackendChange = useRef(onBackendChange);
  const latestOnSemanticZoomSnapshot = useRef(onSemanticZoomSnapshot);
  const latestOnParticleAnchorFrame = useRef(onParticleAnchorFrame);
  const latestHomeBasePresence = useRef(homeBasePresence);
  const latestOnHomeBasePresenceFrame = useRef(onHomeBasePresenceFrame);
  const latestOnManualCameraInteraction = useRef(onManualCameraInteraction);
  const latestOnFocusSettled = useRef(onFocusSettled);
  const latestZoomIntent = useRef(zoomIntent);
  const latestOnGlobePointPick = useRef(onGlobePointPick);
  const latestDragToRotate = useRef(dragToRotate);
  const latestWheelToZoom = useRef(wheelToZoom);
  const latestCameraHold = useRef(cameraHold);
  const latestRotationYOverride = useRef(rotationYOverride);
  const latestCompactMobileLayout = useRef(compactMobileLayout);
  const latestVisibilityHint = useRef(visibilityHint);
  latestMode.current = mode;
  latestQuality.current = quality;
  latestFocusPoint.current = focusPoint;
  latestFocusRoute.current = focusRoute;
  latestInitialCameraAnchor.current = initialCameraAnchor;
  latestFocusRevision.current = focusRevision;
  latestFocusFlightProfile.current = focusFlightProfile;
  latestFocusColor.current = focusColor;
  latestCenterFocusPoint.current = centerFocusPoint;
  latestOnFocusPointActivate.current = onFocusPointActivate;
  latestJourneyRoutes.current = journeyRoutes;
  latestVisibleRoutePointIds.current = visibleRoutePointIds;
  latestActiveJourneyRouteId.current = activeJourneyRouteId;
  latestSelectedJourneyRoutePoint.current = selectedJourneyRoutePoint;
  latestNarrativeJourneyRoutePoint.current = narrativeJourneyRoutePoint;
  latestOnJourneyRouteActivate.current = onJourneyRouteActivate;
  latestOnJourneyRoutePointActivate.current = onJourneyRoutePointActivate;
  latestOnGlobeBlankActivate.current = onGlobeBlankActivate;
  latestOnHomeBaseActivate.current = onHomeBaseActivate;
  latestTemporalReveal.current = temporalReveal;
  latestOnReady.current = onReady;
  latestOnBackendChange.current = onBackendChange;
  latestOnSemanticZoomSnapshot.current = onSemanticZoomSnapshot;
  latestOnParticleAnchorFrame.current = onParticleAnchorFrame;
  latestHomeBasePresence.current = homeBasePresence;
  latestOnHomeBasePresenceFrame.current = onHomeBasePresenceFrame;
  latestOnManualCameraInteraction.current = onManualCameraInteraction;
  latestOnFocusSettled.current = onFocusSettled;
  latestZoomIntent.current = zoomIntent;
  latestOnGlobePointPick.current = onGlobePointPick;
  latestDragToRotate.current = dragToRotate;
  latestWheelToZoom.current = wheelToZoom;
  latestCameraHold.current = cameraHold;
  latestRotationYOverride.current = rotationYOverride;
  latestCompactMobileLayout.current = compactMobileLayout;
  latestVisibilityHint.current = visibilityHint;

  const { hostRef, controllerRef, controllerRevision } = useThreeScene((host) => {
    let disposed = false;
    let animationFrame = 0;
    let lastTime = performance.now();
    let currentMode = latestMode.current;
    let currentQuality = latestQuality.current;
    let currentCompactMobileLayout = latestCompactMobileLayout.current;
    let currentVisibilityHint = latestVisibilityHint.current;
    let currentRenderState: GlobeRenderState = "rendering";
    let resolvedRenderBudget: ResolvedRenderBudget = { effectiveDpr: 1, drawingBufferPixels: 1, drawingBufferWidth: 1, drawingBufferHeight: 1 };
    let lastFrameDeltaMs = 0;
    // #432: how many frames this scene has rendered. A reader outside the
    // scene needs "a frame happened after the state I observed"; the pass
    // counters below say what that frame did, not that one occurred.
    let sceneFrameRevision = 0;
    let qualityBuildRevision = 0;
    const targetSize = new Vector2();
    const scene = new Scene();
    const camera = new PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    const sampledFocusCenter = new Vector2();
    const focusScaleProbePoint = { x: 0, y: 0 };
    const anchorFrameRect = new Vector2();
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
    const renderer = createParticleEarthRenderer();
    if (!renderer) throw new Error("Particle Earth WebGL renderer unavailable");
    const applyRendererBudget = () => {
      resolvedRenderBudget = resolveRenderBudget({
        viewportWidth: targetSize.x,
        viewportHeight: targetSize.y,
        deviceDpr: window.devicePixelRatio,
        qualityProfile: QUALITY_PROFILE[currentQuality],
      });
      renderer.setPixelRatio(resolvedRenderBudget.effectiveDpr);
    };
    const initialBounds = host.getBoundingClientRect();
    targetSize.set(Math.max(1, initialBounds.width), Math.max(1, initialBounds.height));
    applyRendererBudget();
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(new Color(0x020807), 0);
    renderer.domElement.dataset.threeScene = "particle-earth";
    host.dataset.quality = currentQuality;
    host.appendChild(renderer.domElement);
    const routeVectorLayer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    routeVectorLayer.classList.add("particle-earth-route-layer");
    routeVectorLayer.setAttribute("role", "group");
    routeVectorLayer.setAttribute("aria-label", "Journey Route Points");
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
        drawingBufferPixels: number;
        renderState: GlobeRenderState;
        lastFrameDeltaMs: number;
        particleCount: number;
        particleBaseCount: number;
        particleRefinementCount: number;
        particleRefinementCap: number;
        particleRefinementRegion: ParticleRefinementRegion | null;
        particleRefinementBuild: string;
        particleLandSource: string;
        semanticLod: GlobeSemanticZoom;
        semanticLodProgress: number;
        visitedImprintRegions: number;
        visitedImprintJourneyContributions: number;
        visitedImprintMaxGain: number;
        visitedImprintTextureUpdates: number;
        visitedImprintAttenuation: number;
        journeyRouteBuilds: number;
        journeyRouteBuildMs: number;
        journeyRoutePointGeometry: string;
        journeyRouteProjectionReady: boolean;
        coastlineVertices: number;
        coastlineSource: string;
        coastlineInspectionTarget: CoastlineInspectionTarget | null;
        coastlineRegionCenter: { lat: number; lon: number } | null;
        coastlineActiveChunks: string[];
        coastlineRefinement: string;
        coastlineLocalChunkCache: number;
        coastlineLocalVertices: number;
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
      drawingBufferPixels: resolvedRenderBudget.drawingBufferPixels,
      renderState: currentRenderState,
      lastFrameDeltaMs,
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
      visitedImprintRegions: visitedImprintField.activeRegionCount,
      visitedImprintJourneyContributions: visitedImprintField.journeyContributionCount,
      visitedImprintMaxGain: visitedImprintField.maxGain,
      visitedImprintTextureUpdates,
      visitedImprintAttenuation: visitedImprintMaterials[0]
        ?.uniforms.uVisitedImprintAttenuation.value ?? 1,
      journeyRouteBuilds,
      journeyRouteBuildMs,
      journeyRoutePointGeometry: routePointGeometry.uuid,
      journeyRouteProjectionReady: renderedRouteProjectionRevision === routeProjectionRevision,
      coastlineVertices: (semanticZoomState.coastlineLod === "far"
        ? coastlineGeometry
        : semanticZoomState.coastlineLod === "mid" ? midCoastlineGeometry : nearCoastlineGeometry)
        .getAttribute("position")?.count ?? 0,
      coastlineSource: activeCoastlineSource,
      coastlineInspectionTarget: activeCoastlineInspectionTarget
        ? { ...activeCoastlineInspectionTarget }
        : null,
      coastlineRegionCenter: activeCoastlineRegionCenter
        ? { ...activeCoastlineRegionCenter }
        : null,
      coastlineActiveChunks: [...activeCoastlineChunkIds],
      coastlineRefinement: coastlineRefinementState,
      coastlineLocalChunkCache: coastlineLocalChunkCache.size,
      coastlineLocalVertices: activeCoastlineLocalVertices,
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
    const focusProjectionScreen = new Vector2();
    // #237: the focus solver used to apply an Euler, a scalar and the viewport
    // mapping by hand - a third spelling of the projection. It now COMPOSES the
    // candidate placement into the same model matrix Object3D builds and reads
    // it through the same frame, so "where would this place land if the globe
    // were rotated like this" is answered by the projection authority rather
    // than by an algebraically-equal copy of it.
    const focusCandidateFrame = createGeoProjectionFrame();
    const focusCandidateModel = new Matrix4();
    const focusCandidatePoint = { x: 0, y: 0 };
    const projectFocusAnchorForRotation = (
      anchor: Readonly<Vector3>,
      rotationX: number,
      rotationY: number,
      scale: number,
      positionX: number,
      positionY: number,
      targetScreen: Vector2,
    ) => {
      composeGlobeModelMatrix(focusCandidateModel, {
        rotationX,
        rotationY,
        rotationZ: globe.rotation.z,
        scale,
        positionX,
        positionY,
        positionZ: globe.position.z,
      });
      updateGeoProjectionFrame(
        focusCandidateFrame,
        camera,
        focusCandidateModel,
        targetSize.x,
        targetSize.y,
      );
      projectLocalPointToViewport(
        focusCandidateFrame,
        anchor.x,
        anchor.y,
        anchor.z,
        focusCandidatePoint,
      );
      return targetScreen.set(focusCandidatePoint.x, focusCandidatePoint.y);
    };
    const projectFocusPointForRotation = (
      point: { lat: number; lon: number },
      rotationX: number,
      rotationY: number,
      scale: number,
      positionX: number,
      positionY: number,
      targetScreen: Vector2,
      pointRadius = ROUTE_ANCHOR_RADIUS,
    ) => projectFocusAnchorForRotation(
      routePointAnchor(point.lat, point.lon, pointRadius),
      rotationX,
      rotationY,
      scale,
      positionX,
      positionY,
      targetScreen,
    );
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
      // A solve rotates one fixed geographic anchor. Keep its canonical
      // radius/snap conversion outside the finite-difference probes, without
      // retaining an anchor across focus revisions or synchronous solves.
      const anchor = routePointAnchor(point.lat, point.lon, pointRadius);
      return solveScreenAnchorRotation(
        seedRotationX,
        seedRotationY,
        targetScreen,
        (rotationX, rotationY) => projectFocusAnchorForRotation(
          anchor,
          rotationX,
          rotationY,
          scale,
          positionX,
          positionY,
          focusProjectionScreen,
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
    const coastlineMaterial = createCoastlineMaterial();
    const coastlines = new LineSegments(coastlineGeometry, coastlineMaterial);
    coastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    globe.add(coastlines);
    let midCoastlineGeometry = new BufferGeometry();
    let nearCoastlineGeometry = new BufferGeometry();
    // #237: built through the factory rather than cloned - Material.copy does
    // not carry onBeforeCompile, so a clone would silently lose the depth bias
    // and only the far LOD would keep it.
    const midCoastlineMaterial = createCoastlineMaterial();
    const nearCoastlineMaterial = createCoastlineMaterial();
    const midCoastlines = new LineSegments(midCoastlineGeometry, midCoastlineMaterial);
    const nearCoastlines = new LineSegments(nearCoastlineGeometry, nearCoastlineMaterial);
    midCoastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    nearCoastlines.renderOrder = GLOBE_RENDER_ORDER.coastline;
    globe.add(midCoastlines, nearCoastlines);

    const atmosphereMaterial = createAtmosphereMaterial();
    const atmosphere = new Mesh(sphereGeometry, atmosphereMaterial);
    atmosphere.scale.setScalar(1.07);
    globe.add(atmosphere);

    const archiveMaterial = showArchiveSignals && archivePoints.length > 0
      ? createParticleEarthMaterial({
          color: 0xd9fffb,
          opacity: 0.9,
          size: 45,
        })
      : null;
    if (archiveMaterial) {
      const archivePositions = buildArtworkPointPositions(archivePoints, 1.43);
      const archiveGeometry = createPositionGeometry(archivePositions, archivePositions.slice());
      const archiveSignals = new Points(archiveGeometry, archiveMaterial);
      archiveSignals.renderOrder = GLOBE_RENDER_ORDER.signal;
      globe.add(archiveSignals);
    }

    const clusterPositions = buildRegionalClusterPositions(
      920,
      { lat: 40, lon: 65 },
      { lat: 24, lon: 24 },
    );
    const clusterGeometry = createPositionGeometry(clusterPositions, clusterPositions.slice());
    const clusterMaterial = createParticleEarthMaterial({
      color: 0xf19cff,
      opacity: 0,
      size: 28,
    });
    const archiveCluster = new Points(clusterGeometry, clusterMaterial);
    archiveCluster.renderOrder = GLOBE_RENDER_ORDER.signal;
    globe.add(archiveCluster);

    const particleDimmingMaterials: Array<ReturnType<typeof createParticleEarthMaterial>> = [];
    const visitedImprintMaterials: Array<ReturnType<typeof createParticleEarthMaterial>> = [];
    let visitedImprintField: VisitedImprintField = buildVisitedImprintField(
      latestJourneyRoutes.current,
      latestTemporalReveal.current,
    );
    const visitedImprintTexture = new DataTexture(
      encodeVisitedImprintTexture(visitedImprintField),
      visitedImprintField.width,
      visitedImprintField.height,
    );
    visitedImprintTexture.wrapS = RepeatWrapping;
    visitedImprintTexture.minFilter = LinearFilter;
    visitedImprintTexture.magFilter = LinearFilter;
    visitedImprintTexture.generateMipmaps = false;
    visitedImprintTexture.needsUpdate = true;
    let visitedImprintTextureUpdates = 1;
    const attachVisitedImprintMaterial = (
      material: ReturnType<typeof createParticleEarthMaterial>,
    ) => {
      visitedImprintMaterials.push(material);
      material.uniforms.uVisitedImprintMap.value = visitedImprintTexture;
    };
    const removeVisitedImprintMaterial = (
      material: ReturnType<typeof createParticleEarthMaterial>,
    ) => {
      const index = visitedImprintMaterials.indexOf(material);
      if (index >= 0) visitedImprintMaterials.splice(index, 1);
    };
    const syncVisitedImprint = (
      routes: readonly JourneyRoute[],
      temporalReveal = latestTemporalReveal.current,
    ) => {
      const next = buildVisitedImprintField(routes, temporalReveal);
      if (!visitedImprintFieldsEqual(visitedImprintField, next)) {
        visitedImprintField = next;
        visitedImprintTexture.image.data = encodeVisitedImprintTexture(next);
        visitedImprintTexture.needsUpdate = true;
        visitedImprintTextureUpdates += 1;
      }
      host.dataset.visitedImprintRegions = String(visitedImprintField.activeRegionCount);
      host.dataset.visitedImprintJourneyContributions = String(
        visitedImprintField.journeyContributionCount,
      );
      host.dataset.visitedImprintMaxGain = visitedImprintField.maxGain.toFixed(5);
      host.dataset.visitedImprintTextureUpdates = String(visitedImprintTextureUpdates);
    };
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

    const cyanClusterPositions = buildRegionalClusterPositions(
      620,
      { lat: 28, lon: 55 },
      { lat: 38, lon: 36 },
    );
    const cyanClusterGeometry = createPositionGeometry(cyanClusterPositions, cyanClusterPositions.slice());
    const cyanClusterMaterial = createParticleEarthMaterial({
      color: 0xa9fff4,
      opacity: 0,
      size: 22,
    });
    const cyanArchiveCluster = new Points(cyanClusterGeometry, cyanClusterMaterial);
    cyanArchiveCluster.renderOrder = GLOBE_RENDER_ORDER.signal;
    globe.add(cyanArchiveCluster);

    const shellPositions = buildSeededSpherePoints(3_200, 2087);
    for (let index = 0; index < shellPositions.length; index += 1) {
      // #237: decorative archive shell, deliberately not a geographic layer.
      shellPositions[index] *= 1.405;
    }
    const shellGeometry = createPositionGeometry(shellPositions, shellPositions.slice());
    const shellMaterial = createParticleEarthMaterial({
      color: 0xa8f6f3,
      opacity: 0.15,
      size: 8,
    });
    const particleShell = new Points(shellGeometry, shellMaterial);
    globe.add(particleShell);

    const haloPositions = buildSeededSpherePoints(1_100, 9917);
    for (let index = 0; index < haloPositions.length; index += 3) {
      const pointIndex = index / 3;
      const radius = 1.44 + ((pointIndex * 37) % 101) / 101 * 0.34;
      haloPositions[index] *= radius;
      haloPositions[index + 1] *= radius;
      haloPositions[index + 2] *= radius;
    }
    const haloGeometry = createPositionGeometry(haloPositions, haloPositions.slice());
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

    const initialFallback =
      currentMode === "archiveBurst"
        ? { lat: -10, lon: -180 }
        : { lat: 34.0522, lon: -118.2437 };
    const personalPosition = focusSignalAnchor(
      latestFocusPoint.current,
      initialFallback,
    );
    const personalPositions = new Float32Array(personalPosition.toArray());
    const personalGeometry = createPositionGeometry(personalPositions, personalPositions.slice());
    const personalMaterial = createParticleEarthMaterial({
      color: 0xffdc72,
      opacity: 0,
      size: 58,
      radialPulseScale: 0,
      clipDepthBias: PERSONAL_SIGNAL_CLIP_DEPTH_BIAS,
    });
    personalMaterial.uniforms.uColor.value.set(
      latestFocusColor.current ?? 0xffdc72,
    );
    host.dataset.focusColor = `#${personalMaterial.uniforms.uColor.value.getHexString()}`;
    const personalSignal = new Points(personalGeometry, personalMaterial);
    personalSignal.renderOrder = GLOBE_RENDER_ORDER.personalPoint;
    globe.add(personalSignal);
    const focusSignalScreenPoint = { x: 0, y: 0 };
    const coastlineAnchorWorld = new Vector3();

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
      hitTarget: SVGRectElement;
      leader: SVGPathElement;
      text: SVGTextElement;
      width: number;
      positionRole: RouteLabelPositionRole;
      /** Normalized Route Point label identity, for Place Label arbitration. */
      identity: string;
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
      leaderPath: SVGPathElement;
      fadeGradient: SVGLinearGradientElement;
      routePointCount: number;
      labelCandidateIndexes: readonly number[];
      points: Array<{
        element: SVGCircleElement;
        position: Vector3;
        routePointId?: string;
        isStop: boolean;
        label?: RouteVectorLabel;
        /** The Route Point's own label text, kept so a label element can be
         *  created later when attention moves to a point the build-time
         *  candidate set did not cover. */
        labelText?: string;
        /** #374: the presentation roles this frame's label arbitration reads.
         *  Produced once by `resolveRoutePointPresentation`, never re-derived. */
        presentation: RoutePointPresentation;
        // #21: the route point's index inside its journey, for per-point
        // temporal reveal ("one stop lights up at a time").
        routePointIndex: number;
      }>;
    };
    let routeVectorEntries: RouteVectorEntry[] = [];
    // React has already copied incoming props into latest* refs by the time
    // the controller runs. Only these renderer-owned snapshots prove what the
    // current geometry and active presentation have actually applied.
    let appliedJourneyRoutes: readonly JourneyRoute[] | undefined;
    let appliedVisibleRoutePointIds: ReadonlySet<string> | undefined;
    let appliedActiveJourneyRouteId: string | null | undefined;
    let journeyRouteBuilds = 0;
    let journeyRouteBuildMs = 0;
    const createRouteVectorLabel = (
      labelText: string,
      routeId: string,
      routePointId: string | undefined,
      pointIndex: number,
      positionRole: RouteLabelPositionRole,
    ): RouteVectorLabel => {
      const labelElement = document.createElementNS("http://www.w3.org/2000/svg", "g");
      labelElement.classList.add("particle-earth-route__label");
      const hitTarget = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hitTarget.classList.add("particle-earth-route__label-hit");
      hitTarget.setAttribute("aria-hidden", "true");
      const leader = document.createElementNS("http://www.w3.org/2000/svg", "path");
      leader.classList.add("particle-earth-route__leader");
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const displayLabel = formatRouteLabel(labelText);
      text.textContent = displayLabel;
      labelElement.setAttribute("data-route-label", displayLabel);
      labelElement.dataset.journeyRoute = routeId;
      if (routePointId) {
        labelElement.dataset.routePointId = routePointId;
        labelElement.setAttribute("role", "button");
        labelElement.setAttribute("tabindex", "0");
        labelElement.setAttribute("aria-label", `打开地点详情：${labelText}`);
      }
      labelElement.dataset.routePointIndex = String(pointIndex);
      labelElement.append(hitTarget, leader, text);
      return {
        element: labelElement,
        hitTarget,
        leader,
        text,
        width: estimateRouteLabelWidth(displayLabel),
        positionRole,
        // The Route Point's own text, not the truncated display form: an
        // ellipsis must not change which place a label claims.
        identity: normalizeLabelIdentity(labelText),
        pointIndex,
      };
    };
    const syncActiveJourneyRoute = () => {
      for (const entry of routeVectorEntries) {
        entry.group.classList.remove("is-idle", "is-active", "is-muted");
        entry.group.classList.add(getJourneyRouteVisualState(
          entry.routeId,
          latestActiveJourneyRouteId.current,
        ));
        const candidates = new Set(entry.routeId === latestActiveJourneyRouteId.current
          ? entry.labelCandidateIndexes
          : []);
        for (const point of entry.points) {
          if (!candidates.has(point.routePointIndex)) {
            point.label?.element.remove();
            point.label = undefined;
          } else if (!point.label && point.labelText) {
            point.label = createRouteVectorLabel(
              point.labelText,
              entry.routeId,
              point.routePointId,
              point.routePointIndex,
              routeLabelPositionRole(point.routePointIndex, entry.routePointCount),
            );
            point.label.element.style.display = "none";
            entry.group.insertBefore(point.label.element, entry.legs[0]?.path ?? null);
          }
        }
      }
    };
    const syncRoutePresentations = () => {
      for (const entry of routeVectorEntries) {
        const routeAttention = resolveRouteAttentionRole({
          routeId: entry.routeId,
          selectedRouteId: latestActiveJourneyRouteId.current,
          narrativeRouteId: latestNarrativeJourneyRoutePoint.current?.journeyId,
        });
        entry.group.dataset.attentionRole = routeAttention;
        for (const point of entry.points) {
          const presentation = resolveRoutePointPresentation({
            routeId: entry.routeId,
            routePointId: point.routePointId,
            pointIndex: point.routePointIndex,
            isStop: point.isStop,
            selection: latestSelectedJourneyRoutePoint.current,
            narrativeSelection: latestNarrativeJourneyRoutePoint.current,
            temporalReveal: latestTemporalReveal.current,
          });
          point.presentation = presentation;
          point.element.dataset.semanticRole = presentation.semanticRole;
          point.element.dataset.attentionRole = presentation.attentionRole;
          point.element.dataset.temporalVisible = presentation.temporalVisible ? "true" : "false";
          point.element.setAttribute("r", String(routePointMarkerRadiusPx(presentation)));
        }
        // #374: attention can land on a Route Point the ordinary candidate
        // pool did not cover, and selection does not rebuild this layer. Prepare
        // the attended point's label here instead - after every presentation in
        // this route is current, so the pool decision reads no stale role.
        if (entry.routeId !== latestActiveJourneyRouteId.current) continue;
        for (const point of entry.points) {
          if (point.label || !point.labelText) continue;
          if (point.presentation.attentionRole === "ordinary") continue;
          const prepared = entry.points.filter((candidate) => candidate.label);
          if (prepared.length >= MAX_ROUTE_LABEL_CANDIDATES) {
            // A route with more labeled Stops than the pool holds fills it with
            // ordinary candidates on activation. Attention outranks them, so the
            // last ordinary slot is recycled rather than leaving the chosen
            // record or the narrative current point without a label.
            const evictedIndex = selectEvictableRouteLabel(prepared.map((candidate) => ({
              pointIndex: candidate.routePointIndex,
              attentionRole: candidate.presentation.attentionRole,
            })));
            const victim = prepared.find((candidate) => (
              candidate.routePointIndex === evictedIndex
            ));
            if (!victim?.label) continue;
            victim.label.element.remove();
            victim.label = undefined;
          }
          point.label = createRouteVectorLabel(
            point.labelText,
            entry.routeId,
            point.routePointId,
            point.routePointIndex,
            routeLabelPositionRole(point.routePointIndex, entry.routePointCount),
          );
          point.label.element.style.display = "none";
          entry.group.appendChild(point.label.element);
        }
        for (const point of entry.points) {
          if (!point.label) continue;
          point.label.element.dataset.attentionRole = point.presentation.attentionRole;
          point.label.element.setAttribute(
            "aria-pressed",
            point.presentation.attentionRole === "selected" ? "true" : "false",
          );
        }
      }
      // Label visibility is now a function of attention and temporal state, so
      // a selection change has to re-run the projection pass even when the
      // camera has not moved.
      // This is the prepared pool; the projection pass publishes the smaller
      // set that actually fits on screen as journeyRouteVisibleLabelCount.
      host.dataset.journeyRouteLabelCount = String(routeVectorEntries.reduce(
        (count, entry) => count + entry.points.filter((point) => point.label).length,
        0,
      ));
      routeProjectionRevision += 1;
    };
    let routeVectorOpacity = 0;
    const sceneToken = Math.random().toString(36).slice(2, 8);
    // #237: ONE projection frame for every geographic layer. Place Labels,
    // Route Point anchors, the Journey connector, the focus signal and the
    // coastline QA anchor all read this frame, so a latitude/longitude yields
    // one screen coordinate no matter which layer asks for it.
    const geoFrame = createGeoProjectionFrame();
    const routeCameraPosition = geoFrame.cameraLocal;
    const routeLocalPoint = new Vector3();
    const routeProjectedPoint = { x: 0, y: 0 };
    const isCityCandidateInsideViewport = (city: CityPoint) => {
      const x = city.direction[0] * ROUTE_ANCHOR_RADIUS;
      const y = city.direction[1] * ROUTE_ANCHOR_RADIUS;
      const z = city.direction[2] * ROUTE_ANCHOR_RADIUS;
      routeLocalPoint.set(x, y, z);
      if (!isSphericalPointVisible(routeCameraPosition, routeLocalPoint)) return false;
      return isLocalPointInsideClipViewport(geoFrame.clip.elements, x, y, z);
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
    let journeyPointTargets: JourneyPointPointerTarget[] = [];
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

    const applyTemporalProgress = (
      element: SVGElement,
      property: string,
      progress: number | undefined,
    ) => {
      if (progress === undefined) {
        element.style.removeProperty(property);
        delete element.dataset.temporalReveal;
      } else {
        element.style.setProperty(property, progress.toFixed(3));
        element.dataset.temporalReveal = progress.toFixed(3);
      }
    };
    const syncRouteTemporalReveal = () => {
      const reveal = latestTemporalReveal.current;
      for (const entry of routeVectorEntries) {
        applyTemporalProgress(
          entry.group,
          "--journey-temporal-progress",
          reveal?.journeys.get(entry.routeId),
        );
        for (const point of entry.points) {
          applyTemporalProgress(
            point.element,
            "--journey-point-temporal-progress",
            reveal?.points.get(`${entry.routeId}:${point.routePointIndex}`),
          );
        }
        // Each leg reads its destination's reveal without changing the clock.
        for (const leg of entry.legs) {
          applyTemporalProgress(
            leg.path,
            "--journey-leg-temporal-progress",
            reveal?.points.get(`${entry.routeId}:${leg.toPointIndex}`),
          );
        }
      }
      syncRoutePresentations();
    };

    const applyJourneyRoutes = (routes: readonly JourneyRoute[]) => {
      const buildStartedAt = performance.now();
      const visibleRoutes = selectRenderableJourneyRoutes(routes);
      const pointIsVisible = (route: JourneyRoute, pointIndex: number) => (
        latestVisibleRoutePointIds.current === undefined
        || latestVisibleRoutePointIds.current.has(
          route.points[pointIndex].id ?? `${route.id}:${pointIndex}`,
        )
      );
      const pointCount = visibleRoutes.reduce(
        (total, route) => total + route.points.filter((_, index) => pointIsVisible(route, index)).length,
        0,
      );
      // #242 review: the vertices each route needs to pass through every one of
      // its Route Points, and the running total still owed to the routes after
      // it. Reserved rather than competed for, so no route loses a stored point
      // to a route drawn before it.
      const routeTopologyFloors = visibleRoutes.map(
        (route) => Math.max(0, route.points.length - 1) * 2,
      );
      const routeTopologyFloorsAfter = routeTopologyFloors.map(
        (_, index) => routeTopologyFloors
          .slice(index + 1)
          .reduce((total, floor) => total + floor, 0),
      );
      const pointPositions = new Float32Array(pointCount * 3);
      const pointTargets: JourneyPointPointerTarget[] = [];
      let pointIndex = 0;
      let routeVertexCount = 0;

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
          "is-style-quiet-core",
        );
        group.style.color = route.color;
        group.dataset.journeyRoute = route.id;
        group.dataset.lightEffect = route.lightEffect ?? "none";
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
        // Quiet Core: one directional leader is enough to explain motion.
        // The route itself stays a crisp core + restrained halo; no parallel
        // strand loops compete with the geographic content. `pathLength=1`
        // keeps draw/leader math independent of projected pixel length.
        const leaderPath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        leaderPath.classList.add("particle-earth-route__travel-leader");
        glowPath.setAttribute("pathLength", "1");
        corePath.setAttribute("pathLength", "1");
        leaderPath.setAttribute("pathLength", "1");
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
        // Quiet Core keeps the geographic route readable end-to-end. The soft
        // halo may inherit the old palette fade, but the crisp identity line
        // must not disappear exactly where the destination needs clarity.
        corePath.setAttribute("stroke", route.color);
        group.append(glowPath, corePath, leaderPath);
        const vectorPoints: RouteVectorEntry["points"] = [];

        route.points.forEach((point, routePointIndex) => {
          // Only the marker, label and raycast node are projected here. The
          // route line below still samples the complete canonical point order.
          if (!pointIsVisible(route, routePointIndex)) return;
          const position = routePointAnchor(point.lat, point.lon);
          position.toArray(
            pointPositions,
            pointIndex * 3,
          );
          pointTargets.push({
            journeyId: route.id,
            routePointId: point.id,
            routePointIndex,
          });
          pointIndex += 1;

          const positionClass = routePointIndex === 0
            ? "particle-earth-route__point--origin"
            : routePointIndex === route.points.length - 1
              ? "particle-earth-route__point--destination"
              : "particle-earth-route__point--middle";
          const element = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "circle",
          );
          element.classList.add(
            "particle-earth-route__point",
            positionClass,
            point.isStop
              ? "particle-earth-route__point--stop"
              : "particle-earth-route__point--transit",
          );
          // Visible Route Point optics are SVG/CSS-pixel beads. Pointer hit
          // testing remains the independent Three.js point layer below; this
          // marker never grows its geographic anchor or hit geometry.
          element.dataset.journeyRoute = route.id;
          if (point.id) element.dataset.routePointId = point.id;
          const presentation = resolveRoutePointPresentation({
            routeId: route.id,
            routePointId: point.id,
            pointIndex: routePointIndex,
            isStop: point.isStop,
            selection: latestSelectedJourneyRoutePoint.current,
            narrativeSelection: latestNarrativeJourneyRoutePoint.current,
            temporalReveal: latestTemporalReveal.current,
          });
          element.dataset.semanticRole = presentation.semanticRole;
          element.dataset.attentionRole = presentation.attentionRole;
          element.dataset.temporalVisible = presentation.temporalVisible ? "true" : "false";
          element.setAttribute("r", String(routePointMarkerRadiusPx(presentation)));
          group.appendChild(element);
          const labelText = point.label?.trim() ? point.label : undefined;
          vectorPoints.push({
            element,
            position,
            routePointId: point.id,
            isStop: point.isStop,
            labelText,
            presentation,
            routePointIndex,
          });
        });

        const remainingVertices = resolveRouteVertexShare(
          routeVertexCount,
          visibleRoutes.length - routeIndex,
          routeTopologyFloors[routeIndex],
          routeTopologyFloorsAfter[routeIndex],
        );
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
        //
        // #242: the same points, segment angle, budget and arc options as the
        // whole-route build above, so the leg a rewind draws is the very span
        // the static stroke draws. The old build handed the legs a separate
        // 2048-vertex budget, which let the two disagree geometrically and
        // doubled a bright peak wherever they did.
        const legSamples = buildRouteArcLegSamples(
          route.points,
          Math.PI / 96,
          remainingVertices,
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
          path.setAttribute("pathLength", "1");
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
          leaderPath,
          fadeGradient,
          routePointCount: route.points.length,
          labelCandidateIndexes: selectRouteLabelPointIndexes(
            route.points,
            MAX_ROUTE_LABEL_CANDIDATES,
          ).filter((index) => pointIsVisible(route, index)),
          points: vectorPoints,
        });
      });

      const nextPointGeometry = createPositionGeometry(pointPositions);
      if (pointCount > 0) nextPointGeometry.computeBoundingSphere();
      const previousPointGeometry = routePointGeometry;
      routePointGeometry = nextPointGeometry;
      routePointSignals.geometry = routePointGeometry;
      previousPointGeometry.dispose();
      journeyPointTargets = pointTargets;
      host.dataset.journeyRouteCount = String(visibleRoutes.length);
      host.dataset.journeyRoutePointCount = String(pointCount);
      host.dataset.journeyRouteVectorVertices = String(routeVertexCount);
      host.dataset.journeyRouteOverflow = String(routes.length - visibleRoutes.length);
      host.dataset.routeStyle = "quiet-core";
      // Rebuilding the layer clears its children, so the connector is put back
      // last and therefore stays above the route presentation.
      routeVectorLayer.appendChild(journeyConnectorPath);
      syncActiveJourneyRoute();
      updateRouteLabelSafeArea();
      // Data can change while the time cursor stays fixed. New point/leg DOM
      // must receive the current reveal even when its React effect will not run.
      syncRouteTemporalReveal();
      appliedJourneyRoutes = routes;
      appliedVisibleRoutePointIds = latestVisibleRoutePointIds.current;
      appliedActiveJourneyRouteId = latestActiveJourneyRouteId.current;
      journeyRouteBuilds += 1;
      journeyRouteBuildMs += performance.now() - buildStartedAt;
    };


    const projectRoutePoint = (
      x: number,
      y: number,
      z: number,
      target: ProjectedRoutePoint,
    ) => projectLocalPoint(geoFrame, x, y, z, target);
    // City coordinates are fixed by the data loader. Cache only this scene's
    // canonical anchors: scaling the already-snapped unit direction would
    // change near-zero components at the geographic surface radius.
    const cityAnchors = new WeakMap<CityPoint, Vector3>();
    const projectCityPoint = (city: CityPoint, target: ProjectedRoutePoint) => {
      let anchor = cityAnchors.get(city);
      if (!anchor) {
        anchor = routePointAnchor(city.latitude, city.longitude);
        cityAnchors.set(city, anchor);
      }
      return projectRoutePoint(anchor.x, anchor.y, anchor.z, target);
    };

    // #237 QA anchor: a real vertex of the coastline the frame is DRAWING,
    // projected through the shared frame and published beside the place-label
    // anchors. That is what lets a browser lane compare the motion of "the map"
    // against the motion of a label naming the same vicinity, instead of
    // comparing a label against a second copy of the label's own maths.
    //
    // The vertex is chosen once per (geometry, query point) pair rather than
    // per frame: coastline geometry lives in globe-local space and does not
    // move when the globe rotates, so the nearest vertex only changes when the
    // buffer is rebuilt by a LOD or refinement switch. Its own latitude and
    // longitude are published as its identity so a lane can tell a rebuild
    // apart from motion.
    let coastlineAnchorSource: BufferAttribute | null = null;
    let coastlineAnchorQuery: string | null = null;
    let coastlineAnchorVertex: { x: number; y: number; z: number } | null = null;
    const coastlineAnchorPoint = { x: 0, y: 0 };
    const selectCoastlineAnchorVertex = (
      positions: BufferAttribute,
      query: { lat: number; lon: number },
    ) => {
      const target = latLonToVector3(query.lat, query.lon, GEOGRAPHIC_SURFACE_RADIUS);
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        const z = positions.getZ(index);
        const distance = (x - target.x) ** 2 + (y - target.y) ** 2 + (z - target.z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) return null;
      return {
        x: positions.getX(bestIndex),
        y: positions.getY(bestIndex),
        z: positions.getZ(bestIndex),
      };
    };
    const publishCoastlineAnchor = () => {
      const query = latestFocusPoint.current;
      const lod = semanticZoomState.coastlineLod;
      const readPositions = (geometry: BufferGeometry) => {
        const attribute = geometry.getAttribute("position") as BufferAttribute | undefined;
        return attribute && attribute.count > 0 ? attribute : null;
      };
      // The active LOD is what the viewer is looking at, so that is what is
      // measured. The far buffer is the fallback because it is built once at
      // scene setup and never empty, and a detail buffer can legitimately be
      // empty for a frame while a refinement chunk is being rebuilt.
      const positions = readPositions(
        lod === "far"
          ? coastlineGeometry
          : lod === "mid" ? midCoastlineGeometry : nearCoastlineGeometry,
      ) ?? readPositions(coastlineGeometry);
      if (!query || !positions) {
        coastlineAnchorSource = null;
        coastlineAnchorQuery = null;
        coastlineAnchorVertex = null;
        delete host.dataset.coastlineAnchorX;
        delete host.dataset.coastlineAnchorY;
        delete host.dataset.coastlineAnchorLat;
        delete host.dataset.coastlineAnchorLon;
        delete host.dataset.coastlineAnchorRadius;
        return;
      }
      const queryKey = `${query.lat.toFixed(4)}:${query.lon.toFixed(4)}`;
      if (positions !== coastlineAnchorSource || queryKey !== coastlineAnchorQuery) {
        coastlineAnchorSource = positions;
        coastlineAnchorQuery = queryKey;
        coastlineAnchorVertex = selectCoastlineAnchorVertex(positions, query);
      }
      const vertex = coastlineAnchorVertex;
      if (!vertex) return;
      const geographic = vector3ToLatLon(coastlineAnchorWorld.set(vertex.x, vertex.y, vertex.z));
      host.dataset.coastlineAnchorLat = geographic.lat.toFixed(4);
      host.dataset.coastlineAnchorLon = geographic.lon.toFixed(4);
      host.dataset.coastlineAnchorRadius = coastlineAnchorWorld.length().toFixed(3);
      if (projectLocalPoint(geoFrame, vertex.x, vertex.y, vertex.z, coastlineAnchorPoint)) {
        host.dataset.coastlineAnchorX = coastlineAnchorPoint.x.toFixed(2);
        host.dataset.coastlineAnchorY = coastlineAnchorPoint.y.toFixed(2);
      } else {
        delete host.dataset.coastlineAnchorX;
        delete host.dataset.coastlineAnchorY;
      }
    };

    // ML-09 city labels: GeoNames cities15000 with containment-aware zoom —
    // capitals/province seats first, prefecture cities next, then counties
    // and towns; all labels are clickable for point picking.
    let cityTierData: { cities: CityPoint[] } | null = null;
    let lastCityTier: "capitals" | "prefectures" | "all" | null = null;
    let semanticZoomState: GlobeSemanticZoomState = resolveGlobeSemanticZoom({ zoom: interactiveZoom, qualityProfile: currentQuality });
    // Null until the first publish, so a Dive owner that mounts with the camera
    // already inside a band still learns where it stands.
    let publishedSemanticZoomSnapshot: SemanticZoomSnapshot | null = null;
    let publishedAnchorFrame: ParticleAnchorFrame | null = null;
    let publishedHomeBasePresenceFrame: ProjectedHomeBasePresence[] = [];
    const homeBaseProjectionPoint = { x: 0, y: 0 };
    let anchorFrameRectSampledAt = 0;
    let appliedZoomIntentRevision = latestZoomIntent.current?.revision ?? null;
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
      // City text is a painted child of the renderer-owned SVG overlay. Its
      // pointer lifecycle is delegated from the layer to the SAME handlers as
      // the canvas below, so Route Point / globe-pick / Home arbitration and
      // drag/pinch/wheel ownership cannot diverge at a label boundary.
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

    // #432: Place Label anchors are written inside this pass, one pass per
    // rendered frame. Publishing how many passes have completed lets a reader
    // outside the scene wait for "the layout that reflects the state I just
    // observed" instead of for a duration.
    let placeLabelLayoutRevision = 0;
    // Every exit of the layout pass states what it decided and in which frame,
    // so "layout is current for this frame" is readable without inferring it
    // from elapsed time: a completed pass, a skip because the projection did
    // not move, or a layer that is not drawn at all.
    const publishPlaceLabelLayout = (state: "laid-out" | "settled" | "inactive") => {
      host.dataset.placeLabelLayout = state;
      host.dataset.placeLabelLayoutFrame = String(sceneFrameRevision);
    };
    const updateRouteVectorLayer = () => {
      if (routeVectorOpacity <= 0.01) {
        // The layer is not drawn, so no Place Label layout runs this frame and
        // a reader waiting for one would wait forever. Say so instead.
        publishPlaceLabelLayout("inactive");
        return;
      }
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
        // #432: skipping the pass is the SETTLED state, not a missing one -
        // the placement already on screen is the placement this projection
        // produces. A reader waiting for layout has to be able to tell that
        // apart from a pass that has not happened yet, so it is published
        // rather than left to a timeout to guess.
        publishPlaceLabelLayout("settled");
        return;
      }
      lastRouteProjectionState.set(projectionState);
      renderedRouteProjectionRevision = routeProjectionRevision;
      camera.updateMatrixWorld();
      globe.updateWorldMatrix(true, false);
      updateGeoProjectionFrame(geoFrame, camera, globe.matrixWorld, targetSize.x, targetSize.y);

      const labelBoxes: ProjectedRouteLabelBox[] = [];
      // #374: the Route Point labels that actually claimed screen space this
      // frame, with the projected anchor each one claims. Place Label
      // arbitration below reads this instead of guessing from glyph boxes.
      const placedRouteLabels: PlacedRouteLabel[] = [];
      const labelLimit = resolveRouteLabelLimit(currentCompactMobileLayout);
      let visibleLabelCount = 0;

      const arcWorld = {
        radius: ROUTE_ANCHOR_RADIUS,
        liftScale: arcLift.liftScale,
      };
      let routeEndpointMaxErrorPx = 0;

      routeVectorEntries.forEach((entry) => {
        const path = buildProjectedRoutePath(
          entry.samples,
          projectRoutePoint,
          arcWorld,
        );
        entry.glowPath.setAttribute("d", path.d);
        entry.corePath.setAttribute("d", path.d);
        entry.leaderPath.setAttribute("d", path.d);
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
        const labelCandidates = new Map<number, {
          label: RouteVectorLabel;
          x: number;
          y: number;
        }>();
        const arbitrationCandidates: RouteLabelCandidate[] = [];
        entry.points.forEach(({ element, position, label, presentation, routePointIndex }) => {
          if (!projectRoutePoint(
            position.x,
            position.y,
            position.z,
            routeProjectedPoint,
          )) {
            element.style.display = "none";
            if (label) label.element.style.display = "none";
            return;
          }
          element.style.removeProperty("display");
          element.setAttribute("cx", routeProjectedPoint.x.toFixed(1));
          element.setAttribute("cy", routeProjectedPoint.y.toFixed(1));
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
            // #374: the label reads the SAME projected anchor as its marker.
            // The screen-space typography offset is applied below, after the
            // arbitration, and never travels back into a coordinate.
            labelCandidates.set(routePointIndex, {
              label,
              x: routeProjectedPoint.x,
              y: routeProjectedPoint.y,
            });
            arbitrationCandidates.push({
              pointIndex: routePointIndex,
              positionRole: label.positionRole,
              presentation,
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

        // #374: every prepared label starts hidden, so a point that lost its
        // turn this frame cannot keep a stale placement on screen.
        for (const { label } of labelCandidates.values()) {
          label.element.style.display = "none";
        }
        arbitrateRouteLabels(arbitrationCandidates, {
          compactMobileLayout: currentCompactMobileLayout,
        })
          .map((pointIndex) => labelCandidates.get(pointIndex)!)
          .forEach(({ label, x, y }) => {
            if (
              visibleLabelCount >= labelLimit
              || x < 0
              || x > targetSize.x
              || y < 0
              || y > targetSize.y
            ) {
              return;
            }
            // Route Points recorded at the same coordinates share one anchor.
            // They remain separate records with their own identity; only the
            // higher-priority label is drawn, instead of stacking two names on
            // one place or nudging an anchor apart.
            if (placedRouteLabels.some((placed) => isCoincidentLabelAnchor(placed.anchor, { x, y }))) {
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
              hitBox: ProjectedRouteLabelBox;
              horizontal: number;
              vertical: number;
              textX: number;
              textY: number;
            } | null = null;
            for (const [horizontal, vertical] of directions) {
              const textX = x + horizontal * 24;
              const textY = y + vertical * 22 + (vertical > 0 ? 5 : 0);
              const textLeft = horizontal > 0 ? textX : textX - label.width;
              const textRight = horizontal > 0 ? textX + label.width : textX;
              // Keep visual label arbitration on the authored text footprint so
              // making labels touch-safe cannot make distant, otherwise valid
              // labels disappear. Pointer overlap is resolved by nearest Route
              // Point identity below instead of by SVG DOM order.
              const box = {
                left: textLeft,
                top: textY - 13,
                right: textRight,
                bottom: textY + 4,
              };
              const hitBox = {
                left: textLeft - 8,
                top: textY - 26,
                right: textRight + 8,
                bottom: textY + 18,
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
              placement = { box, hitBox, horizontal, vertical, textX, textY };
              break;
            }
            if (!placement) return;

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
            label.hitTarget.setAttribute("x", placement.hitBox.left.toFixed(1));
            label.hitTarget.setAttribute("y", placement.hitBox.top.toFixed(1));
            label.hitTarget.setAttribute("width", (placement.hitBox.right - placement.hitBox.left).toFixed(1));
            label.hitTarget.setAttribute("height", (placement.hitBox.bottom - placement.hitBox.top).toFixed(1));
            label.hitTarget.setAttribute("rx", "8");
            label.element.style.removeProperty("display");
            labelBoxes.push(placement.box);
            placedRouteLabels.push({ identity: label.identity, anchor: { x, y } });
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
      host.dataset.focusSignalRadius = GLOBE_SURFACE_RADIUS.toFixed(3);
      // #237: the coastline is the layer a viewer READS as the map, so it
      // publishes its own semantic radius next to the surface's. The two being
      // equal is the invariant; a regression that puts a map layer back on a
      // shell of its own shows up here before anyone has to look at a globe.
      host.dataset.coastlineSemanticRadius = GEOGRAPHIC_SURFACE_RADIUS.toFixed(3);
      host.dataset.projectionSpace = "single";
      publishCoastlineAnchor();
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
              if (!projectCityPoint(city, routeProjectedPoint)) {
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
        // The regional all-tier scan can contain ~15k cities, so a scalar
        // clip/frustum check against the shared frame's matrix keeps that scan
        // cheap while full projection stays bounded to the <=72 retained labels
        // below (plus the <=72 persistence snapshot). #237: it reads the SAME
        // matrix the projection uses - previously the cheap scan and the real
        // projection composed the camera transform two different ways.
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
        let redundantCityLabelCount = 0;
        for (let index = 0; index < cities.length; index += 1) {
          if (visibleCityCount >= CITY_LABEL_BUDGET) break;
          const city = cities[index];
          const displayName = resolveCityDisplayName(city, cityLabelLocale);
          const entry = ensureCityLabel(index);
          if (!entry) break;
          if (!projectCityPoint(city, routeProjectedPoint) || !isProjectedPointInsideViewport(
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
          // #374: a Place Label can miss every box and still repeat the Route
          // Point label a few pixels away. Suppress only that repetition -
          // equivalent name AND the same vicinity on screen. The city stays in
          // the dataset and returns as soon as the route label moves away.
          const redundantWithRouteLabel = isPlaceLabelRedundant({
            names: [city.name, city.localizedName, displayName],
            anchor: { x: routeProjectedPoint.x, y: routeProjectedPoint.y },
            placedRouteLabels,
          });
          if (redundantWithRouteLabel) redundantCityLabelCount += 1;
          if (
            redundantWithRouteLabel
            || cityBoxes.some((candidate) => routeLabelBoxesOverlap(candidate, box, 4))
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
        // #374 QA read-back: how many Place Labels this frame dropped as a
        // repetition of a drawn Route Point label. It reads 0 whenever no route
        // label names a nearby city, so a regression that starts deduplicating
        // by name alone is visible without inspecting glyphs.
        host.dataset.journeyCityLabelRedundantCount = String(redundantCityLabelCount);
      }

      // Advances whether or not this Atlas has city tier data, so a reader
      // waiting on label layout is never deadlocked by an empty label layer.
      placeLabelLayoutRevision += 1;
      host.dataset.placeLabelLayoutRevision = String(placeLabelLayoutRevision);
      publishPlaceLabelLayout("laid-out");

      updateJourneyConnector();
    };

    const personalRaycaster = new Raycaster();
    personalRaycaster.params.Points = { threshold: 0.18 };
    const personalPointer = new Vector2();
    const preparePersonalPointerRay = (clientX: number, clientY: number) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      personalPointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      personalRaycaster.setFromCamera(personalPointer, camera);
    };
    const journeyTargetFromPreparedRay = (): JourneyPointPointerTarget | null => {
      camera.updateMatrixWorld();
      globe.updateWorldMatrix(true, false);
      updateGeoProjectionFrame(geoFrame, camera, globe.matrixWorld, targetSize.x, targetSize.y);
      const positions = routePointSignals.geometry.getAttribute("position") as
        | BufferAttribute
        | undefined;
      const intersections = personalRaycaster
        .intersectObject(routePointSignals, false)
        .filter((candidate) => {
          if (candidate.index === undefined || !positions) return false;
          const target = journeyPointTargets[candidate.index] ?? null;
          if (!journeyRoutePointTargetEligible(
            target,
            latestActiveJourneyRouteId.current,
            Boolean(latestOnJourneyRoutePointActivate.current),
            latestTemporalReveal.current,
          )) return false;
          routeLocalPoint.fromBufferAttribute(positions, candidate.index);
          return isSphericalPointVisible(routeCameraPosition, routeLocalPoint);
        });
      // THREE sorts point intersections by camera depth. That is correct for
      // occlusion, but adjacent 44px-ish pointer neighborhoods can overlap on
      // screen and the visually nearest Route Point must win instead of array
      // or depth order. `distanceToRay` is the actual pointer-to-point miss
      // distance for Points raycasts; retain stable route order only as the
      // exact-coordinate tie break handled by the existing context switcher.
      const intersection = intersections.reduce<(typeof intersections)[number] | null>((nearest, candidate) => {
        if (!nearest) return candidate;
        const nearestMiss = nearest.distanceToRay ?? Number.POSITIVE_INFINITY;
        const candidateMiss = candidate.distanceToRay ?? Number.POSITIVE_INFINITY;
        if (candidateMiss < nearestMiss - 1e-6) return candidate;
        if (Math.abs(candidateMiss - nearestMiss) <= 1e-6) {
          const nearestIndex = nearest.index ?? Number.POSITIVE_INFINITY;
          const candidateIndex = candidate.index ?? Number.POSITIVE_INFINITY;
          if (candidateIndex < nearestIndex) return candidate;
        }
        return nearest;
      }, null);
      return intersection?.index === undefined
        ? null
        : journeyPointTargets[intersection.index] ?? null;
    };
    const homeBaseTargetFromPointer = (clientX: number, clientY: number): string | null => {
      if (!latestOnHomeBaseActivate.current || publishedHomeBasePresenceFrame.length === 0) return null;
      return selectHomeBasePointerTarget(
        publishedHomeBasePresenceFrame,
        latestHomeBasePresence.current,
        clientX,
        clientY,
      );
    };
    const publishRoutePointActivationEvidence = (
      event: PointerEvent | KeyboardEvent,
      target: { journeyId: string; routePointId: string },
      source: "marker" | "label" | "keyboard-label",
    ) => {
      const marker = [...routeVectorLayer.querySelectorAll<SVGCircleElement>(
        ".particle-earth-route__point[data-journey-route][data-route-point-id]",
      )].find((candidate) => (
        candidate.dataset.journeyRoute === target.journeyId
        && candidate.dataset.routePointId === target.routePointId
      )) ?? null;
      host.dataset.routePointActivationSource = source;
      host.dataset.routePointActivationJourneyId = target.journeyId;
      host.dataset.routePointActivationId = target.routePointId;
      host.dataset.routePointActivationEventTarget = event.target instanceof Element
        ? `${event.target.tagName.toLowerCase()}.${[...event.target.classList].join(".")}`
        : "unknown";
      if (event instanceof PointerEvent) {
        host.dataset.routePointActivationClientX = event.clientX.toFixed(1);
        host.dataset.routePointActivationClientY = event.clientY.toFixed(1);
      } else {
        delete host.dataset.routePointActivationClientX;
        delete host.dataset.routePointActivationClientY;
      }
      if (marker) {
        const routeLayerRect = routeVectorLayer.getBoundingClientRect();
        const projectedX = Number(marker.getAttribute("cx"));
        const projectedY = Number(marker.getAttribute("cy"));
        host.dataset.routePointActivationProjectedX = Number.isFinite(projectedX)
          ? (routeLayerRect.left + projectedX).toFixed(1)
          : "";
        host.dataset.routePointActivationProjectedY = Number.isFinite(projectedY)
          ? (routeLayerRect.top + projectedY).toFixed(1)
          : "";
      } else {
        delete host.dataset.routePointActivationProjectedX;
        delete host.dataset.routePointActivationProjectedY;
      }
    };
    const activatePointerTarget = (
      event: PointerEvent,
      explicitGlobePick: { latitude: number; longitude: number } | null = null,
      explicitRouteTarget: RouteLayerPointerTarget | null = null,
    ) => {
      const canPickGlobe = Boolean(latestOnGlobePointPick.current);
      const canActivateJourney = Boolean(
        journeyPointTargets.length > 0
        && (
          latestOnJourneyRouteActivate.current
          || latestOnJourneyRoutePointActivate.current
        ),
      );
      const canActivateHome = Boolean(latestOnHomeBaseActivate.current);
      if (
        !canPickGlobe
        && !canActivateJourney
        && !canActivateHome
        && !latestOnGlobeBlankActivate.current
        && (
          currentMode !== "focusPoint"
          || !latestCenterFocusPoint.current
          || !latestOnFocusPointActivate.current
        )
      ) {
        return;
      }
      preparePersonalPointerRay(event.clientX, event.clientY);
      if (canPickGlobe) {
        if (explicitGlobePick) {
          latestOnGlobePointPick.current?.(explicitGlobePick);
          return;
        }
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
        if (explicitRouteTarget && latestOnJourneyRoutePointActivate.current) {
          publishRoutePointActivationEvidence(event, explicitRouteTarget, explicitRouteTarget.source);
          latestOnJourneyRoutePointActivate.current(
            explicitRouteTarget.journeyId,
            explicitRouteTarget.routePointId,
          );
          return;
        }
        const target = journeyTargetFromPreparedRay();
        if (target?.routePointId && latestOnJourneyRoutePointActivate.current) {
          const routePointTarget = { journeyId: target.journeyId, routePointId: target.routePointId };
          publishRoutePointActivationEvidence(event, routePointTarget, "marker");
          latestOnJourneyRoutePointActivate.current(
            routePointTarget.journeyId,
            routePointTarget.routePointId,
          );
          return;
        }
        if (target) {
          latestOnJourneyRouteActivate.current?.(target.journeyId);
          return;
        }
      }
      const homeBasePeriodId = homeBaseTargetFromPointer(event.clientX, event.clientY);
      if (homeBasePeriodId) {
        latestOnHomeBaseActivate.current?.(homeBasePeriodId);
        return;
      }
      if (personalRaycaster.intersectObject(personalSignal, false).length > 0) {
        latestOnFocusPointActivate.current?.();
        return;
      }
      if (!explicitGlobePick && personalRaycaster.intersectObject(surface, false).length > 0) {
        latestOnGlobeBlankActivate.current?.();
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
    const claimManualInteraction = (publishExternalOwnership = true) => {
      if (publishExternalOwnership) latestOnManualCameraInteraction.current?.();
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

    const cityPointerPicks = new Map<number, { latitude: number; longitude: number }>();
    type RouteLayerPointerTarget = {
      journeyId: string;
      routePointId: string;
      source: "marker" | "label";
    };
    const routeLabelPointerTargets = new Map<number, RouteLayerPointerTarget>();
    const cityPickFromEventTarget = (target: EventTarget | null) => {
      if (!(target instanceof SVGTextElement) || !target.classList.contains("particle-earth-city")) return null;
      const entry = cityLabelPool.find((candidate) => candidate.element === target) ?? null;
      return cityPointCoordinates(entry?.city ?? null);
    };
    const routeLabelTargetFromEventTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const label = target.closest<SVGGElement>(".particle-earth-route__label[data-journey-route][data-route-point-id]");
      const journeyId = label?.dataset.journeyRoute;
      const routePointId = label?.dataset.routePointId;
      return journeyId && routePointId ? { journeyId, routePointId } : null;
    };
    const routeLabelTargetFromPointer = (event: PointerEvent): RouteLayerPointerTarget | null => {
      // A visible marker owns its own visual center even when a neighbouring
      // 44px label hit box overlaps that pixel. Resolve that stable geographic
      // identity first; otherwise the transparent label rectangle can steal a
      // marker click and open a different Route Point context.
      const markerCandidates = [...routeVectorLayer.querySelectorAll<SVGCircleElement>(
        ".particle-earth-route__point[data-journey-route][data-route-point-id]",
      )]
        .filter((marker) => marker.style.display !== "none")
        .map((marker) => {
          const journeyId = marker.dataset.journeyRoute;
          const routePointId = marker.dataset.routePointId;
          if (!journeyId || !routePointId) return null;
          const rect = marker.getBoundingClientRect();
          if (
            event.clientX < rect.left || event.clientX > rect.right
            || event.clientY < rect.top || event.clientY > rect.bottom
          ) return null;
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          return {
            journeyId,
            routePointId,
            source: "marker" as const,
            distance: Math.hypot(event.clientX - centerX, event.clientY - centerY),
          };
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => left.distance - right.distance);
      if (markerCandidates[0]) {
        const { journeyId, routePointId, source } = markerCandidates[0];
        return { journeyId, routePointId, source };
      }

      const candidates = [...routeVectorLayer.querySelectorAll<SVGGElement>(
        ".particle-earth-route__label[data-journey-route][data-route-point-id]",
      )]
        .filter((label) => label.style.display !== "none")
        .map((label) => {
          const hit = label.querySelector<SVGRectElement>(".particle-earth-route__label-hit");
          const journeyId = label.dataset.journeyRoute;
          const routePointId = label.dataset.routePointId;
          if (!hit || !journeyId || !routePointId) return null;
          const hitRect = hit.getBoundingClientRect();
          if (
            event.clientX < hitRect.left || event.clientX > hitRect.right
            || event.clientY < hitRect.top || event.clientY > hitRect.bottom
          ) return null;
          const marker = [...routeVectorLayer.querySelectorAll<SVGCircleElement>(
            ".particle-earth-route__point[data-journey-route][data-route-point-id]",
          )].find((candidate) => (
            candidate.dataset.journeyRoute === journeyId
            && candidate.dataset.routePointId === routePointId
          )) ?? null;
          const markerRect = marker?.getBoundingClientRect() ?? null;
          const markerX = markerRect ? markerRect.left + markerRect.width / 2 : hitRect.left + hitRect.width / 2;
          const markerY = markerRect ? markerRect.top + markerRect.height / 2 : hitRect.top + hitRect.height / 2;
          return {
            journeyId,
            routePointId,
            source: "label" as const,
            distance: Math.hypot(event.clientX - markerX, event.clientY - markerY),
          };
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => left.distance - right.distance);
      if (candidates[0]) {
        const { journeyId, routePointId, source } = candidates[0];
        return { journeyId, routePointId, source };
      }
      const target = routeLabelTargetFromEventTarget(event.target);
      return target ? { ...target, source: "label" } : null;
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

    const finishPointer = (
      event: PointerEvent,
      allowActivation: boolean,
      explicitGlobePick: { latitude: number; longitude: number } | null = null,
      explicitRouteTarget: RouteLayerPointerTarget | null = null,
    ) => {
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
      if (allowActivation && !wasGesture) activatePointerTarget(event, explicitGlobePick, explicitRouteTarget);
    };

    const onPointerUp = (
      event: PointerEvent,
      explicitGlobePick: { latitude: number; longitude: number } | null = null,
      explicitRouteTarget: RouteLayerPointerTarget | null = null,
    ) => {
      const cityPick = explicitGlobePick ?? cityPointerPicks.get(event.pointerId) ?? null;
      const routeTarget = explicitRouteTarget ?? routeLabelPointerTargets.get(event.pointerId) ?? null;
      cityPointerPicks.delete(event.pointerId);
      routeLabelPointerTargets.delete(event.pointerId);
      if (activePointers.has(event.pointerId)) {
        finishPointer(event, isPrimaryPointerActivation(event), cityPick, routeTarget);
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
        activatePointerTarget(event, cityPick, routeTarget);
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      cityPointerPicks.delete(event.pointerId);
      routeLabelPointerTargets.delete(event.pointerId);
      if (rejectedPointerIds.delete(event.pointerId)) return;
      finishPointer(event, false);
    };
    const onRejectedPointerLifecycleEnd = (event: PointerEvent) => {
      cityPointerPicks.delete(event.pointerId);
      routeLabelPointerTargets.delete(event.pointerId);
      rejectedPointerIds.delete(event.pointerId);
    };
    const onLostPointerCapture = (event: PointerEvent) => {
      cityPointerPicks.delete(event.pointerId);
      routeLabelPointerTargets.delete(event.pointerId);
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

    // City labels are a sibling SVG above the WebGL canvas. Delegate their
    // complete contact lifecycle into the renderer's existing handlers instead
    // of giving labels a second activation path. Pointer capture moves an active
    // gesture onto the canvas; these wrappers are also the fallback when capture
    // is unavailable, and wheel keeps the same anchored-zoom authority.
    const onCityLayerPointerDown = (event: PointerEvent) => {
      event.stopPropagation();
      const cityPick = cityPickFromEventTarget(event.target);
      if (cityPick) cityPointerPicks.set(event.pointerId, cityPick);
      onPointerDown(event);
    };
    const onCityLayerPointerMove = (event: PointerEvent) => {
      event.stopPropagation();
      onPointerMove(event);
    };
    const onCityLayerPointerUp = (event: PointerEvent) => {
      event.stopPropagation();
      onPointerUp(event, cityPickFromEventTarget(event.target));
    };
    const onCityLayerPointerCancel = (event: PointerEvent) => {
      event.stopPropagation();
      onPointerCancel(event);
    };
    const onCityLayerWheel = (event: WheelEvent) => {
      event.stopPropagation();
      onWheel(event);
    };
    const onRouteLayerPointerDown = (event: PointerEvent) => {
      const routeTarget = routeLabelTargetFromPointer(event);
      if (!routeTarget) return;
      event.stopPropagation();
      routeLabelPointerTargets.set(event.pointerId, routeTarget);
      onPointerDown(event);
    };
    const onRouteLayerPointerMove = (event: PointerEvent) => {
      if (!routeLabelPointerTargets.has(event.pointerId)) return;
      event.stopPropagation();
      onPointerMove(event);
    };
    const onRouteLayerPointerUp = (event: PointerEvent) => {
      const routeTarget = routeLabelPointerTargets.get(event.pointerId)
        ?? routeLabelTargetFromPointer(event);
      if (!routeTarget) return;
      event.stopPropagation();
      onPointerUp(event, null, routeTarget);
    };
    const onRouteLayerPointerCancel = (event: PointerEvent) => {
      if (!routeLabelPointerTargets.has(event.pointerId)) return;
      event.stopPropagation();
      onPointerCancel(event);
    };
    const onRouteLayerWheel = (event: WheelEvent) => {
      if (!routeLabelTargetFromEventTarget(event.target)) return;
      event.stopPropagation();
      onWheel(event);
    };
    const onRouteLayerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const routeTarget = routeLabelTargetFromEventTarget(event.target);
      if (!routeTarget || !latestOnJourneyRoutePointActivate.current) return;
      event.preventDefault();
      event.stopPropagation();
      publishRoutePointActivationEvidence(event, routeTarget, "keyboard-label");
      latestOnJourneyRoutePointActivate.current(routeTarget.journeyId, routeTarget.routePointId);
    };

    cityVectorLayer.addEventListener("pointerdown", onCityLayerPointerDown);
    cityVectorLayer.addEventListener("pointermove", onCityLayerPointerMove);
    cityVectorLayer.addEventListener("pointerup", onCityLayerPointerUp);
    cityVectorLayer.addEventListener("pointercancel", onCityLayerPointerCancel);
    cityVectorLayer.addEventListener("wheel", onCityLayerWheel, { passive: false });
    routeVectorLayer.addEventListener("pointerdown", onRouteLayerPointerDown);
    routeVectorLayer.addEventListener("pointermove", onRouteLayerPointerMove);
    routeVectorLayer.addEventListener("pointerup", onRouteLayerPointerUp);
    routeVectorLayer.addEventListener("pointercancel", onRouteLayerPointerCancel);
    routeVectorLayer.addEventListener("wheel", onRouteLayerWheel, { passive: false });
    routeVectorLayer.addEventListener("keydown", onRouteLayerKeyDown);
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
      radialPulseScale: 0,
      terrainRelief: true,
      visitedImprint: true,
    });
    particleDimmingMaterials.push(particleMaterial);
    attachVisitedImprintMaterial(particleMaterial);
    syncParticleDimming(latestJourneyRoutes.current, latestActiveJourneyRouteId.current);
    syncVisitedImprint(latestJourneyRoutes.current);
    let particleGeometry: BufferGeometry | null = null;
    let particles: Points | null = null;
    let landVisualReady = false;
    let baseCoastlineSourceAvailable = false;
    const refinementBuildGuard = new ParticleRefinementBuildGuard();
    refinementBuildGuard.setVisible(!document.hidden);
    const refinementCache = new RefinementCache<{
      region: ParticleRefinementRegion;
      particleCap: number;
      sample: RegionalLandSample;
    }>(PARTICLE_REFINEMENT_CACHE_LIMIT);
    const refinementViewPosition = new Vector3();
    let activeRefinementLayer: ParticleRefinementLayer | null = null;
    let departingRefinementLayer: ParticleRefinementLayer | null = null;
    let lastAttentionLayerPayload = "";
    const publishAttentionLayerMeasurements = () => {
      if (!import.meta.env.DEV) return;
      const rendererDpr = renderer.getPixelRatio();
      const measure = (
        id: AttentionParticleLayerId,
        material: ReturnType<typeof createParticleEarthMaterial> | null,
      ) => resolveAttentionLayerMeasurement({
        id,
        present: Boolean(material),
        authoredCssSizePx: material ? Number(material.uniforms.uPointSize.value) : null,
        shaderPixelRatio: material ? Number(material.uniforms.uPixelRatio.value) : null,
        opacity: material ? Number(material.uniforms.uOpacity.value) : 0,
        rendererDpr,
      });
      const payload = JSON.stringify({
        devicePixelRatio: window.devicePixelRatio,
        rendererPixelRatio: rendererDpr,
        layers: [
          measure("base-particle-surface", particleMaterial),
          measure("spatial-lod-refinement", activeRefinementLayer?.material ?? null),
          measure("archive-signal", archiveMaterial),
          measure("archive-cluster", clusterMaterial),
          measure("cyan-cluster", cyanClusterMaterial),
          measure("particle-shell", shellMaterial),
          measure("particle-halo", haloMaterial),
          measure("personal-focus-signal", personalMaterial),
        ],
      });
      if (payload === lastAttentionLayerPayload) return;
      lastAttentionLayerPayload = payload;
      host.dataset.attentionLayers = payload;
    };
    let requestedRefinementCacheKey: string | null = null;
    let lastRefinementViewSampleAt = Number.NEGATIVE_INFINITY;
    let refinementBuildState = document.hidden ? "paused" : "idle";
    let landSourceDebug = "loading:ne_110m_land.geojson@110m";
    const coastlineRefinementCache = new RefinementCache<Float32Array>(COASTLINE_SPATIAL_CACHE_LIMIT);
    const coastlineLocalChunkCache = new RefinementCache<CoastlineLocalChunk>(COASTLINE_LOCAL_CACHE_LIMIT);
    const coastlineRefinementBuildGuard = new ParticleRefinementBuildGuard();
    coastlineRefinementBuildGuard.setVisible(!document.hidden);
    let detailedCoastlineRings: number[][][] = [];
    let detailedMidCoastlineReady = false;
    let activeCoastlineRegionKey: string | null = null;
    let requestedCoastlineCacheKey: string | null = null;
    let activeCoastlineSource = "50m-regional-foundation";
    let activeCoastlineInspectionTarget: CoastlineInspectionTarget | null = null;
    let activeCoastlineRegionCenter: { lat: number; lon: number } | null = null;
    let activeCoastlineChunkIds: string[] = [];
    let activeCoastlineLocalVertices = 0;
    let localCoastlineRetryAt = Number.NEGATIVE_INFINITY;
    let coastlineRefinementState = document.hidden ? "paused" : "fallback";
    // #432: a terminal refinement state alone cannot say WHICH load it belongs
    // to, so a reader can be satisfied by the previous region's finished load
    // while the current one is still in flight. This counts applied near
    // coastline geometries, so readiness is stated against a load identity.
    let coastlineRefinementRevision = 0;
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
      removeVisitedImprintMaterial(layer.material);
      layer.geometry.dispose();
      layer.material.dispose();
    };

    const applyRefinementSample = (
      cacheKey: string,
      region: ParticleRefinementRegion,
      particleCap: number,
      sample: RegionalLandSample,
    ) => {
      if (activeRefinementLayer?.cacheKey === cacheKey) return;
      const geometry = createPositionGeometry(sample.positions, createBurstTargets(sample.positions));
      geometry.setAttribute(
        "lodThreshold",
        new BufferAttribute(sample.lodThresholds, 1),
      );
      if (sample.positions.length > 0) {
        geometry.computeBoundingSphere();
      }
      const material = createParticleEarthMaterial({
        color: 0x74eee6,
        opacity: 0,
        size: 7.2,
        spatialLod: true,
        radialPulseScale: 0,
        terrainRelief: true,
        visitedImprint: true,
      });
      material.uniforms.uViewportHeight.value = targetSize.y;
      attachVisitedImprintMaterial(material);
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
      const cached = refinementCache.get(cacheKey);
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
        refinementCache.set(cacheKey, { region, particleCap, sample });
        applyRefinementSample(cacheKey, region, particleCap, sample);
      })();
    };

    const applyNearCoastlinePositions = (
      positions: Float32Array,
      {
        cacheKey,
        terminalState = "ready",
        source,
        inspectionTarget,
        regionCenter,
        chunkIds,
        localVertexCount = 0,
      }: {
        cacheKey: string;
        terminalState?: "ready" | "cached";
        source: string;
        inspectionTarget: CoastlineInspectionTarget;
        regionCenter: { lat: number; lon: number };
        chunkIds: string[];
        localVertexCount?: number;
      },
    ) => {
      const nextGeometry = createPositionGeometry(positions);
      if (positions.length > 0) nextGeometry.computeBoundingSphere();
      const previous = nearCoastlineGeometry;
      nearCoastlineGeometry = nextGeometry;
      nearCoastlines.geometry = nextGeometry;
      previous.dispose();
      activeCoastlineRegionKey = cacheKey;
      requestedCoastlineCacheKey = null;
      activeCoastlineSource = source;
      activeCoastlineInspectionTarget = inspectionTarget;
      activeCoastlineRegionCenter = regionCenter;
      activeCoastlineChunkIds = [...chunkIds];
      activeCoastlineLocalVertices = localVertexCount;
      coastlineRefinementState = terminalState;
      coastlineRefinementRevision += 1;
    };

    const readLocalCoastlineChunk = async (
      entry: { id: string; path: string },
    ) => {
      const cached = coastlineLocalChunkCache.get(entry.id);
      if (cached) return cached;
      const loaded = await loadLocalCoastlineChunk(entry);
      if (loaded) coastlineLocalChunkCache.set(entry.id, loaded);
      return loaded;
    };

    const requestCoastlineRefinement = (inspectionTarget: CoastlineInspectionTarget) => {
      const qualityAtRequest = currentQuality;
      const regional = resolveCoastlineRefinementRegion(inspectionTarget);
      const localCell = isLocalCoastlineTarget(inspectionTarget)
        ? resolveLocalCoastlineCell(inspectionTarget)
        : null;
      const useLocalSource = Boolean(localCell && performance.now() >= localCoastlineRetryAt);
      const cacheKey = useLocalSource && localCell
        ? `${qualityAtRequest}:10m:${localCell.id}`
        : `${qualityAtRequest}:50m:${regional.key}`;

      if (activeCoastlineRegionKey === cacheKey) {
        if (requestedCoastlineCacheKey && requestedCoastlineCacheKey !== cacheKey) {
          coastlineRefinementBuildGuard.invalidate();
          requestedCoastlineCacheKey = null;
        }
        activeCoastlineInspectionTarget = inspectionTarget;
        activeCoastlineRegionCenter = useLocalSource && localCell
          ? localCell.center
          : regional.center;
        coastlineRefinementState = "ready";
        return;
      }
      if (requestedCoastlineCacheKey === cacheKey) return;

      requestedCoastlineCacheKey = cacheKey;
      const ticket = coastlineRefinementBuildGuard.request(cacheKey);
      const regionalCacheKey = `${qualityAtRequest}:50m:${regional.key}`;
      const readRegionalPositions = () => {
        if (detailedCoastlineRings.length === 0) return null;
        const cached = coastlineRefinementCache.get(regionalCacheKey);
        if (cached) return { positions: cached, cached: true };
        const positions = buildRegionalCoastlinePositions({
          rings: detailedCoastlineRings,
          region: regional,
          quality: qualityAtRequest,
        });
        coastlineRefinementCache.set(regionalCacheKey, positions);
        return { positions, cached: false };
      };
      const applyRegionalFallback = (source: string) => {
        if (currentQuality !== qualityAtRequest || !coastlineRefinementBuildGuard.isCurrent(ticket)) return;
        const regionalResult = readRegionalPositions();
        if (!regionalResult) {
          requestedCoastlineCacheKey = null;
          coastlineRefinementState = "awaiting-50m";
          return;
        }
        applyNearCoastlinePositions(regionalResult.positions, {
          cacheKey: regionalCacheKey,
          terminalState: regionalResult.cached ? "cached" : "ready",
          source,
          inspectionTarget,
          regionCenter: regional.center,
          chunkIds: [],
        });
      };

      if (!localCell || !useLocalSource) {
        coastlineRefinementState = "building";
        applyRegionalFallback(localCell ? "50m-regional-local-backoff" : "50m-regional-foundation");
        return;
      }

      coastlineRefinementState = "loading-local";
      void (async () => {
        const manifest = await loadLocalCoastlineManifest();
        if (
          !manifest
          || currentQuality !== qualityAtRequest
          || !coastlineRefinementBuildGuard.isCurrent(ticket)
        ) {
          if (manifest === null && coastlineRefinementBuildGuard.isCurrent(ticket)) {
            localCoastlineRetryAt = performance.now() + 5_000;
            applyRegionalFallback("50m-regional-fallback");
          }
          return;
        }
        const chunkIds = resolveLocalCoastlineChunkIds(manifest, inspectionTarget);
        const entries = chunkIds
          .map((id) => manifest.chunks.find((entry) => entry.id === id))
          .filter((entry): entry is CoastlineLocalManifest["chunks"][number] => Boolean(entry));
        if (entries.length === 0) {
          localCoastlineRetryAt = performance.now() + 5_000;
          applyRegionalFallback("50m-regional-fallback");
          return;
        }
        const chunks = await Promise.all(entries.map(readLocalCoastlineChunk));
        if (
          currentQuality !== qualityAtRequest
          || !coastlineRefinementBuildGuard.isCurrent(ticket)
        ) return;
        if (chunks.some((chunk) => chunk === null)) {
          localCoastlineRetryAt = performance.now() + 5_000;
          applyRegionalFallback("50m-regional-fallback");
          return;
        }
        const regionalResult = readRegionalPositions();
        if (!regionalResult) {
          requestedCoastlineCacheKey = null;
          coastlineRefinementState = "awaiting-50m";
          return;
        }
        localCoastlineRetryAt = Number.NEGATIVE_INFINITY;
        const localPositions = buildLocalCoastlinePositions({
          chunks: chunks as CoastlineLocalChunk[],
          quality: qualityAtRequest,
        });
        const positions = mergeRegionalAndLocalCoastlinePositions({
          regionalPositions: regionalResult.positions,
          localPositions,
          localBounds: entries.map((entry) => entry.bounds),
          quality: qualityAtRequest,
        });
        applyNearCoastlinePositions(positions, {
          cacheKey,
          source: "50m-regional+10m-local-natural-earth",
          inspectionTarget,
          regionCenter: localCell.center,
          chunkIds,
          localVertexCount: localPositions.length / 3,
        });
      })();
    };

    const cancelPendingCoastlineRefinement = (state: string) => {
      if (requestedCoastlineCacheKey !== null) {
        coastlineRefinementBuildGuard.invalidate();
        requestedCoastlineCacheKey = null;
      }
      coastlineRefinementState = state;
    };

    const updateCoastlineRefinement = (now: number) => {
      if (semanticZoomState.coastlineWeights.near <= 0.001) {
        cancelPendingCoastlineRefinement("idle");
        return;
      }
      if (isFocusFlightActive(pointFocusSettling, routeFocusSettling)) {
        cancelPendingCoastlineRefinement("deferred-flight");
        return;
      }
      if (activePointers.size > 0 || rotationVelocityX !== 0 || rotationVelocityY !== 0 || now < wheelInteractionUntil) {
        cancelPendingCoastlineRefinement("deferred-interaction");
        return;
      }
      if (document.hidden || now - lastCoastlineRefinementSampleAt < 200) return;
      lastCoastlineRefinementSampleAt = now;
      sampleFocusViewport(false);
      const focusTarget = resolveParticleDiveAnchor(routeFocusFrame, latestFocusPoint.current);
      const bounds = renderer.domElement.getBoundingClientRect();
      const freeExploreTarget = resolveSurfaceAnchor({
        x: bounds.left + sampledFocusCenter.x,
        y: bounds.top + sampledFocusCenter.y,
      });
      const inspectionTarget = resolveCoastlineInspectionTarget({
        focusTarget,
        focusOwnsInspection: shouldUseCoastlineFocusTarget(
          focusTarget,
          freeExploreTarget,
          manualFocusRevision !== null,
        ),
        freeExploreTarget,
      });
      if (!inspectionTarget) {
        coastlineRefinementState = "fallback";
        return;
      }
      requestCoastlineRefinement(inspectionTarget);
    };

    let reliefTextureReady = false;
    let particleTerrainRelief = 0;
    host.dataset.reliefTexture = "loading";
    host.dataset.particleTerrainSource = "natural-earth-shaded-relief;structural-contrast;not-dem";
    // One existing geographic source serves the optional bump support and the
    // default particle relief. A failed source leaves the geographic globe
    // intact instead of substituting procedural terrain.
    const reliefTexture = new TextureLoader().load(
      "/earth/natural-earth-shaded-relief-2048.jpg",
      (loadedTexture) => {
        if (disposed) { loadedTexture.dispose(); return; }
        loadedTexture.wrapS = RepeatWrapping;
        reliefMaterial.bumpMap = loadedTexture;
        reliefMaterial.needsUpdate = true;
        reliefTextureReady = true;
        host.dataset.reliefTexture = "ready";
      },
      undefined,
      () => {
        if (disposed) return;
        reliefTextureReady = false;
        host.dataset.reliefTexture = "unavailable";
      },
    );
    const updateTerrainParticles = (
      material: ReturnType<typeof createParticleEarthMaterial>,
      time: number,
    ) => {
      // Time belongs to the existing point shimmer, never terrain displacement.
      material.uniforms.uTime.value = time;
      material.uniforms.uTerrainReliefMap.value = reliefTexture;
      material.uniforms.uTerrainReliefEmphasis.value = particleTerrainRelief;
    };

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
      const vector = focusSignalAnchor(point, fallback);
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
      applyRendererBudget();
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

      const nextParticleGeometry = createPositionGeometry(particlePositions, createBurstTargets(particlePositions));
      nextParticleGeometry.computeBoundingSphere();
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

      const nextCoastlineGeometry = createPositionGeometry(coastlinePositions);
      if (coastlinePositions.length > 0) nextCoastlineGeometry.computeBoundingSphere();
      const previousCoastlineGeometry = coastlineGeometry;
      coastlineGeometry = nextCoastlineGeometry;
      coastlines.geometry = coastlineGeometry;
      previousCoastlineGeometry.dispose();
      const applyDetailedCoastlinePositions = (positionsByLod: { mid: Float32Array; near: Float32Array }) => {
        for (const [lod, positions] of Object.entries(positionsByLod) as ["mid" | "near", Float32Array][]) {
          const nextGeometry = createPositionGeometry(positions);
          if (positions.length > 0) nextGeometry.computeBoundingSphere();
          if (lod === "mid") {
            const previous = midCoastlineGeometry; midCoastlineGeometry = nextGeometry; midCoastlines.geometry = nextGeometry; previous.dispose();
          } else if (activeCoastlineRegionKey) {
            // #154 review: a quality rebuild owns the base/mid data, but an
            // already-committed near refinement has its own exact cache key.
            // Keep that geometry visible until the new-quality refinement
            // replaces it, so the key and pixels cannot diverge for one frame.
            nextGeometry.dispose();
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
        if (!activeCoastlineRegionKey && requestedCoastlineCacheKey === null) {
          coastlineRefinementState = "idle";
        }
      });
    };

    const applyQuality = (nextQuality: keyof typeof QUALITY_PROFILE) => {
      if (currentQuality === nextQuality && landVisualReady) return;
      currentQuality = nextQuality;
      host.dataset.quality = nextQuality;
      refinementBuildGuard.invalidate();
      requestedRefinementCacheKey = null;
      refinementBuildState = document.hidden ? "paused" : "idle";
      coastlineRefinementBuildGuard.invalidate();
      requestedCoastlineCacheKey = null;
      coastlineRefinementState = document.hidden ? "paused" : activeCoastlineRegionKey ? "ready" : "idle";
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
      animationFrame = 0;
      if (disposed) return;
      sceneFrameRevision += 1;
      const elapsedDelta = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
      const delta = Math.min(0.05, elapsedDelta);
      lastFrameDeltaMs = delta * 1_000;
      lastTime = now;
      const target = GLOBE_MODE_CONFIG[currentMode];
      const audioEnergy = reduceMotion
        ? { low: 0, mid: 0, high: 0, overall: 0 }
        : readAudioAtmosphereEnergy();
      // #20: restrained energy mapping. Even at full energy the environment
      // only gains 12–15%, so it feels alive rather than becoming a visualizer.
      const audioGain = audioAtmosphereGains(audioEnergy);
      const cameraHeldByDetail = latestCameraHold.current;
      const diveDirectManipulation = earthDiveDirectManipulationOwnsCamera({
        overlapActive: Boolean(latestVisibilityHint.current.earthDiveOverlapActive),
        activePointerCount: activePointers.size,
        now,
        wheelInteractionUntil,
      });
      const focusSolverOwnsState = manualFocusRevision === null
        && !cameraHeldByDetail
        && !diveDirectManipulation;
      const initialCameraAnchorNow = focusSolverOwnsState ? latestInitialCameraAnchor.current : null;
      const spatialFocusPoint = initialCameraAnchorNow
        ?? focusTarget?.point
        ?? routeFocusFrame?.center
        ?? latestFocusPoint.current;
      const focusFlightActive = Boolean(
        focusSolverOwnsState
        &&
        currentMode === "focusPoint"
        && !initialCameraAnchorNow
        && latestCenterFocusPoint.current
        && spatialFocusPoint
        && isFocusFlightActive(pointFocusSettling, routeFocusSettling),
      );
      // The fresh-Atlas Home seed is orientation-only, but it still has to use
      // the same layout-aware screen target as semantic focus. A raw lat/lon
      // rotation centers the point on the translated globe itself; on compact
      // layouts that globe center can sit near/outside the usable viewport and
      // leave the Home accessibility target permanently hidden. Solving only the
      // rotation preserves Home's non-semantic ownership while making the seed
      // visible in the canonical focus viewport.
      const initialCameraRotation = focusSolverOwnsState && initialCameraAnchorNow
        ? solveFocusRotationForViewport(
            initialCameraAnchorNow,
            rotationXForLatitude(initialCameraAnchorNow.lat),
            rotationYForLongitude(initialCameraAnchorNow.lon),
            target.scale * interactiveZoom,
            target.x,
            target.y,
          )
        : null;
      let targetRotationX = cameraHeldByDetail
        ? interactiveRotationX
        : initialCameraRotation
          ? nearestEquivalentRotation(interactiveRotationX, initialCameraRotation.x)
          : focusSolverOwnsState && focusTarget
            ? focusTarget.rotationX
            : focusSolverOwnsState && spatialFocusPoint
              ? rotationXForLatitude(spatialFocusPoint.lat)
              : interactiveRotationX;
      let targetBaseRotationY = cameraHeldByDetail
        ? baseRotationY
        : initialCameraRotation
          ? nearestEquivalentRotation(baseRotationY, initialCameraRotation.y)
          : focusSolverOwnsState && focusTarget
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
      let focusSettledRevisionThisFrame: number | null = null;
      for (const material of particleDimmingMaterials) {
        material.uniforms.uActiveDimStrength.value = interpolate(
          material.uniforms.uActiveDimStrength.value,
          particleActiveDimStrengthTarget,
        );
      }

      if (initialCameraAnchorNow && activePointers.size === 0) {
        interactiveRotationX = interpolate(interactiveRotationX, targetRotationX);
        interactiveRotationY = interpolate(interactiveRotationY, 0);
      }

      if (
        focusSolverOwnsState
        && pointFocusSettling
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
          focusSettledRevisionThisFrame = activeFocusRevision;
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

      if (focusSolverOwnsState && routeFocusSettling && routeFocusFrame && activePointers.size === 0) {
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
          focusSettledRevisionThisFrame = activeFocusRevision;
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

      if (!cameraHeldByDetail && routeFocusZoomResetting && activePointers.size === 0) {
        interactiveZoom = interpolate(interactiveZoom, 1);
        if (Math.abs(interactiveZoom - 1) < 0.003) {
          interactiveZoom = 1;
          routeFocusZoomResetting = false;
          syncRouteFocusPhase();
        }
      }

      if (!cameraHeldByDetail) {
        globe.scale.setScalar(interpolate(globe.scale.x, target.scale * interactiveZoom));
        baseRotationY = interpolate(baseRotationY, targetBaseRotationY);
      }
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      // Journey selection rotates (and may zoom) the globe, but never translates
      // its screen position. The globe's x/y belongs to the layout/mode only.
      globe.position.x = interpolate(globe.position.x, target.x);
      globe.position.y = interpolate(globe.position.y, target.y);
      const initialCameraAnchorSettling = Boolean(
        initialCameraAnchorNow
        && activePointers.size === 0
        && (
          Math.abs(getShortestRotationDelta(interactiveRotationX, targetRotationX)) > 0.001
          || Math.abs(getShortestRotationDelta(baseRotationY, targetBaseRotationY)) > 0.001
          || Math.abs(interactiveRotationY) > 0.001
        )
      );
      if (
        !cameraHeldByDetail
        && activePointers.size === 0
        && !reduceMotion
        && !focusSettledThisFrame
        && !initialCameraAnchorNow
      ) {
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
      // #252: a camera hand-back arrives as a revision, and is treated exactly
      // like a manual gesture so the focus machinery does not undo it.
      const zoomIntentNow = latestZoomIntent.current;
      if (zoomIntentNow && zoomIntentNow.revision !== appliedZoomIntentRevision) {
        appliedZoomIntentRevision = zoomIntentNow.revision;
        claimManualInteraction(false);
        if (zoomIntentNow.center) {
          sampleFocusViewport(true);
          const nextZoom = clampGlobeZoom(zoomIntentNow.zoom);
          const nextScale = GLOBE_MODE_CONFIG[currentMode].scale * nextZoom;
          const solved = solveFocusRotationForViewport(
            zoomIntentNow.center,
            interactiveRotationX,
            baseRotationY + interactiveRotationY,
            nextScale,
            globe.position.x,
            globe.position.y,
            sampledFocusCenter,
          );
          if (solved.converged) {
            interactiveRotationX = clampGlobeTilt(solved.x);
            interactiveRotationY = nearestEquivalentRotation(
              baseRotationY + interactiveRotationY,
              solved.y,
            ) - baseRotationY;
            interactiveZoom = nextZoom;
            rotationVelocityX = 0;
            rotationVelocityY = 0;
            globe.scale.setScalar(nextScale);
            globe.rotation.x = interactiveRotationX;
            globe.rotation.y = baseRotationY + interactiveRotationY;
            routeProjectionRevision += 1;
            if (import.meta.env.DEV) {
              const projected = projectFocusPointForRotation(
                zoomIntentNow.center,
                globe.rotation.x,
                globe.rotation.y,
                globe.scale.x,
                globe.position.x,
                globe.position.y,
                focusProjectionScreen,
              );
              host.dataset.cameraHandbackLat = String(zoomIntentNow.center.lat);
              host.dataset.cameraHandbackLon = String(zoomIntentNow.center.lon);
              host.dataset.cameraHandbackErrorPx = Math.hypot(
                projected.x - sampledFocusCenter.x,
                projected.y - sampledFocusCenter.y,
              ).toFixed(3);
            }
          } else {
            applyAnchoredZoom(zoomIntentNow.zoom, null, interactionAnchorScreen);
          }
        } else {
          applyAnchoredZoom(zoomIntentNow.zoom, null, interactionAnchorScreen);
        }
      }
      semanticZoomState = resolveGlobeSemanticZoomForFrame({
        zoom: interactiveZoom,
        current: semanticZoomState,
        qualityProfile: currentQuality,
        focusFlightActive: routeFocusSettling,
      });
      host.dataset.semanticZoom = semanticZoomState.state;
      host.dataset.cityLod = semanticZoomState.cityTier;
      host.dataset.localProgress = semanticZoomState.snapshot.localProgress.toFixed(3);
      const visitedImprintAttenuation = visitedImprintZoomAttenuation(
        semanticZoomState.state,
        semanticZoomState.snapshot.localProgress,
      );
      for (const material of visitedImprintMaterials) {
        material.uniforms.uVisitedImprintAttenuation.value = visitedImprintAttenuation;
      }
      host.dataset.visitedImprintAttenuation = visitedImprintAttenuation.toFixed(3);
      // Publish the authority's snapshot to whoever owns the Dive. Only a
      // material move is reported, so a resting camera costs nothing.
      const snapshot = semanticZoomState.snapshot;
      if (
        latestOnSemanticZoomSnapshot.current
        && (
          !publishedSemanticZoomSnapshot
          || snapshot.level !== publishedSemanticZoomSnapshot.level
          || Math.abs(snapshot.localProgress - publishedSemanticZoomSnapshot.localProgress) >= 0.004
        )
      ) {
        publishedSemanticZoomSnapshot = snapshot;
        latestOnSemanticZoomSnapshot.current(snapshot);
      }
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
          : activeCoastlineRegionKey ? activeCoastlineSource : baseCoastlineSourceAvailable ? "110m-global-fallback" : "unavailable";
      host.dataset.coastlineActiveChunks = activeCoastlineChunkIds.join(",");
      host.dataset.coastlineCacheChunks = String(coastlineRefinementCache.size);
      host.dataset.coastlineLocalChunkCache = String(coastlineLocalChunkCache.size);
      host.dataset.coastlineLocalVertices = String(activeCoastlineLocalVertices);
      host.dataset.coastlineRefinement = coastlineRefinementState;
      // #432: the readiness a reader outside the scene needs is not "some load
      // finished" but "the load for the region being asked about finished and
      // nothing newer is in flight". The scene owns both facts, so it publishes
      // them rather than leaving a wall clock to guess.
      host.dataset.sceneFrameRevision = String(sceneFrameRevision);
      host.dataset.coastlineRefinementRevision = String(coastlineRefinementRevision);
      host.dataset.coastlineRegionKey = activeCoastlineRegionKey ?? "";
      host.dataset.coastlinePendingRegionKey = requestedCoastlineCacheKey ?? "";
      if (activeCoastlineInspectionTarget) {
        host.dataset.coastlineInspectionSource = activeCoastlineInspectionTarget.source;
        host.dataset.coastlineInspectionLat = activeCoastlineInspectionTarget.lat.toFixed(5);
        host.dataset.coastlineInspectionLon = activeCoastlineInspectionTarget.lon.toFixed(5);
      } else {
        delete host.dataset.coastlineInspectionSource;
        delete host.dataset.coastlineInspectionLat;
        delete host.dataset.coastlineInspectionLon;
      }
      if (activeCoastlineRegionCenter) {
        host.dataset.coastlineRegionCenterLat = activeCoastlineRegionCenter.lat.toFixed(5);
        host.dataset.coastlineRegionCenterLon = activeCoastlineRegionCenter.lon.toFixed(5);
      } else {
        delete host.dataset.coastlineRegionCenterLat;
        delete host.dataset.coastlineRegionCenterLon;
      }
      // Keep the particle world alive while idle without involving React's
      // render cycle. Reduced-motion resolves to a stable final frame.
      const motionTime = reduceMotion ? 0 : now / 1000;
      const terrainAvailable = reliefTextureReady && baseCoastlineSourceAvailable
        && currentMode !== "surfaceEarth";
      // Landforms stay geographically fixed. Existing zoom/focus interpolation
      // changes their emphasis as the viewer approaches a different place.
      particleTerrainRelief = interpolate(particleTerrainRelief,
        terrainAvailable ? terrainParticleReliefEmphasis(interactiveZoom, currentQuality) : 0);
      updateTerrainParticles(particleMaterial, motionTime);
      if (activeRefinementLayer) {
        updateTerrainParticles(activeRefinementLayer.material, motionTime);
      }
      if (departingRefinementLayer) {
        updateTerrainParticles(departingRefinementLayer.material, motionTime);
      }
      host.dataset.particleTerrainRelief = particleTerrainRelief.toFixed(4);
      if (archiveMaterial) archiveMaterial.uniforms.uTime.value = motionTime;
      clusterMaterial.uniforms.uTime.value = motionTime;
      cyanClusterMaterial.uniforms.uTime.value = motionTime;
      shellMaterial.uniforms.uTime.value = motionTime;
      haloMaterial.uniforms.uTime.value = motionTime;
      personalMaterial.uniforms.uTime.value = motionTime;

      updateRouteVectorLayer();

      if (latestOnHomeBasePresenceFrame.current) {
        // Home projection must sample the globe transform from THIS frame. Route
        // vector rendering also updates matrixWorld, but Home cannot depend on
        // that sibling being visible (compact/empty Atlas can legitimately have
        // no route vector layer). Without this update, an async Home camera seed
        // can rotate the live globe while Home reads the previous matrix and stays
        // hidden behind the stale horizon indefinitely once the loop settles.
        globe.updateWorldMatrix(true, false);
        updateGeoProjectionFrame(geoFrame, camera, globe.matrixWorld, targetSize.x, targetSize.y);
        if (now - anchorFrameRectSampledAt > 100) {
          anchorFrameRectSampledAt = now;
          const rect = renderer.domElement.getBoundingClientRect();
          anchorFrameRect.set(rect.left, rect.top);
        }
        const nextHomeBasePresenceFrame = latestHomeBasePresence.current.map((descriptor) => {
          const visible = projectLocalPoint(
            geoFrame,
            descriptor.anchor.x,
            descriptor.anchor.y,
            descriptor.anchor.z,
            homeBaseProjectionPoint,
          );
          return {
            periodId: descriptor.periodId,
            x: anchorFrameRect.x + homeBaseProjectionPoint.x,
            y: anchorFrameRect.y + homeBaseProjectionPoint.y,
            visible: visible && isProjectedPointInsideViewport(
              homeBaseProjectionPoint.x,
              homeBaseProjectionPoint.y,
              targetSize.x,
              targetSize.y,
            ),
          };
        });
        const homeBaseFrameChanged = nextHomeBasePresenceFrame.length !== publishedHomeBasePresenceFrame.length
          || nextHomeBasePresenceFrame.some((candidate, index) => {
            const previous = publishedHomeBasePresenceFrame[index];
            return !previous
              || candidate.periodId !== previous.periodId
              || candidate.visible !== previous.visible
              || Math.abs(candidate.x - previous.x) >= 0.5
              || Math.abs(candidate.y - previous.y) >= 0.5;
          });
        if (homeBaseFrameChanged) {
          publishedHomeBasePresenceFrame = nextHomeBasePresenceFrame;
          latestOnHomeBasePresenceFrame.current(nextHomeBasePresenceFrame);
        }
      }

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

      const diveAnchor = resolveParticleDiveAnchor(
        routeFocusFrame,
        latestFocusPoint.current,
        initialCameraAnchorNow,
      );
      if (latestCenterFocusPoint.current && diveAnchor) {
        // #237: the focus signal is a geographic annotation like any other, so
        // it publishes the shared frame's answer for its latitude/longitude
        // instead of re-deriving the transform. QA compares this against place
        // label anchors, and comparing two subsystems is only meaningful once
        // they are two READERS of one projection rather than two projections.
        updateGeoProjectionFrame(geoFrame, camera, globe.matrixWorld, targetSize.x, targetSize.y);
        projectGeographicAnchorToViewport(
          geoFrame,
          diveAnchor.lat,
          diveAnchor.lon,
          focusSignalScreenPoint,
        );
        if (latestFocusPoint.current) {
          host.dataset.personalPointX = String(focusSignalScreenPoint.x);
          host.dataset.personalPointY = String(focusSignalScreenPoint.y);
        } else {
          delete host.dataset.personalPointX;
          delete host.dataset.personalPointY;
        }
        // #252: the same frame, read once more a small step north, gives the
        // local geographic scale in the only unit both renderers share -
        // viewport CSS pixels per degree of LATITUDE. Latitude on purpose: a
        // degree of longitude shrinks with latitude, so an east-west probe
        // would measure where the anchor is rather than how large it is drawn.
        projectGeographicAnchorToViewport(
          geoFrame,
          diveAnchor.lat + ANCHOR_SCALE_PROBE_DEG,
          diveAnchor.lon,
          focusScaleProbePoint,
        );
        const anchorPxPerDegreeLat = Math.hypot(
          focusScaleProbePoint.x - focusSignalScreenPoint.x,
          focusScaleProbePoint.y - focusSignalScreenPoint.y,
        ) / ANCHOR_SCALE_PROBE_DEG;
        // The canvas is offset inside the viewport, so the projection's own
        // coordinates are canvas-relative. Publishing viewport pixels is what
        // lets a second renderer in a different box compare against them.
        if (now - anchorFrameRectSampledAt > 100) {
          anchorFrameRectSampledAt = now;
          const rect = renderer.domElement.getBoundingClientRect();
          anchorFrameRect.set(rect.left, rect.top);
        }
        const anchorViewportX = anchorFrameRect.x + focusSignalScreenPoint.x;
        const anchorViewportY = anchorFrameRect.y + focusSignalScreenPoint.y;
        host.dataset.focusAnchorViewportX = anchorViewportX.toFixed(2);
        host.dataset.focusAnchorViewportY = anchorViewportY.toFixed(2);
        host.dataset.focusAnchorScale = anchorPxPerDegreeLat.toFixed(3);
        if (
          latestOnParticleAnchorFrame.current
          && Number.isFinite(anchorPxPerDegreeLat)
          && anchorPxPerDegreeLat > 0
          && (
            !publishedAnchorFrame
            || Math.abs(publishedAnchorFrame.screen.x - anchorViewportX) >= 0.5
            || Math.abs(publishedAnchorFrame.screen.y - anchorViewportY) >= 0.5
            || Math.abs(publishedAnchorFrame.pxPerDegreeLat / anchorPxPerDegreeLat - 1) >= 0.002
            || publishedAnchorFrame.anchor.lat !== diveAnchor.lat
            || publishedAnchorFrame.anchor.lon !== diveAnchor.lon
            || publishedAnchorFrame.zoom === undefined
            || Math.abs(publishedAnchorFrame.zoom - semanticZoomState.snapshot.zoom) >= 0.001
          )
        ) {
          publishedAnchorFrame = {
            anchor: { lat: diveAnchor.lat, lon: diveAnchor.lon },
            screen: { x: anchorViewportX, y: anchorViewportY },
            pxPerDegreeLat: anchorPxPerDegreeLat,
            zoom: semanticZoomState.snapshot.zoom,
          };
          latestOnParticleAnchorFrame.current(publishedAnchorFrame);
        }
        // #196: the coordinates the focus signal is standing on. A place label
        // sends these when it is clicked, so publishing them is what makes
        // "the click focused the place the label claimed" checkable without
        // depending on that label surviving the tier change during the flight.
        if (latestFocusPoint.current) {
          host.dataset.focusPointLat = latestFocusPoint.current.lat.toFixed(4);
          host.dataset.focusPointLon = latestFocusPoint.current.lon.toFixed(4);
        } else {
          delete host.dataset.focusPointLat;
          delete host.dataset.focusPointLon;
        }
      } else {
        delete host.dataset.personalPointX;
        delete host.dataset.personalPointY;
        delete host.dataset.focusAnchorViewportX;
        delete host.dataset.focusAnchorViewportY;
        delete host.dataset.focusAnchorScale;
        delete host.dataset.focusPointLat;
        delete host.dataset.focusPointLon;
        if (publishedAnchorFrame) {
          publishedAnchorFrame = null;
          latestOnParticleAnchorFrame.current?.(null);
        }
      }

      renderer.render(scene, camera);
      if (focusSettledRevisionThisFrame !== null) {
        latestOnFocusSettled.current?.(focusSettledRevisionThisFrame);
      }
      // Publish only AFTER draw so each material's onBeforeRender has written
      // the actual shader uPixelRatio used for this frame.
      publishAttentionLayerMeasurements();
      const interactionActive = activePointers.size > 0
        || rotationVelocityX !== 0 || rotationVelocityY !== 0
        || now < wheelInteractionUntil;
      currentRenderState = resolveGlobeRenderState({
        documentVisible: !document.hidden,
        opaqueMediaCover: currentVisibilityHint.opaqueMediaCover,
        coverTransitionActive: currentVisibilityHint.coverTransitionActive,
        focusFlightActive: focusFlightActive || initialCameraAnchorSettling,
        interactionActive,
        earthDiveOverlapActive: Boolean(currentVisibilityHint.earthDiveOverlapActive),
      });
      if (globeRenderStateRunsScene(currentRenderState)) {
        refinementBuildGuard.setVisible(true);
        coastlineRefinementBuildGuard.setVisible(true);
        animationFrame = requestAnimationFrame(render);
      } else {
        refinementBuildGuard.setVisible(false);
        coastlineRefinementBuildGuard.setVisible(false);
        requestedRefinementCacheKey = null;
        requestedCoastlineCacheKey = null;
        refinementBuildState = "paused";
        coastlineRefinementState = "paused";
      }
    };

    const wakeRenderLoop = () => {
      if (disposed || animationFrame !== 0 || document.hidden) return;
      lastTime = performance.now();
      lastFrameDeltaMs = 0;
      lastCoastlineRefinementSampleAt = Number.NEGATIVE_INFINITY;
      lastRefinementViewSampleAt = Number.NEGATIVE_INFINITY;
      refinementBuildGuard.setVisible(true);
      coastlineRefinementBuildGuard.setVisible(true);
      animationFrame = requestAnimationFrame(render);
    };

    const pauseRenderLoop = (state: GlobeRenderState) => {
      currentRenderState = state;
      refinementBuildGuard.setVisible(false);
      requestedRefinementCacheKey = null;
      refinementBuildState = "paused";
      coastlineRefinementBuildGuard.setVisible(false);
      requestedCoastlineCacheKey = null;
      coastlineRefinementState = "paused";
      if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    };

    const updateRenderLoopVisibility = () => {
      const state = resolveGlobeRenderState({
        documentVisible: !document.hidden,
        opaqueMediaCover: currentVisibilityHint.opaqueMediaCover,
        coverTransitionActive: currentVisibilityHint.coverTransitionActive,
        focusFlightActive: isFocusFlightActive(pointFocusSettling, routeFocusSettling),
        interactionActive: activePointers.size > 0 || rotationVelocityX !== 0 || rotationVelocityY !== 0 || performance.now() < wheelInteractionUntil,
        earthDiveOverlapActive: Boolean(currentVisibilityHint.earthDiveOverlapActive),
      });
      currentRenderState = state;
      if (globeRenderStateRunsScene(state)) wakeRenderLoop();
      else pauseRenderLoop(state);
    };

    const onVisibilityChange = () => {
      updateRenderLoopVisibility();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    void rebuildLandVisualData(currentQuality);

    applyFocusPoint(latestFocusPoint.current);
    applyJourneyRoutes(latestJourneyRoutes.current);
    updateRenderLoopVisibility();

    const onWebGlContextLost = (event: Event) => {
      event.preventDefault();
      host.dataset.particleEarthBackend = "unavailable";
      latestOnBackendChange.current?.("unavailable");
      setReady(false);
      dispose();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      refinementBuildGuard.dispose();
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      cityVectorLayer.removeEventListener("pointerdown", onCityLayerPointerDown);
      cityVectorLayer.removeEventListener("pointermove", onCityLayerPointerMove);
      cityVectorLayer.removeEventListener("pointerup", onCityLayerPointerUp);
      cityVectorLayer.removeEventListener("pointercancel", onCityLayerPointerCancel);
      cityVectorLayer.removeEventListener("wheel", onCityLayerWheel);
      routeVectorLayer.removeEventListener("pointerdown", onRouteLayerPointerDown);
      routeVectorLayer.removeEventListener("pointermove", onRouteLayerPointerMove);
      routeVectorLayer.removeEventListener("pointerup", onRouteLayerPointerUp);
      routeVectorLayer.removeEventListener("pointercancel", onRouteLayerPointerCancel);
      routeVectorLayer.removeEventListener("wheel", onRouteLayerWheel);
      routeVectorLayer.removeEventListener("keydown", onRouteLayerKeyDown);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener("lostpointercapture", onLostPointerCapture);
      renderer.domElement.removeEventListener("webglcontextlost", onWebGlContextLost);
      window.removeEventListener("pointerup", onRejectedPointerLifecycleEnd);
      window.removeEventListener("pointercancel", onRejectedPointerLifecycleEnd);
      renderer.domElement.removeEventListener("wheel", onWheel);
      reliefTexture?.dispose();
      reliefMaterial.dispose();
      visitedImprintTexture.dispose();
      texture.dispose();
      disposeRefinementLayer(departingRefinementLayer);
      departingRefinementLayer = null;
      disposeRefinementLayer(activeRefinementLayer);
      activeRefinementLayer = null;
      coastlineRefinementBuildGuard.dispose();
      refinementCache.clear();
      coastlineRefinementCache.clear();
      coastlineLocalChunkCache.clear();
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
    };
    renderer.domElement.addEventListener("webglcontextlost", onWebGlContextLost);
    host.dataset.particleEarthBackend = "webgl2";
    latestOnBackendChange.current?.("webgl2");

    return {
      setInitialCameraAnchor(anchor: ParticleEarthSceneProps["initialCameraAnchor"]) {
        latestInitialCameraAnchor.current = anchor;
        wakeRenderLoop();
      },
      setHomeBasePresence(presence: readonly HomeBasePresenceDrawable[]) {
        latestHomeBasePresence.current = presence;
        wakeRenderLoop();
      },
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
        updateRenderLoopVisibility();
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
        visiblePointIds?: ReadonlySet<string>,
      ) {
        const routesChanged = appliedJourneyRoutes !== routes;
        const visibilityChanged = appliedVisibleRoutePointIds !== visiblePointIds;
        const activeRouteChanged = appliedActiveJourneyRouteId !== activeRouteId;
        if (!routesChanged && !visibilityChanged && !activeRouteChanged) return;
        latestVisibleRoutePointIds.current = visiblePointIds;
        latestActiveJourneyRouteId.current = activeRouteId;
        syncParticleDimming(routes, activeRouteId);
        if (routesChanged || visibilityChanged) {
          if (routesChanged) syncVisitedImprint(routes);
          applyJourneyRoutes(routes);
        } else {
          syncActiveJourneyRoute();
          updateRouteLabelSafeArea();
          syncRoutePresentations();
          appliedActiveJourneyRouteId = activeRouteId;
          // Active-route presentation can create a new label set without moving
          // the camera. Force the next frame to lay out that semantic change.
          routeProjectionRevision += 1;
        }
        // Route data often arrives after an idle scene has paused. Building the
        // SVG/point layer is not enough: one real frame must project its anchors
        // and clear stale display:none from their previous hemisphere.
        wakeRenderLoop();
      },
      setSelectedJourneyRoutePoint(selection: RoutePointSelection) {
        latestSelectedJourneyRoutePoint.current = selection;
        syncRoutePresentations();
        routeProjectionRevision += 1;
        wakeRenderLoop();
      },
      setNarrativeJourneyRoutePoint(selection: RoutePointSelection) {
        latestNarrativeJourneyRoutePoint.current = selection;
        syncRoutePresentations();
        routeProjectionRevision += 1;
        wakeRenderLoop();
      },
      // #21: update per-route AND per-point temporal reveal without rebuilding
      // the layer, so the time cursor does not restart route animations.
      // Review P2: points light up one stop at a time (route progress still
      // fades the whole trail); a journey/point absent from the maps (or an
      // undefined map after leaving focus mode) RESETS to full visibility so
      // rewind state never leaks into the normal home view.
      setVisibilityHint(nextVisibilityHint: ParticleEarthSceneProps["visibilityHint"]) {
        currentVisibilityHint = nextVisibilityHint ?? { opaqueMediaCover: false, coverTransitionActive: false };
        updateRenderLoopVisibility();
      },
      setTemporalReveal(reveal?: {
        journeys: ReadonlyMap<string, number>;
        points: ReadonlyMap<string, number>;
      }) {
        latestTemporalReveal.current = reveal;
        syncParticleDimming(
          latestJourneyRoutes.current,
          latestActiveJourneyRouteId.current,
          reveal,
        );
        syncVisitedImprint(latestJourneyRoutes.current, reveal);
        syncRouteTemporalReveal();
        // Temporal reveal also changes GPU dimming/imprint state. If the scene
        // is idle, publish that state on one real frame instead of waiting for
        // an unrelated pointer/camera event to wake the renderer.
        wakeRenderLoop();
      },
      dispose,
    };
  }, (_error, host) => {
    host.dataset.particleEarthBackend = "unavailable";
    setReady(false);
    latestOnBackendChange.current?.("unavailable");
  });

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setInitialCameraAnchor(initialCameraAnchor);
  }, [controllerRevision, controllerRef, initialCameraAnchor?.lat, initialCameraAnchor?.lon]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setHomeBasePresence(homeBasePresence);
  }, [controllerRevision, controllerRef, homeBasePresence]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setQuality(quality);
  }, [controllerRevision, controllerRef, quality]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setMode(mode);
  }, [controllerRevision, controllerRef, mode]);

  useEffect(() => {
    if (!controllerRevision) return;
    // Route/focus semantics are controller-ready, not land-visual-ready.
    // Async journey data and focus-mode transitions must reach the controller
    // before the expensive land rebuild finishes so Route Points can project.
    if (!focusEnabled) return;
    controllerRef.current?.setFocusIntent(
      resolveGlobeFocusIntent(focusPoint, focusRoute, focusRevision),
    );
  }, [controllerRevision, controllerRef, focusEnabled, focusPoint?.lat, focusPoint?.lon, focusRevision, focusRoute]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setFocusColor(focusColor);
  }, [controllerRevision, controllerRef, focusColor]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setCompactMobileLayout(compactMobileLayout);
  }, [compactMobileLayout, controllerRevision, controllerRef]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setVisibilityHint(visibilityHint);
  }, [controllerRevision, controllerRef, visibilityHint.opaqueMediaCover, visibilityHint.coverTransitionActive, visibilityHint.earthDiveOverlapActive]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setJourneyRoutes(journeyRoutes, activeJourneyRouteId, visibleRoutePointIds);
  }, [activeJourneyRouteId, controllerRevision, controllerRef, journeyRoutes, visibleRoutePointIds]);

  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setSelectedJourneyRoutePoint(selectedJourneyRoutePoint);
  }, [
    controllerRevision,
    controllerRef,
    selectedJourneyRoutePoint?.journeyId,
    selectedJourneyRoutePoint?.routePointId,
    selectedJourneyRoutePoint?.pointIndex,
  ]);
  useEffect(() => {
    if (!controllerRevision) return;
    controllerRef.current?.setNarrativeJourneyRoutePoint(narrativeJourneyRoutePoint);
  }, [
    controllerRevision,
    controllerRef,
    narrativeJourneyRoutePoint?.journeyId,
    narrativeJourneyRoutePoint?.routePointId,
    narrativeJourneyRoutePoint?.pointIndex,
  ]);
  useEffect(() => {
    if (!controllerRevision) return;
    // Temporal reveal is Route Point semantic state, just like route/selection
    // identity above. Publish it as soon as the controller exists instead of
    // waiting for the unrelated async land-visual rebuild; otherwise the real
    // pointer surface can remain unprojected while the Journey is already live.
    // Review P2: also called with `undefined` so leaving focus mode resets
    // every route's temporal reveal to full visibility.
    controllerRef.current?.setTemporalReveal(temporalReveal);
  }, [controllerRevision, controllerRef, temporalReveal]);

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
