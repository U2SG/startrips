import { Vector3 } from "three";

interface LocatedRecord {
  point: { lat: number; lon: number };
}

interface GeographicPoint {
  lat: number;
  lon: number;
}

function snap(value: number) {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

export function latLonToVector3(lat: number, lon: number, radius: number) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;

  return new Vector3(
    snap(-radius * Math.sin(phi) * Math.cos(theta)),
    snap(radius * Math.cos(phi)),
    snap(radius * Math.sin(phi) * Math.sin(theta)),
  );
}

export function vector3ToLatLon(point: Vector3): GeographicPoint {
  const normalized = point.clone().normalize();
  const lat = Math.asin(Math.min(1, Math.max(-1, normalized.y))) * 180 / Math.PI;
  const horizontalLength = Math.hypot(normalized.x, normalized.z);
  if (horizontalLength < 1e-12) return { lat, lon: 0 };

  const theta = Math.atan2(normalized.z, -normalized.x);
  const rawLongitude = theta * 180 / Math.PI - 180;
  const lon = ((rawLongitude + 180) % 360 + 360) % 360 - 180;
  return { lat: snap(lat), lon: snap(lon) };
}

function slerpUnitVectors(start: Vector3, end: Vector3, progress: number) {
  const dot = Math.min(1, Math.max(-1, start.dot(end)));
  if (dot > 0.999999) {
    return start.clone().lerp(end, progress).normalize();
  }
  if (dot < -0.999999) {
    const reference = Math.abs(start.y) < 0.9
      ? new Vector3(0, 1, 0)
      : new Vector3(1, 0, 0);
    const orthogonal = reference.cross(start).normalize();
    return start
      .clone()
      .multiplyScalar(Math.cos(Math.PI * progress))
      .addScaledVector(orthogonal, Math.sin(Math.PI * progress));
  }

  const angle = Math.acos(dot);
  const denominator = Math.sin(angle);
  return start
    .clone()
    .multiplyScalar(Math.sin((1 - progress) * angle) / denominator)
    .addScaledVector(end, Math.sin(progress * angle) / denominator)
    .normalize();
}

/** #352: each spherical spline handle is a bounded fraction of its leg. */
export const MAX_ROUTE_SPLINE_HANDLE_RATIO = 0.5;

/** #352: no spline handle may rotate farther than fifteen degrees from its anchor. */
export const MAX_ROUTE_SPLINE_HANDLE_ANGLE = Math.PI / 12;

/** #352: presentation smoothing never strays more than two degrees from the leg geodesic. */
export const MAX_ROUTE_SPLINE_DEVIATION = Math.PI / 90;

/** #352: sample densely enough that a polyline join follows the shared tangent within ~1 degree. */
export const ROUTE_SPLINE_JOIN_TOLERANCE = Math.PI / 180;

function angularDistance(start: Vector3, end: Vector3) {
  return Math.acos(Math.min(1, Math.max(-1, start.dot(end))));
}

/** Unit direction from an anchor toward a neighbour, projected into its tangent plane. */
function tangentToward(anchor: Vector3, neighbour: Vector3) {
  const tangent = neighbour.clone().addScaledVector(anchor, -anchor.dot(neighbour));
  if (tangent.lengthSq() < 1e-18) return new Vector3();
  return tangent.normalize();
}

type RouteSplineAnchor = {
  direction: Vector3;
  tangent: Vector3;
  turnScale: number;
};

/**
 * #352: derive one forward-travel tangent per Route Point. Interior tangents
 * live in the anchor's tangent plane and weight each neighbouring direction by
 * that leg's angular length, so a tiny side leg cannot throw a long leg
 * sideways. Near a U-turn the handle scale tends to zero instead of drawing a
 * decorative loop.
 */
function buildRouteSplineAnchors(directions: readonly Vector3[]) {
  return directions.map((direction, index): RouteSplineAnchor => {
    if (directions.length < 2) {
      return { direction, tangent: new Vector3(), turnScale: 0 };
    }
    if (index === 0) {
      return {
        direction,
        tangent: tangentToward(direction, directions[1]),
        turnScale: 1,
      };
    }
    if (index === directions.length - 1) {
      return {
        direction,
        tangent: tangentToward(direction, directions[index - 1]).multiplyScalar(-1),
        turnScale: 1,
      };
    }

    const previous = directions[index - 1];
    const next = directions[index + 1];
    const incoming = tangentToward(direction, previous).multiplyScalar(-1);
    const outgoing = tangentToward(direction, next);
    const previousAngle = angularDistance(previous, direction);
    const nextAngle = angularDistance(direction, next);
    const turnDot = Math.min(1, Math.max(-1, incoming.dot(outgoing)));
    const turnScale = Math.sqrt(Math.max(0, (1 + turnDot) / 2));
    const tangent = incoming
      .clone()
      .multiplyScalar(previousAngle)
      .addScaledVector(outgoing, nextAngle);

    if (tangent.lengthSq() < 1e-18) {
      tangent.copy(outgoing.lengthSq() > 0 ? outgoing : incoming);
    }
    if (tangent.lengthSq() > 0) tangent.normalize();
    return { direction, tangent, turnScale };
  });
}

function splineHandleAngle(legAngle: number, turnScale: number) {
  return Math.min(
    MAX_ROUTE_SPLINE_HANDLE_ANGLE,
    legAngle * MAX_ROUTE_SPLINE_HANDLE_RATIO,
  ) * turnScale;
}

