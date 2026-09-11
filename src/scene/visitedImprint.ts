import type { JourneyRoute } from "../journey/types";
import type { GlobeSemanticZoom } from "./semanticZoom";

export type VisitedImprintTemporalReveal = {
  journeys: ReadonlyMap<string, number>;
  points: ReadonlyMap<string, number>;
};

export const VISITED_IMPRINT_GAIN_CAP = 0.15;
export const VISITED_IMPRINT_GAIN_SCALE = 3;
export const VISITED_IMPRINT_REGION_DEGREES = 6;
export const VISITED_IMPRINT_CORRIDOR_WEIGHT = 0.35;
export const VISITED_IMPRINT_CORRIDOR_STEP_DEGREES = 18;
export const VISITED_IMPRINT_MAX_CORRIDOR_SAMPLES_PER_LEG = 8;
export const VISITED_IMPRINT_ACTIVE_CONTEXT_SUPPRESSION = 0.85;
export const VISITED_IMPRINT_STABILITY_WEIGHT = 0.22;
export const VISITED_IMPRINT_LOCAL_PROGRESS_REDUCTION = 0.75;

export const VISITED_IMPRINT_ZOOM_ATTENUATION: Readonly<Record<GlobeSemanticZoom, number>> = {
  planet: 1,
  macro: 0.82,
  regional: 0.48,
  local: 0.18,
};

const VISITED_IMPRINT_TEXTURE_WIDTH = Math.round(360 / VISITED_IMPRINT_REGION_DEGREES);
const VISITED_IMPRINT_TEXTURE_HEIGHT = Math.round(180 / VISITED_IMPRINT_REGION_DEGREES);
const DEGREES_PER_RADIAN = 180 / Math.PI;
const RADIANS_PER_DEGREE = Math.PI / 180;

type RegionContributions = Map<string, number>;

export type VisitedImprintField = {
  width: number;
  height: number;
  gains: Float32Array;
  activeRegionCount: number;
  journeyContributionCount: number;
  maxGain: number;
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function regionIndex(latitude: number, longitude: number) {
  const lat = Math.max(-89.999999, Math.min(89.999999, latitude));
  const lon = normalizeLongitude(longitude);
  const x = Math.min(
    VISITED_IMPRINT_TEXTURE_WIDTH - 1,
    Math.max(0, Math.floor((lon + 180) / VISITED_IMPRINT_REGION_DEGREES)),
  );
  const y = Math.min(
    VISITED_IMPRINT_TEXTURE_HEIGHT - 1,
    Math.max(0, Math.floor((lat + 90) / VISITED_IMPRINT_REGION_DEGREES)),
  );
  return y * VISITED_IMPRINT_TEXTURE_WIDTH + x;
}

function pointReveal(
  route: JourneyRoute,
  pointIndex: number,
  temporalReveal?: VisitedImprintTemporalReveal,
) {
  const pointProgress = temporalReveal?.points.get(`${route.id}:${pointIndex}`);
  if (pointProgress !== undefined) return clamp01(pointProgress);
  const journeyProgress = temporalReveal?.journeys.get(route.id);
  return journeyProgress === undefined ? 1 : clamp01(journeyProgress);
}

function addContribution(
  regions: Map<number, RegionContributions>,
  index: number,
  journeyId: string,
  contribution: number,
) {
  const bounded = clamp01(contribution);
  if (bounded <= 0) return;
  let region = regions.get(index);
  if (!region) {
    region = new Map();
    regions.set(index, region);
  }
  // One Journey may pass through the same coarse region many times. Keep its
  // strongest truthful contribution rather than letting dense Route Points or
  // corridor samples stack brightness without bound.
  region.set(journeyId, Math.max(region.get(journeyId) ?? 0, bounded));
}

type UnitPoint = { x: number; y: number; z: number };

function toUnitPoint(latitude: number, longitude: number): UnitPoint {
  const lat = latitude * RADIANS_PER_DEGREE;
  const lon = longitude * RADIANS_PER_DEGREE;
  const cosLat = Math.cos(lat);
  return {
    x: cosLat * Math.cos(lon),
    y: Math.sin(lat),
    z: cosLat * Math.sin(lon),
  };
}

function fromUnitPoint(point: UnitPoint) {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  const x = point.x / length;
  const y = point.y / length;
  const z = point.z / length;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y))) * DEGREES_PER_RADIAN,
    lon: Math.atan2(z, x) * DEGREES_PER_RADIAN,
  };
}

function sphericalDistanceDegrees(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
) {
  const a = toUnitPoint(start.lat, start.lon);
  const b = toUnitPoint(end.lat, end.lon);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * DEGREES_PER_RADIAN;
}

