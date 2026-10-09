import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { getRouteSegmentContext, writeRouteSegment } from "../repositories/route-segment-repository";
import { markAutoRoutePriority } from "../routing/auto-route-status";
import { RoutingInvalidError } from "../routing/route-candidate-provider";
import { routingProvider as provider } from "../routing/routing-provider";
import { MAX_SELECTED_POINT_METERS, routingDistanceMeters, validRoutingCoordinate } from "../routing/routing-coordinates";
import type { RoadProfile, RouteAccessPoints, RouteCandidate, RouteShapePoint } from "../../src/journey/types";
import { createRoutePointSuggestionRoutes, whileRoutingPrepares } from "./route-point-suggestions";
import { readJsonObject } from "./json-body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const journeyRouteSegmentRoutes = new Hono();
journeyRouteSegmentRoutes.route("/", createRoutePointSuggestionRoutes(provider));

function routeIds(context: { req: { param: (name: string) => string } }) {
  const ids = ["journeyId", "fromId", "toId"].map((name) => context.req.param(name));
  if (ids.some((id) => !UUID.test(id))) {
    throw new RoutingInvalidError("INVALID_ROUTE_SEGMENT", "Route segment identifiers are invalid");
  }
  return ids as [string, string, string];
}

function signCandidate(journeyId: string, sourceKey: string, revision: number, candidate: RouteCandidate) {
  return createHmac("sha256", serverConfig.authSecret)
    .update(JSON.stringify(["route-candidate-v1", journeyId, sourceKey, revision, candidate]))
    .digest("hex");
}

