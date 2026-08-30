import { describe, expect, it } from "vitest";
import {
  cityLabelFacingThreshold,
  cityStableKey,
  parseCityFeatures,
  parseCityList,
  resolveCityDisplayName,
  selectCityCandidates,
} from "./cityLabels";

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

  it("parses the localized `z` field into localizedName (#16)", () => {
    const cities = parseCityList({
      cities: [
        { n: "Shenzhen", z: "深圳", la: 22.54, lo: 114.06, p: 17000000, r: 2 },
        { n: "NoZh", la: 10, lo: 20, p: 1000, r: 3 },
        { n: "EmptyZh", z: "   ", la: 5, lo: 5, p: 500, r: 3 },
      ],
    });
    expect(cities[0].localizedName).toBe("深圳");
    expect(cities[1].localizedName).toBeUndefined();
    expect(cities[2].localizedName).toBeUndefined();
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

describe("resolveCityDisplayName (#16)", () => {
  const city = {
    name: "Shenzhen",
    localizedName: "深圳",
  };

  it("uses the localized name for Chinese locales", () => {
    expect(resolveCityDisplayName(city, "zh-CN")).toBe("深圳");
    expect(resolveCityDisplayName(city, "zh-Hans")).toBe("深圳");
    expect(resolveCityDisplayName(city, "zh")).toBe("深圳");
  });

  it("falls back to the asciiname when no localized name exists", () => {
    expect(resolveCityDisplayName({ name: "Paris", localizedName: undefined }, "zh-CN"))
      .toBe("Paris");
  });

  it("prefers the asciiname for non-Chinese locales", () => {
    expect(resolveCityDisplayName(city, "en")).toBe("Shenzhen");
    expect(resolveCityDisplayName(city, "en-US")).toBe("Shenzhen");
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


describe("stable zoom-aware city candidate policy (#79)", () => {
  const pearlRiverDelta = parseCityList({
    cities: [
      { n: "Hong Kong", z: "香港", la: 22.27832, lo: 114.17469, p: 7396076, r: 0 },
      { n: "Shenzhen", z: "深圳", la: 22.54554, lo: 114.0683, p: 17494398, r: 2 },
      { n: "Guangzhou", z: "广州", la: 23.11667, lo: 113.25, p: 16096724, r: 1 },
      { n: "Dongguan", z: "东莞市", la: 23.01797, lo: 113.74866, p: 9644871, r: 2 },
      { n: "Foshan", z: "佛山市", la: 23.02677, lo: 113.13148, p: 9042509, r: 2 },
      { n: "Zhuhai", z: "珠海市", la: 22.27694, lo: 113.56778, p: 2207090, r: 2 },
      { n: "Huizhou", z: "惠州市", la: 23.11147, lo: 114.41523, p: 2900113, r: 2 },
      { n: "Macau", z: "澳门", la: 22.20056, lo: 113.54611, p: 649335, r: 0 },
    ],
  });

  it("does not narrow candidate coverage as globe scale increases", () => {
    expect(cityLabelFacingThreshold(1)).toBe(cityLabelFacingThreshold(2));
    expect(cityLabelFacingThreshold(2)).toBe(cityLabelFacingThreshold(3));
  });

  it("keeps major Pearl River Delta anchors ahead of lower-priority neighbors", () => {
    const shenzhen = pearlRiverDelta.find((city) => city.name === "Shenzhen")!;
    const result = selectCityCandidates(
      pearlRiverDelta,
      shenzhen.direction,
      cityLabelFacingThreshold(2.5),
      8,
      3,
    );
    const names = result.map((city) => city.name);
    expect(names).toContain("Hong Kong");
    expect(names).toContain("Shenzhen");
    expect(names).toContain("Guangzhou");
    expect(names.indexOf("Hong Kong")).toBeLessThan(names.indexOf("Dongguan"));
  });

  it("keeps a centered prefecture city inside a crowded fixed candidate budget", () => {
    const crowded = parseCityList({ cities: [
      { n: "Centered Local", la: 0, lo: 0, p: 12000000, r: 2 },
      ...Array.from({ length: 90 }, (_, index) => ({
        n: `Administrative ${index}`,
        la: 0,
        lo: 28 + (index % 28),
        p: 20000000 - index,
        r: index % 2,
      })),
    ] });
    const centered = crowded.find((city) => city.name === "Centered Local")!;
    const result = selectCityCandidates(crowded, centered.direction, 0.3, 72, 2);
    expect(result.map((city) => city.name)).toContain("Centered Local");
  });

  it("uses persistence as hysteresis for otherwise equivalent nearby labels", () => {
    const twins = parseCityList({ cities: [
      { n: "Visible", la: 22.5, lo: 114, p: 1000000, r: 2 },
      { n: "Challenger", la: 22.5, lo: 114, p: 1000000, r: 2 },
    ] });
    const persistent = new Set([cityStableKey(twins[0])]);
    const result = selectCityCandidates(
      twins,
      twins[0].direction,
      0.3,
      1,
      3,
      persistent,
    );
    expect(result[0].name).toBe("Visible");
  });

  it("expanding rank tiers is monotonic for a fixed view", () => {
    const shenzhen = pearlRiverDelta.find((city) => city.name === "Shenzhen")!;
    const capitals = selectCityCandidates(pearlRiverDelta, shenzhen.direction, 0.3, 72, 1);
    const prefectures = selectCityCandidates(pearlRiverDelta, shenzhen.direction, 0.3, 72, 2);
    const capitalKeys = new Set(capitals.map(cityStableKey));
    const prefectureKeys = new Set(prefectures.map(cityStableKey));
    for (const key of capitalKeys) expect(prefectureKeys.has(key)).toBe(true);
    expect(prefectures.length).toBeGreaterThanOrEqual(capitals.length);
  });
});
