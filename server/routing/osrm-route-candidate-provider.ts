import { createHash } from "node:crypto";
import type { RoadProfile, RouteCandidate } from "../../src/journey/types";
import {
  RoutingUnavailableError,
  type RouteCandidateProvider,
  type RouteCandidateRequest,
  type RoutingCoordinate,
} from "./route-candidate-provider";

// Place labels may identify a park's representative point rather than a road.
// Keep a finite bound and preserve every offset for the member's comparison.
const MAX_SNAP_METERS: Record<RoadProfile, number> = { driving: 10_000, walking: 750, cycling: 750 };
const STEP_MODES: Record<RoadProfile, readonly string[]> = {
  driving: ["driving"],
  walking: ["walking"],
  cycling: ["cycling", "pushing bike"],
};
const MAX_GEOMETRY_POINTS = 4_000;
const MAX_DIRECT_METERS = 400_000;

type OsrmRoute = {
  distance?: number;
  duration?: number;
  geometry?: { type?: string; coordinates?: unknown };
  legs?: { steps?: { mode?: string }[] }[];
};
type OsrmResponse = {
  code?: string;
  routes?: OsrmRoute[];
  waypoints?: { location?: [number, number]; distance?: number }[];
};

function meters(a: RoutingCoordinate, b: RoutingCoordinate): number {
  const rad = Math.PI / 180;
  const latitudeDelta = (b.lat - a.lat) * rad;
  const longitudeDelta = (b.lon - a.lon) * rad;
  const h = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(longitudeDelta / 2) ** 2;
  return 12_742_000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function validGeometry(value: unknown): [number, number][] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_GEOMETRY_POINTS) return null;
  const coordinates: [number, number][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2
      || typeof point[0] !== "number" || typeof point[1] !== "number"
      || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
      || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return null;
    coordinates.push([point[0], point[1]]);
  }
  return coordinates;
}

function cross(a: [number, number], b: [number, number], c: [number, number]) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function obviousSelfIntersection(line: readonly [number, number][]): boolean {
  // A grade-separated crossing may also project as a crossing. Rejecting it
  // loses a suggestion; accepting a loop could invent a wildly wrong route.
  for (let a = 0; a < line.length - 1; a += 1) {
    for (let b = a + 2; b < line.length - 1; b += 1) {
      if (a === 0 && b === line.length - 2) continue;
      const ab1 = cross(line[a], line[a + 1], line[b]);
      const ab2 = cross(line[a], line[a + 1], line[b + 1]);
      const ba1 = cross(line[b], line[b + 1], line[a]);
      const ba2 = cross(line[b], line[b + 1], line[a + 1]);
      if (ab1 * ab2 < 0 && ba1 * ba2 < 0) return true;
    }
  }
  return false;
}

