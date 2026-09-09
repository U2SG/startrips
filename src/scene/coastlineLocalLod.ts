import { GEOGRAPHIC_SURFACE_RADIUS, latLonToVector3 } from "./geo";

export const COASTLINE_LOCAL_MANIFEST_PATH = "/earth/coastline-10m/manifest.json";
export const COASTLINE_LOCAL_GRID_DEGREES = 2;
export const COASTLINE_LOCAL_ACTIVE_CELL_RADIUS = 1;
export const COASTLINE_LOCAL_CACHE_LIMIT = 12;
export const COASTLINE_LOCAL_VERTEX_BUDGET = { low: 8_000, high: 12_000 } as const;
export const COASTLINE_LOCAL_COMBINED_VERTEX_BUDGET = { low: 26_000, high: 48_000 } as const;
export const COASTLINE_LOCAL_COVERAGE = { west: 110, south: 18, east: 118, north: 26 } as const;

export type CoastlineLocalQuality = keyof typeof COASTLINE_LOCAL_VERTEX_BUDGET;
export type CoastlineInspectionSource = "focus" | "free-explore";

export interface CoastlineInspectionTarget {
  lat: number;
  lon: number;
  source: CoastlineInspectionSource;
}

export interface CoastlineLocalChunkManifestEntry {
  id: string;
  bounds: { west: number; south: number; east: number; north: number };
  path: string;
  segmentCount: number;
}

export interface CoastlineLocalManifest {
  version: 1;
  source: { name: string; scale: "10m"; license: string; upstream: string };
  gridDegrees: number;
  coverage: { west: number; south: number; east: number; north: number };
  chunkSegmentLimit: number;
  chunks: CoastlineLocalChunkManifestEntry[];
}

export interface CoastlineLocalChunk {
  version: 1;
  id: string;
  bounds: { west: number; south: number; east: number; north: number };
  sourceScale: "10m";
  segments: number[];
}

function wrapLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function chunkCoordinate(value: number) {
  return Math.floor(value / COASTLINE_LOCAL_GRID_DEGREES) * COASTLINE_LOCAL_GRID_DEGREES;
}

function chunkKey(latSouth: number, lonWest: number) {
  const lat = `${latSouth >= 0 ? "+" : "-"}${String(Math.abs(latSouth)).padStart(2, "0")}`;
  const lon = `${lonWest >= 0 ? "+" : "-"}${String(Math.abs(lonWest)).padStart(3, "0")}`;
  return `${lat}_${lon}`;
}

export function coastlineTargetSeparationDegrees(
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

export function shouldUseCoastlineFocusTarget(
  focusTarget: { lat: number; lon: number } | null | undefined,
  freeExploreTarget: { lat: number; lon: number } | null | undefined,
  manualFocusOwner: boolean,
  toleranceDegrees = 4,
) {
  if (!focusTarget) return false;
  if (!manualFocusOwner) return true;
  return Boolean(
    freeExploreTarget
    && coastlineTargetSeparationDegrees(focusTarget, freeExploreTarget) <= toleranceDegrees
  );
}

export function resolveCoastlineInspectionTarget({
  focusTarget,
  focusOwnsInspection,
  freeExploreTarget,
}: {
  focusTarget: { lat: number; lon: number } | null | undefined;
  focusOwnsInspection: boolean;
  freeExploreTarget: { lat: number; lon: number } | null | undefined;
}): CoastlineInspectionTarget | null {
  if (focusOwnsInspection && focusTarget) {
    return { lat: focusTarget.lat, lon: wrapLongitude(focusTarget.lon), source: "focus" };
  }
  return freeExploreTarget
    ? { lat: freeExploreTarget.lat, lon: wrapLongitude(freeExploreTarget.lon), source: "free-explore" }
    : null;
}

export function resolveLocalCoastlineCell(target: { lat: number; lon: number }) {
  const lon = wrapLongitude(target.lon);
  const latSouth = chunkCoordinate(target.lat);
  const lonWest = chunkCoordinate(lon);
  return {
    id: chunkKey(latSouth, lonWest),
    bounds: {
      west: lonWest,
      south: latSouth,
      east: lonWest + COASTLINE_LOCAL_GRID_DEGREES,
      north: latSouth + COASTLINE_LOCAL_GRID_DEGREES,
    },
    center: {
      lat: latSouth + COASTLINE_LOCAL_GRID_DEGREES / 2,
      lon: wrapLongitude(lonWest + COASTLINE_LOCAL_GRID_DEGREES / 2),
    },
  };
}

export function isLocalCoastlineTarget(target: { lat: number; lon: number }) {
  const lon = wrapLongitude(target.lon);
  return target.lat >= COASTLINE_LOCAL_COVERAGE.south
    && target.lat < COASTLINE_LOCAL_COVERAGE.north
    && lon >= COASTLINE_LOCAL_COVERAGE.west
    && lon < COASTLINE_LOCAL_COVERAGE.east;
}

export function resolveLocalCoastlineChunkIds(
  manifest: CoastlineLocalManifest,
  target: { lat: number; lon: number },
) {
  if (!isLocalCoastlineTarget(target)) return [];
  const primary = resolveLocalCoastlineCell(target);
  const available = new Set(manifest.chunks.map((chunk) => chunk.id));
  const ids: string[] = [];
  for (let latStep = -COASTLINE_LOCAL_ACTIVE_CELL_RADIUS; latStep <= COASTLINE_LOCAL_ACTIVE_CELL_RADIUS; latStep += 1) {
    for (let lonStep = -COASTLINE_LOCAL_ACTIVE_CELL_RADIUS; lonStep <= COASTLINE_LOCAL_ACTIVE_CELL_RADIUS; lonStep += 1) {
      const latSouth = primary.bounds.south + latStep * COASTLINE_LOCAL_GRID_DEGREES;
      const lonWest = wrapLongitude(primary.bounds.west + lonStep * COASTLINE_LOCAL_GRID_DEGREES);
      const id = chunkKey(latSouth, lonWest);
      if (available.has(id)) ids.push(id);
    }
  }
  return ids.sort();
}

export function buildLocalCoastlinePositions({
  chunks,
  quality,
  radius = GEOGRAPHIC_SURFACE_RADIUS,
}: {
  chunks: readonly CoastlineLocalChunk[];
  quality: CoastlineLocalQuality;
  radius?: number;
}) {
  const sourceSegments: number[][] = [];
  for (const chunk of chunks) {
    for (let index = 0; index + 3 < chunk.segments.length; index += 4) {
      sourceSegments.push(chunk.segments.slice(index, index + 4));
    }
  }
  const maxSegments = Math.floor(COASTLINE_LOCAL_VERTEX_BUDGET[quality] / 2);
  const segmentCount = Math.min(sourceSegments.length, maxSegments);
  const positions = new Float32Array(segmentCount * 2 * 3);
  const stride = segmentCount === 0 ? 1 : sourceSegments.length / segmentCount;
  const point = { offset: 0 };
  for (let index = 0; index < segmentCount; index += 1) {
    const sourceIndex = Math.min(sourceSegments.length - 1, Math.floor(index * stride));
    const [lonA, latA, lonB, latB] = sourceSegments[sourceIndex];
    latLonToVector3(latA, lonA, radius).toArray(positions, point.offset);
    point.offset += 3;
    latLonToVector3(latB, lonB, radius).toArray(positions, point.offset);
    point.offset += 3;
  }
  return positions;
}

function vectorPointToLatLon(x: number, y: number, z: number) {
  const length = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(Math.min(1, Math.max(-1, y / length))) * 180 / Math.PI,
    lon: wrapLongitude(Math.atan2(-z, x) * 180 / Math.PI),
  };
}

