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
import {
  resolveEnglishPlaceQuery,
  type PlaceNameAliasResolver,
} from "./place-name-aliases";

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
  placeNameAliases?: PlaceNameAliasResolver;
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

function hasNonAscii(value: string) {
  return /[^\u0000-\u007f]/.test(value);
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
  const chineseLabel = firstText(properties, ["name:zh-Hans", "name:zh"]);
  const providerLabel = text(properties.name)
    || text(properties.street)
    || text(properties.city)
    || text(properties.country);
  const label = chineseLabel || providerLabel;
  const labelEnglish = firstText(properties, [
    "name:en",
    "name_en",
    "name:latin",
    "int_name",
  ]);
  const labelLocal = providerLabel !== label ? providerLabel : "";
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
    ...(labelEnglish && labelEnglish !== label ? { labelEnglish } : {}),
    ...(labelLocal && labelLocal !== label ? { labelLocal } : {}),
    context: contextFrom(properties, label),
    countryCode: text(properties.countrycode).toUpperCase(),
    latitude,
    longitude,
  };
}

function englishAlias(result: LocationSearchResult) {
  if (result.labelEnglish && !hasNonAscii(result.labelEnglish)) {
    return result.labelEnglish;
  }
  return hasNonAscii(result.label) ? "" : result.label;
}

function samePlace(left: LocationSearchResult, right: LocationSearchResult) {
  return left.id === right.id
    || (
      left.countryCode === right.countryCode
      && Math.abs(left.latitude - right.latitude) < 0.001
      && Math.abs(left.longitude - right.longitude) < 0.001
    );
}

function mergeBilingualResults(
  primary: LocationSearchResult[],
  english: LocationSearchResult[],
  limit: number,
  preferEnglish: boolean,
) {
  const output = (preferEnglish ? english : primary).map((result) => ({ ...result }));
  const secondary = preferEnglish ? primary : english;
  const matchedSecondary = new Set<number>();

  output.forEach((result) => {
    const secondaryIndex = secondary.findIndex(
      (candidate, index) => !matchedSecondary.has(index) && samePlace(result, candidate),
    );
    if (secondaryIndex < 0) return;
    matchedSecondary.add(secondaryIndex);
    const candidate = secondary[secondaryIndex];
    const candidateEnglish = englishAlias(preferEnglish ? result : candidate);
    const candidateLocal = preferEnglish
      ? candidate.labelLocal || (hasNonAscii(candidate.label) ? candidate.label : "")
      : candidate.labelLocal;
    if (candidateEnglish && candidateEnglish !== result.label) {
      result.labelEnglish = candidateEnglish;
    }
    if (candidateLocal && candidateLocal !== result.label) {
      result.labelLocal = candidateLocal;
    }
    if (!result.context && candidate.context) result.context = candidate.context;
  });

  // Whenever the provider answered the query in its own language, keep that
  // ordering and append only genuinely new English hits — a localized label
  // the provider supplied is never dropped just to make a query work. When it
  // answered nothing at all, the English hits are the whole list.
  if (!preferEnglish) {
    secondary.forEach((candidate, index) => {
      if (matchedSecondary.has(index)) return;
      output.push(candidate);
    });
  }
  return output.slice(0, limit);
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
  private readonly placeNameAliases: PlaceNameAliasResolver;
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
    this.placeNameAliases = options.placeNameAliases ?? resolveEnglishPlaceQuery;
  }

  search(
    query: string,
    options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    const primaryUrl = new URL("api/", this.baseUrl);
    primaryUrl.searchParams.set("q", normalizedQuery);
    primaryUrl.searchParams.set("limit", String(options.limit));
    return this.requestFeatures(
      primaryUrl,
      `search:${normalizedQuery.toLocaleLowerCase()}::${options.limit}`,
      { limit: options.limit, signal: options.signal },
    ).then(async (primaryResults) => {
      // The English request is queued behind the primary one — a full
      // requestIntervalMs (1s by default) of added latency — so only pay for
      // it when the primary answer is genuinely insufficient: a result carries
      // no English label, or a non-ASCII query found nothing at all. A Chinese
      // query the provider already answers bilingually must not trigger it.
      // Whether the query has a known exonym is deliberately NOT a trigger:
      // the shared place-name index knows Chinese names for domestic cities
      // too, and those are exactly the queries the provider answers in one
      // round trip.
      const shouldFetchEnglish = (
        primaryResults.some((result) => !result.labelEnglish && hasNonAscii(result.label))
        || (hasNonAscii(normalizedQuery) && primaryResults.length === 0)
      );
      if (!shouldFetchEnglish) return primaryResults;

      // Only now is the exonym worth resolving, and a failure to read the
      // shared place-name data is surfaced rather than silently narrowing
      // recall back to whatever the provider answered in its own language.
      const englishQuery = await this.placeNameAliases(normalizedQuery);
      const englishUrl = new URL("api/", this.baseUrl);
      englishUrl.searchParams.set("q", englishQuery);
      englishUrl.searchParams.set("limit", String(options.limit));
      englishUrl.searchParams.set("lang", "en");
      let englishResults: LocationSearchResult[];
      try {
        englishResults = await this.requestFeatures(
          englishUrl,
          `search:${englishQuery.toLocaleLowerCase()}::${options.limit}::lang=en`,
          { limit: options.limit, signal: options.signal },
        );
      } catch {
        throwIfLocationSearchAborted(options.signal);
        return primaryResults;
      }
      return mergeBilingualResults(
        primaryResults,
        englishResults,
        options.limit,
        primaryResults.length === 0 && hasNonAscii(normalizedQuery),
      );
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
