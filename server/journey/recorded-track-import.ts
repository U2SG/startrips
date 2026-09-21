/**
 * #341: the import channel that turns a file the member already holds into
 * recorded-track evidence.
 *
 * The channel is not a format. A request declares which format it carries,
 * this module looks that name up in one registration table, and the named
 * reader turns the bytes into the same write document
 * `normalizeRecordedTrackWrite` already accepts. A second format registers
 * here and becomes importable without a new route, a new store shape or a
 * changed error meaning.
 *
 * Three consequences of that split are deliberate:
 *
 * - The ceilings belong to the registration, not to a reader. Every reader is
 *   handed the limits it must honour, so a later format declares its own
 *   without editing this one's code.
 * - The replay identity belongs to the channel, not to a format.
 *   `recordedTrackImportOperationKey` hashes the uploaded bytes and nothing
 *   else, so re-submitting one file to one Journey is a replay whatever the
 *   file happens to be.
 * - A document this slice does not yet accept is `UNSUPPORTED_FORMAT`, not
 *   `MALFORMED_FILE`. The two codes mean different things forever: the first
 *   says "not yet", and a later slice can start accepting that document
 *   without reversing anything; the second says "broken", and reversing it
 *   would be a contract change.
 *
 * This is a one-shot, user-initiated read of a file that already exists.
 * Nothing here starts a recorder or subscribes to location updates.
 */

import { createHash } from "node:crypto";
import {
  MAX_RECORDED_TRACK_SAMPLES,
  MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
  MAX_RECORDED_TRACK_SEGMENTS,
  normalizeRecordedTrackWrite,
  type RecordedTrackWrite,
} from "./recorded-track";

export const RECORDED_TRACK_IMPORT_REJECTIONS = [
  // The declared format is not registered, or the document is a shape the
  // registered reader does not accept yet. Never a statement about validity.
  "UNSUPPORTED_FORMAT",
  // The document asks the reader to resolve something outside itself.
  "UNSAFE_DOCUMENT",
  // The document is the declared format and is broken.
  "MALFORMED_FILE",
  "FILE_TOO_LARGE",
  "TOO_MANY_POINTS",
  "TOO_MANY_SEGMENTS",
] as const;

export type RecordedTrackImportRejection =
  (typeof RECORDED_TRACK_IMPORT_REJECTIONS)[number];

/**
 * One reader's declared ceilings. They are checked against the uploaded bytes
 * and inside the reader loop, before a document is ever materialized as a
 * write, so a file that cannot be stored is refused by the limit that
 * describes it rather than by a second-tier rejection from the normalizer.
 */
export type RecordedTrackImportLimits = {
  maxBytes: number;
  maxSegments: number;
  maxPoints: number;
  maxPointsPerSegment: number;
};

/** A point a reader recovered, still unvalidated. */
export type ReadTrackPoint = {
  latitude: number;
  longitude: number;
  /** Exactly as written in the document; the normalizer decides if it reads. */
  recordedAt: string | null;
};

export type ReadTrackSegment = { points: ReadTrackPoint[] };

export type RecordedTrackRead =
  | { ok: true; segments: ReadTrackSegment[] }
  | { ok: false; reason: RecordedTrackImportRejection };

export type RecordedTrackImportFormat = {
  /** Also the stored provenance, so the store records what produced a segment set. */
  id: string;
  limits: RecordedTrackImportLimits;
  read: (text: string, limits: RecordedTrackImportLimits) => RecordedTrackRead;
};

/**
 * The store's own ceilings are the hard ones: the segment, sample and
 * per-segment counts are enforced by `normalizeRecordedTrackWrite` and again
 * by CHECK constraints on `journey_recorded_track_segments`. A registration
 * may declare something smaller; declaring something larger would mean a file
 * the reader accepted and the store refused, so these are the ceiling every
 * registration is written against.
 *
 * `maxBytes` is this channel's own. It stays well under the 512 KB request
 * body limit in `server/app.ts` so an over-ceiling upload is refused by the
 * format that declared the ceiling rather than by the transport.
 */