function routeSplineSegmentCount(
  start: Vector3,
  end: Vector3,
  startTangent: Vector3,
  endTangent: Vector3,
  startHandleAngle: number,
  endHandleAngle: number,
  legAngle: number,
) {
  const geodesicStart = tangentToward(start, end);
  const geodesicEnd = tangentToward(end, start).multiplyScalar(-1);
  const fullHandle = Math.min(
    MAX_ROUTE_SPLINE_HANDLE_ANGLE,
    legAngle * MAX_ROUTE_SPLINE_HANDLE_RATIO,
  );
  const startScale = fullHandle > 0 ? startHandleAngle / fullHandle : 0;
  const endScale = fullHandle > 0 ? endHandleAngle / fullHandle : 0;
  const startDeflection = geodesicStart.lengthSq() > 0 && startTangent.lengthSq() > 0
    ? geodesicStart.angleTo(startTangent) * startScale
    : 0;
  const endDeflection = geodesicEnd.lengthSq() > 0 && endTangent.lengthSq() > 0
    ? geodesicEnd.angleTo(endTangent) * endScale
    : 0;
  const count = Math.ceil(
    Math.max(startDeflection, endDeflection) / ROUTE_SPLINE_JOIN_TOLERANCE,
  );
  if (count <= 1) return 1;
  return count % 2 === 0 ? count : count + 1;
}

function routeLegSplineFrame(start: Vector3, end: Vector3) {
  const normal = start.clone().cross(end);
  if (normal.lengthSq() >= 1e-18) {
    normal.normalize();
    return {
      normal,
      startTravel: normal.clone().cross(start).normalize(),
      endTravel: normal.clone().cross(end).normalize(),
    };
  }

  const reference = Math.abs(start.y) < 0.9
    ? new Vector3(0, 1, 0)
    : new Vector3(1, 0, 0);
  const startTravel = reference.cross(start).normalize();
  return {
    normal: start.clone().cross(startTravel).normalize(),
    startTravel,
    endTravel: startTravel.clone().multiplyScalar(-1),
  };
}

function splineDesiredCrossTrackSlope(
  tangent: Vector3,
  travel: Vector3,
  normal: Vector3,
  handleAngle: number,
  legAngle: number,
) {
  if (!(handleAngle > 0) || tangent.lengthSq() < 1e-18) return 0;
  const along = tangent.dot(travel);
  if (!(along > 1e-9)) return 0;
  return legAngle * tangent.dot(normal) / along;
}

type RouteSplineCrossTrackSlopes = {
  start: number;
  end: number;
  startPreservesTangent: boolean;
  endPreservesTangent: boolean;
};

function boundedSplineCrossTrackSlopes(
  startTangent: Vector3,
  endTangent: Vector3,
  frame: ReturnType<typeof routeLegSplineFrame>,
  startHandleAngle: number,
  endHandleAngle: number,
  legAngle: number,
): RouteSplineCrossTrackSlopes {
  const desiredStart = splineDesiredCrossTrackSlope(
    startTangent,
    frame.startTravel,
    frame.normal,
    startHandleAngle,
    legAngle,
  );
  const desiredEnd = splineDesiredCrossTrackSlope(
    endTangent,
    frame.endTravel,
    frame.normal,
    endHandleAngle,
    legAngle,
  );
  let start = Math.max(
    -3 * startHandleAngle,
    Math.min(3 * startHandleAngle, desiredStart),
  );
  let end = Math.max(
    -3 * endHandleAngle,
    Math.min(3 * endHandleAngle, desiredEnd),
  );

  // Both Hermite basis functions peak at 4/27 in magnitude. Scale endpoint
  // slopes together so the entire span stays inside the existing 2° truth
  // boundary without a per-sample hard clamp that could introduce a kink.
  const conservativeDeviation = (4 / 27) * (Math.abs(start) + Math.abs(end));
  if (conservativeDeviation > MAX_ROUTE_SPLINE_DEVIATION) {
    const scale = MAX_ROUTE_SPLINE_DEVIATION / conservativeDeviation;
    start *= scale;
    end *= scale;
  }

  return {
    start,
    end,
    startPreservesTangent: Math.abs(start - desiredStart) <= 1e-12,
    endPreservesTangent: Math.abs(end - desiredEnd) <= 1e-12,
  };
}

/**
 * #352: a spherical cubic Hermite span expressed as a bounded cross-track
 * offset from the leg geodesic. This avoids the near-antipodal normalization
 * singularity of a Euclidean cubic while retaining the shared endpoint tangent
 * direction wherever that direction advances along the leg. A reversal that
 * would point backward collapses that endpoint handle to a stop instead of
 * overshooting the Route Point.
 */
function sampleSphericalSpline(
  start: Vector3,
  end: Vector3,
  startTangent: Vector3,
  endTangent: Vector3,
  startHandleAngle: number,
  endHandleAngle: number,
  progress: number,
) {
  if (progress <= 0) return start.clone();
  if (progress >= 1) return end.clone();

  const legAngle = angularDistance(start, end);
  if (!(legAngle > 1e-12)) return start.clone();
  const frame = routeLegSplineFrame(start, end);
  const slopes = boundedSplineCrossTrackSlopes(
    startTangent,
    endTangent,
    frame,
    startHandleAngle,
    endHandleAngle,
    legAngle,
  );

  const t2 = progress * progress;
  const t3 = t2 * progress;
  const crossTrackAngle = (t3 - 2 * t2 + progress) * slopes.start
    + (t3 - t2) * slopes.end;
  const geodesic = slerpUnitVectors(start, end, progress);
  return geodesic
    .multiplyScalar(Math.cos(crossTrackAngle))
    .addScaledVector(frame.normal, Math.sin(crossTrackAngle))
    .normalize();
}