function slerpRoutePoint(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
  progress: number,
) {
  const a = toUnitPoint(start.lat, start.lon);
  const b = toUnitPoint(end.lat, end.lon);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  if (dot > 0.999999) {
    return fromUnitPoint({
      x: a.x + (b.x - a.x) * progress,
      y: a.y + (b.y - a.y) * progress,
      z: a.z + (b.z - a.z) * progress,
    });
  }
  const angle = Math.acos(dot);
  const denominator = Math.sin(angle);
  if (Math.abs(denominator) < 1e-7) {
    return progress < 0.5 ? start : end;
  }
  const startWeight = Math.sin((1 - progress) * angle) / denominator;
  const endWeight = Math.sin(progress * angle) / denominator;
  return fromUnitPoint({
    x: a.x * startWeight + b.x * endWeight,
    y: a.y * startWeight + b.y * endWeight,
    z: a.z * startWeight + b.z * endWeight,
  });
}

export function visitedImprintGain(effectiveJourneyContributions: number) {
  const contribution = Math.max(0, effectiveJourneyContributions);
  return VISITED_IMPRINT_GAIN_CAP * (1 - Math.exp(-contribution / VISITED_IMPRINT_GAIN_SCALE));
}

export function visitedImprintZoomAttenuation(
  level: GlobeSemanticZoom,
  localProgress = 0,
) {
  const base = VISITED_IMPRINT_ZOOM_ATTENUATION[level];
  if (level !== "local") return base;
  // Once geography becomes local, the ambient history recedes further so
  // coastline, labels and the canonical geographic surface win visually.
  return base * (1 - VISITED_IMPRINT_LOCAL_PROGRESS_REDUCTION * clamp01(localProgress));
}

export function buildVisitedImprintField(
  routes: readonly JourneyRoute[],
  temporalReveal?: VisitedImprintTemporalReveal,
): VisitedImprintField {
  const regions = new Map<number, RegionContributions>();

  for (const route of routes) {
    for (let pointIndex = 0; pointIndex < route.points.length; pointIndex += 1) {
      const point = route.points[pointIndex];
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      const reveal = pointReveal(route, pointIndex, temporalReveal);
      addContribution(regions, regionIndex(point.lat, point.lon), route.id, reveal);

      if (pointIndex === 0) continue;
      const previous = route.points[pointIndex - 1];
      if (!Number.isFinite(previous.lat) || !Number.isFinite(previous.lon)) continue;
      const distance = sphericalDistanceDegrees(previous, point);
      const sampleCount = Math.min(
        VISITED_IMPRINT_MAX_CORRIDOR_SAMPLES_PER_LEG,
        Math.max(0, Math.ceil(distance / VISITED_IMPRINT_CORRIDOR_STEP_DEGREES) - 1),
      );
      if (sampleCount === 0) continue;
      // A route leg becomes visible with its destination Route Point in the
      // existing temporal-reveal contract. Reuse that authority here.
      const corridorReveal = reveal * VISITED_IMPRINT_CORRIDOR_WEIGHT;
      for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
        const progress = sampleIndex / (sampleCount + 1);
        const sample = slerpRoutePoint(previous, point, progress);
        addContribution(
          regions,
          regionIndex(sample.lat, sample.lon),
          route.id,
          corridorReveal,
        );
      }
    }
  }

  const gains = new Float32Array(
    VISITED_IMPRINT_TEXTURE_WIDTH * VISITED_IMPRINT_TEXTURE_HEIGHT,
  );
  let journeyContributionCount = 0;
  let maxGain = 0;
  for (const [index, contributions] of regions) {
    const effectiveJourneyContributions = [...contributions.values()]
      .reduce((sum, contribution) => sum + contribution, 0);
    journeyContributionCount += contributions.size;
    const gain = visitedImprintGain(effectiveJourneyContributions);
    gains[index] = gain;
    maxGain = Math.max(maxGain, gain);
  }

  return {
    width: VISITED_IMPRINT_TEXTURE_WIDTH,
    height: VISITED_IMPRINT_TEXTURE_HEIGHT,
    gains,
    activeRegionCount: regions.size,
    journeyContributionCount,
    maxGain,
  };
}

export function visitedImprintGainAt(
  field: VisitedImprintField,
  latitude: number,
  longitude: number,
) {
  return field.gains[regionIndex(latitude, longitude)] ?? 0;
}

export function encodeVisitedImprintTexture(field: VisitedImprintField) {
  const data = new Uint8Array(field.width * field.height * 4);
  for (let index = 0; index < field.gains.length; index += 1) {
    const normalized = Math.max(
      0,
      Math.min(1, field.gains[index] / VISITED_IMPRINT_GAIN_CAP),
    );
    const byte = Math.round(normalized * 255);
    const offset = index * 4;
    data[offset] = byte;
    data[offset + 1] = byte;
    data[offset + 2] = byte;
    data[offset + 3] = 255;
  }
  return data;
}

export function visitedImprintFieldsEqual(
  left: VisitedImprintField,
  right: VisitedImprintField,
) {
  if (left.width !== right.width || left.height !== right.height) return false;
  if (left.gains.length !== right.gains.length) return false;
  for (let index = 0; index < left.gains.length; index += 1) {
    if (Math.abs(left.gains[index] - right.gains[index]) > 1e-6) return false;
  }
  return true;
}
