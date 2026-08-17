import type {
  Journey,
  JourneyInput,
  LocationSearchResponse,
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
