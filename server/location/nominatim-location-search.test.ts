import { describe, expect, it, vi } from "vitest";
import { LocationSearchUnavailableError } from "./location-search";
import { NominatimLocationSearch } from "./nominatim-location-search";

describe("NominatimLocationSearch", () => {
  it("maps precise places, identifies the app, and caches repeated searches", async () => {
    const fetchMock = vi.fn(async () => Response.json([
      {
        place_id: 123,
        osm_type: "node",
        osm_id: 456,
        display_name: "National Gallery Singapore, St Andrew's Road, Downtown Core, Singapore",
        lat: "1.2905434",
        lon: "103.8515221",
        namedetails: { name: "National Gallery Singapore" },
        address: { country_code: "sg" },
      },
      {
        place_id: 999,
        display_name: "Broken result",
        lat: "not-a-number",
        lon: "103.8",
      },
    ]));
    const fetcher = fetchMock as unknown as typeof fetch;
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0 (+https://startrips.example)",
      fetcher,
      requestIntervalMs: 0,
    });

    const first = await search.search("  National   Gallery Singapore  ", { limit: 8 });
    const second = await search.search("national gallery singapore", { limit: 8 });

    expect(first).toEqual([{
      id: "node:456",
      label: "National Gallery Singapore",
      context: "St Andrew's Road, Downtown Core, Singapore",
      countryCode: "SG",
      latitude: 1.2905434,
      longitude: 103.8515221,
    }]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(requestUrl.pathname).toBe("/search");
    expect(requestUrl.searchParams.get("q")).toBe("National Gallery Singapore");
    expect(requestUrl.searchParams.get("addressdetails")).toBe("1");
    expect(requestUrl.searchParams.get("namedetails")).toBe("1");
    expect(new Headers(requestInit.headers).get("User-Agent")).toContain("Startrips");
    expect(search.attribution?.url).toBe("https://www.openstreetmap.org/copyright");
  });

  it("turns provider failures into the stable unavailable error", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 })) as unknown as typeof fetch;
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher,
      requestIntervalMs: 0,
    });

    await expect(search.search("Singapore", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("prefers a Chinese name and preserves the English namedetail", async () => {
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json([{
        place_id: 123,
        osm_type: "relation",
        osm_id: 456,
        display_name: "Beijing, China",
        lat: "39.9057",
        lon: "116.3913",
        namedetails: {
          name: "北京",
          "name:zh-Hans": "北京市",
          "name:en": "Beijing",
        },
        address: { country_code: "cn" },
      }])) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.search("Beijing", { limit: 8 })).resolves.toMatchObject([{
      label: "北京市",
      labelEnglish: "Beijing",
      labelLocal: "北京",
    }]);
  });

  it("times out a stalled provider request instead of blocking the queue forever", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher,
      requestIntervalMs: 0,
      requestTimeoutMs: 5,
    });

    await expect(search.search("Singapore", { limit: 8 })).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("drops an aborted queued request before it reaches the provider", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(async () => new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    })) as unknown as typeof fetch;
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher,
      requestIntervalMs: 0,
    });
    const first = search.search("Singapore", { limit: 8 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const queuedController = new AbortController();
    const queued = search.search("Tokyo", {
      limit: 8,
      signal: queuedController.signal,
    });
    queuedController.abort();
    releaseFirst?.(Response.json([]));

    await expect(first).resolves.toEqual([]);
    await expect(queued).rejects.toBeInstanceOf(LocationSearchUnavailableError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("resolves a coordinate to the nearest named place", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      place_id: 789,
      osm_type: "relation",
      osm_id: 123,
      display_name: "Shenzhen, Guangdong, China",
      lat: "22.5445741",
      lon: "114.0545429",
      namedetails: { name: "Shenzhen" },
      address: { country_code: "cn" },
    }));
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher: fetchMock as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    const result = await search.reverse(22.5445741, 114.0545429, {});

    expect(result).toMatchObject({
      id: "relation:123",
      label: "Shenzhen",
      context: "Guangdong, China",
      countryCode: "CN",
      latitude: 22.5445741,
      longitude: 114.0545429,
    });
    const [requestUrl] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(requestUrl.pathname).toBe("/reverse");
    expect(requestUrl.searchParams.get("lat")).toBe("22.5445741");
    expect(requestUrl.searchParams.get("lon")).toBe("114.0545429");
    expect(requestUrl.searchParams.get("format")).toBe("jsonv2");
  });

  it("returns null when the provider has no place at the coordinate", async () => {
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher: vi.fn(async () => Response.json({
        error: "Unable to geocode",
      })) as unknown as typeof fetch,
      requestIntervalMs: 0,
    });

    await expect(search.reverse(0, 0, {})).resolves.toBeNull();
  });

  it("rejects excess queued searches under provider backpressure", async () => {
    const controllers = Array.from({ length: 24 }, () => new AbortController());
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;
    const search = new NominatimLocationSearch({
      baseUrl: "https://nominatim.example.test",
      userAgent: "Startrips/1.0",
      fetcher,
      requestIntervalMs: 0,
    });
    const pending = controllers.map((controller, index) =>
      search.search(`query-${index}`, { limit: 8, signal: controller.signal })
        .catch((error: unknown) => error));

    await expect(search.search("overflow", { limit: 8 })).rejects.toThrow(
      "Location search is busy",
    );
    controllers.forEach((controller) => controller.abort());
    const errors = await Promise.all(pending);
    expect(errors).toHaveLength(24);
    expect(errors.every((error) => error instanceof LocationSearchUnavailableError)).toBe(true);
  });
});