/**
 * #15 route arc options. A route is a great circle with an altitude hump:
 * long legs lift off the surface with a natural spatial curve, short legs
 * hug the globe like a glowing thread.
 */
export type RouteArcOptions = {
  /**
   * Max arc height as a fraction of the globe radius (0..~0.6). 0 disables
   * the hump entirely and keeps the old flat spherical arc.
   */
  arcHeightRatio?: number;
  /**
   * Angular distance (radians) at which the cinematic hump saturates. #242:
   * the resulting height is then bounded against the leg's own chord, so a
   * local hop hugs geography instead of standing taller than it is long.
   */
  arcSaturationAngle?: number;
};

/**
 * The canonical geographic surface radius used whenever a latitude/longitude
 * is projected for product semantics. Visual glow/lift may render slightly
 * above this surface, but labels, route endpoints and focus geometry must not
 * invent a different geographic shell.
 */
export const GEOGRAPHIC_SURFACE_RADIUS = 1.39;

/**
 * #193/#196: Route Point semantics live on the geographic surface. Route line
 * endpoints, SVG markers and labels all derive from this same anchor so they
 * stay attached both to one another and to the map while zooming/dragging.
 */
export const ROUTE_ANCHOR_RADIUS = GEOGRAPHIC_SURFACE_RADIUS;

/**
 * #193: the canonical anchor of a Route Point. Anything that has to agree with
 * route geometry on screen - markers, labels, visibility, picking - must derive
 * its position from this helper instead of choosing a radius of its own.
 */
export function routePointAnchor(
  lat: number,
  lon: number,
  radius = ROUTE_ANCHOR_RADIUS,
) {
  return latLonToVector3(lat, lon, radius);
}

/**
 * #193: route geometry is stored as unit directions plus a decorative lift per
 * vertex instead of baked world positions. The lift is a fraction of the anchor
 * radius, so a frame can pick its own lift strength - see resolveRouteArcLift -
 * without rebuilding the route, and both ends of every leg carry lift 0 and
 * therefore land exactly on the Route Point anchor.
 */
export type RouteArcSamples = {
  /** Unit direction per vertex; two vertices (6 floats) per drawn segment. */
  directions: Float32Array;
  /** Decorative lift per vertex as a fraction of the anchor radius. */
  lifts: Float32Array;
};

const EMPTY_ROUTE_ARC_SAMPLES: RouteArcSamples = {
  directions: new Float32Array(),
  lifts: new Float32Array(),
};

/**
 * #242: decorative lift is bounded relative to the leg it decorates.
 *
 * The sqrt policy alone made peak lift divided by endpoint chord length grow
 * without bound as legs shortened - about 1.18 chord lengths at 1.9 degrees -
 * so a chain of local stops rendered as a row of steep takeoffs. The cap below
 * is the highest a hump may stand relative to its own chord, and the ramp
 * takes that fraction smoothly to zero as a leg becomes local, which is what
 * "short hops stay flat" always meant but never enforced.
 */
export const MAX_ROUTE_ARC_LIFT_PER_CHORD = 0.25;

/** Below this leg angle the chord-relative bound ramps toward a flat trace. */
export const ROUTE_ARC_SHORT_LEG_ANGLE = Math.PI / 9;

/**
 * #242: how far the drawn polyline may depart from the lifted curve it stands
 * for, as a fraction of the anchor radius. It is the quality policy the sample
 * count is solved for, rather than a vertex count chosen by hand.
 */
export const ROUTE_ARC_CHORD_TOLERANCE = 5e-5;

/**
 * A lifted leg is never drawn as one or two straight segments. Two segments
 * through one elevated midpoint IS the reported sawtooth: the midpoint is a
 * literal triangular peak, and crossing the old one-segment threshold made a
 * flat leg jump straight to it.
 */
export const MIN_LIFTED_ROUTE_ARC_SEGMENTS = 4;

/**
 * Bound on the second derivative of the sin^1.6 hump in the leg parameter,
 * around its peak: |d2/dt2 of h*sin(pi*t)^1.6| is 1.6*pi^2*h there, and the
 * margin covers the sharper shoulders of the profile.
 */
const ROUTE_ARC_LIFT_CURVATURE = 20;

const ROUTE_ARC_EXPONENT = 1.6;

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function arcHeightRatioFor(angle: number, options: RouteArcOptions) {
  const ratio = options.arcHeightRatio ?? 0;
  if (ratio <= 0 || angle <= 0) return 0;
  const saturation = options.arcSaturationAngle ?? Math.PI / 3;
  const cinematic = ratio * Math.min(1, Math.sqrt(angle / saturation));
  // The chord between the two Route Points, in the same units as the lift.
  const chord = 2 * Math.sin(angle / 2);
  const localBound = MAX_ROUTE_ARC_LIFT_PER_CHORD
    * chord
    * smoothstep(0, ROUTE_ARC_SHORT_LEG_ANGLE, angle);
  return Math.min(cinematic, localBound);
}

/**
 * #242: how many straight segments the lifted curve of one leg needs.
 *
 * The old rule counted angular distance alone, so it could not see the
 * curvature the radial lift itself introduces. Here the leg is a curve in its
 * own plane whose parameter-space acceleration has an angular term and a lift
 * term; the chord error of an n-segment polyline through a curve of
 * acceleration a is at most a / (8 n^2), which inverts to the count below.
 *
 * The count is even so the peak at t = 0.5 is always sampled - an odd count
 * reads the hump about 8 percent low and makes the sampled peak depend on
 * parity rather than on policy.
 */
