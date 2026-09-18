export const MEDIA_SPATIAL_SOURCES = [
  "exif",
  "container-metadata",
  "imported",
  "unknown",
] as const;

export const MEDIA_SPATIAL_GRANULARITIES = [
  "coordinate",
  "city",
  "unknown",
] as const;

export const MEDIA_CAPTURE_TIME_SOURCES = [
  "exif-original",
  "exif-digitized",
  "gps",
  "container-metadata",
  "imported",
  "unknown",
] as const;
export const MEDIA_TIMEZONE_STATES = [
  "offset-known",
  "local-only",
  "unknown",
] as const;

export type MediaSpatialSource = typeof MEDIA_SPATIAL_SOURCES[number];
export type MediaSpatialGranularity =
  typeof MEDIA_SPATIAL_GRANULARITIES[number];
export type MediaCaptureTimeSource =
  typeof MEDIA_CAPTURE_TIME_SOURCES[number];
export type MediaTimezoneState = typeof MEDIA_TIMEZONE_STATES[number];

export type MediaRecordedSpatialEvidence = {
  source: MediaSpatialSource;
  granularity: MediaSpatialGranularity;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  label: string | null;
};
export type MediaRecordedCaptureTime = {
  source: MediaCaptureTimeSource;
  timezone: MediaTimezoneState;
  local: string | null;
  instant: Date | null;
  offsetMinutes: number | null;
};

export type MediaRecordedEvidence = {
  spatial: MediaRecordedSpatialEvidence;
  captureTime: MediaRecordedCaptureTime;
};

export type MediaDisplayCorrection = {
  granularity: Exclude<MediaSpatialGranularity, "unknown">;
  latitude: number | null;
  longitude: number | null;
  label: string | null;
};

export type MediaDisplayState = {
  hidden: boolean;
  correction: MediaDisplayCorrection | null;
};
export type MediaRecordedEvidenceWrite = {
  expectedRevision: number;
  recorded: MediaRecordedEvidence;
};

export type MediaDisplayStateWrite = {
  expectedRevision: number;
  display: MediaDisplayState;
};

export type EffectiveMediaSpatialEvidence = {
  source: "recorded" | "user-correction";
  provenance: MediaSpatialSource | null;
  granularity: Exclude<MediaSpatialGranularity, "unknown">;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  label: string | null;
};

const LOCAL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const OFFSET_INSTANT = /(?:Z|[+-]\d{2}:\d{2})$/i;

function validLocalTimestamp(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const match = LOCAL_TIMESTAMP.exec(value);
  if (!match) return "invalid";
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, sec] = parts;
  const normalized = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (
    normalized.getUTCFullYear() !== y
    || normalized.getUTCMonth() !== mo - 1
    || normalized.getUTCDate() !== d
    || normalized.getUTCHours() !== h
    || normalized.getUTCMinutes() !== mi
    || normalized.getUTCSeconds() !== sec
  ) return "invalid";
  return value;
}

function localWallClockMillis(value: string): number {
  const match = LOCAL_TIMESTAMP.exec(value);
  if (!match) throw new Error("validated local timestamp no longer matches");
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    milliseconds,
  );
}
function isOneOf<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function finite(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "invalid";
}

function label(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160
    ? trimmed
    : "invalid";
}

