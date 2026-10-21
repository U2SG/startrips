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
    // Near-antipodal endpoints still define a real great-circle plane. Follow
    // the tangent toward the ACTUAL endpoint so the last interior sample cannot
    // ride an arbitrary antipodal meridian and then snap sideways at t = 1.
    const towardEnd = end.clone().addScaledVector(start, -dot);
    const antipodalRoundoff = Number.EPSILON * 32;
    if (towardEnd.lengthSq() > antipodalRoundoff * antipodalRoundoff) {
      const angle = Math.acos(dot);
      towardEnd.normalize();
      return start
        .clone()
        .multiplyScalar(Math.cos(angle * progress))
        .addScaledVector(towardEnd, Math.sin(angle * progress))
        .normalize();
    }

    // Exact antipodes can retain a few ulps of projection noise after the
    // latitude/longitude conversion. Reject only that roundoff-sized residue;
    // tiny but representable near-antipodal endpoint planes remain authoritative.
    // Exactly antipodal endpoints do not select a unique great circle. Any
    // orthogonal plane is truthful because all of them land on -start at π.
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

function angularDistance(start: Vector3, end: Vector3) {
  return Math.acos(Math.min(1, Math.max(-1, start.dot(end))));
}

/**
 * The canonical geographic surface radius used whenever a latitude/longitude
 * is projected for product semantics. Labels, route endpoints and focus
 * geometry must not invent a different geographic shell.
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
 * Route geometry is stored as unit directions plus a per-vertex lift, a
 * fraction of the anchor radius. Journey legs and recorded tracks both lie on
 * the surface, so every lift they carry is 0; the field remains so projection
 * reads one sample shape for both.
 */
export type RouteArcSamples = {
  /** Unit direction per vertex; two vertices (6 floats) per drawn segment. */
  directions: Float32Array;
  /** Lift per vertex as a fraction of the anchor radius. */
  lifts: Float32Array;
};

const EMPTY_ROUTE_ARC_SAMPLES: RouteArcSamples = {
  directions: new Float32Array(),
  lifts: new Float32Array(),
};

export function routeArcVertexCount(samples: RouteArcSamples) {
  return samples.lifts.length;
}

export type RouteArcLegPlan = {
  start: Vector3;
  end: Vector3;
  /** Angular length of the leg in radians. */
  angle: number;
  segmentCount: number;
};

/**
 * #242: ONE decision about the geometry of a route, shared by the whole-route
 * stroke and the per-leg rewind paths, so the two are identical rather than
 * merely similar.
 *
 * Owner decision (2026-10-21): a leg between two Route Points is the plain
 * great circle between them, on the surface - no sideways spline, no altitude
 * hump. The renderer dashes the legs that cannot claim an actual route, and a
 * corner at each Route Point is the honest join.
 *
 * The budget is spread across legs instead of being spent front to back, so
 * the tail of a dense route is never dropped. Every leg keeps at least one
 * segment, so every stored Route Point survives; when even one segment per leg
 * will not fit, the route is not drawn at all rather than shortcut across
 * omitted Route Points.
 */
export function planRouteArcLegs(
  points: readonly GeographicPoint[],
  maxSegmentAngle: number,
  maxVertices: number,
): RouteArcLegPlan[] {
  if (points.length < 2 || maxVertices < 2) return [];
  const availableSegments = Math.floor(maxVertices / 2);
  // #242 review: a budget below one segment per leg cannot render this route
  // truthfully. The scene reserves this floor for every route it renders.
  if (points.length - 1 > availableSegments) return [];

  const directions = points.map((point) => latLonToVector3(
    point.lat,
    point.lon,
    1,
  ).normalize());
  const plans: RouteArcLegPlan[] = [];
  for (let index = 1; index < directions.length; index += 1) {
    const start = directions[index - 1];
    const end = directions[index];
    const angle = angularDistance(start, end);
    plans.push({
      start,
      end,
      angle,
      segmentCount: Math.max(1, Math.ceil(angle / maxSegmentAngle)),
    });
  }

  let requested = plans.reduce((sum, plan) => sum + plan.segmentCount, 0);
  if (requested <= availableSegments) return plans;

  // Not enough budget: scale proportionally, never below one segment, then
  // shave the widest remaining allocations until the total fits.
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
  return plans;
}

function appendLegSamples(
  plan: RouteArcLegPlan,
  into: { directions: number[]; lifts: number[] },
) {
  const { start, end, segmentCount } = plan;
  let previous = start;
  for (let step = 1; step <= segmentCount; step += 1) {
    // Both ends are the Route Points themselves, not a slerp that rounds to them.
    const current = step === segmentCount
      ? end
      : slerpUnitVectors(start, end, step / segmentCount);
    into.directions.push(...previous.toArray(), ...current.toArray());
    into.lifts.push(0, 0);
    previous = current;
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
): RouteArcSamples {
  const plans = planRouteArcLegs(points, maxSegmentAngle, maxVertices);
  if (plans.length === 0) return EMPTY_ROUTE_ARC_SAMPLES;
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
): RouteArcSamples[] {
  return planRouteArcLegs(points, maxSegmentAngle, maxVertices).map((plan) => {
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
