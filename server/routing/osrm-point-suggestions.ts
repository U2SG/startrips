import { createHash } from "node:crypto";
import type { RoadProfile, RoutePointSuggestion } from "../../src/journey/types";
import { RoutingUnavailableError, type RoutePointSuggestionRequest, type RoutingCoordinate } from "./route-candidate-provider";
import { compatibleRoutingStep, MAX_SELECTED_POINT_METERS, routingDistanceMeters, validRoutingCoordinate } from "./routing-coordinates";

type NearestPoint = { location?: unknown; distance?: unknown; name?: unknown; hint?: unknown };

export function createOsrmPointSuggestions(baseUrls: Partial<Record<RoadProfile, string | null>>, fetcher: typeof fetch = fetch) {
  return async ({ coordinate, neighbors, profile, allowFerries = false, signal }: RoutePointSuggestionRequest): Promise<RoutePointSuggestion[]> => {
    const baseUrl = baseUrls[profile];
    if (!baseUrl) throw new RoutingUnavailableError("This road profile is not configured");
    if (!validRoutingCoordinate(coordinate)
      || Object.values(neighbors).some((point) => !validRoutingCoordinate(point))) {
      throw new RoutingUnavailableError("Road point coordinates are invalid");
    }
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    async function read(url: URL) {
      let response: Response;
      try { response = await fetcher(url, { signal: boundedSignal }); }
      catch { throw new RoutingUnavailableError("Nearby road service is temporarily unavailable"); }
      if (!response.ok && response.status !== 400) throw new RoutingUnavailableError();
      if (Number(response.headers.get("content-length") ?? 0) > 250_000) throw new RoutingUnavailableError("Nearby road response is too large");
      let payload;
      try {
        const text = await response.text();
        if (text.length > 250_000) throw new Error("oversized");
        payload = JSON.parse(text);
      } catch { throw new RoutingUnavailableError("Nearby road response is invalid"); }
      if (!payload || typeof payload !== "object") throw new RoutingUnavailableError("Nearby road response is invalid");
      if (!response.ok && !["NoRoute", "NoSegment"].includes(payload.code)) throw new RoutingUnavailableError();
      return payload;
    }
    const nearestUrl = new URL(`${baseUrl}/nearest/v1/${profile}/${coordinate.lon},${coordinate.lat}`);
    nearestUrl.searchParams.set("number", "20");
    const nearest = await read(nearestUrl);
    if (["NoSegment", "NoRoute"].includes(nearest.code)) return [];
    if (nearest.code !== "Ok" || !Array.isArray(nearest.waypoints)) throw new RoutingUnavailableError("Nearby road response is invalid");
    const points: { coordinate: RoutingCoordinate; distanceMeters: number; label: string; hint: string }[] = [];
    for (const raw of nearest.waypoints.slice(0, 20) as NearestPoint[]) {
      if (!raw || !Array.isArray(raw.location) || raw.location.length !== 2) continue;
      const point = { lon: raw.location[0], lat: raw.location[1] };
      if (!validRoutingCoordinate(point) || typeof raw.distance !== "number" || !Number.isFinite(raw.distance)
        || raw.distance < 0 || raw.distance > MAX_SELECTED_POINT_METERS) continue;
      const distanceMeters = routingDistanceMeters(coordinate, point);
      if (distanceMeters > MAX_SELECTED_POINT_METERS || points.some((entry) => routingDistanceMeters(entry.coordinate, point) < 80)) continue;
      points.push({ coordinate: point, distanceMeters,
        label: typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "",
        hint: typeof raw.hint === "string" && raw.hint.length <= 2_048 ? raw.hint : "" });
      if (points.length === 5) break;
    }
    const suggestions = await Promise.all(points.map(async (point): Promise<RoutePointSuggestion | null> => {
      const ordered = [neighbors.before, point.coordinate, neighbors.after].filter((entry): entry is RoutingCoordinate => Boolean(entry));
      let connected: boolean | null = null;
      if (ordered.length > 1) {
        const url = new URL(`${baseUrl}/route/v1/${profile}/${ordered.map((entry) => `${entry.lon},${entry.lat}`).join(";")}`);
        url.searchParams.set("overview", "false");
        url.searchParams.set("alternatives", "false");
        url.searchParams.set("steps", "true");
        url.searchParams.set("hints", ordered.map((entry) => entry === point.coordinate ? point.hint : "").join(";"));
        const route = await read(url);
        if (["NoRoute", "NoSegment"].includes(route.code)) return null;
        if (route.code !== "Ok" || !Array.isArray(route.routes) || !Array.isArray(route.waypoints)) {
          throw new RoutingUnavailableError("Nearby road connection response is invalid");
        }
        connected = route.waypoints.length === ordered.length && route.waypoints.every((waypoint: NearestPoint, index: number) => {
          if (!Array.isArray(waypoint?.location) || waypoint.location.length !== 2) return false;
          const snapped = { lon: waypoint.location[0], lat: waypoint.location[1] };
          return validRoutingCoordinate(snapped) && routingDistanceMeters(ordered[index], snapped) <= MAX_SELECTED_POINT_METERS;
        }) && route.routes.some((entry: { distance?: number; duration?: number; legs?: { steps?: { mode?: string }[] }[] }) =>
          Number.isFinite(entry?.distance) && Number(entry.distance) > 0
          && Number.isFinite(entry.duration) && Number(entry.duration) > 0
          && Array.isArray(entry.legs) && entry.legs.length === ordered.length - 1
          && entry.legs.every((leg) => Array.isArray(leg?.steps) && leg.steps.length > 0
            && leg.steps.every((step) => step && compatibleRoutingStep(step.mode, profile, allowFerries))));
        if (!connected) return null;
      }
      return {
        id: createHash("sha256").update(JSON.stringify(["osrm-point", profile, point.coordinate])).digest("hex").slice(0, 24),
        coordinate: point.coordinate, label: point.label, distanceMeters: point.distanceMeters, connected,
      };
    }));
    return suggestions.filter((point): point is RoutePointSuggestion => point !== null)
      .sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id)).slice(0, 3);
  };
}