export function routeArcSegmentCount(
  angle: number,
  heightRatio: number,
  maxSegmentAngle: number,
  liftRequested: boolean,
) {
  if (!(angle > 0)) return 1;
  const angular = Math.ceil(angle / maxSegmentAngle);
  const acceleration = angle * angle * (1 + heightRatio)
    + ROUTE_ARC_LIFT_CURVATURE * heightRatio;
  const curvature = Math.ceil(
    Math.sqrt(acceleration / (8 * ROUTE_ARC_CHORD_TOLERANCE)),
  );
  let count = Math.max(1, angular, curvature);
  if (liftRequested) count = Math.max(count, MIN_LIFTED_ROUTE_ARC_SEGMENTS);
  return count % 2 === 0 ? count : count + 1;
}

/**
 * #242 review: the inverse of routeArcSegmentCount - the tallest hump a leg
 * drawn with `segmentCount` straight segments can carry and still meet
 * ROUTE_ARC_CHORD_TOLERANCE.
 *
 * Under budget pressure a leg can be granted far fewer segments than its hump
 * asked for. Keeping the full height at that density draws the coarse raised
 * polygon this change exists to remove, so the decoration is what gives way,
 * never the fidelity of the path.
 */
export function maxRepresentableArcLift(angle: number, segmentCount: number) {
  if (!(angle > 0) || segmentCount < MIN_LIFTED_ROUTE_ARC_SEGMENTS) return 0;
  const affordable = 8 * ROUTE_ARC_CHORD_TOLERANCE * segmentCount * segmentCount;
  const angular = angle * angle;
  if (affordable <= angular) return 0;
  return (affordable - angular) / (angular + ROUTE_ARC_LIFT_CURVATURE);
}

/**
 * The hump peaks mid-leg and is exactly zero at both ends, so a leg endpoint
 * always resolves to the Route Point anchor itself rather than to a value a
 * sine rounds to 1e-26.
 */
function liftAt(progress: number, heightRatio: number, exponent: number) {
  if (progress <= 0 || progress >= 1 || heightRatio <= 0) return 0;
  return Math.pow(Math.sin(Math.PI * progress), exponent) * heightRatio;
}

export function routeArcVertexCount(samples: RouteArcSamples) {
  return samples.lifts.length;
}

export type RouteArcLegPlan = {
  start: Vector3;
  end: Vector3;
  /** Shared forward-travel tangents at the two canonical Route Point anchors. */
  startTangent: Vector3;
  endTangent: Vector3;
  /** Bounded spherical handle angles; near U-turns shrink toward zero. */
  startHandleAngle: number;
  endHandleAngle: number;
  /** Angular length of the leg in radians; sizes both the count and the lift. */
  angle: number;
  heightRatio: number;
  segmentCount: number;
};

type RouteSplineLegShape = Pick<
  RouteArcLegPlan,
  | "start"
  | "end"
  | "startTangent"
  | "endTangent"
  | "startHandleAngle"
  | "endHandleAngle"
  | "angle"
>;

function sampleBoundedSplineDirections(
  shape: RouteSplineLegShape,
  segmentCount: number,
) {
  const {
    start,
    end,
    startTangent,
    endTangent,
    startHandleAngle,
    endHandleAngle,
  } = shape;
  const directions = [start.clone()];
  for (let step = 1; step <= segmentCount; step += 1) {
    const progress = step / segmentCount;
    directions.push(sampleSphericalSpline(
      start,
      end,
      startTangent,
      endTangent,
      startHandleAngle,
      endHandleAngle,
      progress,
    ));
  }
  return directions;
}

function routeSplineSamplingWithinTolerance(
  directions: readonly Vector3[],
  maxSegmentAngle: number,
) {
  const distinct: Vector3[] = [];
  for (const direction of directions) {
    if (distinct.length === 0
      || angularDistance(distinct[distinct.length - 1], direction) > 1e-10) {
      distinct.push(direction);
    }
  }
  for (let index = 1; index < distinct.length; index += 1) {
    if (angularDistance(distinct[index - 1], distinct[index])
      > maxSegmentAngle + 1e-9) return false;
  }
  for (let index = 1; index < distinct.length - 1; index += 1) {
    const anchor = distinct[index];
    const incoming = tangentToward(anchor, distinct[index - 1]).multiplyScalar(-1);
    const outgoing = tangentToward(anchor, distinct[index + 1]);
    if (incoming.lengthSq() > 0
      && outgoing.lengthSq() > 0
      && incoming.angleTo(outgoing) > ROUTE_SPLINE_JOIN_TOLERANCE + 1e-9) {
      return false;
    }
  }
  return true;
}

/**
 * Endpoint deflection alone can miss a spherical Hermite span's interior
 * speed/curvature peak on a long near-antipodal leg. Verify the actual sample sequence and
 * double the uniform density until both angular step and heading change meet
 * the existing sampling tolerances, never asking for more than the route's
 * hard #242 segment budget can provide.
 */
function routeSplineInteriorSegmentCount(
  shape: RouteSplineLegShape,
  baseCount: number,
  maxSegmentAngle: number,
  maxSegments: number,
) {
  let count = Math.max(1, Math.min(baseCount, maxSegments));
  while (true) {
    const directions = sampleBoundedSplineDirections(shape, count);
    if (routeSplineSamplingWithinTolerance(directions, maxSegmentAngle)
      || count >= maxSegments) return count;
    count = Math.min(maxSegments, Math.max(count + 1, count * 2));
  }
}

