import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocationSearch } from "./create-location-search";
import { LocationSearchUnavailableError } from "./location-search";
import { NominatimLocationSearch } from "./nominatim-location-search";
import { PhotonLocationSearch } from "./photon-location-search";
import { createPlaceNameAliasResolver, resolveNameVariant } from "./place-name-aliases";

type PhotonFeature = {
  geometry: { coordinates: [number, number] };
  properties: Record<string, unknown>;
};

const ELIZABETH_TOWER = {
  osm_type: "way",
  osm_id: 123557148,
  display_name: "Elizabeth Tower, Westminster, London, England, United Kingdom",
  lat: "51.5007292",
  lon: "-0.1246254",
  namedetails: { name: "Elizabeth Tower", "name:zh": "大本钟", "name:en": "Elizabeth Tower" },
  address: { country_code: "gb" },
};

const UNRELATED_STREET: PhotonFeature = {
  geometry: { coordinates: [113.2644, 23.1291] },
  properties: {
    osm_type: "W",
    osm_id: 77,
    name: "大本钟路",
    city: "广州市",
    country: "中国",
    countrycode: "CN",
  },
};

function photonFetcher(primary: PhotonFeature[], english: PhotonFeature[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return Response.json({
      features: url.searchParams.get("lang") === "en" ? english : primary,
    });
  });
}

function nominatimFetcher(places: unknown[]) {
  return vi.fn(async (_input: RequestInfo | URL) => Response.json(places));
}

function searchWith(
  photon: ReturnType<typeof photonFetcher>,
  nominatim: object | null,
) {
  return new PhotonLocationSearch({
    baseUrl: "https://photon.example.test",
    userAgent: "Startrips/1.0",
    fetcher: photon as unknown as typeof fetch,
    requestIntervalMs: 0,
    ...(nominatim
      ? {
        fallback: new NominatimLocationSearch({
          baseUrl: "https://nominatim.example.test",
          userAgent: "Startrips/1.0",
          fetcher: nominatim as unknown as typeof fetch,
          requestIntervalMs: 0,
        }),
      }
      : {}),
  });
}

