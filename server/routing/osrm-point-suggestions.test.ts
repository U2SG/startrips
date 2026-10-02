import { describe, expect, it, vi } from "vitest";
import { createOsrmPointSuggestions } from "./osrm-point-suggestions";
import { MAX_SNAP_METERS } from "./routing-coordinates";

const coordinate = { lat: 0, lon: 0 };
const signal = () => new AbortController().signal;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("nearby routable point suggestions", () => {
  it.each(["driving", "walking", "cycling"] as const)("uses the %s graph and skips a closer disconnected road", async (profile) => {
    const urls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); urls.push(url);
      if (url.pathname.includes("/nearest/")) return reply({ code: "Ok", waypoints: [
        { location: [0.0001, 0], distance: 11, name: "Isolated track", hint: "isolated" },
        { location: [0.003, 0], distance: 334, name: "Connected road", hint: "connected" },
        { location: [0.0031, 0], distance: 345, name: "Duplicate edge" },
        { location: [20, 0], distance: 1, name: "Wrong provider distance" },
        { location: [0.2, 95], distance: 1, name: "Invalid latitude" },
      ] });
      if (url.searchParams.get("hints")?.includes("isolated")) return reply({ code: "NoRoute" }, 400);
      const locations = url.pathname.split("/").at(-1)!.split(";").map((point) => point.split(",").map(Number));
      return reply({ code: "Ok", waypoints: locations.map((location) => ({ location, distance: 0 })),
        routes: [{ distance: 12_000, duration: 900, legs: [{ steps: [{ mode: profile }] }, { steps: [{ mode: profile }] }] }] });
    });
    const suggest = createOsrmPointSuggestions({ [profile]: `http://${profile}.internal:5000` }, fetcher);
    const result = await suggest({ coordinate, neighbors: { before: { lat: 0, lon: -0.1 }, after: { lat: 0, lon: 0.1 } }, profile, signal: signal() });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ label: "Connected road", coordinate: { lon: 0.003, lat: 0 }, connected: true });
    expect(result[0].distanceMeters).toBeGreaterThan(330);
    expect(urls.every((url) => url.hostname === `${profile}.internal`)).toBe(true);
    expect(urls[0].searchParams.get("number")).toBe("20");
    expect(urls.at(-1)!.pathname).toContain("-0.1,0;0.003,0;0.1,0");
    expect(urls.at(-1)!.searchParams.get("steps")).toBe("true");
    expect(result[0].id).toBe((await suggest({ coordinate, neighbors: {}, profile, signal: signal() }))[1]?.id);
  });

  it("does not claim connection without neighbors and deduplicates nearby samples", async () => {
    const fetcher = vi.fn(async () => reply({ code: "Ok", waypoints: [
      { location: [0.001, 0], distance: 111, name: "Road" },
      { location: [0.0011, 0], distance: 122, name: "Same road" },
    ] }));
    const result = await createOsrmPointSuggestions({ walking: "http://foot.internal" }, fetcher)({ coordinate, neighbors: {}, profile: "walking", signal: signal() });
    expect(result).toHaveLength(1);
    expect(result[0].connected).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires explicit ferry permission and still refuses the wrong land mode", async () => {
    let mode = "ferry";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/nearest/")) return reply({ code: "Ok", waypoints: [{ location: [0.001, 0], distance: 111 }] });
      return reply({ code: "Ok", waypoints: [{ location: [0.001, 0], distance: 0 }, { location: [0.1, 0], distance: 0 }],
        routes: [{ distance: 12_000, duration: 900, legs: [{ steps: [{ mode }] }] }] });
    };
    const suggest = createOsrmPointSuggestions({ cycling: "http://bike.internal" }, fetcher);
    const request = { coordinate, neighbors: { after: { lat: 0, lon: 0.1 } }, profile: "cycling" as const, signal: signal() };
    expect(await suggest(request)).toEqual([]);
    expect(await suggest({ ...request, allowFerries: true })).toHaveLength(1);
    mode = "driving";
    expect(await suggest({ ...request, allowFerries: true })).toEqual([]);
  });

  it.each(["driving", "walking", "cycling"] as const)("uses the same %s snap gates for the recommendation and its neighbors", async (profile) => {
    const limit = MAX_SNAP_METERS[profile];
    let reported: unknown = limit;
    let neighborOffset = 0;
    let pointOffset = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).includes("/nearest/")) return reply({ code: "Ok", waypoints: [{ location: [0.001, 0], distance: 111 }] });
      return reply({ code: "Ok", waypoints: [
        { location: [0.001 + pointOffset, 0], distance: 0 },
        { location: [0.1 + neighborOffset, 0], distance: reported },
      ], routes: [{ distance: 12_000, duration: 900, legs: [{ steps: [{ mode: profile }] }] }] });
    };
    const suggest = createOsrmPointSuggestions({ [profile]: "http://road.internal" }, fetcher);
    const request = { coordinate, neighbors: { after: { lat: 0, lon: 0.1 } }, profile, signal: signal() };
    expect(await suggest(request)).toHaveLength(1);
    reported = limit + 1;
    expect(await suggest(request)).toEqual([]);
    reported = 0;
    neighborOffset = (limit + 100) / 111_195;
    expect(await suggest(request)).toEqual([]);
    neighborOffset = 0;
    pointOffset = (limit + 100) / 111_195;
    expect(await suggest(request)).toEqual([]);
    pointOffset = 0;
    for (reported of [undefined, -1, "0"]) expect(await suggest(request)).toEqual([]);
  });

  it("treats NoSegment as empty while refusing malformed, failed or unconfigured providers", async () => {
    const request = { coordinate, neighbors: {}, profile: "walking" as const, signal: signal() };
    expect(await createOsrmPointSuggestions({ walking: "http://foot.internal" }, async () => reply({ code: "NoSegment" }, 400))(request)).toEqual([]);
    for (const response of [reply({ code: "Ok" }), reply({ code: "NoRoute" }, 503), new Response("not json")]) {
      await expect(createOsrmPointSuggestions({ walking: "http://foot.internal" }, async () => response)(request)).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE" });
    }
    const unused = vi.fn<typeof fetch>();
    await expect(createOsrmPointSuggestions({ driving: "http://car.internal" }, unused)(request)).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE" });
    expect(unused).not.toHaveBeenCalled();
  });
});