function revision(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}
function parseRecordedSpatial(
  value: unknown,
): MediaRecordedSpatialEvidence | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !isOneOf(MEDIA_SPATIAL_SOURCES, record.source)
    || !isOneOf(MEDIA_SPATIAL_GRANULARITIES, record.granularity)
  ) return null;

  const latitude = finite(record.latitude);
  const longitude = finite(record.longitude);
  const accuracyMeters = finite(record.accuracyMeters);
  const placeLabel = label(record.label);
  if (
    latitude === "invalid"
    || longitude === "invalid"
    || accuracyMeters === "invalid"
    || placeLabel === "invalid"
  ) return null;
  if (
    latitude !== null && (latitude < -90 || latitude > 90)
    || longitude !== null && (longitude < -180 || longitude > 180)
    || accuracyMeters !== null
      && (accuracyMeters < 0 || accuracyMeters > 1_000_000)
  ) return null;
  if (record.granularity === "coordinate") {
    if (
      record.source === "unknown"
      || latitude === null
      || longitude === null
      || placeLabel !== null
    ) return null;
  } else if (record.granularity === "city") {
    if (
      record.source === "unknown"
      || latitude !== null
      || longitude !== null
      || accuracyMeters !== null
      || placeLabel === null
    ) return null;
  } else if (
    record.source !== "unknown"
    || latitude !== null
    || longitude !== null
    || accuracyMeters !== null
    || placeLabel !== null
  ) return null;

  return {
    source: record.source,
    granularity: record.granularity,
    latitude,
    longitude,
    accuracyMeters,
    label: placeLabel,
  };
}
function parseCaptureTime(
  value: unknown,
): MediaRecordedCaptureTime | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !isOneOf(MEDIA_CAPTURE_TIME_SOURCES, record.source)
    || !isOneOf(MEDIA_TIMEZONE_STATES, record.timezone)
  ) return null;

  const local = validLocalTimestamp(record.local);
  const rawInstant = record.instant === null || record.instant === undefined
    ? null
    : typeof record.instant === "string" && OFFSET_INSTANT.test(record.instant)
      ? record.instant
      : "invalid";
  const instant = rawInstant && rawInstant !== "invalid"
    ? new Date(rawInstant)
    : rawInstant;
  const offsetMinutes = record.offsetMinutes === null
    || record.offsetMinutes === undefined
    ? null
    : Number.isInteger(record.offsetMinutes)
      ? Number(record.offsetMinutes)
      : "invalid";
  if (
    local === "invalid"
    || instant === "invalid"
    || instant instanceof Date && !Number.isFinite(instant.valueOf())
    || offsetMinutes === "invalid"
    || typeof offsetMinutes === "number"
      && (offsetMinutes < -14 * 60 || offsetMinutes > 14 * 60)
  ) return null;

  if (record.timezone === "offset-known") {
    if (
      record.source === "unknown"
      || local === null
      || !(instant instanceof Date)
      || typeof offsetMinutes !== "number"
    ) return null;
    const impliedInstant = localWallClockMillis(local) - offsetMinutes * 60_000;
    if (Math.abs(impliedInstant - instant.valueOf()) >= 1) return null;
  } else if (record.timezone === "local-only") {
    if (
      record.source === "unknown"
      || local === null
      || instant !== null
      || offsetMinutes !== null
    ) return null;
  } else if (
    record.source !== "unknown"
    || local !== null
    || instant !== null
    || offsetMinutes !== null
  ) return null;

  return {
    source: record.source,
    timezone: record.timezone,
    local,
    instant: instant instanceof Date ? instant : null,
    offsetMinutes: typeof offsetMinutes === "number" ? offsetMinutes : null,
  };
}
function parseCorrection(
  value: unknown,
): MediaDisplayCorrection | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") return "invalid";
  const record = value as Record<string, unknown>;
  if (record.granularity !== "coordinate" && record.granularity !== "city") {
    return "invalid";
  }
  const latitude = finite(record.latitude);
  const longitude = finite(record.longitude);
  const placeLabel = label(record.label);
  if (
    latitude === "invalid"
    || longitude === "invalid"
    || placeLabel === "invalid"
    || latitude !== null && (latitude < -90 || latitude > 90)
    || longitude !== null && (longitude < -180 || longitude > 180)
  ) return "invalid";
  if (record.granularity === "coordinate") {
    if (latitude === null || longitude === null) return "invalid";
  } else if (latitude !== null || longitude !== null || placeLabel === null) {
    return "invalid";
  }
  return {
    granularity: record.granularity,
    latitude,
    longitude,
    label: placeLabel,
  };
}

export function parseRecordedEvidenceWrite(
  body: Record<string, unknown> | null,
): MediaRecordedEvidenceWrite | null {
  if (!body) return null;
  const expectedRevision = revision(body.expectedRevision);
  const spatial = parseRecordedSpatial(body.spatial);
  const captureTime = parseCaptureTime(body.captureTime);
  if (expectedRevision === null || !spatial || !captureTime) return null;
  return {
    expectedRevision,
    recorded: { spatial, captureTime },
  };
}

export function parseDisplayStateWrite(
  body: Record<string, unknown> | null,
): MediaDisplayStateWrite | null {
  if (!body) return null;
  const expectedRevision = revision(body.expectedRevision);
  const hidden = body.hidden;
  const correction = parseCorrection(body.correction);
  if (
    expectedRevision === null
    || typeof hidden !== "boolean"
    || correction === "invalid"
  ) return null;
  return {
    expectedRevision,
    display: { hidden, correction },
  };
}

export function effectiveMediaSpatialEvidence(
  recorded: MediaRecordedEvidence,
  display: MediaDisplayState,
): EffectiveMediaSpatialEvidence | null {
  if (display.hidden) return null;
  if (display.correction) {
    return {
      source: "user-correction",
      provenance: null,
      granularity: display.correction.granularity,
      latitude: display.correction.latitude,
      longitude: display.correction.longitude,
      accuracyMeters: null,
      label: display.correction.label,
    };
  }
  if (recorded.spatial.granularity === "unknown") return null;
  return {
    source: "recorded",
    provenance: recorded.spatial.source,
    granularity: recorded.spatial.granularity,
    latitude: recorded.spatial.latitude,
    longitude: recorded.spatial.longitude,
    accuracyMeters: recorded.spatial.accuracyMeters,
    label: recorded.spatial.label,
  };
}

export const UNKNOWN_MEDIA_RECORDED_EVIDENCE: MediaRecordedEvidence = {
  spatial: {
    source: "unknown",
    granularity: "unknown",
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    label: null,
  },
  captureTime: {
    source: "unknown",
    timezone: "unknown",
    local: null,
    instant: null,
    offsetMinutes: null,
  },
};
