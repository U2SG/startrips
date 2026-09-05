import { GEOGRAPHIC_SURFACE_RADIUS, buildSphericalRingSegments } from "./geo";
import {
  resolveParticleRefinementRegion,
  type ParticleRefinementRegion,
} from "./particleSpatialLod";

export const COASTLINE_SPATIAL_CACHE_LIMIT = 4;
export const COASTLINE_SPATIAL_VERTEX_BUDGET = { low: 18_000, high: 36_000 } as const;
export type CoastlineSpatialQuality = keyof typeof COASTLINE_SPATIAL_VERTEX_BUDGET;

export type CoastlineRefinementRegion = ParticleRefinementRegion;

export function resolveCoastlineRefinementRegion(
  view: { lat: number; lon: number },
): CoastlineRefinementRegion {
  // Share the same snapped geographic identity as particle refinement so all
  // high-detail globe layers agree about where local detail is valuable.
  return resolveParticleRefinementRegion(view);
}

function wrapLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function angularDistanceDegrees(
  left: { lat: number; lon: number },
  right: { lat: number; lon: number },
) {
  const leftLat = left.lat * Math.PI / 180;
  const rightLat = right.lat * Math.PI / 180;
  const deltaLon = wrapLongitude(right.lon - left.lon) * Math.PI / 180;
  const cosine = Math.sin(leftLat) * Math.sin(rightLat)
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.cos(deltaLon);
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
}

function coordinateInsideRegion(
  coordinate: readonly number[],
  region: CoastlineRefinementRegion,
  overlapDegrees: number,
) {
  const [lon, lat] = coordinate;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return angularDistanceDegrees(
    { lat, lon },
    region.center,
  ) <= region.radiusDegrees + overlapDegrees;
}

export function selectRegionalCoastlineRings(
  rings: readonly (readonly (readonly number[])[])[],
  region: CoastlineRefinementRegion,
  overlapDegrees = 3,
) {
  const runs: number[][][] = [];
  const sameCoordinate = (left: readonly number[], right: readonly number[]) =>
    left[0] === right[0] && left[1] === right[1];
  for (const ring of rings) {
    let run: number[][] = [];
    const flush = () => {
      if (run.length >= 2) runs.push(run);
      run = [];
    };
    for (let index = 0; index + 1 < ring.length; index += 1) {
      const current = ring[index];
      const next = ring[index + 1];
      const deltaLon = wrapLongitude(next[0] - current[0]);
      const midpoint = [
        wrapLongitude(current[0] + deltaLon / 2),
        (current[1] + next[1]) / 2,
      ];
      const currentInside = coordinateInsideRegion(current, region, overlapDegrees);
      const nextInside = coordinateInsideRegion(next, region, overlapDegrees);
      const midpointInside = coordinateInsideRegion(midpoint, region, overlapDegrees);
      let piece: number[][] | null = null;
      if (currentInside && nextInside) piece = [[...current], [...next]];
      else if (currentInside && midpointInside) piece = [[...current], midpoint];
      else if (nextInside && midpointInside) piece = [midpoint, [...next]];
      if (!piece) {
        flush();
        continue;
      }
      if (run.length === 0) {
        run.push(...piece);
      } else if (sameCoordinate(run[run.length - 1], piece[0])) {
        run.push(piece[1]);
      } else {
        flush();
        run.push(...piece);
      }
    }
    flush();
  }
  return runs;
}

export function buildRegionalCoastlinePositions({
  rings,
  region,
  quality,
  // #237: regional refinement is the same map layer at higher detail, so it is
  // built on the canonical geographic surface rather than on a shell of its
  // own. A caller may still pass a radius, but there is no longer a second
  // default for the coastline to drift onto.
  radius = GEOGRAPHIC_SURFACE_RADIUS,
}: {
  rings: readonly (readonly (readonly number[])[])[];
  region: CoastlineRefinementRegion;
  quality: CoastlineSpatialQuality;
  radius?: number;
}) {
  const regionalRings = selectRegionalCoastlineRings(rings, region);
  return buildSphericalRingSegments(
    regionalRings,
    radius,
    COASTLINE_SPATIAL_VERTEX_BUDGET[quality],
  );
}

export class CoastlineRefinementCache {
  private readonly values = new Map<string, Float32Array>();

  constructor(private readonly limit = COASTLINE_SPATIAL_CACHE_LIMIT) {}

  get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, positions: Float32Array) {
    this.values.delete(key);
    this.values.set(key, positions);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (typeof oldest !== "string") break;
      this.values.delete(oldest);
    }
  }

  clear() {
    this.values.clear();
  }

  get size() {
    return this.values.size;
  }
}
