import { describe, expect, it, vi } from "vitest";
import { createRoutingBaseUrlResolver } from "./graph-builder-client";
import { createOsrmRouteCandidateProvider } from "./osrm-route-candidate-provider";
import { RoutingGraphError, RoutingPreparingError } from "./route-candidate-provider";

const id = "a".repeat(64);
const points = [{ lat: -36.85, lon: 174.76 }, { lat: -36.86, lon: 174.78 }];
const signal = () => new AbortController().signal;
const builder = (body: unknown, status = 200) => vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
  new Response(JSON.stringify(body), { status }));

describe("on-demand road graph resolution", () => {
  it("keeps a static profile URL ahead of the builder and never calls the builder for it", async () => {
    const fetcher = builder({ id, state: "ready" });
    const resolver = createRoutingBaseUrlResolver({ driving: "http://car.internal:5000" }, "http://routing-builder:8080", fetcher);
    expect(await resolver.resolve("driving", points, signal())).toBe("http://car.internal:5000");
    expect(fetcher).not.toHaveBeenCalled();
    expect((["driving", "walking", "cycling"] as const).map(resolver.supports)).toEqual([true, true, true]);
    expect(createRoutingBaseUrlResolver({ driving: "http://car.internal:5000" }, null).supports("walking")).toBe(false);
  });

  it("posts the profile and points and returns the graph proxy as the OSRM base URL", async () => {
    const fetcher = builder({ id, state: "ready" });
    const resolver = createRoutingBaseUrlResolver({}, "http://routing-builder:8080", fetcher);
    expect(await resolver.resolve("walking", points, signal())).toBe(`http://routing-builder:8080/graphs/${id}`);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("http://routing-builder:8080/graphs");
    expect(JSON.parse(String(init?.body))).toEqual({ profile: "walking", points });
  });

  it.each([["queued", 3_000], ["fetching", 2_000], ["building", 2_000]] as const)("reports a %s graph as preparing", async (state, retryAfterMs) => {
    const resolver = createRoutingBaseUrlResolver({}, "http://routing-builder:8080", builder({ id, state }));
    const error = await resolver.resolve("cycling", points, signal()).catch((reason) => reason);
    expect(error).toBeInstanceOf(RoutingPreparingError);
    expect(error).toMatchObject({ phase: state, retryAfterMs });
  });

  it.each([
    [{ id, state: "failed", error: "ROUTING_DATA_UNAVAILABLE" }, 200, "ROUTING_DATA_UNAVAILABLE", 503],
    [{ id, state: "failed", error: "ROUTING_GRAPH_BUILD_FAILED" }, 200, "ROUTING_GRAPH_BUILD_FAILED", 503],
    [{ id, state: "failed", error: "ROUTING_NO_ROADS" }, 200, "ROUTING_NO_ROADS", 422],
    [{ error: "ROUTING_AREA_TOO_LARGE" }, 422, "ROUTING_AREA_TOO_LARGE", 422],
    [{ error: "ROUTING_BUILDER_BUSY" }, 503, "ROUTING_UNAVAILABLE", 503],
    [{ id: "../etc", state: "ready" }, 200, "ROUTING_UNAVAILABLE", 503],
    [{ id, state: "exploded" }, 200, "ROUTING_UNAVAILABLE", 503],
  ])("maps builder answer %j to a structured failure", async (body, status, code, httpStatus) => {
    const resolver = createRoutingBaseUrlResolver({}, "http://routing-builder:8080", builder(body, status));
    await expect(resolver.resolve("driving", points, signal())).rejects.toMatchObject({ code, status: httpStatus });
  });

  it("treats an unreachable builder as unavailable routing", async () => {
    const resolver = createRoutingBaseUrlResolver({}, "http://routing-builder:8080", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(resolver.resolve("driving", points, signal())).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE", status: 503 });
  });

  it("asks for a graph only after the provider's request gates and routes through the graph proxy", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith("/graphs")) return new Response(JSON.stringify({ id, state: "ready" }));
      return new Response(JSON.stringify({ code: "NoRoute" }), { status: 400 });
    });
    const provider = createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({}, "http://routing-builder:8080", fetcher), fetcher);
    const request = { profile: "driving" as const, alternativesCount: 1 as const, signal: signal() };
    expect(await provider.candidates({ ...request, coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 5 }] })).toEqual([]);
    expect(urls).toEqual([]);
    expect(await provider.candidates({ ...request, coordinates: points })).toEqual([]);
    expect(urls[0]).toBe("http://routing-builder:8080/graphs");
    expect(urls[1]).toMatch(new RegExp(`^http://routing-builder:8080/graphs/${id}/route/v1/driving/`));
  });

  describe("one escalation to an extended graph", () => {
    const extendedId = "b".repeat(64);
    const near = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }];
    const route = { distance: 12_000, duration: 900, geometry: { type: "LineString", coordinates: [[0, 0], [0.05, 0], [0.1, 0]] },
      legs: [{ steps: [{ mode: "driving" }] }] };
    // The standard graph is an island: OSRM snaps the start ~1 degree away.
    function graphs({ extendedState = "ready", standardSnap = [1, 0] }: { extendedState?: string; standardSnap?: number[] } = {}) {
      const posted: unknown[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/graphs")) {
          const body = JSON.parse(String(init?.body));
          posted.push(body);
          return new Response(JSON.stringify(body.detail === "extended" ? { id: extendedId, state: extendedState } : { id, state: "ready" }));
        }
        const snapped = url.includes(extendedId) ? [0, 0] : standardSnap;
        return new Response(JSON.stringify({ code: "Ok", routes: [route],
          waypoints: [{ location: snapped, distance: 10 }, { location: [0.1, 0], distance: 0 }] }));
      });
      return { fetcher, posted };
    }
    const request = { coordinates: near, profile: "driving" as const, alternativesCount: 1 as const, signal: signal() };

    it("retries once on the extended graph when a waypoint snaps beyond the profile limit", async () => {
      const { fetcher, posted } = graphs();
      const provider = createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({}, "http://routing-builder:8080", fetcher), fetcher);
      const [candidate] = await provider.candidates(request);
      expect(candidate?.snapping.waypoints[0].snapped).toEqual([0, 0]);
      expect(posted).toEqual([{ profile: "driving", points: near }, { profile: "driving", points: near, detail: "extended" }]);
    });

    it("does not escalate an accepted result or a static graph, and reports a preparing extended graph", async () => {
      const connected = graphs({ standardSnap: [0, 0] });
      await createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({}, "http://routing-builder:8080", connected.fetcher), connected.fetcher)
        .candidates(request);
      expect(connected.posted).toHaveLength(1);
      const island = graphs();
      const fixed = createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({ driving: `http://routing-builder:8080/graphs/${id}` }, "http://routing-builder:8080", island.fetcher), island.fetcher);
      expect(await fixed.candidates(request)).toEqual([]);
      expect(island.posted).toEqual([]);
      const preparing = graphs({ extendedState: "fetching" });
      await expect(createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({}, "http://routing-builder:8080", preparing.fetcher), preparing.fetcher)
        .candidates(request)).rejects.toBeInstanceOf(RoutingPreparingError);
    });

    it("retries nearby point suggestions once when every nearby road fails the connectivity check", async () => {
      const posted: unknown[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/graphs") {
          const body = JSON.parse(String(init?.body));
          posted.push(body);
          return new Response(JSON.stringify({ id: body.detail === "extended" ? extendedId : id, state: "ready" }));
        }
        if (url.pathname.includes("/nearest/")) return new Response(JSON.stringify({ code: "Ok", waypoints: [{ location: [0.001, 0], distance: 111, name: "Lane" }] }));
        if (!url.pathname.includes(extendedId)) return new Response(JSON.stringify({ code: "NoRoute" }), { status: 400 });
        const locations = url.pathname.split("/").at(-1)!.split(";").map((point) => point.split(",").map(Number));
        return new Response(JSON.stringify({ code: "Ok", waypoints: locations.map((location) => ({ location, distance: 0 })),
          routes: [{ distance: 12_000, duration: 900, legs: [{ steps: [{ mode: "driving" }] }, { steps: [{ mode: "driving" }] }] }] }));
      });
      const provider = createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({}, "http://routing-builder:8080", fetcher), fetcher);
      const suggestions = await provider.pointSuggestions({ coordinate: { lat: 0, lon: 0 }, profile: "driving", signal: signal(),
        neighbors: { before: { lat: 0, lon: -0.1 }, after: { lat: 0, lon: 0.1 } } });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({ label: "Lane", connected: true });
      expect(posted.map((body) => (body as { detail?: string }).detail)).toEqual([undefined, "extended"]);
    });
  });

  it("carries the graph error status through the error class", () => {
    expect(new RoutingGraphError("ROUTING_AREA_TOO_LARGE", "x").status).toBe(422);
    expect(new RoutingGraphError("ROUTING_DATA_UNAVAILABLE", "x").status).toBe(503);
  });
});
