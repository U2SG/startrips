import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  LineBasicMaterial,
  LineSegments,
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
import type { JourneyRoute } from "../journey/types";
import {
  buildArtworkPointPositions,
  buildSeededSpherePoints,
  buildSphericalRouteSegments,
  buildSphericalRingSegments,
  latLonToVector3,
  rotationYForLongitude,
  vector3ToLatLon,
} from "./geo";
import { createAtmosphereMaterial, createParticleEarthMaterial } from "./particleEarthMaterial";
import { disposeSceneGraph, useThreeScene } from "./useThreeScene";

export const QUALITY_PROFILE = {
  low: { particleCount: 12_000, maxDpr: 1 },
  high: { particleCount: 28_000, maxDpr: Number.POSITIVE_INFINITY },
} as const;

export const MAX_RENDERED_JOURNEYS = 64;
export const MAX_RENDERED_ROUTE_POINTS = 512;
export const MAX_RENDERED_ROUTE_LINE_VERTICES = 8192;
export const MAX_RENDERED_ROUTE_LABELS = 6;
export const MAX_RENDERED_MOBILE_ROUTE_LABELS = 3;
export const MAX_RENDERED_COASTLINE_VERTICES = 20_000;
export const GLOBE_RENDER_ORDER = {
  coastline: 1,
  signal: 2,
  routeLine: 3,
  routePoint: 4,
  personalPoint: 5,
} as const;
export const GLOBE_DRAG_THRESHOLD_PX = 6;
export const GLOBE_TILT_LIMIT_RADIANS = 0.62;
export const GLOBE_ZOOM_MIN = 0.72;
export const GLOBE_ZOOM_MAX = 2.2;
export const GLOBE_SURFACE_RADIUS = 1.39;

const GLOBE_DRAG_RADIANS_PER_PIXEL = 0.005;
const GLOBE_MAX_ROTATION_SPEED = 4.2;
const GLOBE_INERTIA_FRICTION = 5.2;
const GLOBE_WHEEL_ZOOM_SPEED = 0.0012;

