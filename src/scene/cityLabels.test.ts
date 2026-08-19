import { describe, expect, it } from "vitest";
import { parseCityFeatures, parseCityList, selectCityCandidates } from "./cityLabels";

describe("parseCityFeatures", () => {
  it("parses named cities with valid coordinates sorted by population", () => {
    const cities = parseCityFeatures({
      features: [
        {
          properties: { NAME: "Small Town", POP_MAX: 100 },
          geometry: { coordinates: [10, 20] },
        },
        {
          properties: { NAME: "Big City", POP_MAX: 5000 },
          geometry: { coordinates: [30, 40] },
        },
      ],
    });
    expect(cities.map((city) => city.name)).toEqual(["Big City", "Small Town"]);
    expect(cities[0]).toMatchObject({ latitude: 40, longitude: 30 });
  });

  it("precomputes unit directions on the globe-local sphere", () => {
    const cities = parseCityFeatures({
      features: [
        {
          properties: { NAME: "Sized", POP_MAX: 1 },
          geometry: { coordinates: [10, 20] },
        },
      ],
    });
    const [x, y, z] = cities[0].direction;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
    expect(x).toBeGreaterThan(0.9);
  });

  it("skips unnamed, unlocated, or out-of-range features", () => {
    const cities = parseCityFeatures({
      features: [
        { properties: { NAME: "", POP_MAX: 1 }, geometry: { coordinates: [1, 1] } },
        { properties: { NAME: "No Coords", POP_MAX: 1 } },
        { properties: { NAME: "Bad Range", POP_MAX: 1 }, geometry: { coordinates: [200, 91] } },
        { properties: { NAME: "Not Array", POP_MAX: 1 }, geometry: { coordinates: "x" } },
      ],
    });
    expect(cities).toEqual([]);
  });

  it("accepts a bounded top-N slice for label budgets", () => {
    const cities = parseCityFeatures({
      features: Array.from({ length: 5 }, (_, index) => ({
        properties: { NAME: `City ${index}`, POP_MAX: index },
        geometry: { coordinates: [index, index] },
      })),
    });
    expect(cities.slice(0, 2).map((city) => city.name)).toEqual(["City 4", "City 3"]);
  });
});

describe("parseCityList", () => {
  it("parses the compact GeoNames build with unit directions and ranks", () => {
    const cities = parseCityList({
      cities: [
        { n: "Zhengzhou", la: 34.75, lo: 113.63, p: 4672120, r: 1 },
        { n: "Small", la: 10, lo: 20, p: 15000, r: 3 },
      ],
    });
    expect(cities.map((city) => city.name)).toEqual(["Zhengzhou", "Small"]);
    expect(cities[0]).toMatchObject({ latitude: 34.75, longitude: 113.63, rank: 1 });
    expect(cities[1].rank).toBe(3);
    const [x, y, z] = cities[1].direction;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
  });

  it("clamps invalid ranks and skips unnamed, unlocated, or out-of-range entries", () => {
    const cities = parseCityList({
      cities: [
        { n: "", la: 1, lo: 1, p: 100, r: 1 },
        { n: "No Coords", p: 100, r: 1 },
        { n: "Bad Range", la: 91, lo: 200, p: 100, r: 1 },
        { n: "No Pop", la: 5, lo: 5, r: 1 },
        { n: "Bad Rank", la: 5, lo: 5, p: 50, r: 99 },
        { n: "Valid", la: 5, lo: 5, p: 50, r: 2 },
      ],
    });
    expect(cities.map((city) => city.name)).toEqual(["Bad Rank", "Valid"]);
    expect(cities[0].rank).toBe(3);
  });
});

describe("selectCityCandidates", () => {
  // Facing along +X (globe-local): (0,0) is dead center, (45,10) is nearby
  // (facing ~0.70), (180,0) faces away entirely.
  const cities = parseCityFeatures({
    features: [
      {
        properties: { NAME: "Far", POP_MAX: 9000 },
        geometry: { coordinates: [0, 0] },
      },
      {
        properties: { NAME: "Near", POP_MAX: 100 },
        geometry: { coordinates: [45, 10] },
      },
      {
        properties: { NAME: "Behind", POP_MAX: 500 },
        geometry: { coordinates: [180, 0] },
      },
    ],
  });

  it("orders cities nearest the view center first", () => {
    const result = selectCityCandidates(cities, [1, 0, 0], 0.5, 10);
    expect(result.map((city) => city.name)).toEqual(["Far", "Near"]);
  });

  it("filters out cities that face away from the camera", () => {
    const result = selectCityCandidates(cities, [1, 0, 0], 0.9, 10);
    expect(result.map((city) => city.name)).toEqual(["Far"]);
  });

  it("applies the candidate limit", () => {
    const result = selectCityCandidates(cities, [1, 0, 0], 0.5, 1);
    expect(result.map((city) => city.name)).toEqual(["Far"]);
  });

  it("breaks facing ties by population", () => {
    const sameSpot = parseCityFeatures({
      features: [
        {
          properties: { NAME: "Small", POP_MAX: 10 },
          geometry: { coordinates: [0, 0] },
        },
        {
          properties: { NAME: "Big", POP_MAX: 9000 },
          geometry: { coordinates: [0, 0] },
        },
      ],
    });
    const result = selectCityCandidates(sameSpot, [1, 0, 0], 0.5, 10);
    expect(result.map((city) => city.name)).toEqual(["Big", "Small"]);
  });

  it("filters by containment rank", () => {
    const ranked = parseCityList({
      cities: [
        { n: "Capital", la: 0, lo: 0, p: 100, r: 0 },
        { n: "Province", la: 0, lo: 1, p: 90, r: 1 },
        { n: "Prefecture", la: 0, lo: 2, p: 80, r: 2 },
        { n: "Town", la: 0, lo: 3, p: 70, r: 3 },
      ],
    });
    const capitals = selectCityCandidates(ranked, [1, 0, 0], 0.5, 10, 1);
    expect(capitals.map((city) => city.name)).toEqual(["Capital", "Province"]);
    const prefectures = selectCityCandidates(ranked, [1, 0, 0], 0.5, 10, 2);
    expect(prefectures.map((city) => city.name)).toEqual([
      "Capital",
      "Province",
      "Prefecture",
    ]);
    const all = selectCityCandidates(ranked, [1, 0, 0], 0.5, 10);
    expect(all.map((city) => city.name)).toEqual([
      "Capital",
      "Province",
      "Prefecture",
      "Town",
    ]);
  });

  it("normalizes the facing direction and handles a zero vector", () => {
    expect(selectCityCandidates(cities, [0, 0, 0], 0.5, 10)).toEqual([]);
    const doubled = selectCityCandidates(cities, [2, 0, 0], 0.5, 10);
    expect(doubled.map((city) => city.name)).toEqual(["Far", "Near"]);
  });
});
