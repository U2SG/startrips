import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildArtworkPointPositions,
  buildRoutePolylineLengths,
  buildSeededSpherePoints,
  buildSphericalRouteSegments,
  buildSphericalRingSegments,
  computeRouteStreamParticleCount,
  formatLatitude,
  formatLongitude,
  latLonToVector3,
  rotationYForLongitude,
  sampleRoutePolylinePosition,
  vector3ToLatLon,
} from "./geo";

describe("latLonToVector3", () => {
  it("maps the equator and poles to a unit sphere", () => {
    expect(latLonToVector3(0, 0, 1).toArray()).toEqual([1, 0, 0]);
    expect(latLonToVector3(90, 0, 1).toArray()).toEqual([0, 1, 0]);
    expect(latLonToVector3(-90, 0, 1).toArray()).toEqual([0, -1, 0]);
  });

  it("round-trips globe pick positions back to geographic coordinates", () => {
    for (const point of [
      { lat: 31.2304, lon: 121.4737 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: 0, lon: -179.5 },
    ]) {
      const result = vector3ToLatLon(latLonToVector3(point.lat, point.lon, 2));
      expect(result.lat).toBeCloseTo(point.lat);
      expect(result.lon).toBeCloseTo(point.lon);
    }
  });
});

describe("coordinate labels", () => {
  it("uses the correct hemisphere for signed coordinates", () => {
    expect(formatLatitude(34.0522)).toBe("34.0522°N");
    expect(formatLatitude(-33.8688, 2)).toBe("33.87°S");
    expect(formatLongitude(-118.2437)).toBe("118.2437°W");
    expect(formatLongitude(116.4074, 2)).toBe("116.41°E");
  });

  it("computes the Y rotation that brings a longitude to the visible center", () => {
    expect(rotationYForLongitude(-90)).toBeCloseTo(0);
    expect(rotationYForLongitude(0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe("seeded geographic point generation", () => {
  it("returns the same sphere points for the same seed", () => {
    const first = buildSeededSpherePoints(8, 42);
    const second = buildSeededSpherePoints(8, 42);
    expect([...first]).toEqual([...second]);
    expect(first).toHaveLength(24);
  });

  it("packs archive coordinates in record order", () => {
    const points = buildArtworkPointPositions(
      [
        { point: { lat: 0, lon: 0 } },
        { point: { lat: 90, lon: 0 } },
      ],
      2,
    );
    expect([...points]).toEqual([2, 0, 0, 0, 2, 0]);
  });
});

describe("spherical route geometry", () => {
  it("returns no line for a single point", () => {
    expect(buildSphericalRouteSegments([{ lat: 0, lon: 0 }], 1)).toHaveLength(0);
  });

  it("uses the short spherical arc across the antimeridian", () => {
    const positions = buildSphericalRouteSegments(
      [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }],
      1,
      Math.PI / 180,
    );
    const mid = new Vector3(positions[6], positions[7], positions[8]);
    expect(mid.length()).toBeCloseTo(1);
    expect(mid.x).toBeLessThan(-0.99);
  });

  it("respects the line-vertex budget", () => {
    const positions = buildSphericalRouteSegments(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }],
      1,
      Math.PI / 180,
      10,
    );
    expect(positions.length / 3).toBeLessThanOrEqual(10);
  });
});

describe("route stream sampling", () => {
  const segments = new Float32Array([
    0, 0, 0, 2, 0, 0,
    2, 0, 0, 2, 2, 0,
  ]);

  it("accumulates polyline lengths per segment pair", () => {
    const lengths = buildRoutePolylineLengths(segments);
    expect([...lengths]).toEqual([0, 2, 4]);
  });

  it("samples along the polyline at a fraction of total length", () => {
    const target = new Vector3();
    sampleRoutePolylinePosition(segments, buildRoutePolylineLengths(segments), 0.5, target);
    expect(target.x).toBeCloseTo(2);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(0);
    sampleRoutePolylinePosition(segments, buildRoutePolylineLengths(segments), 0.75, target);
    expect(target.x).toBeCloseTo(2);
    expect(target.y).toBeCloseTo(1);
  });

  it("clamps progress and handles empty geometry", () => {
    const target = new Vector3();
    sampleRoutePolylinePosition(segments, buildRoutePolylineLengths(segments), 2, target);
    expect(target.y).toBeCloseTo(2);
    sampleRoutePolylinePosition(new Float32Array(), new Float32Array([0]), 0.5, target);
    expect(target.x).toBe(0);
  });

  it("sizes route streams by length without exhausting the shared budget", () => {
    expect(computeRouteStreamParticleCount(2.2, 1000)).toBe(6);
    expect(computeRouteStreamParticleCount(20, 1000)).toBeGreaterThan(6);
    expect(computeRouteStreamParticleCount(1000, 1000)).toBeLessThanOrEqual(60);
    expect(computeRouteStreamParticleCount(20, 3)).toBe(3);
    expect(computeRouteStreamParticleCount(0, 1000)).toBe(0);
  });
});

describe("spherical coastline geometry", () => {
  it("converts closed geographic rings into adjacent line segments", () => {
    const positions = buildSphericalRingSegments(
      [[
        [0, 0],
        [90, 0],
        [0, 90],
        [0, 0],
      ]],
      2,
    );
    expect(positions.length / 3).toBe(6);
    for (let index = 0; index < positions.length; index += 3) {
      expect(new Vector3(
        positions[index],
        positions[index + 1],
        positions[index + 2],
      ).length()).toBeCloseTo(2);
    }
  });

  it("respects the coastline vertex budget", () => {
    const positions = buildSphericalRingSegments(
      [[[0, 0], [45, 0], [90, 0], [0, 0]]],
      1,
      4,
    );
    expect(positions.length / 3).toBe(4);
  });

  it("uses the short chord across the antimeridian", () => {
    const positions = buildSphericalRingSegments(
      [[[179, 0], [-179, 0]]],
      1,
    );
    const start = new Vector3(positions[0], positions[1], positions[2]);
    const end = new Vector3(positions[3], positions[4], positions[5]);
    expect(start.distanceTo(end)).toBeLessThan(0.04);
  });

  it("keeps the bundled Natural Earth coastline inside the GPU budget", () => {
    const collection = JSON.parse(readFileSync(
      new URL("../../public/earth/ne_110m_land.geojson", import.meta.url),
      "utf8",
    )) as {
      features: Array<{
        geometry: null | {
          type: "Polygon" | "MultiPolygon";
          coordinates: number[][][] | number[][][][];
        };
      }>;
    };
    const rings: number[][][] = [];
    collection.features.forEach(({ geometry }) => {
      if (!geometry) return;
      const polygons = geometry.type === "Polygon"
        ? [geometry.coordinates as number[][][]]
        : geometry.coordinates as number[][][][];
      polygons.forEach((polygon) => rings.push(...polygon));
    });

    const positions = buildSphericalRingSegments(rings, 1.405, 20_000);
    expect(positions.length / 3).toBe(10_030);
    expect(positions.length / 3).toBeLessThanOrEqual(20_000);
  });
});
