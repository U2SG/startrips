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
  planRouteArcLegs,
  rotationXForLatitude,
  rotationYForLongitude,
  ROUTE_ANCHOR_RADIUS,
  routeArcVertexCount,
  routeFocusZoomForAngularRadius,
  routePointAnchor,
  type RouteArcSamples,
  vector3ToLatLon,
} from "./geo";

/** World position of one stored vertex at a given radius, including its stored lift. */
function sampleAt(
  samples: RouteArcSamples,
  vertex: number,
  radius = 1,
) {
  const offset = vertex * 3;
  const scale = radius * (1 + samples.lifts[vertex]);
  return new Vector3(
    samples.directions[offset] * scale,
    samples.directions[offset + 1] * scale,
    samples.directions[offset + 2] * scale,
  );
}

/** Angle between two directions, well conditioned near 0 and pi (unlike acos). */
function arc(a: Vector3, b: Vector3) {
  return Math.atan2(a.clone().cross(b).length(), a.dot(b));
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

describe("route leg geometry (great circle, owner decision 2026-10-21)", () => {
  /** Every vertex of a leg, as unit directions. */
  function legDirections(leg: RouteArcSamples) {
    return Array.from({ length: routeArcVertexCount(leg) }, (_, vertex) => (
      sampleAt(leg, vertex).normalize()
    ));
  }

  /**
   * A sparse leg lies on the great circle through its endpoints: every sample
   * is on the plane through the origin and both Route Points, at the surface
   * radius (zero lift), and progresses monotonically from start to end.
   */
  function expectGreatCircleLeg(
    leg: RouteArcSamples,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    maxSegmentAngle: number,
  ) {
    const start = latLonToVector3(from.lat, from.lon, 1).normalize();
    const end = latLonToVector3(to.lat, to.lon, 1).normalize();
    const normal = start.clone().cross(end).normalize();
    const angle = arc(start, end);
    const directions = legDirections(leg);
    expect(directions.length).toBeGreaterThanOrEqual(2);
    expect([...leg.lifts].every((lift) => lift === 0)).toBe(true);
    expect(directions[0].distanceTo(start)).toBeLessThan(1e-6);
    expect(directions.at(-1)!.distanceTo(end)).toBeLessThan(1e-6);
    let previousProgress = -1e-6;
    directions.forEach((direction, vertex) => {
      // Float32 storage: tolerances are single-precision, not 1e-12.
      expect(Math.abs(direction.dot(normal))).toBeLessThan(1e-6);
      expect(sampleAt(leg, vertex, ROUTE_ANCHOR_RADIUS).length())
        .toBeCloseTo(ROUTE_ANCHOR_RADIUS, 5);
      // Between the endpoints, never past them and never sideways.
      expect(arc(direction, start) + arc(direction, end)).toBeCloseTo(angle, 5);
      const progress = arc(direction, start);
      expect(progress).toBeGreaterThanOrEqual(previousProgress - 1e-6);
      previousProgress = progress;
    });
    for (let vertex = 0; vertex + 1 < directions.length; vertex += 2) {
      expect(arc(directions[vertex], directions[vertex + 1]))
        .toBeLessThanOrEqual(maxSegmentAngle + 1e-6);
    }
  }

  it("returns no line for a single point", () => {
    expect(routeArcVertexCount(buildRouteArcSamples([{ lat: 0, lon: 0 }]))).toBe(0);
  });

  it("draws each sparse leg on the great circle between its Route Points, on the surface", () => {
    const points = [
      { lat: 34.0522, lon: -118.2437 },
      { lat: 35.3733, lon: -119.0187 },
      { lat: 36.7378, lon: -119.7871 },
      { lat: 36.1699, lon: -115.1398 },
      { lat: 51.5074, lon: -0.1278 },
      { lat: 35.6762, lon: 139.6503 },
    ];
    const legs = buildRouteArcLegSamples(points, Math.PI / 96, 8192);
    expect(legs).toHaveLength(points.length - 1);
    legs.forEach((leg, index) => {
      expectGreatCircleLeg(leg, points[index], points[index + 1], Math.PI / 96);
    });
  });

  it("joins legs at a corner on the Route Point instead of smoothing it", () => {
    const points = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 20 },
      { lat: 20, lon: 20 },
    ];
    const [first, second] = buildRouteArcLegSamples(points, Math.PI / 96, 8192);
    const corner = latLonToVector3(0, 20, 1).normalize();
    const tangent = (toward: Vector3) => toward.addScaledVector(corner, -corner.dot(toward)).normalize();
    const tangentIn = tangent(corner.clone().sub(legDirections(first).at(-2)!));
    const tangentOut = tangent(legDirections(second)[1].sub(corner));
    // A right-angle turn stays a right angle at the shared Route Point.
    expect(arc(tangentIn, tangentOut)).toBeCloseTo(Math.PI / 2, 1);
  });

  it("uses the short great circle across the antimeridian", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }],
      Math.PI / 180,
    );
    const mid = sampleAt(samples, 2);
    expect(mid.length()).toBeCloseTo(1);
    expect(mid.x).toBeLessThan(-0.99);
  });

  it("asks for no more segments than the angular step requires", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 29 }],
      Math.PI / 96,
      8192,
    );
    // 29 degrees at 1.875 degrees per segment: 16 segments.
    expect(routeArcVertexCount(samples)).toBe(32);
    const plans = planRouteArcLegs([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], Math.PI / 96, 8192);
    expect(plans.map((plan) => plan.segmentCount)).toEqual([1]);
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

  it("handles the 180 degree antipodal case with a stable fallback plane", () => {
    const samples = buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }],
      Math.PI / 180,
      4096,
    );
    expect(routeArcVertexCount(samples)).toBeGreaterThan(0);
    expect([...samples.directions].every(Number.isFinite)).toBe(true);
    expect([...samples.lifts].every((lift) => lift === 0)).toBe(true);
    const directions = legDirections(samples);
    for (let vertex = 0; vertex + 1 < directions.length; vertex += 2) {
      expect(arc(directions[vertex], directions[vertex + 1]))
        .toBeLessThanOrEqual(Math.PI / 180 + 1e-6);
    }
  });

  it("keeps a near-antipodal leg on the plane its endpoints define", () => {
    const from = { lat: 0, lon: 0 };
    const to = { lat: 0.5, lon: 179.5 };
    const [leg] = buildRouteArcLegSamples([from, to], Math.PI / 96, 8192);
    expectGreatCircleLeg(leg, from, to, Math.PI / 96);
  });

  it("puts a Route Point anchor on the canonical shell (#193)", () => {
    const anchor = routePointAnchor(37.8651, -119.5383);
    expect(anchor.length()).toBeCloseTo(ROUTE_ANCHOR_RADIUS, 6);
    const samples = buildRouteArcSamples(
      [{ lat: 37.8651, lon: -119.5383 }, { lat: 34.0522, lon: -118.2437 }],
      Math.PI / 96,
      4096,
    );
    expect(sampleAt(samples, 0, ROUTE_ANCHOR_RADIUS).distanceTo(anchor)).toBeLessThan(1e-6);
  });

  it("keeps every Route Point under budget pressure, or draws nothing (#242 review)", () => {
    const points = Array.from({ length: 64 }, (_, index) => ({
      lat: 0,
      lon: -90 + (index * 0.4),
    }));
    const legCount = points.length - 1;
    // One segment per stored leg is the least this route can be drawn as
    // while still passing through every Route Point it stores.
    const topologyFloor = legCount * 2;

    for (const maxVertices of [topologyFloor, topologyFloor + 40, 8192]) {
      const samples = buildRouteArcSamples(points, Math.PI / 96, maxVertices);
      const count = routeArcVertexCount(samples);
      expect(count).toBeLessThanOrEqual(maxVertices);
      expect(count).toBeGreaterThanOrEqual(topologyFloor);

      // The per-leg array maps one to one onto the route's own legs, so
      // Playback temporal reveal keeps its point-to-point mapping.
      const legs = buildRouteArcLegSamples(points, Math.PI / 96, maxVertices);
      expect(legs).toHaveLength(legCount);
      expect(legs.reduce((sum, leg) => sum + routeArcVertexCount(leg), 0))
        .toBe(count);
      legs.forEach((leg, index) => {
        expectGreatCircleLeg(leg, points[index], points[index + 1], Math.PI);
      });
    }

    // Below that floor the route is not drawn at all.
    for (const maxVertices of [topologyFloor - 2, 100, 40, 8, 4, 2]) {
      expect(routeArcVertexCount(
        buildRouteArcSamples(points, Math.PI / 96, maxVertices),
      )).toBe(0);
      expect(buildRouteArcLegSamples(points, Math.PI / 96, maxVertices))
        .toEqual([]);
    }
  });

  it("spreads a squeezed budget over every leg instead of dropping the tail (#242)", () => {
    const points = Array.from({ length: 24 }, (_, index) => ({
      lat: 0,
      lon: index * 5,
    }));
    const samples = buildRouteArcSamples(points, Math.PI / 96, 120);
    expect(routeArcVertexCount(samples)).toBeLessThanOrEqual(120);
    for (const point of points) {
      const anchor = routePointAnchor(point.lat, point.lon);
      let nearest = Number.POSITIVE_INFINITY;
      for (let vertex = 0; vertex < routeArcVertexCount(samples); vertex += 1) {
        nearest = Math.min(
          nearest,
          sampleAt(samples, vertex, ROUTE_ANCHOR_RADIUS).distanceTo(anchor),
        );
      }
      expect(nearest).toBeLessThan(1e-6);
    }
  });

  it("keeps route-wide and per-leg samples byte-identical and deterministic (#242)", () => {
    const points = [
      { lat: 34.0522, lon: -118.2437 },
      { lat: 35.3733, lon: -119.0187 },
      { lat: 36.7378, lon: -119.7871 },
      { lat: 36.1699, lon: -115.1398 },
    ];
    const first = buildRouteArcSamples(points, Math.PI / 96, 8192);
    const second = buildRouteArcSamples(points, Math.PI / 96, 8192);
    const legs = buildRouteArcLegSamples(points, Math.PI / 96, 8192);

    expect([...first.directions]).toEqual([...second.directions]);
    expect([...first.directions]).toEqual(legs.flatMap((leg) => [...leg.directions]));
    expect([...first.lifts]).toEqual(legs.flatMap((leg) => [...leg.lifts]));
  });

  it("returns no legs for a single point (#21 review)", () => {
    expect(buildRouteArcLegSamples([{ lat: 0, lon: 0 }])).toEqual([]);
  });

  it("keeps no spline or lift machinery in the route geometry", () => {
    const source = readFileSync(new URL("./geo.ts", import.meta.url), "utf8");
    expect(source).not.toContain("sampleSphericalSpline");
    expect(source).not.toContain("liftAt(");
    expect(source).not.toContain("arcHeightRatio");
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