/**
 * Find the smallest uniformly sampled count that satisfies the spline's
 * angular-step and heading-change policy without walking every intermediate
 * count. The bounded span gets an exponential bracket and then a binary
 * refinement, keeping dense-route planning O(n log n) instead of quadratic.
 */
function routeSplineMinimumCompliantSegmentCount(
  shape: RouteSplineLegShape,
  maxSegmentAngle: number,
  maxSegments: number,
) {
  const limit = Math.max(1, maxSegments);
  const cache = new Map<number, boolean>();
  const withinTolerance = (count: number) => {
    const cached = cache.get(count);
    if (cached !== undefined) return cached;
    const result = routeSplineSamplingWithinTolerance(
      sampleBoundedSplineDirections(shape, count),
      maxSegmentAngle,
    );
    cache.set(count, result);
    return result;
  };

  // A duplicate Route Point is truthfully represented by its unavoidable
  // one-segment degenerate leg. Do not let that special case invalidate the
  // route-wide rebalance for the non-degenerate legs around it.
  if (!(shape.angle > 1e-12)) return 1;

  // Coarse uniform samples can alias the spline's interior curvature: one
  // candidate count may pass while its immediate neighbours fail. A compliant
  // floor therefore has to remain compliant across a small consecutive window
  // rather than being inferred from one lucky sample grid. The requested
  // pre-budget count remains the hard upper bound and is verified directly.
  if (limit < 2) return null;
  const stableWithinTolerance = (count: number) => {
    const last = Math.min(limit, count + 2);
    for (let candidate = count; candidate <= last; candidate += 1) {
      if (!withinTolerance(candidate)) return false;
    }
    return true;
  };

  let failed = 1;
  let passing = Math.min(limit, 2);
  if (stableWithinTolerance(passing)) return passing;
  failed = passing;
  passing = Math.min(limit, 4);
  while (passing < limit && !stableWithinTolerance(passing)) {
    failed = passing;
    passing = Math.min(limit, passing * 2);
  }
  if (!stableWithinTolerance(passing)) return null;

  while (failed + 1 < passing) {
    const midpoint = Math.floor((failed + passing) / 2);
    if (stableWithinTolerance(midpoint)) passing = midpoint;
    else failed = midpoint;
  }
  return passing;
}

/**
 * #242: ONE decision about the geometry of a route, shared by the whole-route
 * stroke and the per-leg rewind paths.
 *
 * Both used to build their own samples with their own vertex budget from the
 * same Route Points, so the static stroke and the leg that redraws it could
 * disagree. They now read the same plan, and because the plan is a pure
 * function of the route's points and its budget, the two are identical rather
 * than merely similar.
 *
 * The budget is spread across legs instead of being spent front to back: the
 * old build returned early when it ran out, which silently dropped the tail of
 * a dense route and with it the Route Points on it. Every leg keeps at least
 * one segment, so every stored Route Point survives and the returned leg count
 * always matches the route's own legs one for one; a leg granted fewer segments
 * than its hump needs gives up as much of the hump as it cannot draw
 * faithfully. Degradation order is fixed: decorative lift first, then interior
 * subdivision down to one segment per stored leg, and only then - when even
 * that will not fit - the route is not drawn at all. A Route Point is never
 * omitted from a route that IS drawn.
 */