const GPX_LIMITS: RecordedTrackImportLimits = {
  maxBytes: 128 * 1024,
  maxSegments: MAX_RECORDED_TRACK_SEGMENTS,
  maxPoints: MAX_RECORDED_TRACK_SAMPLES,
  maxPointsPerSegment: MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
};

/**
 * A document that wants something resolved from outside itself. The reader
 * below never fetches anything and never expands a declared entity, so these
 * constructs cannot do what they were written to do — but a document carrying
 * one is refused rather than silently read as if it were inert, because what
 * it asked for is not what it would get.
 */
const EXTERNAL_RESOLUTION = /<!DOCTYPE|<!ENTITY|<!\[CDATA\[\s*<!/i;

const GPX_ROOT = /<gpx[\s>]/i;
const TRACK_ELEMENT = /<trk[\s>]/i;
const WAYPOINT_OR_ROUTE_ELEMENT = /<(?:wpt|rte)[\s>]/i;
const TRACK_SEGMENT = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg\s*>/gi;
const TRACK_POINT_OPEN = /<trkpt\b([^>]*)>/gi;
const POINT_TIME = /<time\b[^>]*>([^<]*)<\/time\s*>/i;

function readAttribute(attributes: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(attributes);
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/**
 * A coordinate is read strictly. `Number` accepts `''`, `'0x1f'` and
 * whitespace, all of which would turn an unreadable attribute into a position
 * on the equator, so the written text has to look like a decimal number
 * before it is one.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function readCoordinate(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read `<trk>/<trkseg>/<trkpt>` and nothing else.
 *
 * What it deliberately does not take:
 *
 * - `<ele>` and `<hdop>`. Elevation is not part of the stored sample, and
 *   HDOP is a unitless dilution figure — writing it into a metres column
 *   would invent an accuracy the recorder never claimed, so `accuracyMeters`
 *   stays null for every GPX point.
 * - `<wpt>` and `<rte>`. A document carrying only those is a format this
 *   slice does not accept yet, not a broken one.
 *
 * An empty `<trkseg>` is dropped rather than refused: a segment with no
 * points is not a break between two recordings, and keeping it would make a
 * legal GPX file a malformed one at the normalizer. Every segment that does
 * carry points is kept exactly where it was — no two are merged because their
 * ends are close, and nothing is interpolated across the gap.
 *
 * A `<trkpt>` whose lat/lon cannot be read refuses the whole document. A
 * coordinate that does not parse is a broken file, and silently skipping it
 * would store a recording missing a piece nobody was told about.
 */
export function readGpxRecordedTrack(
  text: string,
  limits: RecordedTrackImportLimits,
): RecordedTrackRead {
  if (EXTERNAL_RESOLUTION.test(text)) {
    return { ok: false, reason: "UNSAFE_DOCUMENT" };
  }
  if (!GPX_ROOT.test(text)) return { ok: false, reason: "MALFORMED_FILE" };
  if (!TRACK_ELEMENT.test(text)) {
    // Ordered so a document carrying both is read as the track document it is.
    return WAYPOINT_OR_ROUTE_ELEMENT.test(text)
      ? { ok: false, reason: "UNSUPPORTED_FORMAT" }
      // No track, no waypoint, no route: nothing this reader could have taken,
      // which is a broken track document rather than a format still to come.
      : { ok: false, reason: "MALFORMED_FILE" };
  }

  const segments: ReadTrackSegment[] = [];
  let totalPoints = 0;
  TRACK_SEGMENT.lastIndex = 0;
  let segmentMatch: RegExpExecArray | null;
  while ((segmentMatch = TRACK_SEGMENT.exec(text)) !== null) {
    const body = segmentMatch[1];
    const points: ReadTrackPoint[] = [];
    TRACK_POINT_OPEN.lastIndex = 0;
    let pointMatch: RegExpExecArray | null;
    while ((pointMatch = TRACK_POINT_OPEN.exec(body)) !== null) {
      const attributes = pointMatch[1];
      const latitude = readCoordinate(readAttribute(attributes, "lat"));
      const longitude = readCoordinate(readAttribute(attributes, "lon"));
      if (latitude === null || longitude === null) {
        return { ok: false, reason: "MALFORMED_FILE" };
      }

      let recordedAt: string | null = null;
      if (!attributes.trimEnd().endsWith("/")) {
        const closeAt = body.indexOf("</trkpt", TRACK_POINT_OPEN.lastIndex);
        if (closeAt === -1) return { ok: false, reason: "MALFORMED_FILE" };
        const inner = body.slice(TRACK_POINT_OPEN.lastIndex, closeAt);
        const time = POINT_TIME.exec(inner);
        if (time) recordedAt = time[1].trim();
      }

      points.push({ latitude, longitude, recordedAt });
      if (points.length > limits.maxPointsPerSegment) {
        return { ok: false, reason: "TOO_MANY_POINTS" };
      }
      totalPoints += 1;
      if (totalPoints > limits.maxPoints) {
        return { ok: false, reason: "TOO_MANY_POINTS" };
      }
    }

    if (points.length === 0) continue;
    segments.push({ points });
    if (segments.length > limits.maxSegments) {
      return { ok: false, reason: "TOO_MANY_SEGMENTS" };
    }
  }

  // One point is a position, not a track. The store would take it; this
  // channel does not, because a single sample carries no recorded movement.
  if (totalPoints < 2) return { ok: false, reason: "MALFORMED_FILE" };
  return { ok: true, segments };
}

/**
 * Every format this channel accepts, keyed by the name a request declares.
 * Adding a format is adding an entry here.
 */
export const RECORDED_TRACK_IMPORT_FORMATS: Record<
  string,
  RecordedTrackImportFormat
> = {
  gpx: { id: "gpx", limits: GPX_LIMITS, read: readGpxRecordedTrack },
};

export function findRecordedTrackImportFormat(
  declared: unknown,
): RecordedTrackImportFormat | null {
  if (typeof declared !== "string") return null;
  return Object.hasOwn(RECORDED_TRACK_IMPORT_FORMATS, declared)
    ? RECORDED_TRACK_IMPORT_FORMATS[declared]
    : null;
}

/**
 * The replay identity of one upload. It hashes the uploaded bytes and nothing
 * else — not the declared format, not the reader's output, not the clock — so
 * the same file submitted twice to the same Journey is the same operation,
 * and the Journey scoping comes from the row the write lands on rather than
 * from this key.
 */
export function recordedTrackImportOperationKey(bytes: Buffer): string {
  return `import:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type RecordedTrackImportResult =
  | { ok: true; format: RecordedTrackImportFormat; write: RecordedTrackWrite }
  | { ok: false; reason: RecordedTrackImportRejection };

/**
 * Read one uploaded document into a write the existing store accepts.
 *
 * The samples reach persistence only through `writeRecordedTrackForAtlas`,
 * and only after `normalizeRecordedTrackWrite` has passed them: a reader
 * produces candidate positions, it never decides what is storable. A document
 * the reader accepted but the normalizer refuses is a malformed file — the
 * reader's limits are declared to sit at or under the store's, so the
 * normalizer refusing is a statement about the document, not about a
 * disagreement between two ceilings.
 */
export function readRecordedTrackImport(
  declaredFormat: unknown,
  bytes: Buffer,
): RecordedTrackImportResult {
  const format = findRecordedTrackImportFormat(declaredFormat);
  if (!format) return { ok: false, reason: "UNSUPPORTED_FORMAT" };
  if (bytes.byteLength > format.limits.maxBytes) {
    return { ok: false, reason: "FILE_TOO_LARGE" };
  }

  const read = format.read(bytes.toString("utf8"), format.limits);
  if (!read.ok) return read;

  const normalized = normalizeRecordedTrackWrite({
    operationKey: recordedTrackImportOperationKey(bytes),
    source: "imported-file",
    // The stored provenance is the format's own id. The column name says
    // nothing about GPX, and a second format writes its own id here.
    provenance: format.id,
    segments: read.segments.map((segment) => ({
      samples: segment.points.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        recordedAt: point.recordedAt,
        accuracyMeters: null,
      })),
    })),
  });
  if (!normalized.ok) return { ok: false, reason: "MALFORMED_FILE" };
  return { ok: true, format, write: normalized.write };
}