/** Hard gates are applied before relevance ordering; no score upgrades history. */
export function acceptOsrmCandidate(
  route: OsrmRoute,
  waypoints: NonNullable<OsrmResponse["waypoints"]>,
  ordered: readonly RoutingCoordinate[],
  profile: RoadProfile,
): RouteCandidate | null {
  if (!route || route.geometry?.type !== "LineString") return null;
  const maxSnapMeters = MAX_SNAP_METERS[profile];
  const geometry = validGeometry(route.geometry.coordinates);
  if (!geometry || waypoints.length !== ordered.length
    || !Array.isArray(route.legs) || route.legs.length !== ordered.length - 1
    || route.legs.some((leg) => !leg || !Array.isArray(leg.steps) || !leg.steps.length
      || leg.steps.some((step) => !step || !STEP_MODES[profile].includes(step.mode ?? "")))
    || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)
    || !(route.distance! > 0) || !(route.duration! > 0)) return null;
  if (waypoints.some((point, index) => !Array.isArray(point?.location) || point.location.length !== 2
    || !point.location.every(Number.isFinite) || Math.abs(point.location[0]) > 180 || Math.abs(point.location[1]) > 90
    || !Number.isFinite(point.distance) || point.distance! < 0 || point.distance! > maxSnapMeters
    || meters(ordered[index], { lon: point.location[0], lat: point.location[1] }) > maxSnapMeters)) return null;
  const direct = ordered.slice(1).reduce((total, point, index) => total + meters(ordered[index], point), 0);
  if (!(direct > 0) || direct > MAX_DIRECT_METERS || route.distance! > Math.max(8_000, direct * 5)) return null;
  if (geometry.some((point, index) => index > 0 && Math.abs(point[0] - geometry[index - 1][0]) > 180)) return null;
  let cursor = 0;
  let corridorError = 0;
  for (const waypoint of waypoints) {
    let best = { index: -1, distance: Infinity };
    for (let index = cursor; index < geometry.length; index += 1) {
      const distance = meters({ lon: geometry[index][0], lat: geometry[index][1] }, {
        lon: waypoint.location![0], lat: waypoint.location![1],
      });
      if (distance < best.distance) best = { index, distance };
    }
    if (best.index < 0 || best.distance > 1_000) return null;
    cursor = best.index;
    corridorError += best.distance;
  }
  if (obviousSelfIntersection(geometry)) return null;
  const id = createHash("sha256")
    .update(JSON.stringify(["osrm", profile, geometry, route.distance, route.duration]))
    .digest("hex").slice(0, 24);
  return {
    id,
    geometry,
    distanceMeters: route.distance!,
    durationSeconds: route.duration!,
    provider: "osrm",
    profile,
    relevance: Math.round(1000 / (1 + route.distance! / direct + corridorError / 1000)),
    snapping: {
      maxDistanceMeters: maxSnapMeters,
      waypoints: waypoints.map((point, index) => ({
        requested: [ordered[index].lon, ordered[index].lat],
        snapped: [point.location![0], point.location![1]],
        distanceMeters: meters(ordered[index], { lon: point.location![0], lat: point.location![1] }),
        providerDistanceMeters: point.distance!,
      })),
    },
  };
}

export function createOsrmRouteCandidateProvider(
  baseUrls: Partial<Record<RoadProfile, string | null>>,
  fetcher: typeof fetch = fetch,
): RouteCandidateProvider {
  return {
    id: "osrm",
    supports: (profile) => Boolean(baseUrls[profile]),
    async candidates({ coordinates, profile, alternativesCount, signal }: RouteCandidateRequest) {
      const baseUrl = baseUrls[profile];
      if (!baseUrl) throw new RoutingUnavailableError("This road profile is not configured");
      if (coordinates.length < 2 || coordinates.length > 18 || alternativesCount < 1 || alternativesCount > 3) {
        throw new RoutingUnavailableError("Road route request exceeds provider limits");
      }
      const coordinatePath = coordinates.map(({ lon, lat }) => `${lon},${lat}`).join(";");
      const url = new URL(`${baseUrl}/route/v1/${profile}/${coordinatePath}`);
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("alternatives", String(alternativesCount - 1));
      // Each URL must serve a graph built for that profile. Check every step
      // as well: a graph may use a ferry/train or be configured incorrectly.
      url.searchParams.set("steps", "true");
      let response: Response;
      try {
        response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      } catch {
        throw new RoutingUnavailableError();
      }
      if (!response.ok && response.status !== 400) throw new RoutingUnavailableError();
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 1_000_000) throw new RoutingUnavailableError("Road route response is too large");
      let payload: OsrmResponse;
      try {
        const body = await response.text();
        if (body.length > 1_000_000) throw new Error("oversized");
        payload = JSON.parse(body) as OsrmResponse;
      } catch {
        throw new RoutingUnavailableError("Road route response is invalid");
      }
      if (!payload || typeof payload !== "object") throw new RoutingUnavailableError("Road route response is invalid");
      if (!response.ok) {
        if (payload.code === "NoRoute" || payload.code === "NoSegment") return [];
        throw new RoutingUnavailableError();
      }
      if (payload.code !== "Ok") return [];
      if (!Array.isArray(payload.waypoints) || !Array.isArray(payload.routes)) {
        throw new RoutingUnavailableError("Road route response is invalid");
      }
      return payload.routes
        .slice(0, alternativesCount)
        .map((route) => acceptOsrmCandidate(route, payload.waypoints!, coordinates, profile))
        .filter((candidate): candidate is RouteCandidate => candidate !== null)
        .sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id));
    },
  };
}
