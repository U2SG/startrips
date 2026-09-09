import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GEOGRAPHIC_SURFACE_RADIUS, latLonToVector3 } from "./geo";
import {
  COASTLINE_LOCAL_COMBINED_VERTEX_BUDGET,
  COASTLINE_LOCAL_VERTEX_BUDGET,
  CoastlineLocalChunkCache,
  buildLocalCoastlinePositions,
  isLocalCoastlineTarget,
  mergeRegionalAndLocalCoastlinePositions,
  resolveCoastlineInspectionTarget,
  resolveLocalCoastlineCell,
  resolveLocalCoastlineChunkIds,
  shouldUseCoastlineFocusTarget,
  type CoastlineLocalChunk,
  type CoastlineLocalManifest,
} from "./coastlineLocalLod";

const manifest = JSON.parse(
  readFileSync("public/earth/coastline-10m/manifest.json", "utf8"),
) as CoastlineLocalManifest;

function chunk(id: string) {
  return JSON.parse(
    readFileSync(`public/earth/coastline-10m/${id}.json`, "utf8"),
  ) as CoastlineLocalChunk;
}

function countSegmentsInBounds(
  collection: { features: Array<{ geometry?: { type: string; coordinates: unknown } | null }> },
  bounds: { west: number; south: number; east: number; north: number },
) {
  let count = 0;
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : geometry.coordinates as number[][][][];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let index = 0; index + 1 < ring.length; index += 1) {
          const left = ring[index];
          const right = ring[index + 1];
          const lon = (left[0] + right[0]) / 2;
          const lat = (left[1] + right[1]) / 2;
          if (
            lon >= bounds.west && lon < bounds.east
            && lat >= bounds.south && lat < bounds.north
          ) count += 1;
        }
      }
    }
  }
  return count;
}

