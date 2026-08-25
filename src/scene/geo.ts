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
   * Angular distance (radians) at which the hump saturates; shorter legs get
   * a proportionally lower hump. The mapping is nonlinear (sqrt) so small
   * hops stay flat while long transits curve gracefully.
   */
  arcSaturationAngle?: number;
};

function arcHeightFor(angle: number, radius: number, options: RouteArcOptions) {
  const ratio = options.arcHeightRatio ?? 0;
  if (ratio <= 0) return 0;
  const saturation = options.arcSaturationAngle ?? Math.PI / 3;
  const progress = Math.min(1, Math.sqrt(angle / saturation));
  return radius * ratio * progress;
}

export function buildSphericalRouteSegments(
  points: readonly GeographicPoint[],
  radius: number,
  maxSegmentAngle = Math.PI / 24,
  maxVertices = 8192,
  arc: RouteArcOptions = {},
) {
  if (points.length < 2 || maxVertices < 2) return new Float32Array();
  const values: number[] = [];
  const arcExponent = 1.6;

  for (let index = 1; index < points.length; index += 1) {
    const start = latLonToVector3(
      points[index - 1].lat,
      points[index - 1].lon,
      1,
    ).normalize();
    const end = latLonToVector3(points[index].lat, points[index].lon, 1).normalize();
    const angle = Math.acos(Math.min(1, Math.max(-1, start.dot(end))));
    const stepCount = Math.max(1, Math.ceil(angle / maxSegmentAngle));
    // #15: the hump peaks mid-leg and touches the surface at both ends, so a
    // multi-stop route reads as a continuous trail, not disconnected arcs.
    const arcHeight = arcHeightFor(angle, radius, arc);

    for (let step = 1; step <= stepCount; step += 1) {
      if (values.length / 3 + 2 > maxVertices) return new Float32Array(values);
      const previousProgress = (step - 1) / stepCount;
      const currentProgress = step / stepCount;
      const previous = slerpUnitVectors(start, end, previousProgress);
      const current = slerpUnitVectors(start, end, currentProgress);
      if (arcHeight > 0) {
        const previousLift = 1 + Math.pow(Math.sin(Math.PI * previousProgress), arcExponent) * (arcHeight / radius);
        const currentLift = 1 + Math.pow(Math.sin(Math.PI * currentProgress), arcExponent) * (arcHeight / radius);
        previous.multiplyScalar(radius * previousLift);
        current.multiplyScalar(radius * currentLift);
      } else {
        previous.multiplyScalar(radius);
        current.multiplyScalar(radius);
      }
      values.push(...previous.toArray(), ...current.toArray());
    }
  }

  return new Float32Array(values);
}

/**
 * #21 review: build each route leg as its own Float32Array, so a rewind can
 * reveal one leg at a time (the trail grows stop by stop) instead of fading
 * the whole route as a single path. Each returned array covers points[i] ->
 * points[i+1]; legs whose points fail validation are skipped.
 */
export function buildSphericalRouteLegs(
  points: readonly GeographicPoint[],
  radius: number,
  maxSegmentAngle = Math.PI / 24,
  maxVertices = 8192,
  arc: RouteArcOptions = {},
): Float32Array[] {
  const legs: Float32Array[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const leg = buildSphericalRouteSegments(
      [points[index - 1], points[index]],
      radius,
      maxSegmentAngle,
      maxVertices,
      arc,
    );
    if (leg.length > 0) legs.push(leg);
  }
  return legs;
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
