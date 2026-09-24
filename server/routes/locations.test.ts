import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocationSearch,
  LocationSearchOptions,
} from "../location/location-search";

/**
 * #539: the optional Journey-context focus on place search. Nothing here talks
 * to PostgreSQL or a provider: the Atlas boundary and the configuration are
 * mocked, and the adapter is a recording fake.
 */

vi.mock("../config", () => ({
  serverConfig: {
    locationSearchDriver: "disabled",
    locationSearchBaseUrl: "",
    locationSearchUserAgent: "Startrips-test",
  },
}));
vi.mock("../authorization/atlas-access", () => ({
  requireAtlasAccess: vi.fn(async () => ({ atlas: { id: "atlas-1" } })),
}));

const { createLocationRoutes, parseLocationSearchFocus } = await import("./locations");
const { LocationSearchInvalidError } = await import("../location/location-search");

const searchCalls: Array<{ query: string; options: LocationSearchOptions }> = [];
const fakeSearch: LocationSearch = {
  driver: "fake",
  attribution: null,
  async search(query, options) {
    searchCalls.push({ query, options });
    return [];
  },
  async reverse() {
    return null;
  },
};

// The same mapping `server/app.ts` answers with, so the envelope under test is
// the envelope a client sees.
const app = new Hono()
  .route("/api/locations", createLocationRoutes(fakeSearch))
  .onError((error, context) => {
    if (error instanceof LocationSearchInvalidError) {
      return context.json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  });

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
      `/api/locations/search?q=${encodeURIComponent("故宫")}&lat=39.9163&lon=116.3972`,
    );

    expect(response.status).toBe(200);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe("故宫");
    expect(searchCalls[0].options.focus).toEqual({ latitude: 39.9163, longitude: 116.3972 });
    expect(searchCalls[0].options.limit).toBe(8);
  });

  it("searches without a focus when none is sent", async () => {
    const response = await app.request("/api/locations/search?q=Central%20Park");

    expect(response.status).toBe(200);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].options).not.toHaveProperty("focus");
  });

  it("answers an invalid focus with the 400 envelope and never searches", async () => {
    const response = await app.request("/api/locations/search?q=Central%20Park&lat=95&lon=10");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_LOCATION_FOCUS",
      message: "Search focus needs a valid lat and lon together",
    });
    expect(searchCalls).toHaveLength(0);
  });
});
