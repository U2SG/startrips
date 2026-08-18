import { describe, expect, it } from "vitest";
import { parseCityFeatures } from "./cityLabels";

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