export function planRouteArcLegs(
  points: readonly GeographicPoint[],
  maxSegmentAngle: number,
  maxVertices: number,
  arc: RouteArcOptions,
): RouteArcLegPlan[] {
  if (points.length < 2 || maxVertices < 2) return [];
  const liftRequested = (arc.arcHeightRatio ?? 0) > 0;
  const availableSegments = Math.floor(maxVertices / 2);
  const plans: RouteArcLegPlan[] = [];
  const directions = points.map((point) => latLonToVector3(
    point.lat,
    point.lon,
    1,
  ).normalize());
  const splineAnchors = buildRouteSplineAnchors(directions);

  // #242 review: maxVertices is a hard ceiling, and one straight segment per
  // leg is the least a route can be drawn as while still passing through every
  // Route Point it stores. A budget below that cannot render this route
  // truthfully, so it renders none of it: dropping a route at the selection
  // level is a policy the viewer can be told about, while a stroke that
  // shortcuts across omitted Route Points is a quiet lie about the Journey.
  // The scene reserves this floor for every route it renders, so a rendered
  // route never reaches this guard.
  if (points.length - 1 > availableSegments) return [];

  for (let index = 1; index < points.length; index += 1) {
    const startAnchor = splineAnchors[index - 1];
    const endAnchor = splineAnchors[index];
    const start = startAnchor.direction;
    const end = endAnchor.direction;
    const angle = angularDistance(start, end);
    const heightRatio = arcHeightRatioFor(angle, arc);
    const geodesicStart = tangentToward(start, end);
    const geodesicEnd = tangentToward(end, start).multiplyScalar(-1);
    const startHandleAngle = startAnchor.tangent.dot(geodesicStart) > 0
      ? splineHandleAngle(angle, startAnchor.turnScale)
      : 0;
    const endHandleAngle = endAnchor.tangent.dot(geodesicEnd) > 0
      ? splineHandleAngle(angle, endAnchor.turnScale)
      : 0;
    const shape: RouteSplineLegShape = {
      start,
      end,
      startTangent: startAnchor.tangent.clone(),
      endTangent: endAnchor.tangent.clone(),
      startHandleAngle,
      endHandleAngle,
      angle,
    };
    const baseSegmentCount = Math.max(
      routeArcSegmentCount(
        angle,
        heightRatio,
        maxSegmentAngle,
        liftRequested,
      ),
      routeSplineSegmentCount(
        start,
        end,
        startAnchor.tangent,
        endAnchor.tangent,
        startHandleAngle,
        endHandleAngle,
        angle,
      ),
    );
    plans.push({
      ...shape,
      heightRatio,
      segmentCount: routeSplineInteriorSegmentCount(
        shape,
        baseSegmentCount,
        maxSegmentAngle,
        availableSegments,
      ),
    });
  }

  let requested = plans.reduce((sum, plan) => sum + plan.segmentCount, 0);

  if (requested <= availableSegments) {
    // A bounded cross-track slope can rotate an active endpoint away from the
    // route-wide shared tangent. When the route otherwise fits its #242 budget,
    // do not preserve that mismatch by slowing along-track Hermite progress to
    // an almost-stationary endpoint (which can consume the entire budget just
    // to approximate one sharp corner). Smoothing is decorative: if either
    // side of an interior anchor cannot express the shared tangent inside the
    // existing handle/deviation bounds, collapse that shared handle on BOTH
    // adjacent legs and keep the exact Route Point corner instead. Moderate
    // representable turns retain the shared tangent unchanged.
    const anchorsToCollapse = new Set<number>();
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const slopes = boundedSplineCrossTrackSlopes(
        plan.startTangent,
        plan.endTangent,
        routeLegSplineFrame(plan.start, plan.end),
        plan.startHandleAngle,
        plan.endHandleAngle,
        plan.angle,
      );
      if (index > 0
        && plan.startHandleAngle > 0
        && !slopes.startPreservesTangent) {
        anchorsToCollapse.add(index);
      }
      if (index < plans.length - 1
        && plan.endHandleAngle > 0
        && !slopes.endPreservesTangent) {
        anchorsToCollapse.add(index + 1);
      }
    }

    if (anchorsToCollapse.size > 0) {
      for (const anchorIndex of anchorsToCollapse) {
        plans[anchorIndex - 1].endHandleAngle = 0;
        plans[anchorIndex].startHandleAngle = 0;
      }
      for (const plan of plans) {
        const baseSegmentCount = Math.max(
          routeArcSegmentCount(
            plan.angle,
            plan.heightRatio,
            maxSegmentAngle,
            liftRequested,
          ),
          routeSplineSegmentCount(
            plan.start,
            plan.end,
            plan.startTangent,
            plan.endTangent,
            plan.startHandleAngle,
            plan.endHandleAngle,
            plan.angle,
          ),
        );
        plan.segmentCount = routeSplineInteriorSegmentCount(
          plan,
          baseSegmentCount,
          maxSegmentAngle,
          availableSegments,
        );
      }
      requested = plans.reduce((sum, plan) => sum + plan.segmentCount, 0);
    }
    if (requested <= availableSegments) return plans;
  }

  // Not enough budget for the curve every leg asked for. Scale proportionally,
  // never below one segment, then shave the widest remaining allocations until
  // the total fits. The guard above already established that there are no more
  // legs than segments, so flooring at one segment cannot breach the ceiling.
  const requestedSegmentCounts = plans.map((plan) => plan.segmentCount);
  const scale = availableSegments / requested;
  for (const plan of plans) {
    plan.segmentCount = Math.max(1, Math.floor(plan.segmentCount * scale));
  }
  requested = plans.reduce((sum, plan) => sum + plan.segmentCount, 0);
  while (requested > availableSegments) {
    let widest = plans[0];
    for (const plan of plans) {
      if (plan.segmentCount > widest.segmentCount) widest = plan;
    }
    if (widest.segmentCount <= 1) break;
    widest.segmentCount -= 1;
    requested -= 1;
  }

  // #352 review: proportional #242 scaling can invalidate the spline sampling
  // policy that chose the pre-budget counts. Compute each leg's compliant floor
  // with logarithmic refinement, then rebalance the scaled allocation above
  // those floors. If the floors themselves do not fit, preserve the existing
  // best-effort budget degradation rather than breaching the hard ceiling.
  const scaledSegmentCounts = plans.map((plan) => plan.segmentCount);
  const minimumCompliantCounts = plans.map((plan, index) => (
    routeSplineMinimumCompliantSegmentCount(
      plan,
      maxSegmentAngle,
      requestedSegmentCounts[index],
    )
  ));

  if (minimumCompliantCounts.every((count): count is number => count !== null)) {
    const minimumTotal = minimumCompliantCounts.reduce((sum, count) => sum + count, 0);
    if (minimumTotal <= availableSegments) {
      const rebalanced = scaledSegmentCounts.map((count, index) => (
        Math.max(count, minimumCompliantCounts[index])
      ));
      let rebalancedTotal = rebalanced.reduce((sum, count) => sum + count, 0);

      while (rebalancedTotal > availableSegments) {
        let donorIndex = -1;
        let donorSurplus = 0;
        for (let index = 0; index < rebalanced.length; index += 1) {
          const surplus = rebalanced[index] - minimumCompliantCounts[index];
          if (surplus > donorSurplus) {
            donorIndex = index;
            donorSurplus = surplus;
          }
        }
        if (donorIndex < 0) break;
        const transfer = Math.min(
          donorSurplus,
          rebalancedTotal - availableSegments,
        );
        rebalanced[donorIndex] -= transfer;
        rebalancedTotal -= transfer;
      }

      const rebalancedIsCompliant = rebalanced.every((count, index) => (
        routeSplineSamplingWithinTolerance(
          sampleBoundedSplineDirections(plans[index], count),
          maxSegmentAngle,
        )
      ));
      const selectedCounts = rebalancedIsCompliant
        ? rebalanced
        : minimumCompliantCounts;
      for (let index = 0; index < plans.length; index += 1) {
        plans[index].segmentCount = selectedCounts[index];
      }
    }
  }

  // #242 review: a leg keeps only the hump the segments it was granted can
  // draw faithfully. The four-segment floor is not the test - a 20 degree leg
  // that asked for 70 segments and got 10 would clear that floor while drawing
  // exactly the coarse raised polygon this change removes.
  for (const plan of plans) {
    plan.heightRatio = Math.min(
      plan.heightRatio,
      maxRepresentableArcLift(plan.angle, plan.segmentCount),
    );
  }
  return plans;
}

