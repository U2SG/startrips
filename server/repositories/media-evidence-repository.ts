import { eq, sql } from "drizzle-orm";
import {
  everydayFragments,
  journeys,
  mediaAssetEvidence,
  mediaAssets,
} from "../db/app-schema";
import { db } from "../db/client";
import {
  UNKNOWN_MEDIA_RECORDED_EVIDENCE,
  effectiveMediaSpatialEvidence,
  type MediaDisplayState,
  type MediaDisplayStateWrite,
  type MediaRecordedEvidence,
  type MediaRecordedEvidenceWrite,
} from "../media/media-evidence";

type EvidenceRow = typeof mediaAssetEvidence.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MediaEvidenceRecord = {
  mediaAssetId: string;
  revision: number;
  recorded: MediaRecordedEvidence;
  display: MediaDisplayState;
  effective: ReturnType<typeof effectiveMediaSpatialEvidence>;
  updatedAt: Date | null;
};

export type MediaEvidenceWriteResult =
  | { outcome: "ok"; evidence: MediaEvidenceRecord }
  | { outcome: "conflict"; evidence: MediaEvidenceRecord }
  | { outcome: "asset-missing" };

function absent(assetId: string): MediaEvidenceRecord {
  const recorded = structuredClone(UNKNOWN_MEDIA_RECORDED_EVIDENCE);
  const display: MediaDisplayState = { hidden: false, correction: null };
  return {
    mediaAssetId: assetId,
    revision: 0,
    recorded,
    display,
    effective: null,
    updatedAt: null,
  };
}

function fromRow(assetId: string, row?: EvidenceRow): MediaEvidenceRecord {
  if (!row) return absent(assetId);
  const recorded: MediaRecordedEvidence = {
    spatial: {
      source: row.spatialSource as MediaRecordedEvidence["spatial"]["source"],
      granularity:
        row.spatialGranularity as MediaRecordedEvidence["spatial"]["granularity"],
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyMeters: row.accuracyMeters,
      label: row.spatialLabel,
    },
    captureTime: {
      source:
        row.captureTimeSource as MediaRecordedEvidence["captureTime"]["source"],
      timezone:
        row.timezoneState as MediaRecordedEvidence["captureTime"]["timezone"],
      local: row.capturedLocal,
      instant: row.capturedAtUtc,
      offsetMinutes: row.capturedOffsetMinutes,
    },
  };
  const display: MediaDisplayState = {
    hidden: row.displayHidden,
    correction: row.correctionGranularity
      ? {
          granularity: row.correctionGranularity as "coordinate" | "city",
          latitude: row.correctionLatitude,
          longitude: row.correctionLongitude,
          label: row.correctionLabel,
        }
      : null,
  };
  return {
    mediaAssetId: assetId,
    revision: row.revision,
    recorded,
    display,
    effective: effectiveMediaSpatialEvidence(recorded, display),
    updatedAt: row.updatedAt,
  };
}

function sameRecorded(
  left: MediaRecordedEvidence,
  right: MediaRecordedEvidence,
) {
  return (
    left.spatial.source === right.spatial.source
    && left.spatial.granularity === right.spatial.granularity
    && left.spatial.latitude === right.spatial.latitude
    && left.spatial.longitude === right.spatial.longitude
    && left.spatial.accuracyMeters === right.spatial.accuracyMeters
    && left.spatial.label === right.spatial.label
    && left.captureTime.source === right.captureTime.source
    && left.captureTime.timezone === right.captureTime.timezone
    && left.captureTime.local === right.captureTime.local
    && left.captureTime.instant?.valueOf() === right.captureTime.instant?.valueOf()
    && left.captureTime.offsetMinutes === right.captureTime.offsetMinutes
  );
}

function sameDisplay(left: MediaDisplayState, right: MediaDisplayState) {
  if (left.hidden !== right.hidden) return false;
  if (!left.correction || !right.correction) {
    return left.correction === right.correction;
  }
  return (
    left.correction.granularity === right.correction.granularity
    && left.correction.latitude === right.correction.latitude
    && left.correction.longitude === right.correction.longitude
    && left.correction.label === right.correction.label
  );
}

async function assetBelongsToAtlas(
  transaction: Transaction,
  atlasId: string,
  assetId: string,
  lock: boolean,
) {
  const statement = sql`
    select ${mediaAssets.id} as id
    from ${mediaAssets}
    left join ${journeys} on ${journeys.id} = ${mediaAssets.journeyId}
    left join ${everydayFragments}
      on ${everydayFragments.id} = ${mediaAssets.everydayFragmentId}
    where ${mediaAssets.id} = ${assetId}
      and (
        ${journeys.atlasId} = ${atlasId}
        or ${everydayFragments.atlasId} = ${atlasId}
      )
    ${lock ? sql`for update of ${mediaAssets}` : sql``}
  `;
  const result = await transaction.execute<{ id: string }>(statement);
  return result.rows.length > 0;
}

