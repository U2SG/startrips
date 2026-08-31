import type {
  Journey,
  JourneyInput,
  LocationSearchResponse,
  LocationSearchResult,
  PrivateMediaRead,
} from "./types";

type Fetcher = typeof fetch;

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export class JourneyApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "JourneyApiError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const response = await fetcher(input, {
    credentials: "include",
    ...init,
    headers: init.body
      ? { "content-type": "application/json", ...init.headers }
      : init.headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiErrorPayload | null;
    throw new JourneyApiError(
      response.status,
      payload?.error ?? "REQUEST_FAILED",
      payload?.message ?? payload?.error ?? `请求失败 (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listJourneys(fetcher: Fetcher = fetch): Promise<Journey[]> {
  const payload = await requestJson<{ journeys: Journey[] }>(
    "/api/journeys",
    { cache: "no-store" },
    fetcher,
  );
  return payload.journeys;
}

export async function createJourney(
  input: JourneyInput,
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    "/api/journeys",
    { method: "POST", body: JSON.stringify(input) },
    fetcher,
  );
  return payload.journey;
}

export async function updateJourney(
  id: string,
  input: JourneyInput,
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    `/api/journeys/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    fetcher,
  );
  return payload.journey;
}

export async function deleteJourney(
  id: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await requestJson<void>(
    `/api/journeys/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    fetcher,
  );
}

export async function restoreJourney(
  id: string,
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    `/api/journeys/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
    fetcher,
  );
  return payload.journey;
}

export function getPrivateMediaRead(
  assetId: string,
  fetcher: Fetcher = fetch,
): Promise<PrivateMediaRead> {
  return requestJson<PrivateMediaRead>(
    `/api/uploads/assets/${encodeURIComponent(assetId)}/read-url`,
    {},
    fetcher,
  );
}

export async function deleteMedia(
  assetId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await requestJson<void>(
    `/api/uploads/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" },
    fetcher,
  );
}

export async function reorderJourneyMedia(
  journeyId: string,
  assetIds: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    "/api/uploads/assets/reorder",
    { method: "POST", body: JSON.stringify({ journeyId, assetIds }) },
    fetcher,
  );
  return payload.journey;
}

// Batch-moves media onto a different route point (or `null`, back to the
// whole journey) — for fixing photos that landed on the wrong stop, without
// re-uploading. One request for the whole selection.
export async function moveJourneyMedia(
  journeyId: string,
  assetIds: readonly string[],
  routePointId: string | null,
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    "/api/uploads/assets/move",
    { method: "POST", body: JSON.stringify({ journeyId, assetIds, routePointId }) },
    fetcher,
  );
  return payload.journey;
}

export type MediaMoveUndo = {
  sourceJourneyId: string;
  targetJourneyId: string;
  assetIds: string[];
  sourceOrder: string[];
  sourceCoverMediaAssetId: string | null;
  placements: Array<{ assetId: string; routePointId: string | null }>;
};

export type CrossJourneyMediaMoveResult = {
  sourceJourney: Journey;
  destinationJourney: Journey;
  undo: MediaMoveUndo;
};

export async function moveMediaBetweenJourneys(
  sourceJourneyId: string,
  targetJourneyId: string,
  assetIds: readonly string[],
  routePointId: string | null,
  fetcher: Fetcher = fetch,
): Promise<CrossJourneyMediaMoveResult> {
  const payload = await requestJson<{
    sourceJourney: Journey;
    destinationJourney: Journey;
    undo: MediaMoveUndo;
  }>(
    "/api/uploads/assets/move",
    {
      method: "POST",
      body: JSON.stringify({
        journeyId: sourceJourneyId,
        targetJourneyId,
        assetIds,
        routePointId,
      }),
    },
    fetcher,
  );
  return payload;
}

export async function undoMediaMove(
  undo: MediaMoveUndo,
  fetcher: Fetcher = fetch,
): Promise<Pick<CrossJourneyMediaMoveResult, "sourceJourney" | "destinationJourney">> {
  return requestJson(
    "/api/uploads/assets/move/undo",
    { method: "POST", body: JSON.stringify(undo) },
    fetcher,
  );
}

// #14: set or clear the journey's explicit cover media.
export async function setJourneyCover(
  journeyId: string,
  coverMediaAssetId: string | null,
  fetcher: Fetcher = fetch,
): Promise<Journey> {
  const payload = await requestJson<{ journey: Journey }>(
    `/api/journeys/${encodeURIComponent(journeyId)}/cover`,
    { method: "PATCH", body: JSON.stringify({ coverMediaAssetId }) },
    fetcher,
  );
  return payload.journey;
}

export async function searchLocations(
  query: string,
  fetcher: Fetcher = fetch,
): Promise<LocationSearchResponse> {
  return requestJson<LocationSearchResponse>(
    `/api/locations/search?q=${encodeURIComponent(query.trim())}`,
    {},
    fetcher,
  );
}

export type ReverseGeocodeResponse = {
  result: LocationSearchResult | null;
  attribution: { label: string; url: string } | null;
};

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  fetcher: Fetcher = fetch,
  timeoutMs = 8_000,
): Promise<ReverseGeocodeResponse> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestJson<ReverseGeocodeResponse>(
      `/api/locations/reverse?latitude=${encodeURIComponent(String(latitude))}&longitude=${encodeURIComponent(String(longitude))}`,
      { signal: controller.signal },
      fetcher,
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
