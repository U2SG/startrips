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
  MAX_ROUTE_ARC_LIFT_PER_CHORD,
  maxRepresentableArcLift,
  MIN_LIFTED_ROUTE_ARC_SEGMENTS,
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
  // #242 probe angles. 1.875 degrees (PI/96) is the segment angle the scene
  // asks for, so 1.86 sits just below the old one-segment threshold and 1.90
  // just above it.
  const SAMPLE_THRESHOLD_DEGREES = [1.86, 1.9, 2, 3, 5];
  const SHORT_LEG_DEGREES = [1.9, 2, 3, 5];
  /** The hump a 20 degree leg carries when its budget is not squeezed. */
  const arcHeightAt20Degrees = Math.min(
    0.22 * Math.sqrt(((20 * Math.PI) / 180) / (Math.PI / 3)),
    MAX_ROUTE_ARC_LIFT_PER_CHORD * 2 * Math.sin((20 * Math.PI) / 360),
  );

  /** One synthetic leg of the given angular length, with lift requested. */
  function shortLeg(degrees: number) {
    return buildRouteArcSamples(
      [{ lat: 0, lon: 0 }, { lat: 0, lon: degrees }],
      Math.PI / 96,
      8192,
      { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 },
    );
  }

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

  // #242 replaces the retired "keeps short legs hugging the surface (hump
  // scales nonlinearly) (#15)" assertion. That test pinned a 3 degree leg
  // above 1.02, which is exactly the sawtooth this issue reports: under the
  // sqrt policy a short leg's hump grew WITHOUT BOUND relative to its own
  // length - about 1.181 chord lengths at 1.90 degrees. The invariant below
  // replaces it rather than sitting beside it, because the two cannot both
  // hold.
  it("bounds a leg's hump against its own chord (#242)", () => {
    const heights = SHORT_LEG_DEGREES.map((degrees) => {
      const samples = shortLeg(degrees);
      const chord = 2 * Math.sin((degrees * Math.PI) / 360);
      return {
        degrees,
        // Peak lift and chord are both fractions of the anchor radius.
        ratio: Math.max(...samples.lifts) / chord,
      };
    });

    // A leg 1.90 degrees long may not stand 1.18 of its own length tall.
    const shortest = heights[0];
    expect(shortest.degrees).toBe(1.9);
    expect(shortest.ratio).toBeLessThanOrEqual(0.25);
    expect(shortest.ratio).toBeLessThanOrEqual(MAX_ROUTE_ARC_LIFT_PER_CHORD);

    // Shorter must never mean proportionally taller: the ratio is
    // non-increasing as the leg shortens, so it tends to a flat local trace
    // instead of diverging.
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index - 1].ratio).toBeLessThanOrEqual(heights[index].ratio);
    }

    // The legacy sqrt policy, recomputed here as the "before" reading the
    // issue tabulated, is what this leg used to do.
    const legacyRatio = (0.22 * Math.sqrt((1.9 * Math.PI / 180) / (Math.PI / 3)))
      / (2 * Math.sin((1.9 * Math.PI) / 360));
    expect(legacyRatio).toBeGreaterThan(1.18);
    expect(shortest.ratio).toBeLessThan(legacyRatio / 100);
  });

  it("never draws a lifted leg as a triangular peak (#242)", () => {
    const counts = SAMPLE_THRESHOLD_DEGREES.map((degrees) => ({
      degrees,
      segments: routeArcVertexCount(shortLeg(degrees)) / 2,
    }));

    // Two straight segments through one elevated midpoint IS the sawtooth.
    for (const { degrees, segments } of counts) {
      expect(
        segments,
        `a ${degrees} degree leg drew ${segments} segments`,
      ).toBeGreaterThanOrEqual(4);
      expect(segments).toBeGreaterThanOrEqual(MIN_LIFTED_ROUTE_ARC_SEGMENTS);
    }

    // The count follows the curve, so it only ever grows with the leg.
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index].segments).toBeGreaterThanOrEqual(
        counts[index - 1].segments,
      );
    }

    // The old rule jumped a 1.86 degree leg from one flat segment to a
    // two-segment peak at 1.875 degrees. Crossing that angle may no longer
    // change the drawn representation by more than a single segment.
    const [below, above] = counts;
    expect(below.degrees).toBe(1.86);
    expect(above.degrees).toBe(1.9);
    expect(Math.abs(above.segments - below.segments)).toBeLessThanOrEqual(1);
  });

  it("keeps every stored Route Point on the anchor shell (#242)", () => {
    const points = [
      { lat: 22.5431, lon: 114.0579 },
      { lat: 23.1291, lon: 113.2644 },
      { lat: 22.8167, lon: 113.2333 },
      { lat: 22.1987, lon: 113.5439 },
      { lat: 22.2793, lon: 114.1628 },
    ];
    const samples = buildRouteArcSamples(points, Math.PI / 96, 8192, {
      arcHeightRatio: 0.22,
      arcSaturationAngle: Math.PI / 3,
    });

    // Every leg endpoint resolves exactly onto the Route Point anchor at any
    // lift strength, because a leg carries lift 0 at both of its ends.
    for (const liftScale of [0, 0.25, 1]) {
      for (const point of points) {
        const anchor = routePointAnchor(point.lat, point.lon);
        let nearest = Number.POSITIVE_INFINITY;
        for (
          let vertex = 0;
          vertex < routeArcVertexCount(samples);
          vertex += 1
        ) {
          const world = sampleAt(samples, vertex, ROUTE_ANCHOR_RADIUS, liftScale);
          nearest = Math.min(nearest, world.distanceTo(anchor));
        }
        // The stored direction is present in the sampled route, unmoved.
        expect(nearest).toBeLessThan(1e-6);
      }
    }
  });

  it("spreads a squeezed budget over every leg instead of dropping the tail (#242)", () => {
    const points = Array.from({ length: 24 }, (_, index) => ({
      lat: 0,
      lon: index * 5,
    }));
    // Far less budget than the curve of 23 legs asks for.
    const samples = buildRouteArcSamples(points, Math.PI / 96, 120, {
      arcHeightRatio: 0.22,
      arcSaturationAngle: Math.PI / 3,
    });
    expect(routeArcVertexCount(samples)).toBeLessThanOrEqual(120);

    // No Route Point is silently dropped by the shortage; the route degrades
    // to a faithful surface trace rather than losing its tail.
    for (const point of points) {
      const anchor = routePointAnchor(point.lat, point.lon);
      let nearest = Number.POSITIVE_INFINITY;
      for (let vertex = 0; vertex < routeArcVertexCount(samples); vertex += 1) {
        nearest = Math.min(
          nearest,
          sampleAt(samples, vertex, ROUTE_ANCHOR_RADIUS, 1).distanceTo(anchor),
        );
      }
      expect(nearest).toBeLessThan(1e-6);
    }
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

  it("never returns more vertices than its budget allows (#242 review)", () => {
    // 63 legs but only 50 segments of budget: one segment each would be 126
    // vertices against a declared ceiling of 100.
    const points = Array.from({ length: 64 }, (_, index) => ({
      lat: 0,
      lon: -90 + (index * 0.4),
    }));
    for (const maxVertices of [100, 40, 8, 4, 2]) {
      const samples = buildRouteArcSamples(points, Math.PI / 96, maxVertices, {
        arcHeightRatio: 0.22,
        arcSaturationAngle: Math.PI / 3,
      });
      expect(routeArcVertexCount(samples)).toBeLessThanOrEqual(maxVertices);
      expect(routeArcVertexCount(samples)).toBeGreaterThan(0);
      // The route still spans its whole extent rather than being truncated:
      // both of its ends are drawn even when interior points cannot be.
      const first = routePointAnchor(points[0].lat, points[0].lon);
      const last = routePointAnchor(points.at(-1)!.lat, points.at(-1)!.lon);
      const count = routeArcVertexCount(samples);
      expect(sampleAt(samples, 0, ROUTE_ANCHOR_RADIUS, 1).distanceTo(first))
        .toBeLessThan(1e-6);
      expect(sampleAt(samples, count - 1, ROUTE_ANCHOR_RADIUS, 1).distanceTo(last))
        .toBeLessThan(1e-6);
      // The legs agree with the whole route under the same pressure.
      const legs = buildRouteArcLegSamples(points, Math.PI / 96, maxVertices, {
        arcHeightRatio: 0.22,
        arcSaturationAngle: Math.PI / 3,
      });
      expect(legs.reduce((sum, leg) => sum + routeArcVertexCount(leg), 0))
        .toBe(count);
    }
  });

  it("gives up the hump a squeezed leg cannot draw faithfully (#242 review)", () => {
    // Twenty 20 degree legs: each asks for many segments, and the budget below
    // grants roughly a tenth of them. Clearing the four-segment floor is not
    // enough - a coarse raised polygon is the very shape being removed.
    const points = Array.from({ length: 21 }, (_, index) => ({
      lat: 0,
      lon: -180 + (index * 20),
    }));
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const generous = buildRouteArcSamples(points, Math.PI / 96, 8192 * 8, arc);
    const squeezed = buildRouteArcSamples(points, Math.PI / 96, 800, arc);

    expect(routeArcVertexCount(squeezed)).toBeLessThanOrEqual(800);
    // Same legs, far fewer segments each.
    expect(routeArcVertexCount(squeezed))
      .toBeLessThan(routeArcVertexCount(generous));
    // So the decoration, not the fidelity of the path, is what gave way: the
    // hump drops by far more than the sample count did.
    expect(Math.max(...squeezed.lifts))
      .toBeLessThan(Math.max(...generous.lifts) / 4);
    expect(maxRepresentableArcLift((20 * Math.PI) / 180, 10))
      .toBeLessThan(arcHeightAt20Degrees);
    // A count below the four-segment floor carries no hump at all.
    expect(maxRepresentableArcLift((20 * Math.PI) / 180, 3)).toBe(0);
    // More segments can always carry at least as much as fewer.
    let previous = -1;
    for (const segments of [4, 8, 16, 32, 64, 128]) {
      const affordable = maxRepresentableArcLift((20 * Math.PI) / 180, segments);
      expect(affordable).toBeGreaterThanOrEqual(previous);
      previous = affordable;
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
