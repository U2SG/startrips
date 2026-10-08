// Pure corridor -> Overpass QL translation. No I/O, so every rule is unit-testable.
import { createHash } from "node:crypto";

export const PROFILES = ["driving", "walking", "cycling"];
// "extended" is the escalation tier: full profile classes along the whole
// corridor, for places whose local roads join the network only far away.
export const DETAILS = ["standard", "extended"];
export const MAX_POINTS = 18;
export const MAX_DIRECT_METERS = 400_000;
// Driving matches the API's MAX_SELECTED_POINT_METERS, so nearby road point
// suggestions find their whole search area in the graph. Walking and cycling
// snap within 750 m and fetch every path, so a city-wide radius would be huge.
export const POINT_RADIUS_METERS = { driving: 25_000, walking: 5_000, cycling: 5_000 };
// Requests are quantized before hashing so that small drags and the slightly
// different point sets of candidates and nearby-point lookups share one graph.
// 0.01 degrees is at most ~0.8 km off, well inside the full-detail radius.
const QUANTUM = 100;

const LINKED = (classes) => classes.flatMap((name) => [name, `${name}_link`]);
// Tertiary and unclassified roads are what joins rural towns to the skeleton;
// without them a town's local roads form an island the route cannot leave.
const DRIVING_LONG = [...LINKED(["motorway", "trunk", "primary", "secondary", "tertiary"]), "unclassified"];
const DRIVING_FULL = [...DRIVING_LONG, "residential", "living_street", "service", "road"];
const LEG_RADIUS = {
  standard: { share: 0.15, min: 5_000, max: 30_000 },
  extended: { share: 0.2, min: 8_000, max: 40_000 },
};
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
    || Object.keys(body).some((key) => !["profile", "points", "detail"].includes(key))
    || !PROFILES.includes(body.profile) || !Array.isArray(body.points)
    || (body.detail !== undefined && !DETAILS.includes(body.detail))
    || body.points.length < 1 || body.points.length > MAX_POINTS
    || !body.points.every(validPoint)) {
    throw new CorridorError("INVALID_GRAPH_REQUEST", "Graph request is invalid");
  }
  return {
    profile: body.profile,
    points: body.points.map(({ lat, lon }) => ({ lat, lon })),
    detail: body.detail ?? "standard",
  };
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
export function buildCorridorQuery(profile, rawPoints, detail = "standard") {
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
    `way(around:${POINT_RADIUS_METERS[profile]},${format(point.lat)},${format(point.lon)})${highwayFilter(full)};`);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const legMeters = distanceMeters(from, to);
    const bounds = LEG_RADIUS[detail];
    const radius = Math.round(Math.min(bounds.max, Math.max(bounds.min, legMeters * bounds.share)));
    const classes = detail === "extended" ? full
      : profile === "driving" ? (legMeters > 25_000 ? DRIVING_LONG : DRIVING_FULL)
        : (legMeters > 50_000 ? ACTIVE_LONG : null);
    const leg = `around:${radius},${format(from.lat)},${format(from.lon)},${format(to.lat)},${format(to.lon)}`;
    statements.push(`way(${leg})${highwayFilter(classes)};`);
    // Ferries are mapped as route=ferry ways, usually without highway=*. Fetch
    // them for every profile; the profile and the member's ferry consent decide.
    statements.push(`way(${leg})[route=ferry];`);
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

export function graphId(profile, query, detail = "standard") {
  return createHash("sha256").update(`${profile}\n${detail}\n${query}`).digest("hex");
}
