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

export type LocationSearchOptions = {
  limit: number;
  signal?: AbortSignal;
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