describe("local 10m coastline refinement (#154)", () => {
  it("uses a genuinely finer source for the Hong Kong cell than the 50m regional source", () => {
    expect(manifest.source.scale).toBe("10m");
    expect(manifest.source.license).toBe("public-domain");
    const hongKong = manifest.chunks.find((entry) => entry.id === "+22_+114");
    expect(hongKong).toBeDefined();

    const fiftyMetre = JSON.parse(
      readFileSync("public/earth/ne_50m_land.geojson", "utf8"),
    );
    const fiftyMetreSegments = countSegmentsInBounds(fiftyMetre, hongKong!.bounds);
    expect(hongKong!.segmentCount).toBeGreaterThan(fiftyMetreSegments * 5);
  });

  it("retains recognizable Hong Kong island coastlines in the local source", () => {
    const ids = resolveLocalCoastlineChunkIds(manifest, { lat: 22.54554, lon: 114.0683 });
    const chunks = ids.map(chunk);
    const countIn = (bounds: { west: number; south: number; east: number; north: number }) => {
      let count = 0;
      for (const candidate of chunks) {
        for (let index = 0; index + 3 < candidate.segments.length; index += 4) {
          const lon = (candidate.segments[index] + candidate.segments[index + 2]) / 2;
          const lat = (candidate.segments[index + 1] + candidate.segments[index + 3]) / 2;
          if (
            lon >= bounds.west && lon <= bounds.east
            && lat >= bounds.south && lat <= bounds.north
          ) count += 1;
        }
      }
      return count;
    };
    expect(countIn({ west: 113.82, south: 22.18, east: 114.0, north: 22.35 })).toBeGreaterThan(20); // Lantau
    expect(countIn({ west: 114.08, south: 22.18, east: 114.32, north: 22.33 })).toBeGreaterThan(50); // Hong Kong Island
    expect(countIn({ west: 114.08, south: 22.15, east: 114.18, north: 22.25 })).toBeGreaterThan(10); // Lamma
  });

  it("selects the same local chunk cell for the same geographic focus regardless of screen placement", () => {
    const centered = resolveLocalCoastlineCell({ lat: 22.54554, lon: 114.0683 });
    const offCenter = resolveLocalCoastlineCell({ lat: 22.54554, lon: 114.0683 });
    expect(centered).toEqual(offCenter);
    expect(centered.id).toBe("+22_+114");
    expect(centered.center).toEqual({ lat: 23, lon: 115 });
  });

  it("keeps wheel zoom on canonical focus while the real inspection ray still sees that place", () => {
    const focus = { lat: 22.54554, lon: 114.0683 };
    expect(shouldUseCoastlineFocusTarget(
      focus,
      { lat: 22.7, lon: 114.2 },
      true,
    )).toBe(true);
    expect(shouldUseCoastlineFocusTarget(
      focus,
      { lat: 28, lon: 120 },
      true,
    )).toBe(false);
    expect(shouldUseCoastlineFocusTarget(focus, null, false)).toBe(true);
  });

  it("lets settled canonical focus outrank free-explore inspection, then falls back after manual ownership", () => {
    const focus = { lat: 22.54554, lon: 114.0683 };
    const free = { lat: 24.2, lon: 116.1 };
    const focused = resolveCoastlineInspectionTarget({
      focusTarget: focus,
      focusOwnsInspection: true,
      freeExploreTarget: free,
    });
    expect(focused?.source).toBe("focus");
    expect(focused?.lat).toBeCloseTo(focus.lat, 8);
    expect(focused?.lon).toBeCloseTo(focus.lon, 8);
    const explored = resolveCoastlineInspectionTarget({
      focusTarget: focus,
      focusOwnsInspection: false,
      freeExploreTarget: free,
    });
    expect(explored?.source).toBe("free-explore");
    expect(explored?.lat).toBeCloseTo(free.lat, 8);
    expect(explored?.lon).toBeCloseTo(free.lon, 8);
  });

  it("loads only the bounded adjacent chunk set for Pearl River Delta inspection", () => {
    const ids = resolveLocalCoastlineChunkIds(manifest, { lat: 22.54554, lon: 114.0683 });
    expect(ids).toEqual(["+20_+112", "+22_+112", "+22_+114", "+22_+116", "+24_+116"]);
    expect(ids.length).toBeLessThanOrEqual(9);
    expect(isLocalCoastlineTarget({ lat: 22.54554, lon: 114.0683 })).toBe(true);
    expect(isLocalCoastlineTarget({ lat: 35.6762, lon: 139.6503 })).toBe(false);
  });

  it("builds the selected local chunks on the canonical geographic surface within a fixed vertex budget", () => {
    const ids = resolveLocalCoastlineChunkIds(manifest, { lat: 22.54554, lon: 114.0683 });
    const positions = buildLocalCoastlinePositions({
      chunks: ids.map(chunk),
      quality: "high",
    });
    expect(positions.length / 3).toBeLessThanOrEqual(COASTLINE_LOCAL_VERTEX_BUDGET.high);
    expect(positions.length).toBeGreaterThan(0);
    for (let index = 0; index < positions.length; index += 3) {
      expect(Math.hypot(positions[index], positions[index + 1], positions[index + 2]))
        .toBeCloseTo(GEOGRAPHIC_SURFACE_RADIUS, 5);
    }
  });

  it("keeps regional coverage outside local chunks while replacing the overlapping 50m segments", () => {
    const segment = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
      const values = new Float32Array(6);
      latLonToVector3(a.lat, a.lon, GEOGRAPHIC_SURFACE_RADIUS).toArray(values, 0);
      latLonToVector3(b.lat, b.lon, GEOGRAPHIC_SURFACE_RADIUS).toArray(values, 3);
      return values;
    };
    const insideRegional = segment({ lat: 22.3, lon: 114.1 }, { lat: 22.35, lon: 114.15 });
    const outsideRegional = segment({ lat: 30, lon: 120 }, { lat: 30.1, lon: 120.1 });
    const regional = new Float32Array([...insideRegional, ...outsideRegional]);
    const local = segment({ lat: 22.31, lon: 114.11 }, { lat: 22.36, lon: 114.16 });
    const merged = mergeRegionalAndLocalCoastlinePositions({
      regionalPositions: regional,
      localPositions: local,
      localBounds: [{ west: 114, south: 22, east: 116, north: 24 }],
      quality: "high",
    });

    expect(Array.from(merged.slice(0, 6))).toEqual(Array.from(outsideRegional));
    expect(Array.from(merged.slice(-6))).toEqual(Array.from(local));
    expect(merged.length / 3).toBeLessThanOrEqual(COASTLINE_LOCAL_COMBINED_VERTEX_BUDGET.high);
  });

  it("keeps a bounded LRU of immutable local chunks", () => {
    const cache = new CoastlineLocalChunkCache(2);
    const a = chunk("+20_+112");
    const b = chunk("+22_+112");
    const c = chunk("+22_+114");
    cache.set(a.id, a);
    cache.set(b.id, b);
    expect(cache.get(a.id)?.id).toBe(a.id);
    cache.set(c.id, c);
    expect(cache.get(b.id)).toBeNull();
    expect(cache.size).toBe(2);
  });
});
