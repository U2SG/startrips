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

export function buildSphericalRouteSegments(
  points: readonly GeographicPoint[],
  radius: number,
  maxSegmentAngle = Math.PI / 24,
  maxVertices = 8192,
) {
  if (points.length < 2 || maxVertices < 2) return new Float32Array();
  const values: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = latLonToVector3(
      points[index - 1].lat,
      points[index - 1].lon,
      1,
    ).normalize();
    const end = latLonToVector3(points[index].lat, points[index].lon, 1).normalize();
    const angle = Math.acos(Math.min(1, Math.max(-1, start.dot(end))));
    const stepCount = Math.max(1, Math.ceil(angle / maxSegmentAngle));

    for (let step = 1; step <= stepCount; step += 1) {
      if (values.length / 3 + 2 > maxVertices) return new Float32Array(values);
      const previous = slerpUnitVectors(start, end, (step - 1) / stepCount)
        .multiplyScalar(radius);
      const current = slerpUnitVectors(start, end, step / stepCount)
        .multiplyScalar(radius);
      values.push(...previous.toArray(), ...current.toArray());
    }
  }

  return new Float32Array(values);
}

/**
 * Cumulative polyline lengths for interleaved segment pairs produced by
 * `buildSphericalRouteSegments` (6 floats per pair: start xyz, end xyz).
 * Returns one entry per pair plus the final total, so `lengths.length`
 * equals `segments.length / 6 + 1` and `lengths[0] === 0`.
 */
export function buildRoutePolylineLengths(segments: Float32Array) {
  const pairCount = Math.floor(segments.length / 6);
  const lengths = new Float32Array(pairCount + 1);
  let total = 0;
  for (let pair = 0; pair < pairCount; pair += 1) {
    const offset = pair * 6;
    const dx = segments[offset + 3] - segments[offset];
    const dy = segments[offset + 4] - segments[offset + 1];
    const dz = segments[offset + 5] - segments[offset + 2];
    total += Math.hypot(dx, dy, dz);
    lengths[pair + 1] = total;
  }
  return lengths;
}

/**
 * Sample a position along an interleaved segment polyline at a fraction
 * `progress` in [0, 1]. Positions are written into `target` and returned.
 * A zero-length polyline yields its first vertex when present.
 */
export function sampleRoutePolylinePosition(
  segments: Float32Array,
  lengths: Float32Array,
  progress: number,
  target: Vector3,
) {
  const pairCount = Math.floor(segments.length / 6);
  const clamped = Math.min(1, Math.max(0, progress));
  const total = lengths[pairCount] ?? 0;
  if (pairCount === 0 || total <= 0) {
    target.set(segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0);
    return target;
  }
  const wanted = clamped * total;
  let pair = 0;
  while (pair < pairCount - 1 && lengths[pair + 1] < wanted) pair += 1;
  const startLength = lengths[pair];
  const pairLength = lengths[pair + 1] - startLength;
  const along = pairLength > 0 ? (wanted - startLength) / pairLength : 0;
  const offset = pair * 6;
  target.set(
    segments[offset] + (segments[offset + 3] - segments[offset]) * along,
    segments[offset + 1] + (segments[offset + 4] - segments[offset + 1]) * along,
    segments[offset + 2] + (segments[offset + 5] - segments[offset + 2]) * along,
  );
  return target;
}

/**
 * Particle budget for a route stream: density grows with route length but
 * never exhausts the shared per-scene budget.
 */
export function computeRouteStreamParticleCount(
  routeLength: number,
  remainingBudget: number,
  minPerRoute = 6,
  maxPerRoute = 60,
) {
  if (remainingBudget <= 0 || routeLength <= 0) return 0;
  const desired = Math.max(minPerRoute, Math.round(routeLength / 0.55));
  return Math.max(0, Math.min(maxPerRoute, remainingBudget, desired));
}

export function buildSphericalRingSegments(
  rings: readonly (readonly (readonly number[])[])[],
  radius: number,
  maxVertices = 20_000,
) {
  if (maxVertices < 2) return new Float32Array();
  const values: number[] = [];

  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      if (values.length / 3 + 2 > maxVertices) return new Float32Array(values);
      const [previousLon, previousLat] = ring[index - 1];
      const [longitude, latitude] = ring[index];
      if (
        !Number.isFinite(previousLat)
        || !Number.isFinite(previousLon)
        || !Number.isFinite(latitude)
        || !Number.isFinite(longitude)
      ) {
        continue;
      }
      const previous = latLonToVector3(previousLat, previousLon, radius);
      const current = latLonToVector3(latitude, longitude, radius);
      values.push(...previous.toArray(), ...current.toArray());
    }
  }

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
