import { describe, expect, it } from "vitest";
import { createOsrmRouteCandidateProvider } from "./osrm-route-candidate-provider";

const coordinates = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }] as const;

function providerWith(payload: unknown) {
  const fetcher = async () => new Response(JSON.stringify(payload), { status: 200 });
  return createOsrmRouteCandidateProvider({ driving: "http://routing.internal:5000" }, fetcher as typeof fetch);
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

function denseRoad(): [number, number][] {
  const geometry: [number, number][] = Array.from({ length: 8_001 }, (_, index) => [
    index / 8_000 * 0.3, Math.sin(index / 8_000 * Math.PI) * 0.003,
  ]);
  geometry[geometry.length - 1] = [0.3, 0];
  return geometry;
}

describe("OSRM road candidate gate", () => {
  it.each(["driving", "walking", "cycling"] as const)("keeps a dense %s road and its ordered shape anchor within a bounded snapshot", async (profile) => {
    const geometry = denseRoad();
    const anchors = [geometry[0], geometry[4_000], geometry.at(-1)!];
    const waypoints = anchors.map((location) => ({ location, distance: 0 }));
    const provider = createOsrmRouteCandidateProvider({ [profile]: "http://routing.internal:5000" },
      (async () => new Response(JSON.stringify(osrmResponse([{
        ...direct, distance: 35_000, geometry: { type: "LineString", coordinates: geometry },
        legs: [{ steps: [{ mode: profile }] }, { steps: [{ mode: profile }] }],
      }], waypoints)))) as typeof fetch);
    const request = { coordinates: anchors.map(([lon, lat]) => ({ lon, lat })), profile,
      alternativesCount: 1 as const, signal: new AbortController().signal };
    const [candidate] = await provider.candidates(request);
    expect(candidate.geometry.length).toBeLessThanOrEqual(4_000);
    expect(candidate.geometry[0]).toEqual(anchors[0]);
    expect(candidate.geometry.at(-1)).toEqual(anchors[2]);
    expect(candidate.geometry).toContainEqual(anchors[1]);
    expect(candidate).toMatchObject({ distanceMeters: 35_000, durationSeconds: 900, profile, provider: "osrm" });
    expect(candidate.snapping.waypoints.map((point) => point.requested)).toEqual(anchors);
    expect((await provider.candidates(request))[0].id).toBe(candidate.id);

    // Independently measure the retained polyline against every source sample.
    let segment = 0;
    let maximumErrorMeters = 0;
    for (const [lon, lat] of geometry) {
      while (segment + 1 < candidate.geometry.length - 1 && candidate.geometry[segment + 1][0] < lon) segment += 1;
      const [x, y] = candidate.geometry[segment];
      const [endX, endY] = candidate.geometry[segment + 1];
      const dx = endX - x, dy = endY - y;
      const fraction = Math.max(0, Math.min(1, ((lon - x) * dx + (lat - y) * dy) / (dx * dx + dy * dy)));
      maximumErrorMeters = Math.max(maximumErrorMeters, 111_320 * Math.hypot(lon - x - fraction * dx, lat - y - fraction * dy));
    }
    expect(maximumErrorMeters).toBeLessThanOrEqual(5.1);
  });

  it("rejects a dense road that skips a required shape point", async () => {
    const geometry = denseRoad();
    const anchors = [[0, 0], [0.15, 0.05], [0.3, 0]];
    const provider = providerWith(osrmResponse([{
      ...direct, distance: 35_000, geometry: { type: "LineString", coordinates: geometry },
    }], anchors.map((location) => ({ location, distance: 0 }))));
    expect(await provider.candidates({ coordinates: anchors.map(([lon, lat]) => ({ lon, lat })),
      profile: "driving", alternativesCount: 1, signal: new AbortController().signal })).toEqual([]);
  });

  it("validates every raw vertex and bounds raw input before simplifying", async () => {
    const invalid = denseRoad();
    invalid[4_123] = [Number.NaN, 0];
    for (const geometry of [invalid, Array.from({ length: 32_001 }, () => [0, 0])]) {
      const provider = providerWith(osrmResponse([{ ...direct, geometry: { type: "LineString", coordinates: geometry } }]));
      expect(await provider.candidates({ coordinates, profile: "driving", alternativesCount: 1,
        signal: new AbortController().signal })).toEqual([]);
    }
  });

  it("keeps the output budget when a sharp road cannot be simplified within the shape tolerance", async () => {
    const geometry = Array.from({ length: 4_201 }, (_, index) => [index / 4_200 * 0.1, index % 2 ? 0.002 : 0]);
    const provider = providerWith(osrmResponse([{ ...direct, geometry: { type: "LineString", coordinates: geometry } }]));
    expect(await provider.candidates({ coordinates, profile: "driving", alternativesCount: 1,
      signal: new AbortController().signal })).toEqual([]);
  });

  it("does not simplify an obvious crossing into an accepted dense road", async () => {
    const corners = [[0, 0], [0.2, 0.1], [0, 0.1], [0.2, 0]];
    const geometry = corners.slice(1).flatMap((end, leg) => Array.from({ length: 2_001 }, (_, index) => [
      corners[leg][0] + (end[0] - corners[leg][0]) * index / 2_000,
      corners[leg][1] + (end[1] - corners[leg][1]) * index / 2_000,
    ]));
    const provider = providerWith(osrmResponse([{
      ...direct, distance: 50_000, geometry: { type: "LineString", coordinates: geometry },
    }], [{ location: corners[0], distance: 0 }, { location: corners[3], distance: 0 }]));
    expect(await provider.candidates({ coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.2 }],
      profile: "driving", alternativesCount: 1, signal: new AbortController().signal })).toEqual([]);
  });

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
    expect(first[0].snapping).toEqual({ maxDistanceMeters: 10_000, waypoints: [
      { requested: [0, 0], snapped: [0, 0], distanceMeters: 0, providerDistanceMeters: 0 },
      { requested: [0.1, 0], snapped: [0.1, 0], distanceMeters: 0, providerDistanceMeters: 0 },
    ] });
  });

  it("preserves inspectable accepted offsets and rejects either distance outside the bound", async () => {
    const request = { coordinates, profile: "driving" as const, alternativesCount: 1 as const, signal: new AbortController().signal };
    const snappedRoute = { ...direct, geometry: { type: "LineString", coordinates: [[0, 0.0065], [0.05, 0.0065], [0.1, 0.0065]] } };
    const waypoints = [{ location: [0, 0.0065], distance: 750 }, { location: [0.1, 0.0065], distance: 750 }];
    const [accepted] = await providerWith(osrmResponse([snappedRoute], waypoints)).candidates(request);
    expect(accepted.snapping.maxDistanceMeters).toBe(10_000);
    expect(accepted.snapping.waypoints[0]).toMatchObject({ requested: [0, 0], snapped: [0, 0.0065], providerDistanceMeters: 750 });
    expect(accepted.snapping.waypoints[0].distanceMeters).toBeGreaterThan(720);
    expect(accepted.snapping.waypoints[0].distanceMeters).toBeLessThan(750);
    for (const outside of [
      [{ location: [0, 0.0065], distance: 10_000.01 }, waypoints[1]],
      [{ location: [0, 0.1], distance: 0 }, waypoints[1]],
      [{ location: [0, 0.0065], distance: -1 }, waypoints[1]],
    ]) {
      expect(await providerWith(osrmResponse([snappedRoute], outside)).candidates(request)).toEqual([]);
    }
  });

  it.each([[0, 0], [45, -110], [-35, 150]])("preserves requested places and shape points at latitude %s, longitude %s", async (lat, lon) => {
    const requested = [{ lat, lon }, { lat, lon: lon + 0.05 }, { lat, lon: lon + 0.1 }];
    const snapped = [[lon, lat + 0.06], [lon + 0.05, lat + 0.05], [lon + 0.1, lat + 0.04]];
    const waypoints = snapped.map((location, index) => ({ location, distance: [6_500, 5_500, 4_400][index] }));
    const route = { ...direct, geometry: { type: "LineString", coordinates: snapped } };
    const [accepted] = await providerWith(osrmResponse([route], waypoints)).candidates({
      coordinates: requested, profile: "driving", alternativesCount: 1, signal: new AbortController().signal,
    });
    expect(accepted.snapping.waypoints.map((point) => point.requested)).toEqual(requested.map((point) => [point.lon, point.lat]));
    expect(accepted.snapping.waypoints.map((point) => point.snapped)).toEqual(snapped);
    expect(accepted.snapping.waypoints[0].distanceMeters).toBeGreaterThan(6_500);
    expect(accepted.snapping.waypoints[1].distanceMeters).toBeGreaterThan(5_500);
    expect(accepted.snapping.waypoints[2].distanceMeters).toBeGreaterThan(4_400);
    expect(accepted.geometry).toEqual(route.geometry.coordinates);
  });

  it("rejects a snapped point outside tolerance and a route skipping an ordered shape point", async () => {
    const shifted = providerWith(osrmResponse([direct], [
      { location: [0, 0], distance: 0 },
      { location: [0.1, 0], distance: 11_000 },
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
    expect(createOsrmRouteCandidateProvider({}).supports("driving")).toBe(false);
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

  it.each(["driving", "walking", "cycling"] as const)("uses the configured %s graph and preserves that mode", async (profile) => {
    const calls: URL[] = [];
    const provider = createOsrmRouteCandidateProvider({
      driving: "http://car.internal:5000", walking: "http://foot.internal:5000", cycling: "http://bike.internal:5000",
    }, (async (url: URL) => {
      calls.push(url);
      return new Response(JSON.stringify(osrmResponse([{ ...direct, legs: [{ steps: [{ mode: profile }] }] }])));
    }) as typeof fetch);
    const [candidate] = await provider.candidates({ coordinates, profile, alternativesCount: 1, signal: new AbortController().signal });
    const host = { driving: "car", walking: "foot", cycling: "bike" }[profile];
    expect(calls[0].origin).toBe(`http://${host}.internal:5000`);
    expect(calls[0].pathname).toBe(`/route/v1/${profile}/0,0;0.1,0`);
    expect(calls[0].searchParams.get("steps")).toBe("true");
    expect(candidate.profile).toBe(profile);
    expect(candidate.snapping.maxDistanceMeters).toBe(profile === "driving" ? 10_000 : 750);
  });

  it("never falls back to driving for an unconfigured walking or cycling graph", async () => {
    let calls = 0;
    const provider = createOsrmRouteCandidateProvider({ driving: "http://car.internal:5000" }, (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch);
    for (const profile of ["walking", "cycling"] as const) {
      expect(provider.supports(profile)).toBe(false);
      await expect(provider.candidates({ coordinates, profile, alternativesCount: 1, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE", status: 503 });
    }
    expect(calls).toBe(0);
  });

  it.each(["walking", "cycling"] as const)("rejects mismatched transport and distant snaps for %s", async (profile) => {
    for (const mode of ["driving", "ferry", "train", profile === "walking" ? "cycling" : "walking"]) {
      const provider = createOsrmRouteCandidateProvider({ [profile]: "http://routing.internal:5000" },
        (async () => new Response(JSON.stringify(osrmResponse([{ ...direct, legs: [{ steps: [{ mode }] }] }])))) as typeof fetch);
      expect(await provider.candidates({ coordinates, profile, alternativesCount: 1, signal: new AbortController().signal })).toEqual([]);
    }
    const provider = createOsrmRouteCandidateProvider({ [profile]: "http://routing.internal:5000" },
      (async () => new Response(JSON.stringify(osrmResponse([{
        ...direct, legs: [{ steps: [{ mode: profile }] }],
        geometry: { type: "LineString", coordinates: [[0, 0.008], [0.1, 0.008]] },
      }], [{ location: [0, 0.008], distance: 0 }, { location: [0.1, 0.008], distance: 0 }])))) as typeof fetch);
    expect(await provider.candidates({ coordinates, profile, alternativesCount: 1, signal: new AbortController().signal })).toEqual([]);
  });

  it("accepts bike-pushing steps as part of cycling, with a different identity from driving", async () => {
    const provider = createOsrmRouteCandidateProvider({ cycling: "http://bike.internal:5000" },
      (async () => new Response(JSON.stringify(osrmResponse([{
        ...direct, legs: [{ steps: [{ mode: "cycling" }, { mode: "pushing bike" }] }],
      }])))) as typeof fetch);
    const [cycling] = await provider.candidates({ coordinates, profile: "cycling", alternativesCount: 1, signal: new AbortController().signal });
    const [driving] = await providerWith(osrmResponse([direct])).candidates({ coordinates, profile: "driving", alternativesCount: 1, signal: new AbortController().signal });
    expect(cycling.profile).toBe("cycling");
    expect(cycling.id).not.toBe(driving.id);
  });

  it.each(["driving", "walking", "cycling"] as const)("returns no candidates for HTTP 400 no-road results in %s", async (profile) => {
    for (const code of ["NoRoute", "NoSegment"]) {
      const provider = createOsrmRouteCandidateProvider({ [profile]: "http://routing.internal:5000" },
        (async () => new Response(JSON.stringify({ code }), { status: 400 })) as typeof fetch);
      expect(await provider.candidates({
        coordinates, profile, alternativesCount: 1, signal: new AbortController().signal,
      })).toEqual([]);
    }
  });

  it.each([[400, "InvalidQuery"], [400, "Ok"], [401, "NoRoute"], [429, "NoSegment"], [503, "NoRoute"]])(
    "keeps HTTP %s %s failures visible as provider errors", async (status, code) => {
      const provider = createOsrmRouteCandidateProvider({ walking: "http://routing.internal:5000" },
        (async () => new Response(JSON.stringify({ code }), { status: Number(status) })) as typeof fetch);
      await expect(provider.candidates({
        coordinates, profile: "walking", alternativesCount: 1, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE", status: 503 });
    },
  );

  it("rejects invalid or oversized HTTP 400 envelopes before interpreting a no-road result", async () => {
    for (const body of ["not-json", JSON.stringify(null), JSON.stringify({ code: "NoRoute", padding: "x".repeat(1_000_000) })]) {
      const provider = createOsrmRouteCandidateProvider({ walking: "http://routing.internal:5000" },
        (async () => new Response(body, { status: 400 })) as typeof fetch);
      await expect(provider.candidates({
        coordinates, profile: "walking", alternativesCount: 1, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE", status: 503 });
    }
  });

  it("reports malformed provider envelopes truthfully and discards malformed individual candidates", async () => {
    const request = { coordinates, profile: "driving" as const, alternativesCount: 1 as const, signal: new AbortController().signal };
    for (const payload of [null, { code: "Ok", routes: {}, waypoints: [] }]) {
      await expect(providerWith(payload).candidates(request)).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE", status: 503 });
    }
    expect(await providerWith(osrmResponse([{ ...direct, legs: [null] }])).candidates(request)).toEqual([]);
    expect(await providerWith({ code: "Ok", routes: [null], waypoints: [null] }).candidates(request)).toEqual([]);
  });
});
