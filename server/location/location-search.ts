export type LocationSearchResult = {
  id: string;
  label: string;
  /** Optional provider-supplied English alias for bilingual result rendering. */
  labelEnglish?: string;
  /** Optional provider-supplied original/local alias for bilingual rendering. */
  labelLocal?: string;
  context: string;
  countryCode: string;
  latitude: number;
  longitude: number;
};

/**
 * #546: the Journey context a search may rank nearby places ahead of. Only
 * these two numbers reach a provider; no Journey, Atlas or member identifier
 * ever does.
 */
export type LocationSearchFocus = {
  latitude: number;
  longitude: number;
};

export type LocationSearchOptions = {
  limit: number;
  signal?: AbortSignal;
  /** A ranking bias only: providers still return far-away matches. */
  focus?: LocationSearchFocus;
};

export type ReverseLocationOptions = {
  signal?: AbortSignal;
};

export type LocationSearchAttribution = {
  label: string;
  url: string;
};

export interface LocationSearch {
  readonly driver: string;
  readonly attribution: LocationSearchAttribution | null;
  search(
    query: string,
    options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]>;
  reverse(
    latitude: number,
    longitude: number,
    options: ReverseLocationOptions,
  ): Promise<LocationSearchResult | null>;
}

export class LocationSearchUnavailableError extends Error {
  constructor(message = "Location search is not configured") {
    super(message);
    this.name = "LocationSearchUnavailableError";
  }
}

/** A search whose parameters are unusable, answered with HTTP 400. */
export class LocationSearchInvalidError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocationSearchInvalidError";
    this.code = code;
  }
}

const FOCUS_DECIMALS = 2;

/**
 * Rounds a focus to about one kilometre: enough for a ranking bias, less
 * precision than a Route Point holds, and nearby searches share a cache entry.
 */
export function roundLocationSearchFocus(
  focus: LocationSearchFocus | undefined,
): LocationSearchFocus | undefined {
  if (!focus) return undefined;
  const factor = 10 ** FOCUS_DECIMALS;
  return {
    latitude: Math.round(focus.latitude * factor) / factor,
    longitude: Math.round(focus.longitude * factor) / factor,
  };
}

/** Cache-key suffix; empty without a focus so unbiased keys stay unchanged. */
export function locationSearchFocusKey(focus: LocationSearchFocus | undefined): string {
  return focus ? `::focus=${focus.latitude},${focus.longitude}` : "";
}

export function throwIfLocationSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LocationSearchUnavailableError("Location search request was cancelled");
  }
}

export function waitForLocationSearchDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfLocationSearchAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(new LocationSearchUnavailableError("Location search request was cancelled"));
    };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function fetchLocationSearch(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  throwIfLocationSearchAborted(init.signal ?? undefined);
  const controller = new AbortController();
  const externalSignal = init.signal ?? undefined;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (externalSignal?.aborted) forwardAbort();
  const timeout = globalThis.setTimeout(
    () => controller.abort(new Error("Location search provider timed out")),
    timeoutMs,
  );
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}