function appendLegSamples(
  plan: RouteArcLegPlan,
  into: { directions: number[]; lifts: number[] },
) {
  const { heightRatio, segmentCount } = plan;
  const directions = sampleBoundedSplineDirections(plan, segmentCount);
  for (let step = 1; step <= segmentCount; step += 1) {
    const previousProgress = (step - 1) / segmentCount;
    const currentProgress = step / segmentCount;
    const previous = directions[step - 1];
    const current = directions[step];
    into.directions.push(...previous.toArray(), ...current.toArray());
    into.lifts.push(
      liftAt(previousProgress, heightRatio, ROUTE_ARC_EXPONENT),
      liftAt(currentProgress, heightRatio, ROUTE_ARC_EXPONENT),
    );
  }
}

function toSamples(buffer: { directions: number[]; lifts: number[] }): RouteArcSamples {
  return {
    directions: new Float32Array(buffer.directions),
    lifts: new Float32Array(buffer.lifts),
  };
}

export function buildRouteArcSamples(
  points: readonly GeographicPoint[],
  maxSegmentAngle = Math.PI / 24,
  maxVertices = 8192,
  arc: RouteArcOptions = {},
): RouteArcSamples {
  const plans = planRouteArcLegs(points, maxSegmentAngle, maxVertices, arc);
  if (plans.length === 0) return EMPTY_ROUTE_ARC_SAMPLES;
  // #15: the hump peaks mid-leg and touches the surface at both ends, so a
  // multi-stop route reads as a continuous trail, not disconnected arcs.
  const buffer = { directions: [] as number[], lifts: [] as number[] };
  for (const plan of plans) appendLegSamples(plan, buffer);
  return toSamples(buffer);
}

/**
 * #21 review: build each route leg as its own sample set, so a rewind can
 * reveal one leg at a time (the trail grows stop by stop) instead of fading
 * the whole path. Each returned entry covers points[i] -> points[i+1].
 *
 * #242: the plan is built from the WHOLE route, so a leg here is the same
 * geometry as the corresponding span of buildRouteArcSamples given the same
 * budget - not a second, independently budgeted copy of it.
 */
export function buildRouteArcLegSamples(
  points: readonly GeographicPoint[],
  maxSegmentAngle = Math.PI / 24,
  maxVertices = 8192,
  arc: RouteArcOptions = {},
): RouteArcSamples[] {
  return planRouteArcLegs(points, maxSegmentAngle, maxVertices, arc).map((plan) => {
    const buffer = { directions: [] as number[], lifts: [] as number[] };
    appendLegSamples(plan, buffer);
    return toSamples(buffer);
  });
}

