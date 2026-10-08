import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadProfile } from "../../src/journey/types";
import { RoutingGraphError, RoutingInvalidError, RoutingPreparingError, RoutingUnavailableError } from "../routing/route-candidate-provider";

const access = vi.hoisted(() => vi.fn(async () => ({ atlas: { id: "synthetic-atlas" } })));
vi.mock("../authorization/atlas-access", () => ({ requireAtlasAccess: access }));
const { createRoutePointSuggestionRoutes } = await import("./route-point-suggestions");
const pointSuggestions = vi.fn(async () => [{ id: "road-1", coordinate: { lat: 0, lon: 0.01 }, label: "Road", distanceMeters: 1_112, connected: true }]);
const supports = vi.fn((profile: RoadProfile) => profile !== "cycling");
const app = new Hono().route("/api/journey-route-segments", createRoutePointSuggestionRoutes({ supports, pointSuggestions }));
app.onError((error, context) => {
  if (error instanceof RoutingInvalidError || error instanceof RoutingUnavailableError || error instanceof RoutingGraphError) return context.json({ error: error.code }, error.status as 400);
  throw error;
});
const request = { coordinate: { lat: 0, lon: 0 }, neighbors: { after: { lat: 0, lon: 0.1 } }, profile: "walking" };
const send = (body: unknown) => app.request("/api/journey-route-segments/point-suggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); });
describe("nearby route point HTTP boundary", () => {
  it("authorizes an Atlas read and returns private suggestions without writing a Journey", async () => {
    const response = await send(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(access).toHaveBeenCalledWith(expect.any(Request), "read");
    expect(pointSuggestions).toHaveBeenCalledWith(expect.objectContaining({ ...request, allowFerries: false, signal: expect.any(AbortSignal) }));
    expect((await response.json()).suggestions).toHaveLength(1);
  });
  it.each([
    { ...request, coordinate: { lat: null, lon: 0 } },
    { ...request, coordinate: { lat: 91, lon: 0 } },
    { ...request, neighbors: { atlasId: "other-atlas" } },
    { ...request, neighbors: [{ lat: 0, lon: 0 }] },
    { ...request, neighbors: { before: { lat: 0, lon: "0" } } },
    { ...request, profile: "unknown" },
    { ...request, allowFerries: "true" },
  ])("rejects invalid coordinates, mode or neighbors before provider work", async (body) => {
    const response = await send(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_ROUTE_POINT_REQUEST");
    expect(pointSuggestions).not.toHaveBeenCalled();
  });
  it("does not fall back to another graph for an unsupported mode", async () => {
    expect((await send({ ...request, profile: "cycling" })).status).toBe(422);
    expect(pointSuggestions).not.toHaveBeenCalled();
  });
  it("does not query private road context without Atlas access", async () => {
    access.mockRejectedValueOnce(new RoutingInvalidError("FORBIDDEN", "Denied", 403));
    expect((await send(request)).status).toBe(403);
    expect(pointSuggestions).not.toHaveBeenCalled();
  });
  it("preserves provider outages as structured failures", async () => {
    pointSuggestions.mockRejectedValueOnce(new RoutingUnavailableError());
    const response = await send(request);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("ROUTING_UNAVAILABLE");
  });
  it("answers 202 with the phase while the on-demand road graph is prepared", async () => {
    pointSuggestions.mockRejectedValueOnce(new RoutingPreparingError("building", 2_000));
    const response = await send(request);
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({ status: "preparing", phase: "building", retryAfterMs: 2_000 });
  });
  it.each([["ROUTING_AREA_TOO_LARGE", 422], ["ROUTING_NO_ROADS", 422], ["ROUTING_DATA_UNAVAILABLE", 503]] as const)("keeps the specific %s graph failure", async (code, status) => {
    pointSuggestions.mockRejectedValueOnce(new RoutingGraphError(code, "x"));
    const response = await send(request);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toBe(code);
  });
});