function signatureMatches(expected: string, supplied: unknown) {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

function validShapePoints(raw: unknown): raw is RouteShapePoint[] {
  if (!Array.isArray(raw) || raw.length > 16) return false;
  const ids = new Set<string>();
  return raw.every((point) => {
    if (!point || typeof point !== "object") return false;
    const value = point as Record<string, unknown>;
    if (typeof value.id !== "string" || !UUID.test(value.id) || ids.has(value.id)
      || typeof value.lat !== "number" || typeof value.lon !== "number"
      || (value.label !== undefined && (typeof value.label !== "string" || value.label.length > 120))
      || !Number.isFinite(value.lat) || !Number.isFinite(value.lon)
      || Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return false;
    ids.add(value.id);
    return true;
  });
}

journeyRouteSegmentRoutes.get("/availability", async (context) => {
  await requireAtlasAccess(context.req.raw, "read");
  return context.json({ profiles: (["driving", "walking", "cycling"] as const).filter((profile) => provider.supports(profile)) });
});

journeyRouteSegmentRoutes.post("/journeys/:journeyId/segments/:fromId/:toId/candidates", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const [journeyId, fromId, toId] = routeIds(context);
  const body = await readJsonObject(() => context.req.json());
  const profile = body?.profile as RoadProfile | undefined;
  if (!body || typeof body.sourceKey !== "string" || !Number.isInteger(body.revision)
    || !Number.isInteger(body.alternativesCount) || Number(body.alternativesCount) < 1
    || Number(body.alternativesCount) > 3 || !["driving", "walking", "cycling"].includes(profile ?? "")
    || (body.allowFerries !== undefined && typeof body.allowFerries !== "boolean")) {
    throw new RoutingInvalidError("INVALID_ROUTE_CANDIDATE_REQUEST", "Route candidate request is invalid");
  }
  if (!provider.supports(profile!)) {
    throw new RoutingInvalidError("UNSUPPORTED_ROUTE_PROFILE", "This road profile is not configured", 422);
  }
  const segment = await getRouteSegmentContext(journeyId, atlas.id, fromId, toId);
  if (!segment) return context.json({ error: "ROUTE_SEGMENT_NOT_FOUND" }, 404);
  const revision = segment.record?.revision ?? 0;
  if (segment.sourceKey !== body.sourceKey || revision !== body.revision) {
    throw new RoutingInvalidError("ROUTE_SEGMENT_CHANGED", "Route segment changed; request new candidates", 409);
  }
  const coordinates = [segment.from, ...(segment.record?.shapePoints ?? []), segment.to];
  const access = (body.accessPoints ?? {}) as RouteAccessPoints;
  if (!access || typeof access !== "object" || Array.isArray(access)
    || Object.keys(access).some((key) => !["from", "to"].includes(key))
    || Object.values(access).some((point) => !validRoutingCoordinate(point))
    || (access.from && routingDistanceMeters(access.from, segment.from) > MAX_SELECTED_POINT_METERS)
    || (access.to && routingDistanceMeters(access.to, segment.to) > MAX_SELECTED_POINT_METERS)) {
    throw new RoutingInvalidError("INVALID_ROUTE_ACCESS_POINTS", "Selected road access points are invalid");
  }
  const result = await whileRoutingPrepares(context, () => provider.candidates({
    coordinates,
    routingCoordinates: [access.from ?? segment.from, ...coordinates.slice(1, -1), access.to ?? segment.to],
    profile: profile!,
    alternativesCount: body.alternativesCount as 1 | 2 | 3,
    signal: context.req.raw.signal,
    allowFerries: body.allowFerries === true,
  }));
  // Nothing is signed while the road graph is prepared; the client retries.
  if ("preparing" in result) return result.preparing;
  const candidates = result.value;
  // The provider can finish after another tab edits this segment. Its result
  // must never become a candidate for that newer shape revision.
  const latest = await getRouteSegmentContext(journeyId, atlas.id, fromId, toId);
  if (!latest || latest.sourceKey !== segment.sourceKey || (latest.record?.revision ?? 0) !== revision) {
    throw new RoutingInvalidError("ROUTE_SEGMENT_CHANGED", "Route segment changed; request new candidates", 409);
  }
  context.header("Cache-Control", "private, no-store");
  return context.json({
    sourceKey: segment.sourceKey,
    revision,
    candidates: candidates.map((candidate) => ({
      candidate,
      confirmationToken: signCandidate(journeyId, segment.sourceKey, revision, candidate),
    })),
  });
});

journeyRouteSegmentRoutes.put("/journeys/:journeyId/segments/:fromId/:toId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const [journeyId, fromId, toId] = routeIds(context);
  const body = await readJsonObject(() => context.req.json());
  if (!body || typeof body.sourceKey !== "string" || !Number.isInteger(body.expectedRevision)
    || Number(body.expectedRevision) < 0 || !["shape", "none", "confirm"].includes(String(body.action))) {
    throw new RoutingInvalidError("INVALID_ROUTE_SEGMENT_WRITE", "Route segment change is invalid");
  }
  const action = body.action as "shape" | "none" | "confirm";
  if (action === "shape" && !validShapePoints(body.shapePoints)) {
    throw new RoutingInvalidError("INVALID_ROUTE_SHAPE_POINTS", "Route shape points are invalid");
  }
  const candidate = body.candidate as RouteCandidate | undefined;
  if (action === "confirm" && (!candidate || typeof candidate.id !== "string"
    || !signatureMatches(signCandidate(journeyId, body.sourceKey, body.expectedRevision as number, candidate), body.confirmationToken))) {
    throw new RoutingInvalidError("INVALID_ROUTE_CONFIRMATION", "Route candidate confirmation is invalid");
  }
  const record = await writeRouteSegment(journeyId, atlas.id, fromId, toId, {
    sourceKey: body.sourceKey,
    expectedRevision: body.expectedRevision as number,
    action,
    ...(action === "shape" ? { shapePoints: body.shapePoints as RouteShapePoint[] } : {}),
    ...(action === "confirm" ? { candidate } : {}),
  });
  if (!record) return context.json({ error: "ROUTE_SEGMENT_NOT_FOUND" }, 404);
  markAutoRoutePriority([journeyId]);
  context.header("Cache-Control", "private, no-store");
  return context.json({ segment: record });
});