function pointInsideBounds(
  point: { lat: number; lon: number },
  bounds: { west: number; south: number; east: number; north: number },
) {
  return point.lon >= bounds.west && point.lon < bounds.east
    && point.lat >= bounds.south && point.lat < bounds.north;
}

export function mergeRegionalAndLocalCoastlinePositions({
  regionalPositions,
  localPositions,
  localBounds,
  quality,
}: {
  regionalPositions: Float32Array;
  localPositions: Float32Array;
  localBounds: readonly { west: number; south: number; east: number; north: number }[];
  quality: CoastlineLocalQuality;
}) {
  const regionalSegments: number[][] = [];
  for (let index = 0; index + 5 < regionalPositions.length; index += 6) {
    const midpoint = vectorPointToLatLon(
      regionalPositions[index] + regionalPositions[index + 3],
      regionalPositions[index + 1] + regionalPositions[index + 4],
      regionalPositions[index + 2] + regionalPositions[index + 5],
    );
    if (localBounds.some((bounds) => pointInsideBounds(midpoint, bounds))) continue;
    regionalSegments.push(Array.from(regionalPositions.slice(index, index + 6)));
  }

  const combinedVertexBudget = COASTLINE_LOCAL_COMBINED_VERTEX_BUDGET[quality];
  const localVertexCount = Math.min(localPositions.length / 3, combinedVertexBudget);
  const regionalVertexBudget = Math.max(0, combinedVertexBudget - localVertexCount);
  const regionalSegmentBudget = Math.floor(regionalVertexBudget / 2);
  const selectedRegionalSegments: number[][] = [];
  if (regionalSegments.length <= regionalSegmentBudget) {
    selectedRegionalSegments.push(...regionalSegments);
  } else if (regionalSegmentBudget > 0) {
    const stride = regionalSegments.length / regionalSegmentBudget;
    for (let index = 0; index < regionalSegmentBudget; index += 1) {
      selectedRegionalSegments.push(regionalSegments[Math.floor(index * stride)]);
    }
  }

  const regionalLength = selectedRegionalSegments.length * 6;
  const localLength = localVertexCount * 3;
  const merged = new Float32Array(regionalLength + localLength);
  let offset = 0;
  for (const segment of selectedRegionalSegments) {
    merged.set(segment, offset);
    offset += 6;
  }
  merged.set(localPositions.slice(0, localLength), offset);
  return merged;
}

export class CoastlineLocalChunkCache {
  private readonly values = new Map<string, CoastlineLocalChunk>();

  constructor(private readonly limit = COASTLINE_LOCAL_CACHE_LIMIT) {}

  get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: CoastlineLocalChunk) {
    this.values.delete(key);
    this.values.set(key, value);
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
