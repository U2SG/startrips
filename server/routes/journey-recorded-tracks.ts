import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { MAX_OPERATION_KEY_LENGTH } from "../journey/recorded-track";
import {
  deleteRecordedTrackForAtlas,
  listRecordedTracksForAtlas,
  type RecordedTrackOperation,
} from "../repositories/journey-recorded-track-repository";
import { readJsonObject } from "./json-body";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// #419: precise recorded positions are owner-only. Nothing here may be
// cached by a shared proxy, and no guest path reads this route.
export const RECORDED_TRACK_CACHE_CONTROL = "private, no-store, max-age=0";

function serialize(operation: RecordedTrackOperation) {
  return {
    journeyId: operation.journeyId,
    operationKey: operation.operationKey,
    source: operation.source,
    provenance: operation.provenance,
    segments: operation.segments.map((segment) => ({
      id: segment.id,
      segmentOrder: segment.segmentOrder,
      sampleCount: segment.sampleCount,
      samples: segment.samples.map((sample) => ({
        id: sample.id,
        sampleOrder: sample.sampleOrder,
        latitude: sample.latitude,
        longitude: sample.longitude,
        recordedAt: sample.recordedAt?.toISOString() ?? null,
        accuracyMeters: sample.accuracyMeters,
      })),
    })),
  };
}

export const journeyRecordedTrackRoutes = new Hono();

// Read-only on purpose. #341 still owns the decision about the first external
// input format, so this slice exposes no import or upload surface; writes go
// through `writeRecordedTrackForAtlas` only.
journeyRecordedTrackRoutes.get("/:journeyId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const journeyId = context.req.param("journeyId");
  if (!UUID_PATTERN.test(journeyId)) {
    return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  }
  const tracks = await listRecordedTracksForAtlas(atlas.id, journeyId);
  if (!tracks) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  context.header("Cache-Control", RECORDED_TRACK_CACHE_CONTROL);
  return context.json({ recordedTracks: tracks.map(serialize) });
});

/**
 * Withdraw one stored recorded-track operation.
 *
 * The operation key travels in the body rather than in the path or the query
 * on purpose: keys are caller-chosen strings, and a URL is the one part of a
 * request that routers, proxies and access logs keep. #341 still owns the
 * first external input format, so this stays a withdrawal of evidence that is
 * already stored and adds no import surface.
 *
 * Every refusal is the same 404. A key the owner never stored, a key that
 * exists only under someone else's Atlas, a Journey that is not the caller's
 * and a repeat of a delete that already happened are indistinguishable from
 * outside, so a delete cannot be used to ask whether an operation exists.
 */
journeyRecordedTrackRoutes.delete("/:journeyId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "delete");
  context.header("Cache-Control", RECORDED_TRACK_CACHE_CONTROL);
  const journeyId = context.req.param("journeyId");
  if (!UUID_PATTERN.test(journeyId)) {
    return context.json({ error: "RECORDED_TRACK_NOT_FOUND" }, 404);
  }
  const body = await readJsonObject(() => context.req.json());
  const operationKey = body?.operationKey;
  // The predicate `normalizeRecordedTrackWrite` applies to a stored key, plus
  // a zero byte. PostgreSQL refuses a NUL inside a `text` value, so a key
  // carrying one would leave as a 500 from the global handler instead of this
  // route's own refusal — and no stored key can contain one anyway.
  if (
    typeof operationKey !== "string"
    || operationKey.trim() !== operationKey
    || operationKey.length === 0
    || operationKey.length > MAX_OPERATION_KEY_LENGTH
    || operationKey.includes("\u0000")
  ) {
    return context.json({ error: "INVALID_OPERATION_KEY" }, 400);
  }
  const outcome = await deleteRecordedTrackForAtlas(
    atlas.id,
    journeyId,
    operationKey,
  );
  if (outcome !== "deleted") {
    return context.json({ error: "RECORDED_TRACK_NOT_FOUND" }, 404);
  }
  return context.json({ deleted: true });
});
