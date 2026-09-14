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
  MAX_ROUTE_SPLINE_DEVIATION,
  MAX_ROUTE_SPLINE_HANDLE_ANGLE,
  MAX_ROUTE_SPLINE_HANDLE_RATIO,
  maxRepresentableArcLift,
  MIN_LIFTED_ROUTE_ARC_SEGMENTS,
  planRouteArcLegs,
  rotationXForLatitude,
  rotationYForLongitude,
  ROUTE_ANCHOR_RADIUS,
  ROUTE_SPLINE_JOIN_TOLERANCE,
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

function expectRouteLegSamplingWithinTolerance(
  leg: RouteArcSamples,
  maxSegmentAngle: number,
) {
  const directions: Vector3[] = [sampleAt(leg, 0, 1, 0).normalize()];
  for (let vertex = 1; vertex < routeArcVertexCount(leg); vertex += 2) {
    directions.push(sampleAt(leg, vertex, 1, 0).normalize());
  }
  for (let index = 1; index < directions.length; index += 1) {
    expect(directions[index - 1].angleTo(directions[index]))
      .toBeLessThanOrEqual(maxSegmentAngle + 1e-6);
  }
  for (let index = 1; index < directions.length - 1; index += 1) {
    const anchor = directions[index];
    const incoming = directions[index - 1]
      .clone()
      .addScaledVector(anchor, -anchor.dot(directions[index - 1]))
      .normalize()
      .multiplyScalar(-1);
    const outgoing = directions[index + 1]
      .clone()
      .addScaledVector(anchor, -anchor.dot(directions[index + 1]))
      .normalize();
    if (incoming.lengthSq() > 0 && outgoing.lengthSq() > 0) {
      expect(incoming.angleTo(outgoing))
        .toBeLessThanOrEqual(ROUTE_SPLINE_JOIN_TOLERANCE + 1e-6);
    }
  }
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

  it("keeps every Route Point under budget pressure, or draws nothing (#242 review)", () => {
    const points = Array.from({ length: 64 }, (_, index) => ({
      lat: 0,
      lon: -90 + (index * 0.4),
    }));
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const legCount = points.length - 1;
    // One straight segment per stored leg is the least this route can be drawn
    // as while still passing through every Route Point it stores.
    const topologyFloor = legCount * 2;

    // At the floor and just above it, the topology is complete: no Route Point
    // is omitted and no stroke shortcuts across one.
    for (const maxVertices of [topologyFloor, topologyFloor + 40, 8192]) {
      const samples = buildRouteArcSamples(points, Math.PI / 96, maxVertices, arc);
      const count = routeArcVertexCount(samples);
      expect(count).toBeLessThanOrEqual(maxVertices);
      expect(count).toBeGreaterThanOrEqual(topologyFloor);

      // Every stored Route Point is a vertex of the drawn route, in order.
      for (const point of points) {
        const anchor = routePointAnchor(point.lat, point.lon);
        let nearest = Number.POSITIVE_INFINITY;
        for (let vertex = 0; vertex < count; vertex += 1) {
          nearest = Math.min(
            nearest,
            sampleAt(samples, vertex, ROUTE_ANCHOR_RADIUS, 1).distanceTo(anchor),
          );
        }
        expect(nearest).toBeLessThan(1e-6);
      }

      // The per-leg array still maps one to one onto the route's own legs, so
      // Playback temporal reveal keeps its point-to-point mapping.
      const legs = buildRouteArcLegSamples(points, Math.PI / 96, maxVertices, arc);
      expect(legs).toHaveLength(legCount);
      expect(legs.reduce((sum, leg) => sum + routeArcVertexCount(leg), 0))
        .toBe(count);
      // Each leg still starts on its own Route Point and ends on the next.
      legs.forEach((leg, index) => {
        const legVertices = routeArcVertexCount(leg);
        expect(legVertices).toBeGreaterThanOrEqual(2);
        expect(sampleAt(leg, 0, ROUTE_ANCHOR_RADIUS, 1).distanceTo(
          routePointAnchor(points[index].lat, points[index].lon),
        )).toBeLessThan(1e-6);
        expect(sampleAt(leg, legVertices - 1, ROUTE_ANCHOR_RADIUS, 1).distanceTo(
          routePointAnchor(points[index + 1].lat, points[index + 1].lon),
        )).toBeLessThan(1e-6);
      });
    }

    // Below that floor the route is not drawn at all. A stroke that shortcut
    // across omitted Route Points would be a lie about the Journey rather than
    // a lower-quality picture of it, so this degrades at the route level.
    for (const maxVertices of [topologyFloor - 2, 100, 40, 8, 4, 2]) {
      expect(routeArcVertexCount(
        buildRouteArcSamples(points, Math.PI / 96, maxVertices, arc),
      )).toBe(0);
      expect(buildRouteArcLegSamples(points, Math.PI / 96, maxVertices, arc))
        .toEqual([]);
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

  it("derives one length-weighted tangent in each interior Route Point tangent plane (#352)", () => {
    const points = [
      { lat: 32.7157, lon: -117.1611 },
      { lat: 34.0522, lon: -118.2437 },
      { lat: 36.1699, lon: -115.1398 },
    ];
    const plans = planRouteArcLegs(points, Math.PI / 180, 8192, {});
    expect(plans).toHaveLength(2);

    const previous = latLonToVector3(points[0].lat, points[0].lon, 1).normalize();
    const anchor = latLonToVector3(points[1].lat, points[1].lon, 1).normalize();
    const next = latLonToVector3(points[2].lat, points[2].lon, 1).normalize();
    const towardPrevious = previous.clone().addScaledVector(anchor, -anchor.dot(previous)).normalize();
    const incoming = towardPrevious.multiplyScalar(-1);
    const outgoing = next.clone().addScaledVector(anchor, -anchor.dot(next)).normalize();
    const previousAngle = Math.acos(Math.min(1, Math.max(-1, previous.dot(anchor))));
    const nextAngle = Math.acos(Math.min(1, Math.max(-1, anchor.dot(next))));
    const expected = incoming
      .clone()
      .multiplyScalar(previousAngle)
      .addScaledVector(outgoing, nextAngle)
      .normalize();

    expect(plans[0].endTangent.distanceTo(plans[1].startTangent)).toBeLessThan(1e-12);
    expect(Math.abs(anchor.dot(plans[0].endTangent))).toBeLessThan(1e-12);
    expect(plans[0].endTangent.angleTo(expected)).toBeLessThan(1e-8);
    expect(plans[0].endHandleAngle).toBeLessThanOrEqual(
      Math.min(MAX_ROUTE_SPLINE_HANDLE_ANGLE, plans[0].angle * MAX_ROUTE_SPLINE_HANDLE_RATIO),
    );
    expect(plans[1].startHandleAngle).toBeLessThanOrEqual(
      Math.min(MAX_ROUTE_SPLINE_HANDLE_ANGLE, plans[1].angle * MAX_ROUTE_SPLINE_HANDLE_RATIO),
    );
  });

  it("removes the independent-leg hard kink in the southwest-US regression fixture (#352)", () => {
    const points = [
      { lat: 32.7157, lon: -117.1611 }, // San Diego
      { lat: 33.8303, lon: -116.5453 }, // Palm Springs
      { lat: 36.1699, lon: -115.1398 }, // Las Vegas
      { lat: 36.1069, lon: -112.1129 }, // Grand Canyon
    ];
    const legs = buildRouteArcLegSamples(points, Math.PI / 360, 8192, {
      arcHeightRatio: 0.22,
      arcSaturationAngle: Math.PI / 3,
    });

    const travelTangent = (from: Vector3, at: Vector3, forward: boolean) => {
      const delta = forward ? from.clone().sub(at) : at.clone().sub(from);
      return delta.addScaledVector(at, -at.dot(delta)).normalize();
    };
    const oldIndependentJoinAngle = (index: number) => {
      const previous = latLonToVector3(points[index - 1].lat, points[index - 1].lon, 1).normalize();
      const anchor = latLonToVector3(points[index].lat, points[index].lon, 1).normalize();
      const next = latLonToVector3(points[index + 1].lat, points[index + 1].lon, 1).normalize();
      const incoming = previous.clone().addScaledVector(anchor, -anchor.dot(previous)).normalize().multiplyScalar(-1);
      const outgoing = next.clone().addScaledVector(anchor, -anchor.dot(next)).normalize();
      return incoming.angleTo(outgoing);
    };
    const sampledJoinAngle = (index: number) => {
      const incomingLeg = legs[index - 1];
      const outgoingLeg = legs[index];
      const anchor = sampleAt(incomingLeg, routeArcVertexCount(incomingLeg) - 1, 1, 0).normalize();
      const previous = sampleAt(incomingLeg, routeArcVertexCount(incomingLeg) - 2, 1, 0).normalize();
      const next = sampleAt(outgoingLeg, 1, 1, 0).normalize();
      const incoming = travelTangent(previous, anchor, false);
      const outgoing = travelTangent(next, anchor, true);
      return incoming.angleTo(outgoing);
    };

    // The old per-leg great-circle construction has a visibly hard change of
    // direction at at least one interior anchor in this sparse route.
    expect(Math.max(oldIndependentJoinAngle(1), oldIndependentJoinAngle(2)))
      .toBeGreaterThan(0.2);
    // The new route-wide tangent is shared on both sides. With half-degree
    // sampling, the finite-difference reading stays within three degrees.
    expect(sampledJoinAngle(1)).toBeLessThan(Math.PI / 60);
    expect(sampledJoinAngle(2)).toBeLessThan(Math.PI / 60);
  });

  it("caps spherical spline deviation and collapses near-U-turn handles instead of looping (#352)", () => {
    const points = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 40 },
      { lat: 0.5, lon: 1 },
    ];
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const plans = planRouteArcLegs(points, Math.PI / 180, 8192, arc);
    const legs = buildRouteArcLegSamples(points, Math.PI / 180, 8192, arc);

    expect(plans[0].endHandleAngle).toBeLessThan(0.02);
    expect(plans[1].startHandleAngle).toBeLessThan(0.02);

    plans.forEach((plan, index) => {
      const leg = legs[index];
      const normal = plan.start.clone().cross(plan.end);
      if (normal.lengthSq() > 1e-18) normal.normalize();
      let previousAlong = -1;
      for (let vertex = 0; vertex < routeArcVertexCount(leg); vertex += 1) {
        const direction = sampleAt(leg, vertex, 1, 0).normalize();
        if (normal.lengthSq() > 0) {
          const crossTrack = Math.asin(Math.min(1, Math.abs(direction.dot(normal))));
          expect(crossTrack).toBeLessThanOrEqual(MAX_ROUTE_SPLINE_DEVIATION + 1e-6);
        }
        const along = plan.start.angleTo(direction);
        expect(along).toBeLessThanOrEqual(plan.angle + 1e-5);
        expect(along + 1e-5).toBeGreaterThanOrEqual(previousAlong);
        previousAlong = along;
      }
      expect(Math.max(...leg.lifts)).toBeLessThanOrEqual(
        maxRepresentableArcLift(plan.angle, plan.segmentCount) + 1e-7,
      );
    });
  });

  it("keeps asymmetric near-reversal spline progress inside each leg without backward hooks (#352 review)", () => {
    const points = [
      { lat: -75.534343, lon: 30.884792 },
      { lat: -74.438199, lon: -129.350272 },
      { lat: 68.163208, lon: 30.198264 },
    ];
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const plans = planRouteArcLegs(points, Math.PI / 96, 8192, arc);
    const legs = buildRouteArcLegSamples(points, Math.PI / 96, 8192, arc);

    expect(legs).toHaveLength(2);
    plans.forEach((plan, index) => {
      let previousProgress = -1e-8;
      for (let vertex = 0; vertex < routeArcVertexCount(legs[index]); vertex += 1) {
        const direction = sampleAt(legs[index], vertex, 1, 0).normalize();
        const progress = plan.start.angleTo(direction);
        expect(progress).toBeLessThanOrEqual(plan.angle + 1e-6);
        expect(progress + 1e-6).toBeGreaterThanOrEqual(previousProgress);
        previousProgress = progress;
      }
    });
  });

  it("allocates enough interior samples for long near-antipodal spline curvature (#352 review)", () => {
    const points = [
      { lat: -62.542382, lon: 175.620270 },
      { lat: -86.715906, lon: 132.043252 },
      { lat: 84.425311, lon: -90.503350 },
    ];
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const maxSegmentAngle = Math.PI / 96;
    const legs = buildRouteArcLegSamples(points, maxSegmentAngle, 8192, arc);

    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      const directions: Vector3[] = [sampleAt(leg, 0, 1, 0).normalize()];
      for (let vertex = 1; vertex < routeArcVertexCount(leg); vertex += 2) {
        directions.push(sampleAt(leg, vertex, 1, 0).normalize());
      }
      for (let index = 1; index < directions.length; index += 1) {
        expect(directions[index - 1].angleTo(directions[index]))
          .toBeLessThanOrEqual(maxSegmentAngle + 1e-6);
      }
      for (let index = 1; index < directions.length - 1; index += 1) {
        const anchor = directions[index];
        const incoming = directions[index - 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index - 1]))
          .normalize()
          .multiplyScalar(-1);
        const outgoing = directions[index + 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index + 1]))
          .normalize();
        if (incoming.lengthSq() > 0 && outgoing.lengthSq() > 0) {
          expect(incoming.angleTo(outgoing))
            .toBeLessThanOrEqual(ROUTE_SPLINE_JOIN_TOLERANCE + 1e-6);
        }
      }
    }
  });

  it("rebalances post-budget spline density without violating the hard route budget (#352 review)", () => {
    const motif = [
      { lat: -49.800555, lon: -130.299050 },
      { lat: -86.335613, lon: -158.363781 },
      { lat: -72.167089, lon: 163.880242 },
    ];
    const points = Array.from({ length: 20 }, () => motif).flat();
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const maxSegmentAngle = Math.PI / 96;
    const plans = planRouteArcLegs(points, maxSegmentAngle, 8192, arc);
    const legs = buildRouteArcLegSamples(points, maxSegmentAngle, 8192, arc);

    expect(points).toHaveLength(60);
    expect(plans).toHaveLength(59);
    expect(legs).toHaveLength(59);
    expect(plans.reduce((sum, plan) => sum + plan.segmentCount, 0))
      .toBeLessThanOrEqual(4096);

    const fifteenDegreeLegs = plans.filter((plan) => (
      Math.abs((plan.angle * 180) / Math.PI - 15.0979446616) < 1e-6
    ));
    expect(fifteenDegreeLegs.length).toBeGreaterThan(0);
    expect(Math.min(...fifteenDegreeLegs.map((plan) => plan.segmentCount)))
      .toBeGreaterThanOrEqual(52);

    for (const leg of legs) {
      const directions: Vector3[] = [sampleAt(leg, 0, 1, 0).normalize()];
      for (let vertex = 1; vertex < routeArcVertexCount(leg); vertex += 2) {
        directions.push(sampleAt(leg, vertex, 1, 0).normalize());
      }
      for (let index = 1; index < directions.length; index += 1) {
        expect(directions[index - 1].angleTo(directions[index]))
          .toBeLessThanOrEqual(maxSegmentAngle + 1e-6);
      }
      for (let index = 1; index < directions.length - 1; index += 1) {
        const anchor = directions[index];
        const incoming = directions[index - 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index - 1]))
          .normalize()
          .multiplyScalar(-1);
        const outgoing = directions[index + 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index + 1]))
          .normalize();
        if (incoming.lengthSq() > 0 && outgoing.lengthSq() > 0) {
          expect(incoming.angleTo(outgoing))
            .toBeLessThanOrEqual(ROUTE_SPLINE_JOIN_TOLERANCE + 1e-6);
        }
      }
    }
  });

  it("does not treat an endpoint-only spline sample as a compliant budget floor (#352 review)", () => {
    const motif = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 30, lon: 50 },
      { lat: -20, lon: 100 },
      { lat: 25, lon: 145 },
      { lat: -35, lon: -170 },
      { lat: 10, lon: -100 },
    ];
    const points = Array.from({ length: 9 }, () => motif).flat().slice(0, 60);
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const maxSegmentAngle = Math.PI / 96;
    const plans = planRouteArcLegs(points, maxSegmentAngle, 8192, arc);
    const legs = buildRouteArcLegSamples(points, maxSegmentAngle, 8192, arc);

    expect(points).toHaveLength(60);
    expect(plans).toHaveLength(59);
    expect(legs).toHaveLength(59);
    expect(plans.reduce((sum, plan) => sum + plan.segmentCount, 0))
      .toBeLessThanOrEqual(4096);
    expect((plans[0].angle * 180) / Math.PI).toBeCloseTo(1, 6);
    expect(plans[0].segmentCount).toBeGreaterThan(76);

    for (const leg of legs) {
      const directions: Vector3[] = [sampleAt(leg, 0, 1, 0).normalize()];
      for (let vertex = 1; vertex < routeArcVertexCount(leg); vertex += 2) {
        directions.push(sampleAt(leg, vertex, 1, 0).normalize());
      }
      for (let index = 1; index < directions.length; index += 1) {
        expect(directions[index - 1].angleTo(directions[index]))
          .toBeLessThanOrEqual(maxSegmentAngle + 1e-6);
      }
      for (let index = 1; index < directions.length - 1; index += 1) {
        const anchor = directions[index];
        const incoming = directions[index - 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index - 1]))
          .normalize()
          .multiplyScalar(-1);
        const outgoing = directions[index + 1]
          .clone()
          .addScaledVector(anchor, -anchor.dot(directions[index + 1]))
          .normalize();
        if (incoming.lengthSq() > 0 && outgoing.lengthSq() > 0) {
          expect(incoming.angleTo(outgoing))
            .toBeLessThanOrEqual(ROUTE_SPLINE_JOIN_TOLERANCE + 1e-6);
        }
      }
    }
  });

  it("keeps density rebalancing active when a dense route contains a duplicate Route Point (#352 review)", () => {
    const motif = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 30, lon: 50 },
      { lat: -20, lon: 100 },
      { lat: 25, lon: 145 },
      { lat: -35, lon: -170 },
      { lat: 10, lon: -100 },
    ];
    const points = Array.from({ length: 9 }, () => motif).flat().slice(0, 60);
    points[points.length - 1] = { ...points[points.length - 2] };
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const maxSegmentAngle = Math.PI / 96;
    const plans = planRouteArcLegs(points, maxSegmentAngle, 8192, arc);
    const legs = buildRouteArcLegSamples(points, maxSegmentAngle, 8192, arc);

    expect(plans).toHaveLength(59);
    expect(legs).toHaveLength(59);
    expect(plans[plans.length - 1].angle).toBeLessThanOrEqual(1e-12);
    expect(plans[plans.length - 1].segmentCount).toBe(1);
    expect(plans[0].segmentCount).toBeGreaterThan(78);
    expect(plans.reduce((sum, plan) => sum + plan.segmentCount, 0))
      .toBeLessThanOrEqual(4096);
    for (const leg of legs) expectRouteLegSamplingWithinTolerance(leg, maxSegmentAngle);
  });

  it("does not infer compliance from an aliased two-segment spline probe (#352 review)", () => {
    const motif = [
      { lat: 72.825361, lon: 176.895686 },
      { lat: 70.572676, lon: -178.701490 },
      { lat: -76.187329, lon: -11.914533 },
    ];
    const points = Array.from({ length: 20 }, () => motif).flat();
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const maxSegmentAngle = Math.PI / 96;
    const plans = planRouteArcLegs(points, maxSegmentAngle, 8192, arc);
    const legs = buildRouteArcLegSamples(points, maxSegmentAngle, 8192, arc);

    expect(points).toHaveLength(60);
    expect(plans).toHaveLength(59);
    expect(legs).toHaveLength(59);
    expect(plans[0].segmentCount).toBe(5);
    expect(plans.reduce((sum, plan) => sum + plan.segmentCount, 0))
      .toBeLessThanOrEqual(4096);
    for (const leg of legs) expectRouteLegSamplingWithinTolerance(leg, maxSegmentAngle);
  });

  it("keeps route-wide and per-leg spline samples byte-identical and deterministic (#352)", () => {
    const points = [
      { lat: 34.0522, lon: -118.2437 },
      { lat: 35.3733, lon: -119.0187 },
      { lat: 36.7378, lon: -119.7871 },
      { lat: 36.1699, lon: -115.1398 },
    ];
    const arc = { arcHeightRatio: 0.22, arcSaturationAngle: Math.PI / 3 };
    const first = buildRouteArcSamples(points, Math.PI / 96, 8192, arc);
    const second = buildRouteArcSamples(points, Math.PI / 96, 8192, arc);
    const legs = buildRouteArcLegSamples(points, Math.PI / 96, 8192, arc);
    const legDirections = legs.flatMap((leg) => [...leg.directions]);
    const legLifts = legs.flatMap((leg) => [...leg.lifts]);

    expect([...first.directions]).toEqual([...second.directions]);
    expect([...first.lifts]).toEqual([...second.lifts]);
    expect([...first.directions]).toEqual(legDirections);
    expect([...first.lifts]).toEqual(legLifts);

    legs.forEach((leg, index) => {
      const start = latLonToVector3(points[index].lat, points[index].lon, 1).normalize();
      const end = latLonToVector3(points[index + 1].lat, points[index + 1].lon, 1).normalize();
      expect(sampleAt(leg, 0, 1, 0).normalize().distanceTo(start)).toBeLessThan(1e-6);
      expect(sampleAt(leg, routeArcVertexCount(leg) - 1, 1, 0).normalize().distanceTo(end))
        .toBeLessThan(1e-6);
    });
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
