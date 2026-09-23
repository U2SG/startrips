type Fetcher = typeof fetch;

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

type RecordedTrackWireSample = {
  recordedAt?: string | null;
};

type RecordedTrackWireSegment = {
  sampleCount?: number;
  samples?: RecordedTrackWireSample[];
};

type RecordedTrackWireOperation = {
  journeyId: string;
  operationKey: string;
  source: string;
  provenance: string;
  segments: RecordedTrackWireSegment[];
};

export type JourneyRecordedTrackSummary = {
  journeyId: string;
  operationKey: string;
  source: string;
  provenance: string;
  segmentCount: number;
  sampleCount: number;
  startedAt: string | null;
  endedAt: string | null;
};

export type JourneyRecordedTrackImportResult = {
  status: 200 | 201;
  replayed: boolean;
  format: string;
  recordedTrack: JourneyRecordedTrackSummary;
};

export class JourneyRecordedTrackApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "JourneyRecordedTrackApiError";
    this.status = status;
    this.code = code;
  }
}

export type JourneyRecordedTrackRequestOptions = {
  signal?: AbortSignal;
  fetcher?: Fetcher;
};

function routeForJourney(journeyId: string) {
  return `/api/journey-recorded-tracks/${encodeURIComponent(journeyId)}`;
}

async function readError(response: Response) {
  const payload = await response.json().catch(() => null) as ApiErrorPayload | null;
  return new JourneyRecordedTrackApiError(
    response.status,
    payload?.error ?? "REQUEST_FAILED",
    payload?.message ?? payload?.error ?? `请求失败 (${response.status})`,
  );
}

function summarize(operation: RecordedTrackWireOperation): JourneyRecordedTrackSummary {
  let sampleCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const segment of operation.segments) {
    sampleCount += segment.sampleCount ?? segment.samples?.length ?? 0;
    for (const sample of segment.samples ?? []) {
      const time = sample.recordedAt;
      if (typeof time !== "string" || time.length === 0) continue;
      if (startedAt === null || time < startedAt) startedAt = time;
      if (endedAt === null || time > endedAt) endedAt = time;
    }
  }
  return {
    journeyId: operation.journeyId,
    operationKey: operation.operationKey,
    source: operation.source,
    provenance: operation.provenance,
    segmentCount: operation.segments.length,
    sampleCount,
    startedAt,
    endedAt,
  };
}

/**
 * Read owner-private recorded-track batches. Precise sample coordinates are
 * deliberately collapsed to counts/time coverage at this boundary: the editor
 * has no product need to retain or expose them.
 */
export async function listJourneyRecordedTracks(
  journeyId: string,
  options: JourneyRecordedTrackRequestOptions = {},
): Promise<JourneyRecordedTrackSummary[]> {
  const response = await (options.fetcher ?? fetch)(routeForJourney(journeyId), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) throw await readError(response);
  const payload = await response.json() as { recordedTracks: RecordedTrackWireOperation[] };
  return payload.recordedTracks.map(summarize);
}

/**
 * Import one user-selected file through the format-neutral server channel.
 * The document is a JSON body value only; neither file bytes nor replay keys
 * enter a URL, browser storage, or telemetry surface here.
 */
export async function importJourneyRecordedTrack(
  journeyId: string,
  document: string,
  options: JourneyRecordedTrackRequestOptions = {},
): Promise<JourneyRecordedTrackImportResult> {
  const response = await (options.fetcher ?? fetch)(`${routeForJourney(journeyId)}/imports`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "gpx", document }),
    signal: options.signal,
  });
  if (!response.ok) throw await readError(response);
  if (response.status !== 200 && response.status !== 201) {
    throw new JourneyRecordedTrackApiError(
      response.status,
      "UNEXPECTED_IMPORT_STATUS",
      "轨迹导入返回了未知状态",
    );
  }
  const payload = await response.json() as {
    imported: {
      format: string;
      replayed: boolean;
      recordedTrack: RecordedTrackWireOperation;
    };
  };
  return {
    status: response.status,
    replayed: payload.imported.replayed,
    format: payload.imported.format,
    recordedTrack: summarize(payload.imported.recordedTrack),
  };
}

/** Withdrawal keeps the opaque operation key in the DELETE JSON body. */
export async function withdrawJourneyRecordedTrack(
  journeyId: string,
  operationKey: string,
  options: JourneyRecordedTrackRequestOptions = {},
): Promise<void> {
  const response = await (options.fetcher ?? fetch)(routeForJourney(journeyId), {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationKey }),
    signal: options.signal,
  });
  if (!response.ok) throw await readError(response);
}
