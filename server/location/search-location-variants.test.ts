import { describe, expect, it, vi } from "vitest";
import type { LocationSearch, LocationSearchResult } from "./location-search";
import { searchLocationVariants } from "./search-location-variants";

const nationalGallery: LocationSearchResult = {
  id: "N:4759240362",
  label: "National Gallery Singapore",
  context: "Singapore",
  countryCode: "SG",
  latitude: 1.29054,
  longitude: 103.85152,
};

describe("searchLocationVariants", () => {
  it("gives Chinese and English names the same provider-backed result", async () => {
    const lookup = vi.fn(async (query: string) =>
      query === "National Gallery Singapore Singapore" ? [nationalGallery] : []
    );
    const search = { search: lookup } as unknown as LocationSearch;
    const options = { limit: 8 };
    const fromChinese = await searchLocationVariants(search, "新加坡国家美术馆", options, {
      aliases: ["National Gallery Singapore"], searchArea: "Singapore", countryCode: "SG",
    });
    const fromEnglish = await searchLocationVariants(search, "National Gallery Singapore", options, {
      aliases: ["新加坡国家美术馆"], searchArea: "Singapore", countryCode: "SG",
    });

    expect(fromChinese).toEqual([nationalGallery]);
    expect(fromEnglish).toEqual(fromChinese);
    expect(lookup.mock.calls.map(([query]) => query))
      .toEqual(["National Gallery Singapore Singapore", "National Gallery Singapore Singapore"]);
  });

  it("keeps looking when a name matches in the wrong country or locality", async () => {
    const wrongCountry = {
      ...nationalGallery, id: "N:1", countryCode: "ZA", context: "Mogale City, South Africa",
    };
    const wrongCity = {
      ...nationalGallery, id: "N:2", context: "Jurong",
    };
    const street = { ...nationalGallery, id: "W:3", label: "National Gallery Singapore Road" };
    const lookup = vi.fn(async (query: string) =>
      query === "National Gallery Singapore Singapore" ? [wrongCountry, wrongCity, street]
        : query === "National Gallery Singapore" ? [nationalGallery] : []
    );
    const results = await searchLocationVariants(
      { search: lookup } as unknown as LocationSearch,
      "新加坡国家美术馆", { limit: 8 }, {
        aliases: ["National Gallery Singapore"], searchArea: "Singapore", countryCode: "SG",
      },
    );

    expect(results).toEqual([nationalGallery]);
    expect(lookup.mock.calls.map(([query]) => query))
      .toEqual(["National Gallery Singapore Singapore", "National Gallery Singapore"]);
  });
});
