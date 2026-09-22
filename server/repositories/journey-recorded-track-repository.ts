import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  journeyRecordedTrackSamples,
  journeyRecordedTrackSegments,
  journeys,
} from "../db/app-schema";
import {
  canonicalRecordedTrackPayload,
  type RecordedTrackSource,
  type RecordedTrackWrite,
} from "../journey/recorded-track";
import { lockActiveAtlas, lockActiveJourney } from "./journey-repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordedTrackSample = {
  id: string;
  sampleOrder: number;
  latitude: number;
  longitude: number;
  recordedAt: Date | null;
  accuracyMeters: number | null;
};

export type RecordedTrackSegment = {
  id: string;
  segmentOrder: number;
  sampleCount: number;
  samples: RecordedTrackSample[];
};

export type RecordedTrackOperation = {
  journeyId: string;
  operationKey: string;
  source: RecordedTrackSource;
  provenance: string;
  segments: RecordedTrackSegment[];
};

export type RecordedTrackWriteResult =
  | { outcome: "ok"; replayed: boolean; operation: RecordedTrackOperation }
  // The same Journey-scoped key carrying different evidence. Refused rather
  // than merged: the caller has to decide which recording it meant.
  | { outcome: "operation-conflict" }
  // One answer for "no such Journey" and for "someone else's Journey", so a
  // probe cannot learn that another member's Journey exists.
  | { outcome: "journey-missing" };

function fingerprint(write: RecordedTrackWrite) {
  return createHash("sha256")
    .update(canonicalRecordedTrackPayload(write))
    .digest("hex");
}

type SegmentRow = typeof journeyRecordedTrackSegments.$inferSelect;

async function loadSamples(transaction: Transaction, segmentIds: string[]) {
  if (segmentIds.length === 0) return new Map<string, RecordedTrackSample[]>();
  const rows = await transaction
    .select()
    .from(journeyRecordedTrackSamples)
    .where(inArray(journeyRecordedTrackSamples.segmentId, segmentIds))
    .orderBy(
      asc(journeyRecordedTrackSamples.segmentId),
      asc(journeyRecordedTrackSamples.sampleOrder),
    );
  const bySegment = new Map<string, RecordedTrackSample[]>();
  for (const row of rows) {
    const sample: RecordedTrackSample = {
      id: row.id,
      sampleOrder: row.sampleOrder,
      latitude: row.latitude,
      longitude: row.longitude,
      recordedAt: row.recordedAt,
      accuracyMeters: row.accuracyMeters,
    };
    const existing = bySegment.get(row.segmentId);
    if (existing) existing.push(sample);
    else bySegment.set(row.segmentId, [sample]);
  }
  return bySegment;
}

function toOperations(
  segmentRows: SegmentRow[],
  samplesBySegment: Map<string, RecordedTrackSample[]>,
) {
  const operations: RecordedTrackOperation[] = [];
  const byKey = new Map<string, RecordedTrackOperation>();
  for (const row of segmentRows) {
    let operation = byKey.get(row.operationKey);
    if (!operation) {
      operation = {
        journeyId: row.journeyId,
        operationKey: row.operationKey,
        source: row.source as RecordedTrackSource,
        provenance: row.provenance,
        segments: [],
      };
      byKey.set(row.operationKey, operation);
      operations.push(operation);
    }
    operation.segments.push({
      id: row.id,
      segmentOrder: row.segmentOrder,
      sampleCount: row.sampleCount,
      samples: samplesBySegment.get(row.id) ?? [],
    });
  }
  return operations;
}

async function readOperation(
  transaction: Transaction,
  journeyId: string,
  operationKey: string,
) {
  const segmentRows = await transaction
    .select()
    .from(journeyRecordedTrackSegments)
    .where(and(
      eq(journeyRecordedTrackSegments.journeyId, journeyId),
      eq(journeyRecordedTrackSegments.operationKey, operationKey),
    ))
    .orderBy(asc(journeyRecordedTrackSegments.segmentOrder));
  if (segmentRows.length === 0) return null;
  const samples = await loadSamples(
    transaction,
    segmentRows.map((row) => row.id),
  );
  return {
    storedFingerprint: segmentRows[0].payloadFingerprint,
    operation: toOperations(segmentRows, samples)[0],
  };
}

/**
 * PostgreSQL binds at most 65,535 parameters per statement, and every sample
 * row binds six columns. A write at `MAX_RECORDED_TRACK_SAMPLES` would need
 * 120,000 of them, so evidence the normalizer explicitly accepts would fail at
 * persistence. The samples are written in chunks instead, inside the same
 * transaction and in `sampleOrder`. The bound is stated here rather than
 * derived from the per-segment limit, so raising that limit cannot silently
 * reintroduce the ceiling.
 */
const SAMPLE_INSERT_CHUNK_SIZE = 2_000;

