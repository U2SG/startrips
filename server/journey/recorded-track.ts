/**
 * #419: recorded-track evidence — the ordered positions a recording produced,
 * kept structurally apart from the Route Points a member authored.
 *
 * A recorded track is *evidence*, not canon. Nothing here verifies that the
 * samples describe a journey that happened, the gap between two segments is
 * never a travelled line, and no sample is ever promoted to a Route Point.
 * This module owns the whole normalization contract: a caller hands it an
 * already-parsed request document and gets back either normalized evidence or
 * one rejection reason. It never interpolates, resamples, reorders or invents
 * a sample, and it never reads authority out of the document.
 */

export const MAX_RECORDED_TRACK_SEGMENTS = 64;
export const MAX_RECORDED_TRACK_SAMPLES = 20_000;
export const MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT = 5_000;
export const MAX_OPERATION_KEY_LENGTH = 200;
export const MAX_PROVENANCE_LENGTH = 200;
export const MAX_ACCURACY_METERS = 1_000_000;

/**
 * How the samples were produced. `unknown` exists because a later approved
 * importer may receive evidence whose producer never said; it is a recorded
 * absence, not a default that hides one.
 */
export const RECORDED_TRACK_SOURCES = [
  "device-recording",
  "imported-file",
  "unknown",
] as const;

export type RecordedTrackSource = (typeof RECORDED_TRACK_SOURCES)[number];

export function isRecordedTrackSource(
  value: unknown,
): value is RecordedTrackSource {
  return typeof value === "string"
    && (RECORDED_TRACK_SOURCES as readonly string[]).includes(value);
}

/**
 * Authority never travels in the document. A body that carries any of these
 * is refused outright rather than quietly ignored, so a client cannot come to
 * believe it selected the Atlas, the Organization or the Journey it wrote to.
 */
const AUTHORITY_KEYS = [
  "atlasId",
  "atlas_id",
  "organizationId",
  "organization_id",
  "journeyId",
  "journey_id",
] as const;

export const RECORDED_TRACK_REJECTIONS = [
  "AUTHORITY_IN_BODY",
  "INVALID_OPERATION_KEY",
  "INVALID_SOURCE",
  "INVALID_PROVENANCE",
  "INVALID_SEGMENTS",
  "INVALID_SAMPLE",
  "INVALID_COORDINATE",
  "INVALID_SAMPLE_TIME",
  "INVALID_ACCURACY",
  "TOO_MANY_SEGMENTS",
  "TOO_MANY_SAMPLES",
] as const;

export type RecordedTrackRejection = (typeof RECORDED_TRACK_REJECTIONS)[number];

export type RecordedTrackSampleWrite = {
  latitude: number;
  longitude: number;
  recordedAt: Date | null;
  accuracyMeters: number | null;
};

export type RecordedTrackSegmentWrite = {
  samples: RecordedTrackSampleWrite[];
};

export type RecordedTrackWrite = {
  operationKey: string;
  source: RecordedTrackSource;
  provenance: string;
  segments: RecordedTrackSegmentWrite[];
};

export type RecordedTrackNormalization =
  | { ok: true; write: RecordedTrackWrite }
  | { ok: false; reason: RecordedTrackRejection };