async function readRow(transaction: Transaction, assetId: string) {
  const [row] = await transaction
    .select()
    .from(mediaAssetEvidence)
    .where(eq(mediaAssetEvidence.mediaAssetId, assetId))
    .limit(1);
  return row;
}

export async function readMediaEvidenceForAtlas(
  atlasId: string,
  assetId: string,
): Promise<MediaEvidenceRecord | null> {
  return db.transaction(
    async (transaction) => {
      if (!await assetBelongsToAtlas(transaction, atlasId, assetId, false)) {
        return null;
      }
      return fromRow(assetId, await readRow(transaction, assetId));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function recordedValues(recorded: MediaRecordedEvidence) {
  return {
    spatialSource: recorded.spatial.source,
    spatialGranularity: recorded.spatial.granularity,
    latitude: recorded.spatial.latitude,
    longitude: recorded.spatial.longitude,
    accuracyMeters: recorded.spatial.accuracyMeters,
    spatialLabel: recorded.spatial.label,
    captureTimeSource: recorded.captureTime.source,
    timezoneState: recorded.captureTime.timezone,
    capturedLocal: recorded.captureTime.local,
    capturedAtUtc: recorded.captureTime.instant,
    capturedOffsetMinutes: recorded.captureTime.offsetMinutes,
  };
}

function displayValues(display: MediaDisplayState) {
  return {
    displayHidden: display.hidden,
    correctionGranularity: display.correction?.granularity ?? null,
    correctionLatitude: display.correction?.latitude ?? null,
    correctionLongitude: display.correction?.longitude ?? null,
    correctionLabel: display.correction?.label ?? null,
  };
}

export async function writeRecordedMediaEvidenceForAtlas(
  atlasId: string,
  assetId: string,
  write: MediaRecordedEvidenceWrite,
): Promise<MediaEvidenceWriteResult> {
  return db.transaction(async (transaction) => {
    if (!await assetBelongsToAtlas(transaction, atlasId, assetId, true)) {
      return { outcome: "asset-missing" } as const;
    }
    const currentRow = await readRow(transaction, assetId);
    const current = fromRow(assetId, currentRow);
    if (sameRecorded(current.recorded, write.recorded)) {
      return { outcome: "ok", evidence: current } as const;
    }
    if (current.revision !== write.expectedRevision) {
      return { outcome: "conflict", evidence: current } as const;
    }

    const [saved] = currentRow
      ? await transaction
          .update(mediaAssetEvidence)
          .set({
            ...recordedValues(write.recorded),
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(mediaAssetEvidence.mediaAssetId, assetId))
          .returning()
      : await transaction
          .insert(mediaAssetEvidence)
          .values({
            mediaAssetId: assetId,
            ...recordedValues(write.recorded),
            revision: 1,
          })
          .returning();
    if (!saved) throw new Error("Media evidence revision changed during write");
    return { outcome: "ok", evidence: fromRow(assetId, saved) } as const;
  });
}

export async function writeMediaDisplayStateForAtlas(
  atlasId: string,
  assetId: string,
  write: MediaDisplayStateWrite,
): Promise<MediaEvidenceWriteResult> {
  return db.transaction(async (transaction) => {
    if (!await assetBelongsToAtlas(transaction, atlasId, assetId, true)) {
      return { outcome: "asset-missing" } as const;
    }
    const currentRow = await readRow(transaction, assetId);
    const current = fromRow(assetId, currentRow);
    if (sameDisplay(current.display, write.display)) {
      return { outcome: "ok", evidence: current } as const;
    }
    if (current.revision !== write.expectedRevision) {
      return { outcome: "conflict", evidence: current } as const;
    }

    const [saved] = currentRow
      ? await transaction
          .update(mediaAssetEvidence)
          .set({
            ...displayValues(write.display),
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(mediaAssetEvidence.mediaAssetId, assetId))
          .returning()
      : await transaction
          .insert(mediaAssetEvidence)
          .values({
            mediaAssetId: assetId,
            ...displayValues(write.display),
            revision: 1,
          })
          .returning();
    if (!saved) throw new Error("Media evidence revision changed during write");
    return { outcome: "ok", evidence: fromRow(assetId, saved) } as const;
  });
}
