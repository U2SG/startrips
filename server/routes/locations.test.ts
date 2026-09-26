import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocationSearch,
  LocationSearchOptions,
} from "../location/location-search";

/**
 * #546: the optional Journey-context focus on place search, through the real
 * `app` so the 400 envelope is the one `server/app.ts`'s `onError` answers.
 * The Atlas boundary is stubbed and the configured adapter is replaced by a
 * recording fake, so no request here reaches a provider.
 */

const { searchCalls, fakeSearch } = vi.hoisted(() => {
  const calls: Array<{ query: string; options: LocationSearchOptions }> = [];
  const search: LocationSearch = {
    driver: "fake",
    attribution: null,
    async search(query, options) {
      calls.push({ query, options });
      return [];
    },
    async reverse() {
      return null;
    },
  };
  return { searchCalls: calls, fakeSearch: search };
});

vi.mock("../location/create-location-search", () => ({
  createLocationSearch: () => fakeSearch,
}));
vi.mock("../authorization/atlas-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("../authorization/atlas-access")>(),
  requireAtlasAccess: vi.fn(async () => ({})),
}));

const { app } = await import("../app");
const { parseLocationSearchFocus } = await import("./locations");
const { LocationSearchInvalidError } = await import("../location/location-search");

beforeEach(() => {
  searchCalls.length = 0;
});

describe("parseLocationSearchFocus", () => {
  it("returns no focus when neither coordinate is given", () => {
    expect(parseLocationSearchFocus(undefined, undefined)).toBeUndefined();
    expect(parseLocationSearchFocus(" ", "")).toBeUndefined();
  });

  it("accepts finite in-range coordinates", () => {
    expect(parseLocationSearchFocus("39.9163", "116.3972")).toEqual({
      latitude: 39.9163,
      longitude: 116.3972,
    });
    expect(parseLocationSearchFocus("-90", "180")).toEqual({
      latitude: -90,
      longitude: 180,
    });
  });

  it.each([
    ["39.9", undefined],
    [undefined, "116.4"],
    ["91", "0"],
    ["0", "-180.5"],
    ["NaN", "0"],
    ["Infinity", "0"],
    ["north", "east"],
  ])("refuses lat=%s lon=%s with the typed invalid error", (lat, lon) => {
    expect(() => parseLocationSearchFocus(lat, lon)).toThrow(LocationSearchInvalidError);
  });
});

describe("GET /api/locations/search", () => {
  it("forwards a valid focus to the adapter", async () => {
    const response = await app.request(
      `/api/locations/search?q=${encodeURIComponent("中山公园")}&lat=39.9163&lon=116.3972`,
    );

    expect(response.status).toBe(200);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe("中山公园");
    expect(searchCalls[0].options.focus).toEqual({ latitude: 39.9163, longitude: 116.3972 });
    expect(searchCalls[0].options.limit).toBe(8);
  });

  it("searches without a focus when none is sent", async () => {
    const response = await app.request("/api/locations/search?q=Central%20Park");

    expect(response.status).toBe(200);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].options).not.toHaveProperty("focus");
  });

  it("carries the focus through the alias and area search path", async () => {
    const response = await app.request(
      "/api/locations/search?q=West%20Lake&alias=Xihu&area=Fuzhou&lat=26.07&lon=119.3",
    );

    expect(response.status).toBe(200);
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.every((call) =>
      call.options.focus?.latitude === 26.07 && call.options.focus.longitude === 119.3
    )).toBe(true);
  });

  it.each([
    "lat=39.9",
    "lon=116.4",
    "lat=95&lon=10",
    "lat=10&lon=181",
    "lat=north&lon=east",
    "lat=NaN&lon=0",
  ])("answers %s with the 400 envelope and never searches", async (focus) => {
    const response = await app.request(`/api/locations/search?q=Central%20Park&${focus}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_LOCATION_FOCUS",
      message: "Search focus needs a valid lat and lon together",
    });
    expect(searchCalls).toHaveLength(0);
  });
});
