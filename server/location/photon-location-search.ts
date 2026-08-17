import {
  fetchLocationSearch,
  LocationSearchUnavailableError,
  throwIfLocationSearchAborted,
  waitForLocationSearchDelay,
  type LocationSearch,
  type LocationSearchOptions,
  type LocationSearchResult,
  type ReverseLocationOptions,
} from "./location-search";

type PhotonFeature = {
  geometry?: {
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

type PhotonPayload = {
  features?: unknown;
};

type CachedResults = {
  expiresAt: number;
  results: LocationSearchResult[];
};

type PhotonLocationSearchOptions = {
  baseUrl: string;
  userAgent: string;
  fetcher?: typeof fetch;
  requestIntervalMs?: number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_INTERVAL_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_PENDING_REQUESTS = 24;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function contextFrom(properties: Record<string, unknown>, label: string): string {
  const street = [text(properties.street), text(properties.housenumber)]
    .filter(Boolean)
    .join(" ");
  const parts = [
    street,
    text(properties.district),
    text(properties.city),
    text(properties.county),
    text(properties.state),
    text(properties.country),
  ].filter(Boolean);
  return [...new Set(parts.filter((part) => part !== label))].join(", ");
}

function toLocationResult(feature: PhotonFeature): LocationSearchResult | null {
  const coordinates = feature.geometry?.coordinates;
  const properties = feature.properties ?? {};
  if (!Array.isArray(coordinates)) return null;

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const label = text(properties.name)
    || text(properties.street)
    || text(properties.city)
    || text(properties.country);
  if (
    !label
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }

  const osmType = text(properties.osm_type);
  const osmId = typeof properties.osm_id === "string"
    || typeof properties.osm_id === "number"
    ? String(properties.osm_id)
    : "";

  return {
    id: osmType && osmId
      ? `${osmType}:${osmId}`
      : `place:${latitude}:${longitude}`,
    label,
    context: contextFrom(properties, label),
    countryCode: text(properties.countrycode).toUpperCase(),
    latitude,
    longitude,
  };
}

export class PhotonLocationSearch implements LocationSearch {
  readonly driver = "photon";
  readonly attribution = {
    label: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
  };

  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetcher: typeof fetch;
  private readonly requestIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly cache = new Map<string, CachedResults>();
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private pendingRequests = 0;

  constructor(options: PhotonLocationSearchOptions) {
    this.baseUrl = `${options.baseUrl.replace(/\/$/, "")}/`;
    this.userAgent = options.userAgent;
    this.fetcher = options.fetcher ?? fetch;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  search(
    query: string,
    options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    const url = new URL("api/", this.baseUrl);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("limit", String(options.limit));
    return this.requestFeatures(
      url,
      `search:${normalizedQuery.toLocaleLowerCase()}::${options.limit}`,
      { limit: options.limit, signal: options.signal },
    );
  }

  reverse(
    latitude: number,
    longitude: number,
    options: ReverseLocationOptions,
  ): Promise<LocationSearchResult | null> {
    const url = new URL("reverse", this.baseUrl);
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("limit", "1");
    return this.requestFeatures(
      url,
      `reverse:${latitude}:${longitude}`,
      { signal: options.signal },
    ).then((results) => results[0] ?? null);
  }

  private requestFeatures(
    url: URL,
    cacheKey: string,
    options: { limit?: number; signal?: AbortSignal },
  ): Promise<LocationSearchResult[]> {
    if (this.pendingRequests >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new LocationSearchUnavailableError("Location search is busy; try again shortly"),
      );
    }
    this.pendingRequests += 1;
    const task = this.queue.then(async () => {
      throwIfLocationSearchAborted(options.signal);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.results;

      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      await waitForLocationSearchDelay(waitMs, options.signal);
      throwIfLocationSearchAborted(options.signal);
      this.nextRequestAt = Date.now() + this.requestIntervalMs;

      let response: Response;
      try {
        response = await fetchLocationSearch(this.fetcher, url, {
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          signal: options.signal,
        }, this.requestTimeoutMs);
      } catch {
        throw new LocationSearchUnavailableError("Location search request failed");
      }
      if (!response.ok) {
        throw new LocationSearchUnavailableError(
          `Location search returned HTTP ${response.status}`,
        );
      }

      let payload: PhotonPayload;
      try {
        payload = await response.json() as PhotonPayload;
      } catch {
        throw new LocationSearchUnavailableError("Location search returned invalid data");
      }
      if (!Array.isArray(payload.features)) {
        throw new LocationSearchUnavailableError("Location search returned invalid data");
      }
      const results = payload.features
        .map((feature) => toLocationResult(feature as PhotonFeature))
        .filter((result): result is LocationSearchResult => result !== null)
        .slice(0, options.limit ?? 1);

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + this.cacheTtlMs,
        results,
      });
      return results;
    }).finally(() => {
      this.pendingRequests -= 1;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