function reject(reason: RecordedTrackRejection): RecordedTrackNormalization {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A sample time is only readable when it names one unambiguous instant.
 * `new Date` is too permissive for evidence: it rewrites `2026-02-30T00:00:00Z`
 * into March 2 and reads an offset-less `2026-09-01T12:00:00` in whatever
 * timezone the server happens to run in, so an identical replay would conflict
 * after an environment change. Both are rejections here, not corrections.
 *
 * Precision below a millisecond is refused for the same reason: `Date` keeps
 * three fractional digits, so a finer reading would be stored truncated, and
 * two samples differing only below the millisecond would fingerprint alike and
 * be taken for a replay of each other. A producer that records finer has to
 * round deliberately rather than have this module do it silently.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseSampleInstant(value: string): Date | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  // The written wall-clock fields are checked literally. The offset shifts the
  // instant but never makes February 30 or 24:00 a real reading.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const parsed = new Date(value);
  // Backstop for what the field checks cannot see, such as an out-of-range
  // offset like `+99:00`.
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parseSample(value: unknown): RecordedTrackSampleWrite | RecordedTrackRejection {
  if (!isRecord(value)) return "INVALID_SAMPLE";

  const { latitude, longitude } = value;
  // `Number.isFinite` is the whole non-finite guard: NaN, Infinity and
  // -Infinity all fail it, and so does a numeric string.
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    return "INVALID_COORDINATE";
  }
  if (latitude < -90 || latitude > 90) return "INVALID_COORDINATE";
  if (longitude < -180 || longitude > 180) return "INVALID_COORDINATE";

  const rawRecordedAt = value.recordedAt ?? null;
  let recordedAt: Date | null = null;
  if (rawRecordedAt !== null) {
    if (typeof rawRecordedAt !== "string") return "INVALID_SAMPLE_TIME";
    const parsed = parseSampleInstant(rawRecordedAt);
    if (parsed === null) return "INVALID_SAMPLE_TIME";
    recordedAt = parsed;
  }

  const rawAccuracy = value.accuracyMeters ?? null;
  let accuracyMeters: number | null = null;
  if (rawAccuracy !== null) {
    if (!isFiniteNumber(rawAccuracy)) return "INVALID_ACCURACY";
    if (rawAccuracy < 0 || rawAccuracy > MAX_ACCURACY_METERS) {
      return "INVALID_ACCURACY";
    }
    accuracyMeters = rawAccuracy;
  }

  return { latitude, longitude, recordedAt, accuracyMeters };
}

/**
 * Normalize one recorded-track write document.
 *
 * Segment boundaries are taken exactly as given: an empty segment is a
 * malformed document rather than a gap to close, and two segments are never
 * merged because their ends happen to be near each other.
 */
export function normalizeRecordedTrackWrite(
  body: unknown,
): RecordedTrackNormalization {
  if (!isRecord(body)) return reject("INVALID_SEGMENTS");
  if (AUTHORITY_KEYS.some((key) => key in body)) {
    return reject("AUTHORITY_IN_BODY");
  }

  const operationKey = body.operationKey;
  if (
    typeof operationKey !== "string"
    || operationKey.trim() !== operationKey
    || operationKey.length === 0
    || operationKey.length > MAX_OPERATION_KEY_LENGTH
  ) {
    return reject("INVALID_OPERATION_KEY");
  }

  const source = body.source;
  if (!isRecordedTrackSource(source)) return reject("INVALID_SOURCE");

  const rawProvenance = body.provenance ?? "";
  if (
    typeof rawProvenance !== "string"
    || rawProvenance.length > MAX_PROVENANCE_LENGTH
  ) {
    return reject("INVALID_PROVENANCE");
  }
  const provenance = rawProvenance.trim();

  const rawSegments = body.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return reject("INVALID_SEGMENTS");
  }
  if (rawSegments.length > MAX_RECORDED_TRACK_SEGMENTS) {
    return reject("TOO_MANY_SEGMENTS");
  }

  const segments: RecordedTrackSegmentWrite[] = [];
  let totalSamples = 0;
  for (const rawSegment of rawSegments) {
    if (!isRecord(rawSegment)) return reject("INVALID_SEGMENTS");
    const rawSamples = rawSegment.samples;
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      return reject("INVALID_SEGMENTS");
    }
    if (rawSamples.length > MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT) {
      return reject("TOO_MANY_SAMPLES");
    }
    totalSamples += rawSamples.length;
    if (totalSamples > MAX_RECORDED_TRACK_SAMPLES) {
      return reject("TOO_MANY_SAMPLES");
    }

    const samples: RecordedTrackSampleWrite[] = [];
    for (const rawSample of rawSamples) {
      const sample = parseSample(rawSample);
      if (typeof sample === "string") return reject(sample);
      samples.push(sample);
    }
    segments.push({ samples });
  }

  return { ok: true, write: { operationKey, source, provenance, segments } };
}

/**
 * The canonical form the operation fingerprint is taken over. Field order is
 * fixed here rather than inherited from the request document, so two writes
 * that say the same thing in a different key order are the same replay, and a
 * write that moved one sample by a metre is not.
 */
export function canonicalRecordedTrackPayload(write: RecordedTrackWrite) {
  return JSON.stringify({
    source: write.source,
    provenance: write.provenance,
    segments: write.segments.map((segment) => ({
      samples: segment.samples.map((sample) => ({
        latitude: sample.latitude,
        longitude: sample.longitude,
        recordedAt: sample.recordedAt?.toISOString() ?? null,
        accuracyMeters: sample.accuracyMeters,
      })),
    })),
  });
}
