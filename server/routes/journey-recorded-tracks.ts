import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  listRecordedTracksForAtlas,
  type RecordedTrackOperation,
} from "../repositories/journey-recorded-track-repository";

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