export function buildSphericalRingSegments(
  rings: readonly (readonly (readonly number[])[])[],
  radius: number,
  maxVertices = 20_000,
) {
  const maxSegments = Math.floor(maxVertices / 2);
  if (maxSegments < 1) return new Float32Array();

  type CoastlinePath = {
    points: Array<[longitude: number, latitude: number]>;
    segmentCount: number;
  };
  const paths: CoastlinePath[] = [];

  const flushRun = (run: Array<[number, number]>) => {
    if (run.length >= 2) {
      paths.push({ points: run, segmentCount: run.length - 1 });
    }
  };

  for (const ring of rings) {
    let run: Array<[number, number]> = [];
    for (const coordinate of ring) {
      const [longitude, latitude] = coordinate;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        flushRun(run);
        run = [];
        continue;
      }
      run.push([longitude, latitude]);
    }
    flushRun(run);
  }

  if (paths.length === 0) return new Float32Array();

  const totalSegments = paths.reduce((sum, path) => sum + path.segmentCount, 0);
  let selectedPaths = paths;
  if (paths.length > maxSegments) {
    selectedPaths = Array.from({ length: maxSegments }, (_, index) => {
      const sampledIndex = Math.min(
        paths.length - 1,
        Math.floor(((index + 0.5) * paths.length) / maxSegments),
      );
      return paths[sampledIndex];
    });
  }

  const quotas = new Array(selectedPaths.length).fill(1);
  if (totalSegments <= maxSegments && selectedPaths.length === paths.length) {
    selectedPaths.forEach((path, index) => {
      quotas[index] = path.segmentCount;
    });
  } else if (selectedPaths.length < maxSegments) {
    let remaining = maxSegments - selectedPaths.length;
    const capacities = selectedPaths.map((path) => Math.max(0, path.segmentCount - 1));
    const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
    if (totalCapacity > 0 && remaining > 0) {
      const remainders: Array<{ index: number; fraction: number }> = [];
      capacities.forEach((capacity, index) => {
        const exact = (remaining * capacity) / totalCapacity;
        const extra = Math.min(capacity, Math.floor(exact));
        quotas[index] += extra;
        remainders.push({ index, fraction: exact - extra });
      });
      remaining = maxSegments - quotas.reduce((sum, quota) => sum + quota, 0);
      remainders.sort((a, b) => b.fraction - a.fraction);
      for (const { index } of remainders) {
        if (remaining <= 0) break;
        if (quotas[index] >= selectedPaths[index].segmentCount) continue;
        quotas[index] += 1;
        remaining -= 1;
      }
    }
  }

  const values: number[] = [];
  selectedPaths.forEach((path, pathIndex) => {
    const quota = Math.min(path.segmentCount, quotas[pathIndex]);
    if (quota >= path.segmentCount) {
      for (let index = 1; index < path.points.length; index += 1) {
        const [previousLon, previousLat] = path.points[index - 1];
        const [longitude, latitude] = path.points[index];
        values.push(
          ...latLonToVector3(previousLat, previousLon, radius).toArray(),
          ...latLonToVector3(latitude, longitude, radius).toArray(),
        );
      }
      return;
    }

    const [firstLon, firstLat] = path.points[0];
    const [lastLon, lastLat] = path.points[path.points.length - 1];
    if (quota === 1 && firstLon === lastLon && firstLat === lastLat) {
      for (let index = 1; index < path.points.length; index += 1) {
        const [previousLon, previousLat] = path.points[index - 1];
        const [longitude, latitude] = path.points[index];
        const previous = latLonToVector3(previousLat, previousLon, radius);
        const current = latLonToVector3(latitude, longitude, radius);
        if (previous.distanceToSquared(current) <= 1e-20) continue;
        values.push(...previous.toArray(), ...current.toArray());
        return;
      }
      return;
    }

    let previousIndex = 0;
    for (let segmentIndex = 1; segmentIndex <= quota; segmentIndex += 1) {
      const pointIndex = Math.min(
        path.points.length - 1,
        Math.round((segmentIndex * path.segmentCount) / quota),
      );
      const [previousLon, previousLat] = path.points[previousIndex];
      const [longitude, latitude] = path.points[pointIndex];
      values.push(
        ...latLonToVector3(previousLat, previousLon, radius).toArray(),
        ...latLonToVector3(latitude, longitude, radius).toArray(),
      );
      previousIndex = pointIndex;
    }
  });

  return new Float32Array(values);
}

export function formatLatitude(value: number, precision = 4) {
  return `${Math.abs(value).toFixed(precision)}°${value >= 0 ? "N" : "S"}`;
}

export function formatLongitude(value: number, precision = 4) {
  return `${Math.abs(value).toFixed(precision)}°${value >= 0 ? "E" : "W"}`;
}

export function rotationYForLongitude(longitude: number) {
  return ((-longitude - 90) * Math.PI) / 180;
}

export type SphericalRouteFocus = {
  center: GeographicPoint;
  angularRadius: number;
  zoom: number;
};

export function routeFocusZoomForAngularRadius(angularRadius: number) {
  const degrees = Math.max(0, angularRadius) * 180 / Math.PI;
  const stops = [
    [0, 1.72],
    [8, 1.58],
    [20, 1.34],
    [40, 1.06],
    [70, 0.82],
  ] as const;
  if (degrees <= stops[0][0]) return stops[0][1];
  for (let index = 1; index < stops.length; index += 1) {
    const [nextDegrees, nextZoom] = stops[index];
    const [previousDegrees, previousZoom] = stops[index - 1];
    if (degrees <= nextDegrees) {
      const progress = (degrees - previousDegrees) / (nextDegrees - previousDegrees);
      return previousZoom + (nextZoom - previousZoom) * progress;
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Returns a spherical framing target for an ordered route. Using unit-vector
 * averaging keeps routes that cross the antimeridian centered near ±180°
 * instead of incorrectly jumping to Greenwich. The angular radius drives a
 * bounded zoom target: local routes move closer, broad routes pull back.
 */
export function getSphericalRouteFocus(
  points: readonly GeographicPoint[],
): SphericalRouteFocus | null {
  const vectors = points
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map((point) => latLonToVector3(point.lat, point.lon, 1).normalize());
  if (vectors.length === 0) return null;

  const mean = vectors.reduce((sum, vector) => sum.add(vector), new Vector3());
  const centerVector = mean.lengthSq() > 1e-8
    ? mean.normalize()
    : vectors[Math.floor((vectors.length - 1) / 2)].clone();
  const center = vector3ToLatLon(centerVector);
  const angularRadius = vectors.reduce((radius, vector) => (
    Math.max(radius, Math.acos(Math.min(1, Math.max(-1, centerVector.dot(vector)))))
  ), 0);

  return {
    center,
    angularRadius,
    zoom: routeFocusZoomForAngularRadius(angularRadius),
  };
}

export function rotationXForLatitude(latitude: number) {
  return latitude * Math.PI / 180;
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSeededSpherePoints(count: number, seed: number) {
  const points = new Float32Array(Math.max(0, count) * 3);
  const random = mulberry32(seed);

  for (let index = 0; index < count; index += 1) {
    const y = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const radial = Math.sqrt(1 - y * y);
    const offset = index * 3;
    points[offset] = radial * Math.cos(theta);
    points[offset + 1] = y;
    points[offset + 2] = radial * Math.sin(theta);
  }

  return points;
}

export function buildArtworkPointPositions(
  records: readonly LocatedRecord[],
  radius: number,
) {
  const points = new Float32Array(records.length * 3);

  records.forEach((record, index) => {
    const point = latLonToVector3(record.point.lat, record.point.lon, radius);
    point.toArray(points, index * 3);
  });

  return points;
}
