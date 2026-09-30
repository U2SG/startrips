import { describe, expect, it } from "vitest";
import { createOsrmRouteCandidateProvider } from "./osrm-route-candidate-provider";

const coordinates = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }] as const;

function providerWith(payload: unknown) {
  const fetcher = async () => new Response(JSON.stringify(payload), { status: 200 });
  return createOsrmRouteCandidateProvider("http://routing.internal:5000", fetcher as typeof fetch);
}

function osrmResponse(routes: unknown[], waypoints = [
  { location: [0, 0], distance: 0 },
  { location: [0.1, 0], distance: 0 },
]) {
  return { code: "Ok", routes: routes.map((route) => ({
    legs: Array.from({ length: waypoints.length - 1 }, () => ({ steps: [{ mode: "driving" }] })),
    ...(route as object),
  })), waypoints };
}

const direct = {
  distance: 12_000,
  duration: 900,
  geometry: { type: "LineString", coordinates: [[0, 0], [0.05, 0], [0.1, 0]] },
};

describe("OSRM road candidate gate", () => {
  it("returns stable suggested geometries and ranks alternatives as relevance only", async () => {
    const provider = providerWith(osrmResponse([
      { distance: 16_000, duration: 1_200, geometry: {
        type: "LineString", coordinates: [[0, 0], [0.05, 0.02], [0.1, 0]],
      } },
      direct,
    ]));
    const request = { coordinates, profile: "driving" as const, alternativesCount: 3 as const, signal: new AbortController().signal };
    const first = await provider.candidates(request);
    expect(first).toHaveLength(2);
    expect(first[0].distanceMeters).toBe(12_000);
    expect(first[0].id).toBe((await provider.candidates(request))[0].id);
    expect(first[0]).not.toHaveProperty("provenance", "user-confirmed-route");
  });

  it("rejects a snapped point outside tolerance and a route skipping an ordered shape point", async () => {
    const shifted = providerWith(osrmResponse([direct], [
      { location: [0, 0], distance: 0 },
      { location: [0.1, 0], distance: 900 },
    ]));
    expect(await shifted.candidates({ coordinates, profile: "driving", alternativesCount: 1, signal: new AbortController().signal })).toEqual([]);
    const via = providerWith(osrmResponse([direct], [
      { location: [0, 0], distance: 0 },
      { location: [0.05, 0.05], distance: 0 },
      { location: [0.1, 0], distance: 0 },
    ]));
    expect(await via.candidates({
      coordinates: [coordinates[0], { lat: 0.05, lon: 0.05 }, coordinates[1]],
      profile: "driving", alternativesCount: 1, signal: new AbortController().signal,
    })).toEqual([]);
  });

  it("rejects impossible long roads and requires configured explicit driving", async () => {
    const provider = providerWith(osrmResponse([direct]));
    expect(await provider.candidates({
      coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }],
      profile: "driving", alternativesCount: 1, signal: new AbortController().signal,
    })).toEqual([]);
    expect(createOsrmRouteCandidateProvider(null).supports("driving")).toBe(false);
    expect(provider.supports("walking")).toBe(false);
  });

  it("does not label a ferry step as a driving road", async () => {
    const provider = providerWith(osrmResponse([{
      ...direct, legs: [{ steps: [{ mode: "driving" }, { mode: "ferry" }] }],
    }]));
    expect(await provider.candidates({
      coordinates, profile: "driving", alternativesCount: 1, signal: new AbortController().signal,
    })).toEqual([]);
  });
});
