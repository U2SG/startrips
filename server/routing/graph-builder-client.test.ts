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

  it("carries the graph error status through the error class", () => {
    expect(new RoutingGraphError("ROUTING_AREA_TOO_LARGE", "x").status).toBe(422);
    expect(new RoutingGraphError("ROUTING_DATA_UNAVAILABLE", "x").status).toBe(503);
  });
});
