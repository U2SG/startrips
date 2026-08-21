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
