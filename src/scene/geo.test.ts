import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildArtworkPointPositions,
  buildSeededSpherePoints,
  buildRouteArcLegSamples,
  buildRouteArcSamples,
  buildSphericalRingSegments,
  formatLatitude,
  formatLongitude,
  GEOGRAPHIC_SURFACE_RADIUS,
  getSphericalRouteFocus,
  latLonToVector3,
  rotationXForLatitude,
  rotationYForLongitude,
  ROUTE_ANCHOR_RADIUS,
  routeArcVertexCount,
  routeFocusZoomForAngularRadius,
  routePointAnchor,
  type RouteArcSamples,
  vector3ToLatLon,
} from "./geo";

/** World position of one stored vertex at a given radius and lift strength. */
function sampleAt(
  samples: RouteArcSamples,
  vertex: number,
  radius = 1,
  liftScale = 1,
) {
  const offset = vertex * 3;
  const scale = radius * (1 + samples.lifts[vertex] * liftScale);
  return new Vector3(
    samples.directions[offset] * scale,
    samples.directions[offset + 1] * scale,
    samples.directions[offset + 2] * scale,
  );
}

function maxRadius(samples: RouteArcSamples, radius = 1, liftScale = 1) {
  let largest = 0;
  for (let vertex = 0; vertex < routeArcVertexCount(samples); vertex += 1) {
    largest = Math.max(largest, sampleAt(samples, vertex, radius, liftScale).length());
  }
  return largest;
}

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

describe("route arc geometry", () => {
  it("returns no line for a single point", () => {
    expect(routeArcVertexCount(buildRouteArcSamples([{ lat: 0, lon: 0 }]))).toBe(0);
  });

  it("uses the short spherical arc across the antimeridian", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }],
      Math.PI / 180,
    );
    const mid = sampleAt(samples, 2);
    expect(mid.length()).toBeCloseTo(1);
    expect(mid.x).toBeLessThan(-0.99);
  });

  it("respects the line-vertex budget", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }],
      Math.PI / 180,
      10,
    );
    expect(routeArcVertexCount(samples)).toBeLessThanOrEqual(10);
    expect(samples.directions.length).toBe(routeArcVertexCount(samples) * 3);
  });

  it("lifts long legs off the surface with a clamped altitude hump (#15)", () => {
    const flat = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 60 }],
      Math.PI / 180,
      4096,
    );
    const arced = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 60 }],
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.5, arcSaturationAngle: Math.PI / 3 },
    );
    // The arc must stay above the flat great circle somewhere in the middle.
    expect(maxRadius(arced)).toBeGreaterThan(1.1);
    // Endpoints stay on the anchor shell (both ends of every leg meet a point).
    expect(arced.lifts[0]).toBe(0);
    expect(arced.lifts.at(-1)).toBe(0);
    expect(sampleAt(arced, 0).length()).toBeCloseTo(1, 6);
    expect(sampleAt(arced, routeArcVertexCount(arced) - 1).length()).toBeCloseTo(1, 6);
    // The flat build never leaves the surface.
    expect(maxRadius(flat)).toBeCloseTo(1, 6);
  });

  it("keeps short legs hugging the surface (hump scales nonlinearly) (#15)", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 3 }],
      Math.PI / 360,
      4096,
      { arcHeightRatio: 0.5, arcSaturationAngle: Math.PI / 3 },
    );
    // 3 degrees is ~0.052 rad; sqrt(0.052/1.047) ~ 0.223 -> lift ~ 1.11 max
    expect(maxRadius(samples)).toBeGreaterThan(1.02);
    expect(maxRadius(samples)).toBeLessThan(1.16);
  });

  it("handles the 180 degree antipodal case with the orthonormal fallback (#15)", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }],
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.4, arcSaturationAngle: Math.PI / 3 },
    );
    expect(routeArcVertexCount(samples)).toBeGreaterThan(0);
    expect([...samples.directions].every(Number.isFinite)).toBe(true);
    expect(maxRadius(samples)).toBeGreaterThan(1.05);
  });

  it("scales the stored hump with the frame's lift strength (#193)", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 60 }],
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 },
    );
    const cinematic = maxRadius(samples, ROUTE_ANCHOR_RADIUS, 1);
    const restrained = maxRadius(samples, ROUTE_ANCHOR_RADIUS, 0.25);
    const geographic = maxRadius(samples, ROUTE_ANCHOR_RADIUS, 0);
    expect(cinematic).toBeGreaterThan(restrained);
    expect(restrained).toBeGreaterThan(geographic);
    // Zero lift collapses the route onto the Route Point anchor shell.
    expect(geographic).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 6);
    // Every lift strength leaves both endpoints exactly on the anchor shell.
    for (const liftScale of [0, 0.25, 1]) {
      expect(sampleAt(samples, 0, ROUTE_ANCHOR_RADIUS, liftScale).length())
        .toBeCloseTo(ROUTE_ANCHOR_RADIUS, 6);
    }
  });

  it("puts a Route Point anchor on the canonical shell (#193)", () => {
    const anchor = routePointAnchor(37.8651, -119.5383);
    expect(anchor.length()).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 6);
    const samples = buildRouteArcSamples(
      [{ lat: 37.8651, lon: -119.5383 }, { lat: 34.0522, lon: -118.2437 }],
      Math.PI / 96,
      4096,
      { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 },
    );
    // The route's first vertex IS the Route Point, at every lift strength.
    for (const liftScale of [0, 0.5, 1]) {
      const endpoint = sampleAt(samples, 0, ROUTE_ANCHOR_RADIUS, liftScale);
      expect(endpoint.distanceTo(anchor)).toBeLessThan(1e-6);
    }
  });

  it("builds one sample set per leg for stop-by-stop reveal (#21 review)", () => {
    const legs = buildRouteArcLegSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 30 }, { lat: 0, lon: 60 }],
      Math.PI / 180,
      4096,
      { arcHeightRatio: 0.3, arcSaturationAngle: Math.PI / 3 },
    );
    expect(legs).toHaveLength(2);
    expect(sampleAt(legs[0], 0).length()).toBeCloseTo(1, 6);
    const last = legs[1];
    expect(sampleAt(last, routeArcVertexCount(last) - 1).length()).toBeCloseTo(1, 6);
  });

  it("returns no legs for a single point (#21 review)", () => {
    expect(buildRouteArcLegSamples([{ lat: 0, lon: 0 }])).toEqual([]);
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

    // #237: the coastline is a geographic reference layer, so it is built on
    // the canonical surface radius rather than on the 1.405 shell it used to
    // occupy. The vertex budget is unchanged - decimation selects paths and
    // segments by index, so the radius never moved the count.
    const positions = buildSphericalRingSegments(
      rings,
      GEOGRAPHIC_SURFACE_RADIUS,
      20_000,
    );
    expect(positions.length / 3).toBe(10_030);
    expect(positions.length / 3).toBeLessThanOrEqual(20_000);
    let maxRadiusError = 0;
    for (let index = 0; index < positions.length; index += 3) {
      const radius = Math.hypot(
        positions[index],
        positions[index + 1],
        positions[index + 2],
      );
      maxRadiusError = Math.max(
        maxRadiusError,
        Math.abs(radius - GEOGRAPHIC_SURFACE_RADIUS),
      );
    }
    // Every coastline vertex lives on the surface a Place Label is anchored to,
    // so no part of the map sits on an Earth of its own.
    expect(maxRadiusError).toBeLessThan(1e-6);
    expect(GEOGRAPHIC_SURFACE_RADIUS).not.toBe(1.405);
  });
});
