import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { RoutingInvalidError, type RouteCandidateProvider } from "../routing/route-candidate-provider";
import { validRoutingCoordinate } from "../routing/routing-coordinates";
import type { RoadProfile } from "../../src/journey/types";
import { readJsonObject } from "./json-body";

export function createRoutePointSuggestionRoutes(provider: Pick<RouteCandidateProvider, "supports" | "pointSuggestions">) {
  const routes = new Hono();
  routes.post("/point-suggestions", async (context) => {
    await requireAtlasAccess(context.req.raw, "read");
    const body = await readJsonObject(() => context.req.json());
    const neighbors = body?.neighbors as Record<string, unknown> | undefined;
    if (!body || !validRoutingCoordinate(body.coordinate)
      || !["driving", "walking", "cycling"].includes(String(body.profile))
      || (body.allowFerries !== undefined && typeof body.allowFerries !== "boolean")
      || !neighbors || typeof neighbors !== "object" || Array.isArray(neighbors)
      || Object.keys(neighbors).some((key) => !["before", "after"].includes(key))
      || Object.values(neighbors).some((point) => !validRoutingCoordinate(point))) {
      throw new RoutingInvalidError("INVALID_ROUTE_POINT_REQUEST", "Nearby road point request is invalid");
    }
    const profile = body.profile as RoadProfile;
    if (!provider.supports(profile)) throw new RoutingInvalidError("UNSUPPORTED_ROUTE_PROFILE", "This road profile is not configured", 422);
    const suggestions = await provider.pointSuggestions({ coordinate: body.coordinate, profile,
      neighbors: {
        ...(validRoutingCoordinate(neighbors.before) ? { before: neighbors.before } : {}),
        ...(validRoutingCoordinate(neighbors.after) ? { after: neighbors.after } : {}),
      }, allowFerries: body.allowFerries === true, signal: context.req.raw.signal });
    context.header("Cache-Control", "private, no-store");
    return context.json({ suggestions });
  });
  return routes;
}
