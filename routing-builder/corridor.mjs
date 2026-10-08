// Pure corridor -> Overpass QL translation. No I/O, so every rule is unit-testable.
import { createHash } from "node:crypto";

export const PROFILES = ["driving", "walking", "cycling"];
export const MAX_POINTS = 18;
export const MAX_DIRECT_METERS = 400_000;
export const POINT_RADIUS_METERS = 5_000;
// Requests are quantized before hashing so that small drags and the slightly
// different point sets of candidates and nearby-point lookups share one graph.
// 0.01 degrees is at most ~0.8 km off, well inside the 5 km full-detail radius.
const QUANTUM = 100;

const LINKED = (classes) => classes.flatMap((name) => [name, `${name}_link`]);
const DRIVING_MAJOR = LINKED(["motorway", "trunk", "primary", "secondary"]);
const DRIVING_FULL = [...LINKED(["motorway", "trunk", "primary", "secondary", "tertiary"]),
  "unclassified", "residential", "living_street", "service", "road"];
// Trunk stays in long walking/cycling corridors: country-access.geojson permits
// it in some countries, and the profile, not the query, decides access.
const ACTIVE_LONG = [...LINKED(["trunk", "primary", "secondary", "tertiary"]),
  "unclassified", "cycleway", "path", "track"];

export class CorridorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 12_742_000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function validPoint(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof value.lat === "number" && typeof value.lon === "number"
    && Number.isFinite(value.lat) && Number.isFinite(value.lon)
    && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180;
}

/** Strictly validates a request body; throws CorridorError("INVALID_GRAPH_REQUEST"). */
export function parseGraphRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "profile" && key !== "points")
    || !PROFILES.includes(body.profile) || !Array.isArray(body.points)
    || body.points.length < 1 || body.points.length > MAX_POINTS
    || !body.points.every(validPoint)) {
    throw new CorridorError("INVALID_GRAPH_REQUEST", "Graph request is invalid");
  }
  return { profile: body.profile, points: body.points.map(({ lat, lon }) => ({ lat, lon })) };
}

const quantize = (value) => Math.round(value * QUANTUM) / QUANTUM;
const format = (value) => quantize(value).toFixed(2);

function highwayFilter(classes) {
  return classes ? `[highway~"^(${classes.join("|")})$"]` : `[highway][highway!~"^(motorway|motorway_link)$"]`;
}

/**
 * Returns the normalized Overpass query for a corridor. Deterministic for the
 * same quantized points, so the query itself is the graph identity.
 */
export function buildCorridorQuery(profile, rawPoints) {
  const points = [];
  for (const point of rawPoints) {
    const next = { lat: quantize(point.lat), lon: quantize(point.lon) };
    const last = points.at(-1);
    if (!last || last.lat !== next.lat || last.lon !== next.lon) points.push(next);
  }
  const direct = points.slice(1).reduce((sum, point, index) => sum + distanceMeters(points[index], point), 0);
  if (direct > MAX_DIRECT_METERS) {
    throw new CorridorError("ROUTING_AREA_TOO_LARGE", "Corridor exceeds the direct distance limit");
  }
  const full = profile === "driving" ? DRIVING_FULL : null;
  const statements = points.map((point) =>
    `way(around:${POINT_RADIUS_METERS},${format(point.lat)},${format(point.lon)})${highwayFilter(full)};`);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const legMeters = distanceMeters(from, to);
    const radius = Math.round(Math.min(30_000, Math.max(3_000, legMeters * 0.15)));
    const classes = profile === "driving"
      ? (legMeters > 25_000 ? DRIVING_MAJOR : DRIVING_FULL)
      : (legMeters > 50_000 ? ACTIVE_LONG : null);
    statements.push(`way(around:${radius},${format(from.lat)},${format(from.lon)},${format(to.lat)},${format(to.lon)})${highwayFilter(classes)};`);
  }
  // One union and a single `out;` keeps the XML ordered nodes, ways, relations.
  // Restriction relations bring their member ways and nodes with `>`.
  return [
    "[out:xml][timeout:180][maxsize:536870912];",
    "(",
    ...statements.map((statement) => `  ${statement}`),
    ")->.roads;",
    "(.roads; rel(bw.roads)[type=restriction];);",
    "(._; >;);",
    "out;",
  ].join("\n");
}

export function graphId(profile, query) {
  return createHash("sha256").update(`${profile}\n${query}`).digest("hex");
}