describe("Photon with a bounded Nominatim fallback (#547)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("consults the fallback when a Chinese landmark query finds nothing", async () => {
    const nominatim = nominatimFetcher([ELIZABETH_TOWER]);
    const search = searchWith(photonFetcher([]), nominatim);

    await expect(search.search("大本钟", { limit: 8 })).resolves.toMatchObject([{
      id: "way:123557148",
      label: "大本钟",
      labelEnglish: "Elizabeth Tower",
      countryCode: "GB",
      latitude: 51.5007292,
      longitude: -0.1246254,
    }]);
    expect(nominatim).toHaveBeenCalledOnce();
    const url = new URL(String(nominatim.mock.calls[0][0]));
    expect(url.hostname).toBe("nominatim.example.test");
    expect(url.searchParams.get("q")).toBe("大本钟");
  });

  it("consults the fallback when the primary answer carries no confident label", async () => {
    const nominatim = nominatimFetcher([ELIZABETH_TOWER]);
    const search = searchWith(photonFetcher([UNRELATED_STREET]), nominatim);

    const results = await search.search("大本钟", { limit: 8 });

    expect(nominatim).toHaveBeenCalledOnce();
    // The hit that names the query leads; the provider's own fuzzy hit is kept
    // behind it rather than dropped or relabelled.
    expect(results.map((result) => result.id)).toEqual(["way:123557148", "W:77"]);
  });

  it("does not request the fallback for a confident local Chinese query", async () => {
    const nominatim = nominatimFetcher([ELIZABETH_TOWER]);
    const photon = photonFetcher([{
      geometry: { coordinates: [114.0545429, 22.5445741] },
      properties: {
        osm_type: "R",
        osm_id: 123,
        name: "深圳市",
        "name:en": "Shenzhen",
        country: "中国",
        countrycode: "CN",
      },
    }]);
    const search = searchWith(photon, nominatim);

    await expect(search.search("深圳", { limit: 8 })).resolves.toMatchObject([{
      label: "深圳市",
      labelEnglish: "Shenzhen",
    }]);
    expect(photon).toHaveBeenCalledOnce();
    expect(nominatim).not.toHaveBeenCalled();
  });

  it("does not request the fallback for a query that is not all Han", async () => {
    const nominatim = nominatimFetcher([ELIZABETH_TOWER]);
    const search = searchWith(photonFetcher([]), nominatim);

    await expect(search.search("大本钟 London", { limit: 8 })).resolves.toEqual([]);
    await expect(search.search("Big Ben", { limit: 8 })).resolves.toEqual([]);
    expect(nominatim).not.toHaveBeenCalled();
  });

  it("returns the provider's own answer for an unmatched query instead of inventing a place", async () => {
    const empty = searchWith(photonFetcher([]), nominatimFetcher([]));
    await expect(empty.search("这个地方并不存在", { limit: 8 })).resolves.toEqual([]);

    const withoutFallback = await searchWith(photonFetcher([UNRELATED_STREET]), null)
      .search("大本钟", { limit: 8 });
    const withEmptyFallback = await searchWith(
      photonFetcher([UNRELATED_STREET]),
      nominatimFetcher([]),
    ).search("大本钟", { limit: 8 });
    expect(withEmptyFallback).toEqual(withoutFallback);
    expect(withEmptyFallback.map((result) => result.id)).toEqual(["W:77"]);
  });

  it("does not admit a fallback hit that does not name the query", async () => {
    // Nominatim answers, but only with a place whose names are not the query:
    // that is a fuzzy match, not the landmark, and must not surface a coordinate.
    const unrelatedPlace = {
      osm_type: "node",
      osm_id: 991,
      display_name: "大本钟咖啡, 朝阳区, 北京市, 中国",
      lat: "39.9219",
      lon: "116.4432",
      namedetails: { name: "大本钟咖啡" },
      address: { country_code: "cn" },
    };

    const nominatim = nominatimFetcher([unrelatedPlace]);
    const empty = searchWith(photonFetcher([]), nominatim);
    await expect(empty.search("大本钟", { limit: 8 })).resolves.toEqual([]);
    expect(nominatim).toHaveBeenCalledOnce();

    const withoutFallback = await searchWith(photonFetcher([UNRELATED_STREET]), null)
      .search("大本钟", { limit: 8 });
    const withFuzzyFallback = await searchWith(
      photonFetcher([UNRELATED_STREET]),
      nominatimFetcher([unrelatedPlace]),
    ).search("大本钟", { limit: 8 });
    expect(withFuzzyFallback).toEqual(withoutFallback);
  });

  it("degrades a fallback failure through the unavailable error", async () => {
    const failing = () => vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    // With nothing to show, a failed fallback is unavailable search, not an
    // empty answer claiming the place does not exist.
    const empty = searchWith(photonFetcher([]), failing());
    const rejection = await empty.search("大本钟", { limit: 8 }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(LocationSearchUnavailableError);

    // With a real primary answer, that answer stands.
    const fuzzy = searchWith(photonFetcher([UNRELATED_STREET]), failing());
    await expect(fuzzy.search("大本钟", { limit: 8 })).resolves.toMatchObject([{ id: "W:77" }]);

    // A fallback that throws something other than the stable error is still
    // reported as the stable error.
    const odd = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: photonFetcher([]) as unknown as typeof fetch,
      requestIntervalMs: 0,
      fallback: {
        driver: "odd",
        attribution: null,
        search: async () => {
          throw new RangeError("unexpected");
        },
        reverse: async () => null,
      },
    });
    await expect(odd.search("大本钟", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("sends simplified and indexed spellings of one name as the same outbound query", async () => {
    expect(resolveNameVariant("鸭川")).toBe("鴨川");
    expect(resolveNameVariant("鴨川")).toBe("鴨川");
    // Whole names only: an unrelated name that shares characters is untouched.
    expect(resolveNameVariant("鸭川路")).toBe("鸭川路");

    const outbound = async (query: string) => {
      const photon = photonFetcher([]);
      const nominatim = nominatimFetcher([]);
      await searchWith(photon, nominatim).search(query, { limit: 8 });
      return [...photon.mock.calls, ...nominatim.mock.calls].map((call) =>
        new URL(String(call[0])).searchParams.get("q"));
    };
    const simplified = await outbound("鸭川");
    expect(simplified).toEqual(await outbound("鴨川"));
    expect(simplified[0]).toBe("鴨川");
    expect(simplified).not.toContain("鸭川");
  });

  it("resolves the English name of either spelling of a variant", async () => {
    const resolve = createPlaceNameAliasResolver();
    // The payload records the simplified spelling, so the indexed spelling
    // sent to the provider still earns the same English round trip.
    await expect(resolve("鸭川")).resolves.toBe(await resolve("鴨川"));
    await expect(resolve("岚山")).resolves.toBe("Arashiyama");
    await expect(resolve("嵐山")).resolves.toBe("Arashiyama");
  });

  it("is wired by createLocationSearch only when a fallback endpoint is named", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json(url.hostname === "nominatim.example.test"
        ? [ELIZABETH_TOWER]
        : { features: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const hosts = () => fetchMock.mock.calls.map((call) => new URL(String(call[0])).hostname);

    const plain = createLocationSearch({
      driver: "photon",
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
    });
    await expect(plain.search("大本钟", { limit: 8 })).resolves.toEqual([]);
    expect(hosts()).not.toContain("nominatim.example.test");

    fetchMock.mockClear();
    const withFallback = createLocationSearch({
      driver: "photon",
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fallbackBaseUrl: "https://nominatim.example.test",
    });
    await expect(withFallback.search("大本钟", { limit: 8 })).resolves.toMatchObject([{
      id: "way:123557148",
    }]);
    expect(hosts()).toContain("nominatim.example.test");
  });
});