async function insertOperation(
  transaction: Transaction,
  journeyId: string,
  write: RecordedTrackWrite,
  payloadFingerprint: string,
) {
  const segmentRows = await transaction
    .insert(journeyRecordedTrackSegments)
    .values(write.segments.map((segment, segmentOrder) => ({
      journeyId,
      operationKey: write.operationKey,
      payloadFingerprint,
      segmentOrder,
      source: write.source,
      provenance: write.provenance,
      sampleCount: segment.samples.length,
    })))
    .returning();

  const idByOrder = new Map(
    segmentRows.map((row) => [row.segmentOrder, row.id]),
  );
  const sampleValues = write.segments.flatMap((segment, segmentOrder) => {
    const segmentId = idByOrder.get(segmentOrder);
    if (!segmentId) throw new Error("Recorded track segment was not inserted");
    return segment.samples.map((sample, sampleOrder) => ({
      segmentId,
      sampleOrder,
      latitude: sample.latitude,
      longitude: sample.longitude,
      recordedAt: sample.recordedAt,
      accuracyMeters: sample.accuracyMeters,
    }));
  });
  for (
    let offset = 0;
    offset < sampleValues.length;
    offset += SAMPLE_INSERT_CHUNK_SIZE
  ) {
    await transaction
      .insert(journeyRecordedTrackSamples)
      .values(sampleValues.slice(offset, offset + SAMPLE_INSERT_CHUNK_SIZE));
  }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "23505";
}

/**
 * Persist one recorded-track operation under a Journey the caller's Atlas
 * owns. `atlasId` is the only authority, and it reaches this function from
 * the session-derived Atlas — never from the write document.
 *
 * Replaying the same `operationKey` with the same evidence returns the rows
 * the first call created. A concurrent replay loses the unique-index race
 * rather than a pre-read guard: 23505 here means another transaction already
 * claimed this Journey-scoped key.
 */
export async function writeRecordedTrackForAtlas(
  atlasId: string,
  journeyId: string,
  write: RecordedTrackWrite,
): Promise<RecordedTrackWriteResult> {
  const payloadFingerprint = fingerprint(write);
  return db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) {
      return { outcome: "journey-missing" } as const;
    }
    if (!await lockActiveJourney(transaction, journeyId, atlasId)) {
      return { outcome: "journey-missing" } as const;
    }

    const existing = await readOperation(
      transaction,
      journeyId,
      write.operationKey,
    );
    if (existing) {
      if (existing.storedFingerprint !== payloadFingerprint) {
        return { outcome: "operation-conflict" } as const;
      }
      return {
        outcome: "ok",
        replayed: true,
        operation: existing.operation,
      } as const;
    }

    try {
      await insertOperation(transaction, journeyId, write, payloadFingerprint);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { outcome: "operation-conflict" } as const;
    }

    const saved = await readOperation(
      transaction,
      journeyId,
      write.operationKey,
    );
    if (!saved) throw new Error("Recorded track vanished during write");
    return {
      outcome: "ok",
      replayed: false,
      operation: saved.operation,
    } as const;
  });
}

/**
 * Every recorded-track operation stored under a Journey, oldest first.
 * `null` means the Journey is not the caller's to read — the same answer a
 * Journey that does not exist gets.
 */
export async function listRecordedTracksForAtlas(
  atlasId: string,
  journeyId: string,
): Promise<RecordedTrackOperation[] | null> {
  return db.transaction(
    async (transaction) => {
      const [journey] = await transaction
        .select({ id: journeys.id })
        .from(journeys)
        .where(and(
          eq(journeys.id, journeyId),
          eq(journeys.atlasId, atlasId),
          isNull(journeys.deletionStartedAt),
        ))
        .limit(1);
      if (!journey) return null;

      const segmentRows = await transaction
        .select()
        .from(journeyRecordedTrackSegments)
        .where(eq(journeyRecordedTrackSegments.journeyId, journeyId))
        .orderBy(
          asc(journeyRecordedTrackSegments.createdAt),
          asc(journeyRecordedTrackSegments.operationKey),
          asc(journeyRecordedTrackSegments.segmentOrder),
        );
      const samples = await loadSamples(
        transaction,
        segmentRows.map((row) => row.id),
      );
      return toOperations(segmentRows, samples);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Drop one recorded-track operation. Only its own segments and samples go:
 * Route Points and media belong to the Journey, not to this evidence, and a
 * recording being withdrawn says nothing about either.
 */
export async function deleteRecordedTrackForAtlas(
  atlasId: string,
  journeyId: string,
  operationKey: string,
): Promise<"deleted" | "operation-missing" | "journey-missing"> {
  return db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) {
      return "journey-missing" as const;
    }
    if (!await lockActiveJourney(transaction, journeyId, atlasId)) {
      return "journey-missing" as const;
    }
    const removed = await transaction
      .delete(journeyRecordedTrackSegments)
      .where(and(
        eq(journeyRecordedTrackSegments.journeyId, journeyId),
        eq(journeyRecordedTrackSegments.operationKey, operationKey),
      ))
      .returning({ id: journeyRecordedTrackSegments.id });
    return removed.length > 0
      ? "deleted" as const
      : "operation-missing" as const;
  });
}