export function clampGlobeTilt(rotation: number) {
  return Math.max(
    -GLOBE_TILT_LIMIT_RADIANS,
    Math.min(GLOBE_TILT_LIMIT_RADIANS, rotation),
  );
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

export function buildProjectedRoutePath(
  segments: Float32Array,
  projectPoint: (
    x: number,
    y: number,
    z: number,
    target: ProjectedRoutePoint,
  ) => boolean,
) {
  const start = { x: 0, y: 0 };
  const end = { x: 0, y: 0 };
  const commands: string[] = [];
  let previousEndX = Number.NaN;
  let previousEndY = Number.NaN;

  for (let index = 0; index + 5 < segments.length; index += 6) {
    const startVisible = projectPoint(
      segments[index],
      segments[index + 1],
      segments[index + 2],
      start,
    );
    const endVisible = projectPoint(
      segments[index + 3],
      segments[index + 4],
      segments[index + 5],
      end,
    );
    if (!startVisible || !endVisible) {
      previousEndX = Number.NaN;
      previousEndY = Number.NaN;
      continue;
    }
    const startX = start.x.toFixed(1);
    const startY = start.y.toFixed(1);
    const endX = end.x.toFixed(1);
    const endY = end.y.toFixed(1);
    if (
      !Number.isFinite(previousEndX)
      || Math.abs(previousEndX - start.x) > 0.11
      || Math.abs(previousEndY - start.y) > 0.11
    ) {
      commands.push(`M${startX} ${startY}`);
    }
    commands.push(`L${endX} ${endY}`);
    previousEndX = end.x;
    previousEndY = end.y;
  }

  return commands.join("");
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
  focusColor?: string;
  centerFocusPoint?: boolean;
  onFocusPointActivate?: () => void;
  journeyRoutes?: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  onJourneyRouteActivate?: (id: string) => void;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  onReady?: () => void;
  onDetailRequested?: () => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  dragToRotate?: boolean;
  reduceMotion?: boolean;
}

interface LandGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

interface LandFeatureCollection {
  features: Array<{ geometry: LandGeometry | null }>;
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

async function buildLandVisualData(count: number) {
  const width = 720;
  const height = 360;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {
      particlePositions: buildSeededSpherePoints(count, 1908),
      coastlinePositions: new Float32Array(),
    };
  }

  const response = await fetch("/earth/ne_110m_land.geojson");
  if (!response.ok) {
    return {
      particlePositions: buildSeededSpherePoints(count, 1908),
      coastlinePositions: new Float32Array(),
    };
  }
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
      rings.push(...polygon);
    });
  });

  const mask = context.getImageData(0, 0, width, height).data;
  const points = new Float32Array(count * 3);
  let accepted = 0;

  for (let attempt = 1; accepted < count && attempt < count * 80; attempt += 1) {
    const longitudeUnit = (attempt * 0.7548776662466927 + 0.1387) % 1;
    const latitudeUnit = (attempt * 0.5698402909980532 + 0.4173) % 1;
    const lon = longitudeUnit * 360 - 180;
    const sphereY = latitudeUnit * 2 - 1;
    const lat = (Math.asin(sphereY) * 180) / Math.PI;
    const x = Math.min(width - 1, Math.floor(longitudeUnit * width));
    const y = Math.min(height - 1, Math.floor(((90 - lat) / 180) * height));

    if (mask[(y * width + x) * 4 + 3] < 128) continue;
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
      rings,
      1.405,
      MAX_RENDERED_COASTLINE_VERTICES,
    ),
  };
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
  focusColor,
  centerFocusPoint = false,
  onFocusPointActivate,
  journeyRoutes = [],
  activeJourneyRouteId,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onReady,
  onDetailRequested,
  onGlobePointPick,
  dragToRotate = false,
  reduceMotion = false,
}: ParticleEarthSceneProps) {
  const [ready, setReady] = useState(false);
  const latestMode = useRef(mode);
  const latestFocusPoint = useRef(focusPoint);
  const latestFocusColor = useRef(focusColor);
  const latestCenterFocusPoint = useRef(centerFocusPoint);
  const latestOnFocusPointActivate = useRef(onFocusPointActivate);
  const latestJourneyRoutes = useRef(journeyRoutes);
  const latestActiveJourneyRouteId = useRef(activeJourneyRouteId);
  const latestOnJourneyRouteActivate = useRef(onJourneyRouteActivate);
  const latestOnJourneyRoutePointActivate = useRef(onJourneyRoutePointActivate);
  const latestOnReady = useRef(onReady);
  const latestOnDetailRequested = useRef(onDetailRequested);
  const latestOnGlobePointPick = useRef(onGlobePointPick);
  const latestDragToRotate = useRef(dragToRotate);
  latestMode.current = mode;
  latestFocusPoint.current = focusPoint;
  latestFocusColor.current = focusColor;
  latestCenterFocusPoint.current = centerFocusPoint;
  latestOnFocusPointActivate.current = onFocusPointActivate;
  latestJourneyRoutes.current = journeyRoutes;
  latestActiveJourneyRouteId.current = activeJourneyRouteId;
  latestOnJourneyRouteActivate.current = onJourneyRouteActivate;
  latestOnJourneyRoutePointActivate.current = onJourneyRoutePointActivate;
  latestOnReady.current = onReady;
  latestOnDetailRequested.current = onDetailRequested;
  latestOnGlobePointPick.current = onGlobePointPick;
  latestDragToRotate.current = dragToRotate;

  const { hostRef, controllerRef } = useThreeScene((host) => {
    let disposed = false;
    let animationFrame = 0;
    let lastTime = performance.now();
    let currentMode = latestMode.current;
    const targetSize = new Vector2();
    const scene = new Scene();
    const camera = new PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
      premultipliedAlpha: false,
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(new Color(0x020807), 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PROFILE[quality].maxDpr));
    renderer.domElement.dataset.threeScene = "particle-earth";
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
    const debugWindow = window as Window & {
      __particleEarthDebug?: () => {
        canvases: number;
        geometries: number;
        textures: number;
        mode: GlobeMode;
        rotationX: number;
        rotationY: number;
        zoom: number;
        scale: number;
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
      zoom: interactiveZoom,
      scale: globe.scale.x,
      coastlineVertices: coastlineGeometry.getAttribute("position")?.count ?? 0,
    });

    scene.add(new AmbientLight(0x69736f, 0.72));
    const keyLight = new DirectionalLight(0xe3eee8, 1.9);
    keyLight.position.set(2.8, 2.4, 4);
    scene.add(keyLight);

    const globe = new Group();
    globe.rotation.set(0.08, GLOBE_MODE_CONFIG[currentMode].rotationY, -0.03);
    scene.add(globe);
    let baseRotationY = globe.rotation.y;
    let interactiveRotationX = globe.rotation.x;
    let interactiveRotationY = 0;
    let interactiveZoom = 1;
    let rotationVelocityX = 0;
    let rotationVelocityY = 0;
    let centeredFocusKey = latestFocusPoint.current
      ? `${latestFocusPoint.current.lat}:${latestFocusPoint.current.lon}`
      : "";

    const sphereGeometry = new SphereGeometry(1.39, 64, 40);
    const surfaceMaterial = new MeshPhongMaterial({
      color: 0xd1d7d4,
      emissive: 0x010403,
      shininess: 1,
      transparent: true,
      opacity: 0,
    });
    const surface = new Mesh(sphereGeometry, surfaceMaterial);
    globe.add(surface);

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

    const coastlineGeometry = new BufferGeometry();
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

    const atmosphereMaterial = createAtmosphereMaterial();
    const atmosphere = new Mesh(sphereGeometry, atmosphereMaterial);
    atmosphere.scale.setScalar(1.07);
    globe.add(atmosphere);

    const archiveGeometry = new BufferGeometry();
    const archivePositions = buildArtworkPointPositions(archiveRecords, 1.43);
    archiveGeometry.setAttribute("position", new BufferAttribute(archivePositions, 3));
    archiveGeometry.setAttribute("targetPosition", new BufferAttribute(archivePositions.slice(), 3));
    const archiveMaterial = createParticleEarthMaterial({
      color: 0xd9fffb,
      opacity: 0.9,
      size: 45,
    });
    const archiveSignals = new Points(archiveGeometry, archiveMaterial);
    archiveSignals.renderOrder = GLOBE_RENDER_ORDER.signal;
    globe.add(archiveSignals);

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

    const personalGeometry = new BufferGeometry();
    const initialFallback =
      currentMode === "archiveBurst"
        ? { lat: -10, lon: -180 }
        : { lat: 34.0522, lon: -118.2437 };
    const personalPosition = latLonToVector3(
      latestFocusPoint.current?.lat ?? initialFallback.lat,
      latestFocusPoint.current?.lon ?? initialFallback.lon,
      1.45,
    );
    const personalPositions = new Float32Array(personalPosition.toArray());
    personalGeometry.setAttribute("position", new BufferAttribute(personalPositions, 3));
    personalGeometry.setAttribute(
      "targetPosition",
      new BufferAttribute(personalPositions.slice(), 3),
    );
    const personalMaterial = createParticleEarthMaterial({
      color: 0xffdc72,
      opacity: 0,
      size: 160,
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
      segments: Float32Array;
      glowPath: SVGPathElement;
      corePath: SVGPathElement;
      points: Array<{
        element: SVGCircleElement;
        position: Vector3;
        label?: RouteVectorLabel;
      }>;
    };
    let routeVectorEntries: RouteVectorEntry[] = [];
    let routeVectorOpacity = 0;
    const routeCameraPosition = new Vector3();
    const routeLocalPoint = new Vector3();
    const routeScreenPoint = new Vector3();
    const routeProjectedPoint = { x: 0, y: 0 };
    const lastRouteProjectionState = new Float64Array(9).fill(Number.NaN);
    let routeProjectionRevision = 0;
    let renderedRouteProjectionRevision = -1;
    let journeyPointTargets: Array<{ journeyId: string; routePointId?: string }> = [];
    const routeLabelSafeArea = {
      left: 16,
      top: 74,
      right: 16,
      bottom: 18,
    };

    const updateRouteLabelSafeArea = () => {
      const hostBounds = host.getBoundingClientRect();
      const atlas = host.closest(".living-atlas");
      const headerBounds = atlas
        ?.querySelector(".living-atlas__header")
        ?.getBoundingClientRect();
      const cardBounds = atlas
        ?.querySelector(".living-atlas__active")
        ?.getBoundingClientRect();
      const compact = window.innerWidth <= 760;
      routeLabelSafeArea.left = 16;
      routeLabelSafeArea.top = headerBounds
        ? Math.max(16, headerBounds.bottom - hostBounds.top + 10)
        : compact ? 62 : 74;
      routeLabelSafeArea.right = hostBounds.width - 16;
      routeLabelSafeArea.bottom = hostBounds.height - 18;
      if (!cardBounds) return;
      const overlapsHorizontally = cardBounds.left < hostBounds.right
        && cardBounds.right > hostBounds.left;
      const overlapsVertically = cardBounds.top < hostBounds.bottom
        && cardBounds.bottom > hostBounds.top;
      if (!overlapsHorizontally || !overlapsVertically) return;
      if (compact && cardBounds.top > hostBounds.top) {
        routeLabelSafeArea.bottom = Math.min(
          routeLabelSafeArea.bottom,
          cardBounds.top - hostBounds.top - 16,
        );
      } else if (!compact && cardBounds.left > hostBounds.left) {
        routeLabelSafeArea.right = Math.min(
          routeLabelSafeArea.right,
          cardBounds.left - hostBounds.left - 18,
        );
      }
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

      visibleRoutes.forEach((route) => {
        const group = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "g",
        );
        group.classList.add("particle-earth-route");
        group.style.color = route.color;
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
        group.append(glowPath, corePath);
        const vectorPoints: RouteVectorEntry["points"] = [];
        const routeLabelIndexes = route.id === latestActiveJourneyRouteId.current
          ? selectRouteLabelPointIndexes(route.points)
          : [];
        const routeLabelIndexSet = new Set(routeLabelIndexes);
        const routeLabelElements: SVGGElement[] = [];

        route.points.forEach((point, routePointIndex) => {
          const position = latLonToVector3(point.lat, point.lon, 1.46);
          position.toArray(
            pointPositions,
            pointIndex * 3,
          );
          pointTargets.push({ journeyId: route.id, routePointId: point.id });
          pointIndex += 1;

          const element = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "circle",
          );
          element.classList.add(
            "particle-earth-route__point",
            point.isStop
              ? "particle-earth-route__point--stop"
              : "particle-earth-route__point--transit",
          );
          element.setAttribute("r", point.isStop ? "4.4" : "2.8");
          group.appendChild(element);
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
          vectorPoints.push({ element, position, label });
        });
        group.append(...routeLabelElements);

        const remainingVertices = MAX_RENDERED_ROUTE_LINE_VERTICES
          - routeVertexCount;
        const routeSegments = buildSphericalRouteSegments(
          route.points,
          1.445,
          Math.PI / 96,
          remainingVertices,
        );
        routeVertexCount += routeSegments.length / 3;
        routeVectorLayer.appendChild(group);
        routeVectorEntries.push({
          segments: routeSegments,
          glowPath,
          corePath,
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

    const updateRouteVectorLayer = () => {
      if (routeVectorOpacity <= 0.01 || routeVectorEntries.length === 0) return;
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
      ];
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
      const compactRouteLabels = window.innerWidth <= 760;
      const labelLimit = compactRouteLabels
        ? MAX_RENDERED_MOBILE_ROUTE_LABELS
        : MAX_RENDERED_ROUTE_LABELS;
      let visibleLabelCount = 0;

      routeVectorEntries.forEach((entry) => {
        const path = buildProjectedRoutePath(entry.segments, projectRoutePoint);
        entry.glowPath.setAttribute("d", path);
        entry.corePath.setAttribute("d", path);
        const labelCandidates: Array<{
          label: RouteVectorLabel;
          x: number;
          y: number;
        }> = [];
        entry.points.forEach(({ element, position, label }) => {
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
          if (label) {
            labelCandidates.push({
              label,
              x: routeProjectedPoint.x,
              y: routeProjectedPoint.y,
            });
          }
        });

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
      });
      host.dataset.journeyRouteVisibleLabelCount = String(visibleLabelCount);
      host.dataset.journeyRouteLabelSafeRight = routeLabelSafeArea.right.toFixed(1);
      host.dataset.journeyRouteLabelSafeBottom = routeLabelSafeArea.bottom.toFixed(1);
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
    const activePointers = new Map<number, { x: number; y: number }>();
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

    const clearDragState = () => {
      dragPointerId = null;
      dragTravel = 0;
      dragStarted = false;
      gestureConsumed = false;
      pinchDistance = 0;
      delete host.dataset.dragging;
    };

    const beginRotationFrom = (
      pointerId: number,
      pointer: { x: number; y: number },
      timeStamp: number,
      alreadyConsumed = false,
    ) => {
      dragPointerId = pointerId;
      dragLastX = pointer.x;
      dragLastY = pointer.y;
      dragLastTime = timeStamp;
      dragTravel = alreadyConsumed ? GLOBE_DRAG_THRESHOLD_PX : 0;
      dragStarted = alreadyConsumed;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        !latestDragToRotate.current
        || (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      rotationVelocityX = 0;
      rotationVelocityY = 0;
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
        host.dataset.dragging = "true";
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.size >= 2) {
        event.preventDefault();
        const nextDistance = currentPinchDistance();
        if (pinchDistance > 0 && nextDistance > 0) {
          interactiveZoom = clampGlobeZoom(
            interactiveZoom * (nextDistance / pinchDistance),
          );
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
      const rotationDeltaX = deltaY * GLOBE_DRAG_RADIANS_PER_PIXEL;
      const rotationDeltaY = deltaX * GLOBE_DRAG_RADIANS_PER_PIXEL;
      interactiveRotationX = clampGlobeTilt(interactiveRotationX + rotationDeltaX);
      interactiveRotationY += rotationDeltaY;
      const nextVelocityX = rotationDeltaX / elapsed;
      const nextVelocityY = rotationDeltaY / elapsed;
      rotationVelocityX = Math.max(
        -GLOBE_MAX_ROTATION_SPEED,
        Math.min(GLOBE_MAX_ROTATION_SPEED, nextVelocityX),
      );
      rotationVelocityY = Math.max(
        -GLOBE_MAX_ROTATION_SPEED,
        Math.min(GLOBE_MAX_ROTATION_SPEED, nextVelocityY),
      );
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
        beginRotationFrom(
          remainingId,
          remainingPointer,
          event.timeStamp,
          wasGesture,
        );
        return;
      }

      if (!wasGesture || reduceMotion) {
        rotationVelocityX = 0;
        rotationVelocityY = 0;
      }
      clearDragState();
      if (allowActivation && !wasGesture) activatePointerTarget(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (activePointers.has(event.pointerId)) {
        finishPointer(event, isPrimaryPointerActivation(event));
      } else if (isPrimaryPointerActivation(event)) {
        activatePointerTarget(event);
      }
    };
    const onPointerCancel = (event: PointerEvent) => finishPointer(event, false);
    const onLostPointerCapture = (event: PointerEvent) => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.delete(event.pointerId);
      rotationVelocityX = 0;
      rotationVelocityY = 0;
      if (activePointers.size === 0) {
        clearDragState();
      } else {
        const [remainingId, remainingPointer] = [...activePointers.entries()][0];
        gestureConsumed = true;
        beginRotationFrom(remainingId, remainingPointer, event.timeStamp, true);
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!latestDragToRotate.current) return;
      event.preventDefault();
      const requestedZoom = interactiveZoom
        * Math.exp(-event.deltaY * GLOBE_WHEEL_ZOOM_SPEED);
      if (requestedZoom > GLOBE_ZOOM_MAX && latestOnDetailRequested.current) {
        latestOnDetailRequested.current();
        return;
      }
      interactiveZoom = clampGlobeZoom(requestedZoom);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("lostpointercapture", onLostPointerCapture);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    let particleMaterial = createParticleEarthMaterial({
      color: 0x61e4dc,
      opacity: 0,
      size: 8.8,
    });
    let particleGeometry: BufferGeometry | null = null;
    let particles: Points | null = null;

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
      const vector = latLonToVector3(
        point?.lat ?? fallback.lat,
        point?.lon ?? fallback.lon,
        1.45,
      );
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
        Math.min(window.devicePixelRatio, QUALITY_PROFILE[quality].maxDpr),
      );
      renderer.setSize(targetSize.x, targetSize.y, false);
      routeVectorLayer.setAttribute(
        "viewBox",
        `0 0 ${targetSize.x} ${targetSize.y}`,
      );
      updateRouteLabelSafeArea();
      camera.aspect = targetSize.x / targetSize.y;
      camera.updateProjectionMatrix();
      particleMaterial.uniforms.uViewportHeight.value = targetSize.y;
      archiveMaterial.uniforms.uViewportHeight.value = targetSize.y;
      clusterMaterial.uniforms.uViewportHeight.value = targetSize.y;
      cyanClusterMaterial.uniforms.uViewportHeight.value = targetSize.y;
      shellMaterial.uniforms.uViewportHeight.value = targetSize.y;
      haloMaterial.uniforms.uViewportHeight.value = targetSize.y;
      personalMaterial.uniforms.uViewportHeight.value = targetSize.y;
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener("resize", resize);
    resize();

    const render = (now: number) => {
      if (disposed) return;
      const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      const target = GLOBE_MODE_CONFIG[currentMode];
      const targetBaseRotationY =
        currentMode === "focusPoint"
        && latestCenterFocusPoint.current
        && latestFocusPoint.current
          ? rotationYForLongitude(latestFocusPoint.current.lon)
          : target.rotationY;
      const snap = reduceMotion ? 1 : 0;
      const interpolate = (value: number, next: number) =>
        snap ? next : damp(value, next, delta);

      globe.position.x = interpolate(globe.position.x, target.x);
      globe.position.y = interpolate(globe.position.y, target.y);
      globe.scale.setScalar(interpolate(globe.scale.x, target.scale * interactiveZoom));
      baseRotationY = interpolate(baseRotationY, targetBaseRotationY);
      if (activePointers.size === 0 && !reduceMotion) {
        interactiveRotationX = clampGlobeTilt(
          interactiveRotationX + rotationVelocityX * delta,
        );
        interactiveRotationY += rotationVelocityY * delta;
        const inertia = Math.exp(-GLOBE_INERTIA_FRICTION * delta);
        rotationVelocityX *= inertia;
        rotationVelocityY *= inertia;
        if (Math.abs(rotationVelocityX) < 0.001) rotationVelocityX = 0;
        if (Math.abs(rotationVelocityY) < 0.001) rotationVelocityY = 0;
      }
      globe.rotation.x = interactiveRotationX;
      globe.rotation.y = baseRotationY + interactiveRotationY;
      particleMaterial.uniforms.uMorph.value = interpolate(
        particleMaterial.uniforms.uMorph.value,
        target.burst,
      );
      particleMaterial.uniforms.uOpacity.value = interpolate(
        particleMaterial.uniforms.uOpacity.value,
        target.particleOpacity,
      );
      surfaceMaterial.opacity = interpolate(surfaceMaterial.opacity, target.surfaceOpacity);
      archiveMaterial.uniforms.uOpacity.value = interpolate(
        archiveMaterial.uniforms.uOpacity.value,
        target.signalOpacity,
      );
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
        target.shellOpacity,
      );
      haloMaterial.uniforms.uOpacity.value = interpolate(
        haloMaterial.uniforms.uOpacity.value,
        target.haloOpacity,
      );
      personalMaterial.uniforms.uOpacity.value = interpolate(
        personalMaterial.uniforms.uOpacity.value,
        target.personalOpacity,
      );
      personalMaterial.uniforms.uPointSize.value = interpolate(
        personalMaterial.uniforms.uPointSize.value,
        currentMode === "particleSphere" ? 110 : 160,
      );
      const routeOpacity = currentMode === "surfaceEarth"
        ? 0
        : currentMode === "focusPoint"
          ? 0.96
          : 0.66;
      routeVectorOpacity = interpolate(routeVectorOpacity, routeOpacity);
      routeVectorLayer.style.opacity = String(routeVectorOpacity);
      atmosphereMaterial.uniforms.uOpacity.value = interpolate(
        atmosphereMaterial.uniforms.uOpacity.value,
        currentMode === "surfaceEarth" ? 0.05 : currentMode === "particleSphere" ? 0.5 : 0.36,
      );
      wireMaterial.opacity = interpolate(wireMaterial.opacity, target.wireOpacity);
      coastlineMaterial.opacity = interpolate(
        coastlineMaterial.opacity,
        target.coastlineOpacity,
      );
      particleMaterial.uniforms.uTime.value = now / 1000;
      archiveMaterial.uniforms.uTime.value = now / 1000;
      clusterMaterial.uniforms.uTime.value = now / 1000;
      cyanClusterMaterial.uniforms.uTime.value = now / 1000;
      shellMaterial.uniforms.uTime.value = now / 1000;
      haloMaterial.uniforms.uTime.value = now / 1000;
      personalMaterial.uniforms.uTime.value = now / 1000;

      updateRouteVectorLayer();

      if (latestCenterFocusPoint.current && latestFocusPoint.current) {
        const positionAttribute = personalGeometry.getAttribute("position") as BufferAttribute;
        personalScreenPosition.fromBufferAttribute(positionAttribute, 0);
        personalSignal.localToWorld(personalScreenPosition);
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
        cancelAnimationFrame(animationFrame);
      } else {
        lastTime = performance.now();
        animationFrame = requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    void buildLandVisualData(QUALITY_PROFILE[quality].particleCount).then(({
      particlePositions,
      coastlinePositions,
    }) => {
      if (disposed) return;
      particleGeometry = new BufferGeometry();
      particleGeometry.setAttribute(
        "position",
        new BufferAttribute(particlePositions, 3),
      );
      particleGeometry.setAttribute(
        "targetPosition",
        new BufferAttribute(createBurstTargets(particlePositions), 3),
      );
      particles = new Points(particleGeometry, particleMaterial);
      globe.add(particles);
      coastlineGeometry.setAttribute(
        "position",
        new BufferAttribute(coastlinePositions, 3),
      );
      if (coastlinePositions.length > 0) coastlineGeometry.computeBoundingSphere();
      host.dataset.coastlineVertices = String(coastlinePositions.length / 3);
      setReady(true);
      latestOnReady.current?.();
    });

    applyFocusPoint(latestFocusPoint.current);
    applyJourneyRoutes(latestJourneyRoutes.current);
    animationFrame = requestAnimationFrame(render);

    return {
      setMode(nextMode: GlobeMode) {
        currentMode = nextMode;
        if (!latestFocusPoint.current) {
          applyFocusPoint(
            nextMode === "archiveBurst" ? { lat: -10, lon: -180 } : null,
          );
        }
      },
      setFocusPoint(point: { lat: number; lon: number } | null | undefined) {
        const nextFocusKey = point ? `${point.lat}:${point.lon}` : "";
        if (
          latestDragToRotate.current
          && latestCenterFocusPoint.current
          && nextFocusKey !== centeredFocusKey
        ) {
          interactiveRotationX = 0.08;
          interactiveRotationY = 0;
          rotationVelocityX = 0;
          rotationVelocityY = 0;
        }
        centeredFocusKey = nextFocusKey;
        applyFocusPoint(point);
      },
      setFocusColor(color: string | undefined) {
        personalMaterial.uniforms.uColor.value.set(color ?? 0xffdc72);
        host.dataset.focusColor = `#${personalMaterial.uniforms.uColor.value.getHexString()}`;
      },
      setJourneyRoutes(
        routes: readonly JourneyRoute[],
        activeRouteId: string | null | undefined,
      ) {
        latestActiveJourneyRouteId.current = activeRouteId;
        applyJourneyRoutes(routes);
      },
      dispose() {
        disposed = true;
        cancelAnimationFrame(animationFrame);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resizeObserver.disconnect();
        window.removeEventListener("resize", resize);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
        renderer.domElement.removeEventListener("lostpointercapture", onLostPointerCapture);
        renderer.domElement.removeEventListener("wheel", onWheel);
        texture.dispose();
        if (particles) globe.remove(particles);
        if (particleGeometry) particleGeometry.dispose();
        particleMaterial.dispose();
        disposeSceneGraph(scene);
        renderer.dispose();
        renderer.forceContextLoss();
        routeVectorLayer.remove();
        renderer.domElement.remove();
        Reflect.deleteProperty(debugWindow, "__particleEarthDebug");
      },
    };
  });

  useEffect(() => {
    controllerRef.current?.setMode(mode);
  }, [controllerRef, mode]);

  useEffect(() => {
    controllerRef.current?.setFocusPoint(focusPoint);
  }, [controllerRef, focusPoint]);

  useEffect(() => {
    controllerRef.current?.setFocusColor(focusColor);
  }, [controllerRef, focusColor]);

  useEffect(() => {
    controllerRef.current?.setJourneyRoutes(journeyRoutes, activeJourneyRouteId);
  }, [activeJourneyRouteId, controllerRef, journeyRoutes]);

  return (
    <div
      ref={hostRef}
      className="particle-earth-scene"
      data-scene-ready={ready ? "true" : "false"}
      data-personal-point-interactive={
        centerFocusPoint && onFocusPointActivate ? "true" : "false"
      }
      data-journey-routes-interactive={
        onJourneyRouteActivate || onJourneyRoutePointActivate ? "true" : "false"
      }
      data-globe-point-pick={onGlobePointPick ? "true" : "false"}
      data-detail-transition={onDetailRequested ? "true" : "false"}
      data-drag-rotation={dragToRotate ? "true" : "false"}
      aria-label="由世界陆地轮廓与艺术信号组成的粒子地球"
      role="img"
    />
  );
}
