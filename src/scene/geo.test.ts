import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildArtworkPointPositions,
  buildSeededSpherePoints,
  buildSphericalRouteLegs,
  buildSphericalRouteSegments,
  buildSphericalRingSegments,
  formatLatitude,
  formatLongitude,
  getSphericalRouteFocus,
  latLonToVector3,
  rotationXForLatitude,
  rotationYForLongitude,
  routeFocusZoomForAngularRadius,
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

  it("computes a spherical route frame across the antimeridian", () => {
    const frame = getSphericalRouteFocus([
      { lat: 10, lon: 179 },
      { lat: 12, lon: -179 },
    ]);
    expect(frame).not.toBeNull();
    expect(Math.abs(frame!.center.lon)).toBeGreaterThan(175);
    expect(frame!.center.lat).toBeCloseTo(11, 0);
    expect(frame!.zoom).toBeGreaterThan(1.5);
  });

  it("pulls back as a journey covers more of the globe", () => {
    const local = getSphericalRouteFocus([
      { lat: 22.54, lon: 114.05 },
      { lat: 22.30, lon: 114.20 },
    ]);
    const broad = getSphericalRouteFocus([
      { lat: 22.54, lon: 114.05 },
      { lat: 35.68, lon: 139.69 },
      { lat: 37.77, lon: -122.42 },
    ]);
    expect(local).not.toBeNull();
    expect(broad).not.toBeNull();
    expect(local!.zoom).toBeGreaterThan(broad!.zoom);
  });

  it("maps route latitude to the globe X rotation needed for centering", () => {
    expect(rotationXForLatitude(30)).toBeCloseTo(Math.PI / 6);
    expect(rotationXForLatitude(-45)).toBeCloseTo(-Math.PI / 4);
  });

  it("keeps route-focus zoom within the intended framing range", () => {
    expect(routeFocusZoomForAngularRadius(0)).toBeCloseTo(1.72);
    expect(routeFocusZoomForAngularRadius(Math.PI / 2)).toBeCloseTo(0.82);
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

  it("lifts long legs off the surface with a clamped altitude hump (#15)", () => {
    const flat = buildSphericalRouteSegments(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 60 }],
      1,
      Math.PI / 180,
      4096,
    );
    const arced = buildSphericalRouteSegments(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 60 }],
      1,
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.5, arcSaturationAngle: Math.PI / 3 },
    );
    // The arc must stay above the flat great circle somewhere in the middle.
    let maxLift = 0;
    for (let index = 0; index < arced.length; index += 3) {
      const distance = new Vector3(
        arced[index],
        arced[index + 1],
        arced[index + 2],
      ).length();
      if (distance > maxLift) maxLift = distance;
    }
    expect(maxLift).toBeGreaterThan(1.1);
    // Endpoints stay on the surface (both ends of every leg touch the globe).
    const start = new Vector3(arced[0], arced[1], arced[2]);
    const end = new Vector3(arced.at(-3)!, arced.at(-2)!, arced.at(-1)!);
    expect(start.length()).toBeCloseTo(1, 2);
    expect(end.length()).toBeCloseTo(1, 2);
    // The flat build never leaves the surface.
    let flatMax = 0;
    for (let index = 0; index < flat.length; index += 3) {
      flatMax = Math.max(flatMax, new Vector3(
        flat[index],
        flat[index + 1],
        flat[index + 2],
      ).length());
    }
    expect(flatMax).toBeCloseTo(1, 6);
  });

  it("keeps short legs hugging the surface (hump scales nonlinearly) (#15)", () => {
    const positions = buildSphericalRouteSegments(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 3 }],
      1,
      Math.PI / 360,
      4096,
      { arcHeightRatio: 0.5, arcSaturationAngle: Math.PI / 3 },
    );
    let maxDistance = 0;
    for (let index = 0; index < positions.length; index += 3) {
      maxDistance = Math.max(maxDistance, new Vector3(
        positions[index],
        positions[index + 1],
        positions[index + 2],
      ).length());
    }
    // 3° is ~0.052 rad; sqrt(0.052/1.047) ≈ 0.223 -> lift ≈ 1 + 0.5*0.223 ≈ 1.11 max
    expect(maxDistance).toBeGreaterThan(1.02);
    expect(maxDistance).toBeLessThan(1.16);
  });

  it("handles the 180° antipodal case with the orthonormal fallback (#15)", () => {
    const positions = buildSphericalRouteSegments(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }],
      1,
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.4, arcSaturationAngle: Math.PI / 3 },
    );
    // The path is finite, every vertex is real, and the mid-arc lifts.
    expect(positions.length).toBeGreaterThan(0);
    let midMax = 0;
    for (let index = 0; index < positions.length; index += 3) {
      const distance = new Vector3(
        positions[index],
        positions[index + 1],
        positions[index + 2],
      ).length();
      if (Number.isFinite(distance)) midMax = Math.max(midMax, distance);
    }
    expect(midMax).toBeGreaterThan(1.05);
  });

  it("builds one Float32Array per leg for stop-by-stop reveal (#21 review)", () => {
    const legs = buildSphericalRouteLegs(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 30 }, { lat: 0, lon: 60 }],
      1,
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.3, arcSaturationAngle: Math.PI / 3 },
    );
    expect(legs).toHaveLength(2);
    // Each leg starts on the surface at its origin point.
    const firstStart = new Vector3(legs[0][0], legs[0][1], legs[0][2]);
    expect(firstStart.length()).toBeCloseTo(1, 3);
    // The last leg's end is the route destination on the surface.
    const last = legs[1];
    const lastEnd = new Vector3(last.at(-3)!, last.at(-2)!, last.at(-1)!);
    expect(lastEnd.length()).toBeCloseTo(1, 3);
  });

  it("returns no legs for a single point (#21 review)", () => {
    expect(buildSphericalRouteLegs([{ lat: 0, lon: 0 }], 1)).toEqual([]);
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

  it("keeps a one-segment closed-ring budget non-degenerate", () => {
    const positions = buildSphericalRingSegments(
      [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]],
      1,
      2,
    );

    expect(positions.length / 3).toBe(2);
    const start = new Vector3(positions[0], positions[1], positions[2]);
    const end = new Vector3(positions[3], positions[4], positions[5]);
    expect(start.distanceTo(end)).toBeGreaterThan(0.01);
  });

  it("simplifies an over-budget coastline as connected runs instead of isolated dashes", () => {
    const positions = buildSphericalRingSegments(
      [[
        [-160, 0], [-120, 5], [-80, 10], [-40, 15],
        [0, 20], [40, 15], [80, 10], [120, 5], [160, 0],
      ]],
      1,
      4,
    );

    expect(positions.length / 3).toBe(4);
    expect([...positions.slice(3, 6)]).toEqual([...positions.slice(6, 9)]);
    const first = new Vector3(positions[0], positions[1], positions[2]);
    const last = new Vector3(positions.at(-3)!, positions.at(-2)!, positions.at(-1)!);
    expect(vector3ToLatLon(first).lon).toBeCloseTo(-160);
    expect(vector3ToLatLon(last).lon).toBeCloseTo(160);
  });

  it("distributes a constrained coastline budget across the full ring set", () => {
    const positions = buildSphericalRingSegments(
      [
        [[-170, 0], [-160, 0]],
        [[-60, 0], [-50, 0]],
        [[50, 0], [60, 0]],
        [[160, 0], [170, 0]],
      ],
      1,
      4,
    );

    expect(positions.length / 3).toBe(4);
    const points = [];
    for (let index = 0; index < positions.length; index += 3) {
      points.push(new Vector3(positions[index], positions[index + 1], positions[index + 2]));
    }
    const earlierSample = latLonToVector3(0, -60, 1);
    const finalSample = latLonToVector3(0, 160, 1);
    expect(points.some((point) => point.distanceTo(earlierSample) < 1e-5)).toBe(true);
    expect(points.some((point) => point.distanceTo(finalSample) < 1e-5)).toBe(true);
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
