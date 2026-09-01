import { resolveGlobeSemanticZoom, type GlobeSemanticZoom } from "./semanticZoom";

export type ParticleLodQuality = "low" | "high";

export const PARTICLE_BASE_LAND_SOURCE = {
  path: "/earth/ne_110m_land.geojson",
  vectorScale: "110m",
  maskWidth: 720,
  maskHeight: 360,
  maskDegreesPerPixel: 0.5,
} as const;

export const PARTICLE_REFINEMENT_LAND_SOURCE = {
  path: "/earth/ne_50m_land.geojson",
  vectorScale: "50m",
  maskWidth: 1440,
  maskHeight: 720,
  maskDegreesPerPixel: 0.25,
} as const;

// Backwards-compatible name for callers/tests that refer to the stable global
// base source. High-zoom refinement deliberately uses the finer 50m source.
export const PARTICLE_LAND_SOURCE = PARTICLE_BASE_LAND_SOURCE;

export const PARTICLE_REFINEMENT_CAPS: Record<ParticleLodQuality, number> = {
  low: 3_600,
  high: 9_000,
};

export const PARTICLE_REFINEMENT_REGION_GRID_DEGREES = 12;
export const PARTICLE_REFINEMENT_REGION_RADIUS_DEGREES = 42;
export const PARTICLE_REFINEMENT_CACHE_LIMIT = 4;
export const PARTICLE_REFINEMENT_SAMPLE_RADIUS = 1.39;

export interface ParticleRefinementLod {
  level: GlobeSemanticZoom;
  levelProgress: number;
  refinementProgress: number;
  activeCount: number;
  particleCap: number;
}

export function resolveParticleRefinementLod(
  zoom: number,
  quality: ParticleLodQuality,
  previousLevel?: GlobeSemanticZoom,
): ParticleRefinementLod {
  const semantic = resolveGlobeSemanticZoom({
    zoom,
    previous: previousLevel,
    qualityProfile: quality,
  });
  const finiteZoom = Number.isFinite(zoom) ? zoom : 1;
  const clampedZoom = Math.max(0.72, Math.min(3, finiteZoom));
  const ranges: Record<GlobeSemanticZoom, readonly [number, number]> = {
    planet: [0.72, 1.3],
    macro: [1.3, 2.1],
    regional: [2.1, 2.55],
    local: [2.55, 3],
  };
  const [lower, upper] = ranges[semantic.state];
  const levelProgress = upper === lower
    ? 1
    : Math.min(1, Math.max(0, (clampedZoom - lower) / (upper - lower)));
  const refinementUnit = Math.min(1, Math.max(0, (clampedZoom - 1.3) / (3 - 1.3)));
  const refinementProgress = refinementUnit * refinementUnit * (3 - 2 * refinementUnit);
  const particleCap = PARTICLE_REFINEMENT_CAPS[quality];
  return {
    level: semantic.state,
    levelProgress,
    refinementProgress,
    particleCap,
    activeCount: Math.floor(particleCap * refinementProgress),
  };
}

export function resolveParticleRefinementLodForFrame({
  zoom,
  quality,
  current,
  focusFlightActive,
}: {
  zoom: number;
  quality: ParticleLodQuality;
  current: ParticleRefinementLod;
  focusFlightActive: boolean;
}): ParticleRefinementLod {
  if (focusFlightActive) return current;
  return resolveParticleRefinementLod(zoom, quality, current.level);
}

export function shouldCancelPendingRefinementRequest({
  activeCacheKey,
  requestedCacheKey,
  targetCacheKey,
}: {
  activeCacheKey: string | null;
  requestedCacheKey: string | null;
  targetCacheKey: string;
}) {
  return activeCacheKey === targetCacheKey
    && requestedCacheKey !== null
    && requestedCacheKey !== targetCacheKey;
}

export interface ParticleRefinementRegion {
  key: string;
  center: { lat: number; lon: number };
  radiusDegrees: number;
}

function wrapLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function snapNearZero(value: number) {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

export function resolveParticleRefinementRegion(
  view: { lat: number; lon: number },
): ParticleRefinementRegion {
  const grid = PARTICLE_REFINEMENT_REGION_GRID_DEGREES;
  const centerLat = snapNearZero(Math.max(-84, Math.min(84, Math.round(view.lat / grid) * grid)));
  const centerLon = snapNearZero(wrapLongitude(Math.round(wrapLongitude(view.lon) / grid) * grid));
  return {
    key: `${centerLat}:${centerLon}`,
    center: { lat: centerLat, lon: centerLon },
    radiusDegrees: PARTICLE_REFINEMENT_REGION_RADIUS_DEGREES,
  };
}

export interface ParticleRefinementBuildTicket {
  key: string;
  revision: number;
}

export class ParticleRefinementBuildGuard {
  private revision = 0;
  private visible = true;
  private disposed = false;
  private desiredKey: string | null = null;

  request(key: string): ParticleRefinementBuildTicket {
    this.desiredKey = key;
    return { key, revision: ++this.revision };
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.revision += 1;
  }

  invalidate() {
    this.revision += 1;
    this.desiredKey = null;
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
  }

  isCurrent(ticket: ParticleRefinementBuildTicket) {
    return !this.disposed
      && this.visible
      && ticket.revision === this.revision
      && ticket.key === this.desiredKey;
  }
}

export interface RegionalLandSample {
  positions: Float32Array;
  lodThresholds: Float32Array;
}

interface RegionalLandSampleOptions {
  region: ParticleRefinementRegion;
  count: number;
  isLand: (lat: number, lon: number) => boolean;
  shouldContinue: () => boolean;
  yieldControl: () => Promise<void>;
  batchAttempts?: number;
}

function hashRegionKey(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitVector(lat: number, lon: number) {
  const latitude = lat * Math.PI / 180;
  const longitude = lon * Math.PI / 180;
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: -cosLatitude * Math.sin(longitude),
  };
}

function normalize(x: number, y: number, z: number) {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function cross(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function vectorToLatLon(x: number, y: number, z: number) {
  return {
    lat: Math.asin(Math.min(1, Math.max(-1, y))) * 180 / Math.PI,
    lon: wrapLongitude(Math.atan2(-z, x) * 180 / Math.PI),
  };
}

export async function buildRegionalLandSample({
  region,
  count,
  isLand,
  shouldContinue,
  yieldControl,
  batchAttempts = 8_192,
}: RegionalLandSampleOptions): Promise<RegionalLandSample | null> {
  const boundedCount = Math.max(0, Math.floor(count));
  const positions = new Float32Array(boundedCount * 3);
  const lodThresholds = new Float32Array(boundedCount);
  if (boundedCount === 0) return { positions, lodThresholds };

  const center = unitVector(region.center.lat, region.center.lon);
  const reference = Math.abs(center.y) < 0.9
    ? { x: 0, y: 1, z: 0 }
    : { x: 1, y: 0, z: 0 };
  const tangent = cross(reference, center);
  const tangentX = normalize(tangent.x, tangent.y, tangent.z);
  const tangentY = cross(center, tangentX);
  const minimumCosine = Math.cos(region.radiusDegrees * Math.PI / 180);
  const seed = hashRegionKey(region.key) / 0x1_0000_0000;
  const maximumAttempts = boundedCount * 120;
  let accepted = 0;

  for (let attempt = 0; accepted < boundedCount && attempt < maximumAttempts; attempt += 1) {
    if (attempt > 0 && attempt % batchAttempts === 0) {
      await yieldControl();
      if (!shouldContinue()) return null;
    }
    const radialUnit = (seed + (attempt + 1) * 0.7548776662466927) % 1;
    const angleUnit = (seed * 0.6180339887498948 + (attempt + 1) * 0.5698402909980532) % 1;
    const cosine = 1 - radialUnit * (1 - minimumCosine);
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const angle = angleUnit * Math.PI * 2;
    const tangentScaleX = sine * Math.cos(angle);
    const tangentScaleY = sine * Math.sin(angle);
    const x = center.x * cosine + tangentX.x * tangentScaleX + tangentY.x * tangentScaleY;
    const y = center.y * cosine + tangentX.y * tangentScaleX + tangentY.y * tangentScaleY;
    const z = center.z * cosine + tangentX.z * tangentScaleX + tangentY.z * tangentScaleY;
    const point = vectorToLatLon(x, y, z);
    if (!isLand(point.lat, point.lon)) continue;

    const offset = accepted * 3;
    positions[offset] = x * PARTICLE_REFINEMENT_SAMPLE_RADIUS;
    positions[offset + 1] = y * PARTICLE_REFINEMENT_SAMPLE_RADIUS;
    positions[offset + 2] = z * PARTICLE_REFINEMENT_SAMPLE_RADIUS;
    lodThresholds[accepted] = (accepted + 0.5) / boundedCount;
    accepted += 1;
  }

  if (!shouldContinue()) return null;
  return {
    positions: accepted === boundedCount ? positions : positions.slice(0, accepted * 3),
    lodThresholds: accepted === boundedCount ? lodThresholds : lodThresholds.slice(0, accepted),
  };
}
