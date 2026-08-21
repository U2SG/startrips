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

type NominatimPlace = {
  place_id?: string | number;
  osm_type?: string;
  osm_id?: string | number;
  display_name?: string;
  lat?: string;
  lon?: string;
  namedetails?: Record<string, unknown>;
  address?: Record<string, unknown>;
};

type CachedPayload = {
  expiresAt: number;
  payload: unknown;
};

type NominatimLocationSearchOptions = {
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

function firstText(properties: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(properties[key]);
    if (value) return value;
  }
  return "";
}

function toLocationResult(place: NominatimPlace): LocationSearchResult | null {
  const latitude = Number(place.lat);
  const longitude = Number(place.lon);
  const displayName = text(place.display_name);
  if (
    !displayName
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }

  const parts = displayName.split(",").map((part) => part.trim()).filter(Boolean);
  const nameDetails = place.namedetails ?? {};
  const localLabel = text(nameDetails.name) || parts[0] || displayName;
  const chineseLabel = firstText(nameDetails, ["name:zh-Hans", "name:zh"]);
  const label = chineseLabel || localLabel;
  const labelEnglish = firstText(nameDetails, ["name:en", "int_name", "official_name:en"]);
  const context = parts.filter((part, index) => index > 0 && part !== label).join(", ");
  const sourceId = place.osm_type && place.osm_id !== undefined
    ? `${place.osm_type}:${place.osm_id}`
    : `place:${place.place_id ?? `${latitude}:${longitude}`}`;

  return {
    id: sourceId,
    label,
    ...(labelEnglish && labelEnglish !== label ? { labelEnglish } : {}),
    ...(localLabel && localLabel !== label ? { labelLocal: localLabel } : {}),
    context,
    countryCode: text(place.address?.country_code).toUpperCase(),
    latitude,
    longitude,
  };
}

export class NominatimLocationSearch implements LocationSearch {
  readonly driver = "nominatim";
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
  private readonly cache = new Map<string, CachedPayload>();
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private pendingRequests = 0;

  constructor(options: NominatimLocationSearchOptions) {
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
    const url = new URL("search", this.baseUrl);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "1");
    url.searchParams.set("accept-language", "zh-CN,zh,en");
    url.searchParams.set("limit", String(options.limit));
    return this.requestPayload(
      url,
      `search:${normalizedQuery.toLocaleLowerCase()}::${options.limit}`,
      options.signal,
    ).then((payload) => {
      if (!Array.isArray(payload)) {
        throw new LocationSearchUnavailableError("Location search returned invalid data");
      }
      return payload
        .map((place) => toLocationResult(place as NominatimPlace))
        .filter((result): result is LocationSearchResult => result !== null)
        .slice(0, options.limit);
    });
  }

  reverse(
    latitude: number,
    longitude: number,
    options: ReverseLocationOptions,
  ): Promise<LocationSearchResult | null> {
    const url = new URL("reverse", this.baseUrl);
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "1");
    url.searchParams.set("accept-language", "zh-CN,zh,en");
    return this.requestPayload(
      url,
      `reverse:${latitude}:${longitude}`,
      options.signal,
    ).then((payload) => {
      if (!payload || typeof payload !== "object") return null;
      return toLocationResult(payload as NominatimPlace);
    });
  }

  private requestPayload(
    url: URL,
    cacheKey: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.pendingRequests >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new LocationSearchUnavailableError("Location search is busy; try again shortly"),
      );
    }
    this.pendingRequests += 1;
    const task = this.queue.then(async () => {
      throwIfLocationSearchAborted(signal);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.payload;

      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      await waitForLocationSearchDelay(waitMs, signal);
      throwIfLocationSearchAborted(signal);
      this.nextRequestAt = Date.now() + this.requestIntervalMs;

      let response: Response;
      try {
        response = await fetchLocationSearch(this.fetcher, url, {
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          signal,
        }, this.requestTimeoutMs);
      } catch {
        throw new LocationSearchUnavailableError("Location search request failed");
      }
      if (!response.ok) {
        throw new LocationSearchUnavailableError(
          `Location search returned HTTP ${response.status}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new LocationSearchUnavailableError("Location search returned invalid data");
      }

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + this.cacheTtlMs,
        payload,
      });
      return payload;
    }).finally(() => {
      this.pendingRequests -= 1;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
