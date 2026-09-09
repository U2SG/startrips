import { describe, expect, it, vi } from "vitest";
import { LocationSearchUnavailableError } from "./location-search";
import { PhotonLocationSearch } from "./photon-location-search";

describe("PhotonLocationSearch", () => {
  it("maps precise places, identifies the app, and caches repeated searches", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      features: [
        {
          geometry: { coordinates: [103.8515221, 1.2905434] },
          properties: {
            osm_type: "N",
            osm_id: 456,
            name: "National Gallery Singapore",
            street: "St Andrew's Road",
            housenumber: "1",
            district: "Downtown Core",
            city: "Singapore",
            country: "Singapore",
            countrycode: "SG",
          },
        },
        {
          geometry: { coordinates: [103.8, "not-a-number"] },
          properties: { name: "Broken result" },
        },
      ],
    }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0 (+https://startrips.example)",
      fetcher,
      requestIntervalMs: 0,
    });

    const first = await search.search("  National   Gallery Singapore  ", { limit: 8 });
    const second = await search.search("national gallery singapore", { limit: 8 });

    expect(first).toEqual([{
      id: "N:456",
      label: "National Gallery Singapore",
      context: "St Andrew's Road 1, Downtown Core, Singapore",
      countryCode: "SG",
      latitude: 1.2905434,
      longitude: 103.8515221,
    }]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(requestUrl.pathname).toBe("/api/");
    expect(requestUrl.searchParams.get("q")).toBe("National Gallery Singapore");
    expect(requestUrl.searchParams.get("limit")).toBe("8");
    expect(requestUrl.searchParams.has("lang")).toBe(false);
    expect(new Headers(requestInit.headers).get("User-Agent")).toContain("Startrips");
    expect(search.attribution?.url).toBe("https://www.openstreetmap.org/copyright");
  });

  it("turns provider failures and malformed payloads into the stable unavailable error", async () => {
    const unavailable = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => new Response(null, { status: 429 })) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });
    const malformed = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json({ features: null })) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(unavailable.search("Singapore", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
    await expect(malformed.search("Singapore", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("prefers a Chinese alias and keeps an English alias when Photon provides both", async () => {
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json({
        features: [{
          geometry: { coordinates: [116.3913, 39.9057] },
          properties: {
            osm_type: "R",
            osm_id: 912940,
            name: "Beijing",
            "name:zh-Hans": "北京市",
            "name:en": "Beijing",
            country: "China",
            countrycode: "CN",
          },
        }],
      })) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("Beijing", { limit: 8 })).resolves.toMatchObject([{
      label: "北京市",
      labelEnglish: "Beijing",
    }]);
  });

  it("merges Photon local results with a second English-language query", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const english = url.searchParams.get("lang") === "en";
      return Response.json({
        features: [{
          geometry: { coordinates: [116.3913, 39.9057] },
          properties: {
            osm_type: "R",
            osm_id: 912940,
            name: english ? "Beijing" : "北京市",
            country: english ? "China" : "中国",
            countrycode: "CN",
          },
        }],
      });
    });
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("Beijing", { limit: 8 })).resolves.toMatchObject([{
      label: "北京市",
      labelEnglish: "Beijing",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const englishUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(englishUrl.searchParams.get("q")).toBe("Beijing");
    expect(englishUrl.searchParams.get("lang")).toBe("en");
  });

  it("does not pay a second queued round trip when the Chinese query is already bilingual", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      features: [{
        geometry: { coordinates: [114.0545429, 22.5445741] },
        properties: {
          osm_type: "R",
          osm_id: 123,
          name: "深圳市",
          "name:en": "Shenzhen",
          country: "中国",
          countrycode: "CN",
        },
      }],
    }));
    // No requestIntervalMs override, exactly like production: a needless
    // English follow-up would sit a full second in the queue.
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
    });

    const startedAt = Date.now();
    await expect(search.search("深圳", { limit: 8 })).resolves.toMatchObject([{
      label: "深圳市",
      labelEnglish: "Shenzhen",
    }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("still falls back to English when a Chinese query finds nothing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json({
        features: url.searchParams.get("lang") === "en" ? [{
          geometry: { coordinates: [135.7681, 35.0116] },
          properties: {
            osm_type: "R",
            osm_id: 2,
            name: "Kyoto",
            country: "Japan",
            countrycode: "JP",
          },
        }] : [],
      });
    });
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("京都", { limit: 8 })).resolves.toMatchObject([{
      label: "Kyoto",
      countryCode: "JP",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a common Chinese foreign-city alias when the local query is ambiguous", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const english = url.searchParams.get("lang") === "en";
      return Response.json({
        features: english ? [{
          geometry: { coordinates: [-0.1257, 51.5085] },
          properties: {
            osm_type: "N",
            osm_id: 1,
            name: "London",
            country: "United Kingdom",
            countrycode: "GB",
          },
        }] : [],
      });
    });
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("伦敦", { limit: 8 })).resolves.toMatchObject([{
      label: "London",
      countryCode: "GB",
    }]);
    const englishUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(englishUrl.searchParams.get("q")).toBe("London");
    expect(englishUrl.searchParams.get("lang")).toBe("en");
  });

  it("resolves a Chinese exonym, a country-qualified exonym and the English name to one place", async () => {
    const honolulu = {
      geometry: { coordinates: [-157.85833, 21.30694] },
      properties: {
        osm_type: "R",
        osm_id: 6980,
        name: "Honolulu",
        "name:en": "Honolulu",
        state: "Hawaii",
        country: "United States",
        countrycode: "US",
      },
    };
    // Photon answers this place under its English name only, exactly like the
    // provider does for the reported 檀香山 search.
    const provider = () => vi.fn(async (input: RequestInfo | URL) => Response.json({
      features: new URL(String(input)).searchParams.get("q") === "Honolulu"
        ? [honolulu]
        : [],
    }));
    const searchFor = (fetcher: ReturnType<typeof provider>) => new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetcher as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    for (const query of ["檀香山", "美国檀香山", "Honolulu"]) {
      const fetchMock = provider();
      const results = await searchFor(fetchMock).search(query, { limit: 8 });

      expect(results).toHaveLength(1);
      expect(results[0].countryCode).toBe("US");
      expect(Math.abs(results[0].latitude - 21.307)).toBeLessThan(0.05);
      expect(Math.abs(results[0].longitude - -157.858)).toBeLessThan(0.05);
      // The English query the provider is actually asked is what proves the
      // expansion; the coordinates come from the provider's own answer.
      const queries = fetchMock.mock.calls.map(
        (call) => new URL(String(call[0])).searchParams.get("q"),
      );
      expect(queries.at(-1)).toBe("Honolulu");
    }
  });

  it("resolves an exonym that was never written into the search layer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => Response.json({
      features: new URL(String(input)).searchParams.get("q") === "Rio de Janeiro"
        ? [{
          geometry: { coordinates: [-43.2075, -22.9028] },
          properties: {
            osm_type: "R",
            osm_id: 2697338,
            name: "Rio de Janeiro",
            country: "Brazil",
            countrycode: "BR",
          },
        }]
        : [],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("里约热内卢", { limit: 8 })).resolves.toMatchObject([{
      label: "Rio de Janeiro",
      countryCode: "BR",
    }]);
    const englishUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(englishUrl.searchParams.get("q")).toBe("Rio de Janeiro");
  });

  it("keeps the bilingual labels of the queries the removed alias table covered", async () => {
    const places = {
      London: {
        geometry: { coordinates: [-0.1257, 51.5085] },
        properties: {
          osm_type: "R",
          osm_id: 65606,
          name: "London",
          "name:zh-Hans": "伦敦",
          "name:en": "London",
          country: "United Kingdom",
          countrycode: "GB",
        },
      },
      Tokyo: {
        geometry: { coordinates: [139.7514, 35.6855] },
        properties: {
          osm_type: "R",
          osm_id: 1543125,
          name: "東京都",
          "name:zh-Hans": "东京都",
          "name:en": "Tokyo",
          country: "日本",
          countrycode: "JP",
        },
      },
    } as const;
    const search = () => new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async (input: RequestInfo | URL) => {
        const query = new URL(String(input)).searchParams.get("q") ?? "";
        const place = Object.entries(places).find(
          ([english]) => query === english,
        );
        return Response.json({ features: place ? [place[1]] : [] });
      }) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search().search("伦敦", { limit: 8 })).resolves.toMatchObject([{
      label: "伦敦",
      labelEnglish: "London",
      labelLocal: "London",
      countryCode: "GB",
    }]);
    await expect(search().search("London", { limit: 8 })).resolves.toMatchObject([{
      label: "伦敦",
      labelEnglish: "London",
      labelLocal: "London",
      countryCode: "GB",
    }]);
    await expect(search().search("东京", { limit: 8 })).resolves.toMatchObject([{
      label: "东京都",
      labelEnglish: "Tokyo",
      labelLocal: "東京都",
      countryCode: "JP",
    }]);
    await expect(search().search("Tokyo", { limit: 8 })).resolves.toMatchObject([{
      label: "东京都",
      labelEnglish: "Tokyo",
      labelLocal: "東京都",
      countryCode: "JP",
    }]);
  });

  it("still resolves the exonym when the provider answers with unrelated bilingual places", async () => {
    const unrelated = (index: number) => ({
      geometry: { coordinates: [114.06 + index, 22.54] },
      properties: {
        osm_type: "N",
        osm_id: 900 + index,
        name: `檀香街${index}号`,
        "name:en": `Sandalwood Street ${index}`,
        country: "中国",
        countrycode: "CN",
      },
    });
    // Every primary hit is bilingual, and the primary list is full at the
    // requested limit — neither may hide the place the query actually names.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => Response.json({
      features: new URL(String(input)).searchParams.get("q") === "Honolulu"
        ? [{
          geometry: { coordinates: [-157.85833, 21.30694] },
          properties: {
            osm_type: "R",
            osm_id: 6980,
            name: "Honolulu",
            state: "Hawaii",
            country: "United States",
            countrycode: "US",
          },
        }]
        : [unrelated(0), unrelated(1), unrelated(2)],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    const results = await search.search("檀香山", { limit: 3 });

    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("q")).toBe("Honolulu");
    expect(results.map((result) => result.label)).toContain("Honolulu");
    expect(results[0]).toMatchObject({ label: "Honolulu", countryCode: "US" });
  });

  it("does not let a longer name containing the exonym stand in for it", async () => {
    // `檀香山路` is a street in China whose name contains the query. Treating
    // it as an answer would narrow recall exactly where the alias table used
    // to force the English round trip unconditionally.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => Response.json({
      features: new URL(String(input)).searchParams.get("q") === "Honolulu"
        ? [{
          geometry: { coordinates: [-157.85833, 21.30694] },
          properties: {
            osm_type: "R",
            osm_id: 6980,
            name: "Honolulu",
            country: "United States",
            countrycode: "US",
          },
        }]
        : [{
          geometry: { coordinates: [114.06, 22.54] },
          properties: {
            osm_type: "W",
            osm_id: 77,
            name: "檀香山路",
            "name:en": "Tanxiangshan Road",
            country: "中国",
            countrycode: "CN",
          },
        }],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("檀香山", { limit: 8 })).resolves.toMatchObject([{
      label: "Honolulu",
      countryCode: "US",
    }]);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("q")).toBe("Honolulu");
  });

  it("returns nothing for an unknown Chinese query and never invents a place", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      features: [],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("这个地方并不存在", { limit: 8 })).resolves.toEqual([]);
    // The unresolvable query is still what the second request carries: no
    // English name is synthesized for it.
    const englishUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(englishUrl.searchParams.get("q")).toBe("这个地方并不存在");
  });

  it("keeps an unknown query that merely ends in a known exonym", async () => {
    // `巴黎` is an indexed exonym, but `不存在` is no country or region, so the
    // query names no place and must reach the provider unchanged rather than
    // become a search for Paris.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      features: [],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("不存在巴黎", { limit: 8 })).resolves.toEqual([]);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get("q")).toBe("不存在巴黎");
    }
  });

  it("surfaces an unavailable place-name source instead of degrading silently", async () => {
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json({ features: [] })) as unknown as typeof fetch,
      requestIntervalMs: 0,
      placeNameAliases: async () => {
        throw new LocationSearchUnavailableError("place-name data is unavailable");
      },
    });

    await expect(search.search("檀香山", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("resolves a coordinate to the nearest named place", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      features: [
        {
          geometry: { coordinates: [114.0545429, 22.5445741] },
          properties: {
            osm_type: "R",
            osm_id: 123,
            name: "Shenzhen",
            city: "Shenzhen",
            country: "China",
            countrycode: "CN",
          },
        },
      ],
    }));
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    const result = await search.reverse(22.5445741, 114.0545429, {});

    expect(result).toMatchObject({
      id: "R:123",
      label: "Shenzhen",
      countryCode: "CN",
      latitude: 22.5445741,
      longitude: 114.0545429,
    });
    const [requestUrl] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(requestUrl.pathname).toBe("/reverse");
    expect(requestUrl.searchParams.get("lat")).toBe("22.5445741");
    expect(requestUrl.searchParams.get("lon")).toBe("114.0545429");
    expect(requestUrl.searchParams.get("limit")).toBe("1");
  });

  it("returns null when the provider has no place at the coordinate", async () => {
    const search = new PhotonLocationSearch({
      baseUrl: "https://photon.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json({ features: [] })) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.reverse(0, 0, {})).resolves.toBeNull();
  });
});
