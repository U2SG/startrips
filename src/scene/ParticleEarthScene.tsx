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
  latLonToVector3,
  rotationYForLongitude,
  vector3ToLatLon,
} from "./geo";
import { createAtmosphereMaterial, createParticleEarthMaterial } from "./particleEarthMaterial";
import { disposeSceneGraph, useThreeScene } from "./useThreeScene";

export const QUALITY_PROFILE = {
  low: { particleCount: 12_000, maxDpr: 1 },
  high: { particleCount: 28_000, maxDpr: 1.25 },
} as const;

export const MAX_RENDERED_JOURNEYS = 64;
export const MAX_RENDERED_ROUTE_POINTS = 512;
export const MAX_RENDERED_ROUTE_LINE_VERTICES = 8192;

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
  },
  focusPoint: {
    x: 0.7,
    y: -0.23,
    scale: 1.15,
    burst: 0,
    particleOpacity: 0.62,
    shellOpacity: 0.18,
    haloOpacity: 0.05,
    surfaceOpacity: 0.08,
    signalOpacity: 0.72,
    clusterOpacity: 1,
    personalOpacity: 1,
    rotationY: -1.57,
    wireOpacity: 0.018,
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
  onJourneyRouteActivate?: (id: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
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

async function buildLandParticlePositions(count: number) {
  const width = 720;
  const height = 360;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return buildSeededSpherePoints(count, 1908);

  const response = await fetch("/earth/ne_110m_land.geojson");
  if (!response.ok) return buildSeededSpherePoints(count, 1908);
  const collection = (await response.json()) as LandFeatureCollection;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fff";

  collection.features.forEach(({ geometry }) => {
    if (!geometry) return;
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates as number[][][]]
        : (geometry.coordinates as number[][][][]);
    polygons.forEach((polygon) => drawPolygonMask(context, polygon, width));
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

  return points;
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
  onJourneyRouteActivate,
  onGlobePointPick,
  reduceMotion = false,
}: ParticleEarthSceneProps) {
  const [ready, setReady] = useState(false);
  const latestMode = useRef(mode);
  const latestFocusPoint = useRef(focusPoint);
  const latestFocusColor = useRef(focusColor);
  const latestCenterFocusPoint = useRef(centerFocusPoint);
  const latestOnFocusPointActivate = useRef(onFocusPointActivate);
  const latestJourneyRoutes = useRef(journeyRoutes);
  const latestOnJourneyRouteActivate = useRef(onJourneyRouteActivate);
  const latestOnGlobePointPick = useRef(onGlobePointPick);
  latestMode.current = mode;
  latestFocusPoint.current = focusPoint;
  latestFocusColor.current = focusColor;
  latestCenterFocusPoint.current = centerFocusPoint;
  latestOnFocusPointActivate.current = onFocusPointActivate;
  latestJourneyRoutes.current = journeyRoutes;
  latestOnJourneyRouteActivate.current = onJourneyRouteActivate;
  latestOnGlobePointPick.current = onGlobePointPick;

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
    const debugWindow = window as Window & {
      __particleEarthDebug?: () => {
        canvases: number;
        geometries: number;
        textures: number;
        mode: GlobeMode;
      };
    };
    debugWindow.__particleEarthDebug = () => ({
      canvases: document.querySelectorAll('canvas[data-three-scene="particle-earth"]').length,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      mode: currentMode,
    });

    scene.add(new AmbientLight(0x69736f, 0.72));
    const keyLight = new DirectionalLight(0xe3eee8, 1.9);
    keyLight.position.set(2.8, 2.4, 4);
    scene.add(keyLight);

    const globe = new Group();
    globe.rotation.set(0.08, GLOBE_MODE_CONFIG[currentMode].rotationY, -0.03);
    scene.add(globe);

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
    globe.add(personalSignal);
    const personalScreenPosition = new Vector3();

    let routePointGeometry = new BufferGeometry();
    const routePointMaterial = new PointsMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0,
      size: 0.09,
      sizeAttenuation: true,
      transparent: true,
      vertexColors: true,
    });
    const routePointSignals = new Points(routePointGeometry, routePointMaterial);
    globe.add(routePointSignals);
    let routeLineGeometry = new BufferGeometry();
    const routeLineMaterial = new LineBasicMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0,
      transparent: true,
      vertexColors: true,
    });
    const routeLines = new LineSegments(routeLineGeometry, routeLineMaterial);
    globe.add(routeLines);
    let journeyPointIds: string[] = [];

    const applyJourneyRoutes = (routes: readonly JourneyRoute[]) => {
      const visibleRoutes = selectRenderableJourneyRoutes(routes);
      const pointCount = visibleRoutes.reduce(
        (total, route) => total + route.points.length,
        0,
      );
      const pointPositions = new Float32Array(pointCount * 3);
      const pointColors = new Float32Array(pointCount * 3);
      const linePositions: number[] = [];
      const lineColors: number[] = [];
      const pointIds: string[] = [];
      let pointIndex = 0;

      visibleRoutes.forEach((route) => {
        const color = new Color(route.color);
        route.points.forEach((point) => {
          latLonToVector3(point.lat, point.lon, 1.46).toArray(
            pointPositions,
            pointIndex * 3,
          );
          color.toArray(pointColors, pointIndex * 3);
          pointIds.push(route.id);
          pointIndex += 1;
        });

        const remainingVertices = MAX_RENDERED_ROUTE_LINE_VERTICES
          - linePositions.length / 3;
        const routeSegments = buildSphericalRouteSegments(
          route.points,
          1.445,
          Math.PI / 24,
          remainingVertices,
        );
        linePositions.push(...routeSegments);
        for (let index = 0; index < routeSegments.length / 3; index += 1) {
          lineColors.push(color.r, color.g, color.b);
        }
      });

      const nextPointGeometry = new BufferGeometry();
      nextPointGeometry.setAttribute(
        "position",
        new BufferAttribute(pointPositions, 3),
      );
      nextPointGeometry.setAttribute(
        "color",
        new BufferAttribute(pointColors, 3),
      );
      const nextLineGeometry = new BufferGeometry();
      nextLineGeometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array(linePositions), 3),
      );
      nextLineGeometry.setAttribute(
        "color",
        new BufferAttribute(new Float32Array(lineColors), 3),
      );
      if (pointCount > 0) nextPointGeometry.computeBoundingSphere();
      if (linePositions.length > 0) nextLineGeometry.computeBoundingSphere();
      const previousPointGeometry = routePointGeometry;
      const previousLineGeometry = routeLineGeometry;
      routePointGeometry = nextPointGeometry;
      routeLineGeometry = nextLineGeometry;
      routePointSignals.geometry = routePointGeometry;
      routeLines.geometry = routeLineGeometry;
      previousPointGeometry.dispose();
      previousLineGeometry.dispose();
      journeyPointIds = pointIds;
      host.dataset.journeyRouteCount = String(visibleRoutes.length);
      host.dataset.journeyRoutePointCount = String(pointCount);
      host.dataset.journeyRouteOverflow = String(routes.length - visibleRoutes.length);
    };

    const personalRaycaster = new Raycaster();
    personalRaycaster.params.Points = { threshold: 0.18 };
    const personalPointer = new Vector2();
    const onPersonalPointerUp = (event: PointerEvent) => {
      const canPickGlobe = Boolean(latestOnGlobePointPick.current);
      const canActivateJourney = Boolean(
        latestOnJourneyRouteActivate.current && journeyPointIds.length > 0,
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
        const [intersection] = personalRaycaster.intersectObject(
          routePointSignals,
          false,
        );
        const journeyId = intersection?.index === undefined
          ? undefined
          : journeyPointIds[intersection.index];
        if (journeyId) {
          latestOnJourneyRouteActivate.current?.(journeyId);
          return;
        }
      }
      if (personalRaycaster.intersectObject(personalSignal, false).length > 0) {
        latestOnFocusPointActivate.current?.();
      }
    };
    renderer.domElement.addEventListener("pointerup", onPersonalPointerUp);

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
      renderer.setSize(targetSize.x, targetSize.y, false);
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
    resize();

    const render = (now: number) => {
      if (disposed) return;
      const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      const target = GLOBE_MODE_CONFIG[currentMode];
      const targetRotationY =
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
      globe.scale.setScalar(interpolate(globe.scale.x, target.scale));
      globe.rotation.y = interpolate(globe.rotation.y, targetRotationY);
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
      routePointMaterial.opacity = interpolate(
        routePointMaterial.opacity,
        routeOpacity,
      );
      routeLineMaterial.opacity = interpolate(
        routeLineMaterial.opacity,
        routeOpacity * 0.72,
      );
      atmosphereMaterial.uniforms.uOpacity.value = interpolate(
        atmosphereMaterial.uniforms.uOpacity.value,
        currentMode === "surfaceEarth" ? 0.05 : currentMode === "particleSphere" ? 0.5 : 0.36,
      );
      wireMaterial.opacity = interpolate(wireMaterial.opacity, target.wireOpacity);
      particleMaterial.uniforms.uTime.value = now / 1000;
      archiveMaterial.uniforms.uTime.value = now / 1000;
      clusterMaterial.uniforms.uTime.value = now / 1000;
      cyanClusterMaterial.uniforms.uTime.value = now / 1000;
      shellMaterial.uniforms.uTime.value = now / 1000;
      haloMaterial.uniforms.uTime.value = now / 1000;
      personalMaterial.uniforms.uTime.value = now / 1000;

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

    void buildLandParticlePositions(QUALITY_PROFILE[quality].particleCount).then((positions) => {
      if (disposed) return;
      particleGeometry = new BufferGeometry();
      particleGeometry.setAttribute("position", new BufferAttribute(positions, 3));
      particleGeometry.setAttribute(
        "targetPosition",
        new BufferAttribute(createBurstTargets(positions), 3),
      );
      particles = new Points(particleGeometry, particleMaterial);
      globe.add(particles);
      setReady(true);
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
        applyFocusPoint(point);
      },
      setFocusColor(color: string | undefined) {
        personalMaterial.uniforms.uColor.value.set(color ?? 0xffdc72);
        host.dataset.focusColor = `#${personalMaterial.uniforms.uColor.value.getHexString()}`;
      },
      setJourneyRoutes(routes: readonly JourneyRoute[]) {
        applyJourneyRoutes(routes);
      },
      dispose() {
        disposed = true;
        cancelAnimationFrame(animationFrame);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener("pointerup", onPersonalPointerUp);
        texture.dispose();
        if (particles) globe.remove(particles);
        if (particleGeometry) particleGeometry.dispose();
        particleMaterial.dispose();
        disposeSceneGraph(scene);
        renderer.dispose();
        renderer.forceContextLoss();
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
    controllerRef.current?.setJourneyRoutes(journeyRoutes);
  }, [controllerRef, journeyRoutes]);

  return (
    <div
      ref={hostRef}
      className="particle-earth-scene"
      data-scene-ready={ready ? "true" : "false"}
      data-personal-point-interactive={
        centerFocusPoint && onFocusPointActivate ? "true" : "false"
      }
      data-journey-routes-interactive={onJourneyRouteActivate ? "true" : "false"}
      data-globe-point-pick={onGlobePointPick ? "true" : "false"}
      aria-label="由世界陆地轮廓与艺术信号组成的粒子地球"
      role="img"
    />
  );
}
