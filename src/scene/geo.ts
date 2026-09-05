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
  heightRatio: number;
  segmentCount: number;
};

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
 * one segment, so every stored Route Point survives; a leg squeezed below the
 * segments its hump needs gives the hump up and is drawn as a faithful surface
 * trace, which is the honest degradation rather than an invented shortcut.
 */
export function planRouteArcLegs(
  points: readonly GeographicPoint[],
  maxSegmentAngle: number,
  maxVertices: number,
  arc: RouteArcOptions,
): RouteArcLegPlan[] {
  if (points.length < 2 || maxVertices < 2) return [];
  const liftRequested = (arc.arcHeightRatio ?? 0) > 0;
  const plans: RouteArcLegPlan[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = latLonToVector3(
      points[index - 1].lat,
      points[index - 1].lon,
      1,
    ).normalize();
    const end = latLonToVector3(points[index].lat, points[index].lon, 1).normalize();
    const angle = Math.acos(Math.min(1, Math.max(-1, start.dot(end))));
    const heightRatio = arcHeightRatioFor(angle, arc);
    plans.push({
      start,
      end,
      heightRatio,
      segmentCount: routeArcSegmentCount(
        angle,
        heightRatio,
        maxSegmentAngle,
        liftRequested,
      ),
    });
  }

  const availableSegments = Math.floor(maxVertices / 2);
  let requested = plans.reduce((sum, plan) => sum + plan.segmentCount, 0);
  if (requested <= availableSegments) return plans;

  // Not enough budget for the curve every leg asked for. Scale proportionally,
  // never below one segment, then shave the widest remaining allocations until
  // the total fits. A leg left with fewer segments than a hump needs is
  // flattened rather than drawn as a peak.
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
  for (const plan of plans) {
    if (plan.segmentCount < MIN_LIFTED_ROUTE_ARC_SEGMENTS) plan.heightRatio = 0;
  }
  return plans;
}

function appendLegSamples(
  plan: RouteArcLegPlan,
  into: { directions: number[]; lifts: number[] },
) {
  const { start, end, heightRatio, segmentCount } = plan;
  for (let step = 1; step <= segmentCount; step += 1) {
    const previousProgress = (step - 1) / segmentCount;
    const currentProgress = step / segmentCount;
    const previous = slerpUnitVectors(start, end, previousProgress);
    const current = slerpUnitVectors(start, end, currentProgress);
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
