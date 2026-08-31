import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { db } from "../db/client";
import {
  atlases,
  journeyRoutePoints,
  mediaAssets,
  mediaUploads,
  journeys,
} from "../db/app-schema";
import { deleteMediaAssetForAtlas } from "../services/delete-media";
import { getJourneyForAtlas } from "../repositories/journey-repository";
import {
  getMultipartStorage,
  hasConfiguredStorageBackends,
} from "../storage/storage-registry";
import {
  CompletedObjectIntegrityError,
  type MultipartPart,
  type MultipartStorage,
} from "../storage/multipart-storage";

const PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2_000_000_000;
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_REORDER_ASSETS = 256;
const MAX_MOVE_UNDO_ORDER = 10_000;
const FINALIZATION_LEASE_MS = 20_000;
const FINALIZATION_HEARTBEAT_MS = 5_000;
const STALE_UPLOAD_AFTER_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1_000;
const RECONCILE_BATCH_SIZE = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
// Journey soundtracks. Kept in step with ACCEPTED_JOURNEY_SOUNDTRACK_TYPES in
// src/journey/journeyModel.ts; this copy is the authoritative validator.
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav",
]);

// The deduplication scope of an upload: "image", "video", or "audio". Every
// accepted MIME type carries one of those top-level types, and an unexpected
// value falls back to a scope that matches nothing else.
export function mediaKindOf(mimeType: string): string {
  const kind = mimeType.split("/")[0];
  return /^[a-z]+$/.test(kind) ? kind : "unknown";
}

type StartUploadInput = {
  journeyId?: unknown;
  routePointId?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  bytes?: unknown;
  contentHash?: unknown;
};

export function parseStartUpload(body: StartUploadInput) {
  const journeyId = typeof body.journeyId === "string" ? body.journeyId : "";
  const routePointId = body.routePointId === undefined || body.routePointId === null
    ? null
    : typeof body.routePointId === "string"
      ? body.routePointId
      : "invalid";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  const bytes = Number(body.bytes);
  const partCount = Math.ceil(bytes / PART_SIZE);
  const contentHash = body.contentHash === undefined || body.contentHash === null
    ? null
    : typeof body.contentHash === "string" && /^[0-9a-f]{64}$/i.test(body.contentHash)
      ? body.contentHash.toLowerCase()
      : "invalid";

  const isSoundtrack = ALLOWED_AUDIO_MIME_TYPES.has(mimeType);
  const maxBytes = isSoundtrack ? MAX_AUDIO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;

  if (
    // A soundtrack belongs to the whole journey. Accepting one against a route
    // point would create a row the atlas has no way to express, since every
    // audio asset is read as the journey's single track.
    (isSoundtrack && routePointId !== null) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      journeyId,
    ) ||
    (routePointId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routePointId)) ||
    !fileName ||
    fileName.length > 180 ||
    (!ALLOWED_MIME_TYPES.has(mimeType) && !isSoundtrack) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > maxBytes ||
    partCount < 1 ||
    partCount > MAX_PARTS ||
    contentHash === "invalid"
  ) {
    return null;
  }

  return { journeyId, routePointId, fileName, mimeType, bytes, partCount, contentHash };
}

export function parseParts(value: unknown, expectedCount: number): MultipartPart[] | null {
  if (expectedCount < 1 || !Array.isArray(value) || value.length !== expectedCount) {
    return null;
  }

  const parts = value
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const record = part as Record<string, unknown>;
      const partNumber = Number(record.partNumber);
      const etag = typeof record.etag === "string" ? record.etag.trim() : "";
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > expectedCount ||
        !etag ||
        etag.length > 1024
      ) {
        return null;
      }
      return { partNumber, etag };
    })
    .sort((left, right) => (left?.partNumber ?? 0) - (right?.partNumber ?? 0));

  if (
    parts.some(
      (part, index) => !part || part.partNumber !== index + 1,
    )
  ) {
    return null;
  }
  return parts as MultipartPart[];
}

type ReorderMediaInput = {
  journeyId?: unknown;
  assetIds?: unknown;
};

export function parseReorderInput(body: ReorderMediaInput) {
  const journeyId = typeof body.journeyId === "string" ? body.journeyId : "";
  if (
    !UUID_PATTERN.test(journeyId)
    || !Array.isArray(body.assetIds)
    || body.assetIds.length < 1
    || body.assetIds.length > MAX_REORDER_ASSETS
  ) {
    return null;
  }
  const assetIds: string[] = [];
  for (const raw of body.assetIds) {
    if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) return null;
    assetIds.push(raw);
  }
  if (new Set(assetIds).size !== assetIds.length) return null;
  return { journeyId, assetIds };
}

type MoveMediaInput = {
  journeyId?: unknown;
  targetJourneyId?: unknown;
  assetIds?: unknown;
  routePointId?: unknown;
};

// A batch move onto a route point (or `null`, back to the whole journey).
// `journeyId` remains the source Journey for backwards compatibility; an
// optional `targetJourneyId` upgrades the same mutation to a cross-Journey
// move inside the active Atlas.
export function parseMoveMediaInput(body: MoveMediaInput) {
  const journeyId = typeof body.journeyId === "string" ? body.journeyId : "";
  const targetJourneyId = body.targetJourneyId === undefined || body.targetJourneyId === null
    ? null
    : typeof body.targetJourneyId === "string"
      ? body.targetJourneyId
      : "invalid";
  const routePointId = body.routePointId === undefined || body.routePointId === null
    ? null
    : typeof body.routePointId === "string"
      ? body.routePointId
      : "invalid";
  if (
    !UUID_PATTERN.test(journeyId)
    || targetJourneyId === "invalid"
    || (targetJourneyId !== null && !UUID_PATTERN.test(targetJourneyId))
    || !Array.isArray(body.assetIds)
    || body.assetIds.length < 1
    || body.assetIds.length > MAX_REORDER_ASSETS
    || routePointId === "invalid"
    || (routePointId !== null && !UUID_PATTERN.test(routePointId))
  ) {
    return null;
  }
  const assetIds: string[] = [];
  for (const raw of body.assetIds) {
    if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) return null;
    assetIds.push(raw);
  }
  if (new Set(assetIds).size !== assetIds.length) return null;
  return {
    journeyId,
    ...(targetJourneyId === null ? {} : { targetJourneyId }),
    assetIds,
    routePointId,
  };
}

export type MediaMoveUndo = {
  sourceJourneyId: string;
  targetJourneyId: string;
  assetIds: string[];
  sourceOrder: string[];
  sourceCoverMediaAssetId: string | null;
  placements: Array<{ assetId: string; routePointId: string | null }>;
};

type UndoMediaMoveInput = Partial<MediaMoveUndo>;

export function parseUndoMediaMoveInput(body: UndoMediaMoveInput): MediaMoveUndo | null {
  const sourceJourneyId = typeof body.sourceJourneyId === "string" ? body.sourceJourneyId : "";
  const targetJourneyId = typeof body.targetJourneyId === "string" ? body.targetJourneyId : "";
  if (
    !UUID_PATTERN.test(sourceJourneyId)
    || !UUID_PATTERN.test(targetJourneyId)
    || sourceJourneyId === targetJourneyId
    || !Array.isArray(body.assetIds)
    || body.assetIds.length < 1
    || body.assetIds.length > MAX_REORDER_ASSETS
    || !Array.isArray(body.sourceOrder)
    || body.sourceOrder.length < body.assetIds.length
    || body.sourceOrder.length > MAX_MOVE_UNDO_ORDER
    || !Array.isArray(body.placements)
    || body.placements.length !== body.assetIds.length
    || !(body.sourceCoverMediaAssetId === null || typeof body.sourceCoverMediaAssetId === "string")
    || (typeof body.sourceCoverMediaAssetId === "string" && !UUID_PATTERN.test(body.sourceCoverMediaAssetId))
  ) return null;

  const assetIds = [...body.assetIds];
  const sourceOrder = [...body.sourceOrder];
  if (
    assetIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || sourceOrder.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || new Set(assetIds).size !== assetIds.length
    || new Set(sourceOrder).size !== sourceOrder.length
    || assetIds.some((id) => !sourceOrder.includes(id))
  ) return null;

  const placementByAsset = new Map<string, string | null>();
  for (const placement of body.placements) {
    if (!placement || typeof placement !== "object") return null;
    const assetId = typeof placement.assetId === "string" ? placement.assetId : "";
    const routePointId = placement.routePointId === null
      ? null
      : typeof placement.routePointId === "string"
        ? placement.routePointId
        : "invalid";
    if (
      !UUID_PATTERN.test(assetId)
      || !assetIds.includes(assetId)
      || routePointId === "invalid"
      || (routePointId !== null && !UUID_PATTERN.test(routePointId))
      || placementByAsset.has(assetId)
    ) return null;
    placementByAsset.set(assetId, routePointId);
  }
  if (placementByAsset.size !== assetIds.length) return null;

  return {
    sourceJourneyId,
    targetJourneyId,
    assetIds,
    sourceOrder,
    sourceCoverMediaAssetId: body.sourceCoverMediaAssetId ?? null,
    placements: assetIds.map((assetId) => ({ assetId, routePointId: placementByAsset.get(assetId) ?? null })),
  };
}

async function findUpload(uploadId: string, atlasId: string) {
  const [row] = await db
    .select({ upload: mediaUploads })
    .from(mediaUploads)
    .innerJoin(journeys, eq(journeys.id, mediaUploads.journeyId))
    .where(
      and(
        eq(mediaUploads.id, uploadId),
        eq(mediaUploads.atlasId, atlasId),
        isNull(journeys.deletionStartedAt),
      ),
    )
    .limit(1);
  return row?.upload;
}

export type UploadRecord = NonNullable<Awaited<ReturnType<typeof findUpload>>>;
type CompletionLease = {
  attemptId: string;
  status: "finalizing" | "reconciling";
};

class JourneyUnavailableForUploadError extends Error {}

async function markCompletionUnknown(uploadId: string, attemptId: string) {
  const [marked] = await db
    .update(mediaUploads)
    .set({ status: "completion_unknown", updatedAt: new Date() })
    .where(
      and(
        eq(mediaUploads.id, uploadId),
        eq(mediaUploads.status, "finalizing"),
        eq(mediaUploads.completionAttemptId, attemptId),
      ),
    )
    .returning({ id: mediaUploads.id });
  return Boolean(marked);
}

async function withCompletionLease<T>(
  uploadId: string,
  attemptId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const heartbeat = setInterval(() => {
    void db
      .update(mediaUploads)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(mediaUploads.id, uploadId),
          eq(mediaUploads.status, "finalizing"),
          eq(mediaUploads.completionAttemptId, attemptId),
        ),
      )
      .catch((error: unknown) => {
        console.error(
          "Upload completion heartbeat failed",
          error instanceof Error ? error.message : "unknown error",
        );
      });
  }, FINALIZATION_HEARTBEAT_MS);
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
}

export async function finalizeUpload(
  upload: UploadRecord,
  lease?: CompletionLease,
) {
  const result = await db.transaction(async (transaction) => {
    const lockedAtlas = await transaction.execute<{ id: string }>(sql`
      select ${atlases.id} as id
      from ${atlases}
      where ${atlases.id} = ${upload.atlasId}
        and ${atlases.deletionStartedAt} is null
      for update
    `);
    if (lockedAtlas.rows.length === 0) {
      throw new Error("Upload atlas no longer exists");
    }

    if (lease) {
      const lockedUpload = await transaction.execute<{ id: string }>(sql`
        select ${mediaUploads.id} as id
        from ${mediaUploads}
        where ${mediaUploads.id} = ${upload.id}
          and ${mediaUploads.status} = ${lease.status}
          and ${mediaUploads.completionAttemptId} = ${lease.attemptId}
        for update
      `);
      if (lockedUpload.rows.length === 0) {
        throw new Error("Upload completion lease was lost");
      }
    }
    const lockedJourney = await transaction.execute<{ id: string }>(sql`
      select ${journeys.id} as id
      from ${journeys}
      where ${journeys.id} = ${upload.journeyId}
        and ${journeys.deletionStartedAt} is null
      for update
    `);
    if (lockedJourney.rows.length === 0) {
      throw new Error("Upload journey no longer exists");
    }

    const [routePoint] = upload.routePointId
      ? await transaction
        .select({ id: journeyRoutePoints.id })
        .from(journeyRoutePoints)
        .where(and(
          eq(journeyRoutePoints.id, upload.routePointId),
          eq(journeyRoutePoints.journeyId, upload.journeyId),
        ))
        .limit(1)
      : [];

    // Deduplication is scoped to the media kind AND the route point. The same
    // bytes can be a journey video and a journey soundtrack, and collapsing
    // those into one row would answer an audio upload with a visual asset that
    // no soundtrack reader would ever find. Likewise, the same photo shared by
    // two route points must produce two assets (one per point); a route-point
    // asset and a journey-scoped asset (routePointId = null) must never
    // collapse either. Within one journey + one route point + one media kind,
    // an identical content hash is still a user mistake and dedupes.
    const [duplicate] = upload.contentHash
      ? await transaction
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(
          eq(mediaAssets.journeyId, upload.journeyId),
          eq(mediaAssets.contentHash, upload.contentHash),
          like(mediaAssets.mimeType, `${mediaKindOf(upload.mimeType)}/%`),
          upload.routePointId
            ? eq(mediaAssets.routePointId, upload.routePointId)
            : isNull(mediaAssets.routePointId),
        ))
        .limit(1)
      : [];

    let asset: typeof mediaAssets.$inferSelect;
    let deduplicated = false;
    if (duplicate) {
      const [existing] = await transaction
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, duplicate.id))
        .limit(1);
      if (!existing) throw new Error("Duplicate media asset could not be loaded");
      asset = existing;
      deduplicated = true;
    } else {
      const [lastAsset] = await transaction
        .select({ sortOrder: mediaAssets.sortOrder })
        .from(mediaAssets)
        .where(eq(mediaAssets.journeyId, upload.journeyId))
        .orderBy(desc(mediaAssets.sortOrder))
        .limit(1);
      const [created] = await transaction
        .insert(mediaAssets)
        .values({
          journeyId: upload.journeyId,
          routePointId: routePoint?.id ?? null,
          storageDriver: upload.storageDriver,
          storageKey: upload.storageKey,
          fileName: upload.fileName,
          mimeType: upload.mimeType,
          bytes: upload.bytes,
          contentHash: upload.contentHash,
          sortOrder: (lastAsset?.sortOrder ?? -1) + 1,
          uploadedByUserId: upload.createdByUserId,
        })
        .onConflictDoNothing({ target: mediaAssets.storageKey })
        .returning();
      asset = created ?? (
        await transaction
          .select()
          .from(mediaAssets)
          .where(eq(mediaAssets.storageKey, upload.storageKey))
          .limit(1)
      )[0];
      if (!asset || asset.journeyId !== upload.journeyId) {
        throw new Error("Completed media asset could not be reconciled");
      }
    }
    await transaction
      .update(mediaUploads)
      .set({
        status: "completed",
        mediaAssetId: asset.id,
        completionAttemptId: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaUploads.id, upload.id));
    return { asset, deduplicated };
  });

  // A deduplicated upload leaves its just-completed object behind; remove it
  // best-effort after the transaction so a storage hiccup cannot roll back a
  // completed asset. A leftover orphan only wastes object storage.
  if (result.deduplicated) {
    try {
      await getMultipartStorage(upload.storageDriver).deleteObject({
        key: upload.storageKey,
      });
    } catch (error) {
      console.error(
        "Deduplicated object cleanup failed",
        upload.storageKey,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  return result.asset;
}

async function recoverCompletedUpload(upload: UploadRecord) {
  const inspected = await getMultipartStorage(upload.storageDriver).inspectObject({
    key: upload.storageKey,
  });
  if (!inspected.exists) return null;
  if (inspected.bytes !== upload.bytes) {
    throw new Error("Completed object size does not match the upload record");
  }
  return finalizeUpload(upload);
}

async function markUploadAborted(uploadId: string, attemptId: string) {
  await db
    .update(mediaUploads)
    .set({
      status: "aborted",
      completionAttemptId: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(mediaUploads.id, uploadId),
      eq(mediaUploads.status, "reconciling"),
      eq(mediaUploads.completionAttemptId, attemptId),
    ));
}

async function markUploadRetryable(uploadId: string, attemptId: string) {
  await db
    .update(mediaUploads)
    .set({
      status: "completion_unknown",
      completionAttemptId: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(mediaUploads.id, uploadId),
      eq(mediaUploads.status, "reconciling"),
      eq(mediaUploads.completionAttemptId, attemptId),
    ));
}

export type ReconciliationDependencies = {
  claim: (
    candidate: UploadRecord,
    attemptId: string,
    now: Date,
    cutoff: Date,
  ) => Promise<UploadRecord | undefined>;
  storageForBackend: (backendId: string) => MultipartStorage;
  finalize: (
    upload: UploadRecord,
    lease: CompletionLease,
  ) => Promise<unknown>;
  markAborted: (uploadId: string, attemptId: string) => Promise<void>;
  markRetryable: (uploadId: string, attemptId: string) => Promise<void>;
  onError: (upload: UploadRecord, error: unknown) => void;
};

const reconciliationDependencies: ReconciliationDependencies = {
  async claim(candidate, attemptId, now, cutoff) {
    const [claimed] = await db
      .update(mediaUploads)
      .set({
        status: "reconciling",
        completionAttemptId: attemptId,
        updatedAt: now,
      })
      .where(and(
        eq(mediaUploads.id, candidate.id),
        eq(mediaUploads.status, candidate.status),
        lt(mediaUploads.updatedAt, cutoff),
      ))
      .returning();
    return claimed;
  },
  storageForBackend: getMultipartStorage,
  finalize: finalizeUpload,
  markAborted: markUploadAborted,
  markRetryable: markUploadRetryable,
  onError(upload, error) {
    console.error(
      "Stale upload reconciliation failed",
      upload.id,
      error instanceof Error ? error.message : "unknown error",
    );
  },
};

export async function reconcileUploadCandidates(
  candidates: UploadRecord[],
  now: Date,
  cutoff: Date,
  dependencies: ReconciliationDependencies = reconciliationDependencies,
) {
  for (const candidate of candidates) {
    const attemptId = randomUUID();
    const claimed = await dependencies.claim(candidate, attemptId, now, cutoff);
    if (!claimed) continue;

    try {
      const storage = dependencies.storageForBackend(claimed.storageDriver);
      const inspected = await storage.inspectObject({ key: claimed.storageKey });
      if (inspected.exists) {
        if (inspected.bytes !== claimed.bytes) {
          await storage.deleteObject({ key: claimed.storageKey });
          await dependencies.markAborted(claimed.id, attemptId);
          continue;
        }
        await dependencies.finalize(claimed, {
          status: "reconciling",
          attemptId,
        });
        continue;
      }

      await storage.abortMultipartUpload({
        key: claimed.storageKey,
        providerUploadId: claimed.providerUploadId,
      });
      await dependencies.markAborted(claimed.id, attemptId);
    } catch (error) {
      await dependencies.markRetryable(claimed.id, attemptId);
      dependencies.onError(claimed, error);
    }
  }
}

export async function reconcileStaleUploads(now = new Date()) {
  if (!hasConfiguredStorageBackends()) return;
  const cutoff = new Date(now.getTime() - STALE_UPLOAD_AFTER_MS);
  const rows = await db
    .select({ upload: mediaUploads })
    .from(mediaUploads)
    .innerJoin(journeys, eq(journeys.id, mediaUploads.journeyId))
    .where(and(
      inArray(mediaUploads.status, [
        "initiated",
        "finalizing",
        "completion_unknown",
        "reconciling",
      ]),
      lt(mediaUploads.updatedAt, cutoff),
      isNull(journeys.deletionStartedAt),
    ))
    .limit(RECONCILE_BATCH_SIZE);

  await reconcileUploadCandidates(
    rows.map((row) => row.upload),
    now,
    cutoff,
  );
}

export function startUploadReconciler() {
  if (!hasConfiguredStorageBackends()) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileStaleUploads();
    } catch (error) {
      console.error(
        "Upload reconciliation pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  void run();
  const interval = setInterval(run, RECONCILE_INTERVAL_MS);
  interval.unref();
}

export const uploadRoutes = new Hono();

uploadRoutes.post("/start", async (context) => {
  const { atlas, session } = await requireAtlasAccess(context.req.raw, "create");
  const input = parseStartUpload(await context.req.json<StartUploadInput>());
  if (!input) {
    return context.json({ error: "INVALID_UPLOAD" }, 400);
  }

  const storage = getMultipartStorage();
  const storageKey = `${atlas.id}/${input.journeyId}/${randomUUID()}`;
  let started: { providerUploadId: string } | undefined;

  try {
    const upload = await db.transaction(async (transaction) => {
      const lockedAtlas = await transaction.execute<{ id: string }>(sql`
        select ${atlases.id} as id
        from ${atlases}
        where ${atlases.id} = ${atlas.id}
          and ${atlases.deletionStartedAt} is null
        for update
      `);
      if (lockedAtlas.rows.length === 0) return undefined;

      const lockedJourney = await transaction.execute<{ id: string }>(sql`
        select ${journeys.id} as id
        from ${journeys}
        where ${journeys.id} = ${input.journeyId}
          and ${journeys.atlasId} = ${atlas.id}
          and ${journeys.deletionStartedAt} is null
        for update
      `);
      if (lockedJourney.rows.length === 0) return undefined;

      if (input.routePointId) {
        const [routePoint] = await transaction
          .select({ id: journeyRoutePoints.id })
          .from(journeyRoutePoints)
          .where(and(
            eq(journeyRoutePoints.id, input.routePointId),
            eq(journeyRoutePoints.journeyId, input.journeyId),
          ))
          .limit(1);
        if (!routePoint) return undefined;
      }

      started = await storage.startMultipartUpload({
        key: storageKey,
        mimeType: input.mimeType,
        bytes: input.bytes,
      });
      const [created] = await transaction
        .insert(mediaUploads)
        .values({
          atlasId: atlas.id,
          journeyId: input.journeyId,
          routePointId: input.routePointId,
          storageDriver: storage.driver,
          storageKey,
          providerUploadId: started.providerUploadId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          bytes: input.bytes,
          contentHash: input.contentHash,
          partSize: PART_SIZE,
          partCount: input.partCount,
          createdByUserId: session.user.id,
        })
        .returning();
      return created;
    });
    if (!upload) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
    return context.json(
      {
        uploadId: upload.id,
        partSize: upload.partSize,
        partCount: upload.partCount,
      },
      201,
    );
  } catch (error) {
    if (started) {
      await storage
        .abortMultipartUpload({
          key: storageKey,
          providerUploadId: started.providerUploadId,
        })
        .catch((abortError: unknown) => {
          console.error(
            "Multipart cleanup after upload start failed",
            storageKey,
            abortError instanceof Error ? abortError.message : "unknown error",
          );
        });
    }
    throw error;
  }
});

uploadRoutes.post("/:id/parts/:partNumber", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const upload = await findUpload(context.req.param("id"), atlas.id);
  if (!upload) return context.json({ error: "UPLOAD_NOT_FOUND" }, 404);
  if (upload.status !== "initiated") {
    return context.json({ error: "UPLOAD_NOT_ACTIVE" }, 409);
  }

  const partNumber = Number(context.req.param("partNumber"));
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > upload.partCount
  ) {
    return context.json({ error: "INVALID_PART_NUMBER" }, 400);
  }

  const bytes = Math.min(
    upload.partSize,
    upload.bytes - (partNumber - 1) * upload.partSize,
  );
  const [active] = await db
    .update(mediaUploads)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(mediaUploads.id, upload.id),
      eq(mediaUploads.atlasId, atlas.id),
      eq(mediaUploads.status, "initiated"),
    ))
    .returning({ id: mediaUploads.id });
  if (!active) return context.json({ error: "UPLOAD_NOT_ACTIVE" }, 409);

  const signed = await getMultipartStorage(upload.storageDriver).signUploadPart({
    key: upload.storageKey,
    providerUploadId: upload.providerUploadId,
    partNumber,
    bytes,
  });
  return context.json({
    url: signed.url,
    headers: signed.headers ?? {},
    expiresAt: signed.expiresAt.toISOString(),
  });
});

uploadRoutes.post("/:id/complete", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const upload = await findUpload(context.req.param("id"), atlas.id);
  if (!upload) return context.json({ error: "UPLOAD_NOT_FOUND" }, 404);

  if (upload.status === "completed") {
    const [asset] = upload.mediaAssetId
      ? await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, upload.mediaAssetId))
        .limit(1)
      : [];
    if (asset) return context.json({ asset, completed: true });
    const recovered = await recoverCompletedUpload(upload);
    if (recovered) return context.json({ asset: recovered, completed: true });
    throw new Error("Completed upload object is missing");
  }
  if (upload.status === "finalizing" || upload.status === "completion_unknown") {
    const recovered = await recoverCompletedUpload(upload);
    if (recovered) {
      return context.json({ asset: recovered, completed: true });
    }
    if (
      upload.status === "finalizing" &&
      upload.updatedAt.getTime() > Date.now() - FINALIZATION_LEASE_MS
    ) {
      return context.json(
        { error: "UPLOAD_COMPLETION_PENDING", status: upload.status },
        409,
      );
    }
  }
  if (
    upload.status !== "initiated" &&
    upload.status !== "completion_unknown" &&
    upload.status !== "finalizing"
  ) {
    return context.json(
      { error: "UPLOAD_NOT_COMPLETABLE", status: upload.status },
      409,
    );
  }

  const body = await context.req.json<{ parts?: unknown }>();
  const parts = parseParts(body.parts, upload.partCount);
  if (!parts) return context.json({ error: "INVALID_UPLOAD_PARTS" }, 400);

  const attemptId = randomUUID();
  const [claimed] = await db
    .update(mediaUploads)
    .set({
      status: "finalizing",
      completionAttemptId: attemptId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mediaUploads.id, upload.id),
        eq(mediaUploads.atlasId, atlas.id),
        or(
          eq(mediaUploads.status, "initiated"),
          eq(mediaUploads.status, "completion_unknown"),
          and(
            eq(mediaUploads.status, "finalizing"),
            lt(
              mediaUploads.updatedAt,
              new Date(Date.now() - FINALIZATION_LEASE_MS),
            ),
          ),
        ),
      ),
    )
    .returning({ id: mediaUploads.id });
  if (!claimed) return context.json({ error: "UPLOAD_ALREADY_FINALIZING" }, 409);

  try {
    const storage = getMultipartStorage(upload.storageDriver);
    await db.transaction(async (transaction) => {
      const lockedAtlas = await transaction.execute<{ id: string }>(sql`
        select ${atlases.id} as id
        from ${atlases}
        where ${atlases.id} = ${atlas.id}
          and ${atlases.deletionStartedAt} is null
        for update
      `);
      if (lockedAtlas.rows.length === 0) {
        throw new JourneyUnavailableForUploadError();
      }

      const lockedJourney = await transaction.execute<{ id: string }>(sql`
        select ${journeys.id} as id
        from ${journeys}
        where ${journeys.id} = ${upload.journeyId}
          and ${journeys.deletionStartedAt} is null
        for update
      `);
      if (lockedJourney.rows.length === 0) {
        throw new JourneyUnavailableForUploadError();
      }
      await withCompletionLease(upload.id, attemptId, () =>
        storage.completeMultipartUpload({
          key: upload.storageKey,
          providerUploadId: upload.providerUploadId,
          parts,
          bytes: upload.bytes,
        }),
      );
    });
  } catch (error) {
    if (error instanceof JourneyUnavailableForUploadError) {
      await markCompletionUnknown(upload.id, attemptId);
      return context.json({ error: "JOURNEY_DELETING" }, 409);
    }
    const stillOwnsCompletion = await markCompletionUnknown(upload.id, attemptId);
    if (!stillOwnsCompletion) throw error;
    if (error instanceof CompletedObjectIntegrityError) {
      const storage = getMultipartStorage(upload.storageDriver);
      try {
        await storage.deleteObject({ key: upload.storageKey });
        await db
          .update(mediaUploads)
          .set({
            status: "aborted",
            completionAttemptId: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(mediaUploads.id, upload.id),
            eq(mediaUploads.status, "completion_unknown"),
            eq(mediaUploads.completionAttemptId, attemptId),
          ));
      } catch {
        // Leave completion_unknown for the reconciler to retry deletion.
      }
      throw error;
    }
    const recovered = await recoverCompletedUpload(upload).catch(() => null);
    if (recovered) {
      return context.json({ asset: recovered, completed: true });
    }
    throw error;
  }

  let asset;
  try {
    asset = await finalizeUpload(upload, {
      status: "finalizing",
      attemptId,
    });
  } catch (error) {
    await markCompletionUnknown(upload.id, attemptId);
    throw error;
  }

  return context.json({ asset, completed: true }, 201);
});

uploadRoutes.delete("/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const upload = await findUpload(context.req.param("id"), atlas.id);
  if (!upload) return context.json({ error: "UPLOAD_NOT_FOUND" }, 404);
  if (upload.status === "completed" || upload.status === "finalizing") {
    return context.json({ error: "UPLOAD_NOT_ABORTABLE" }, 409);
  }

  await getMultipartStorage(upload.storageDriver).abortMultipartUpload({
    key: upload.storageKey,
    providerUploadId: upload.providerUploadId,
  });
  await db
    .update(mediaUploads)
    .set({ status: "aborted", updatedAt: new Date() })
    .where(
      and(eq(mediaUploads.id, upload.id), eq(mediaUploads.atlasId, atlas.id)),
    );
  return context.body(null, 204);
});

uploadRoutes.get("/assets/:id/read-url", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const [row] = await db
    .select({ asset: mediaAssets })
    .from(mediaAssets)
    .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
    .where(
      and(
        eq(mediaAssets.id, context.req.param("id")),
        eq(journeys.atlasId, atlas.id),
        isNull(journeys.deletionStartedAt),
      ),
    )
    .limit(1);
  if (!row) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);

  const signed = await getMultipartStorage(
    row.asset.storageDriver,
  ).createPrivateReadUrl({
    key: row.asset.storageKey,
    expiresInSeconds: serverConfig.mediaReadUrlExpiresInSeconds,
  });
  return context.json({
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
  });
});

uploadRoutes.delete("/assets/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const deleted = await deleteMediaAssetForAtlas(
    context.req.param("id"),
    atlas.id,
  );
  if (!deleted) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);
  return context.body(null, 204);
});

uploadRoutes.post("/assets/reorder", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const input = parseReorderInput(await context.req.json<ReorderMediaInput>());
  if (!input) {
    return context.json(
      { error: "INVALID_MEDIA_ORDER", message: "Invalid media order" },
      400,
    );
  }

  const ordered = await db.transaction(async (transaction) => {
    const lockedJourney = await transaction.execute<{ id: string }>(sql`
      select ${journeys.id} as id
      from ${journeys}
      where ${journeys.id} = ${input.journeyId}
        and ${journeys.atlasId} = ${atlas.id}
        and ${journeys.deletionStartedAt} is null
      for update
    `);
    if (lockedJourney.rows.length === 0) return undefined;

    const owned = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.journeyId, input.journeyId),
        inArray(mediaAssets.id, input.assetIds),
      ));
    if (owned.length !== input.assetIds.length) return false;

    await transaction
      .update(mediaAssets)
      .set({ sortOrder: sql`${mediaAssets.sortOrder} + 1000` })
      .where(eq(mediaAssets.journeyId, input.journeyId));
    for (let index = 0; index < input.assetIds.length; index += 1) {
      await transaction
        .update(mediaAssets)
        .set({ sortOrder: index })
        .where(eq(mediaAssets.id, input.assetIds[index]));
    }
    return true;
  });

  if (ordered === undefined) {
    return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  }
  if (ordered === false) {
    return context.json(
      {
        error: "INVALID_MEDIA_ORDER",
        message: "Media assets do not belong to this journey",
      },
      400,
    );
  }
  return context.json({
    journey: await getJourneyForAtlas(input.journeyId, atlas.id),
  });
});

uploadRoutes.post("/assets/move", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const input = parseMoveMediaInput(await context.req.json<MoveMediaInput>());
  if (!input) {
    return context.json(
      { error: "INVALID_MEDIA_MOVE", message: "Invalid media move" },
      400,
    );
  }

  const sourceJourneyId = input.journeyId;
  const targetJourneyId = input.targetJourneyId ?? input.journeyId;
  const crossJourney = sourceJourneyId !== targetJourneyId;

  const result = await db.transaction(async (transaction) => {
    const lockedJourneys = new Map<string, { id: string; coverMediaAssetId: string | null }>();
    for (const journeyId of [...new Set([sourceJourneyId, targetJourneyId])].sort()) {
      const locked = await transaction.execute<{ id: string; coverMediaAssetId: string | null }>(sql`
        select
          ${journeys.id} as id,
          ${journeys.coverMediaAssetId} as "coverMediaAssetId"
        from ${journeys}
        where ${journeys.id} = ${journeyId}
          and ${journeys.atlasId} = ${atlas.id}
          and ${journeys.deletionStartedAt} is null
        for update
      `);
      const row = locked.rows[0];
      if (!row) {
        return journeyId === sourceJourneyId
          ? "journey-not-found" as const
          : "destination-journey-not-found" as const;
      }
      lockedJourneys.set(row.id, row);
    }

    if (input.routePointId) {
      const lockedRoutePoint = await transaction.execute<{ id: string }>(sql`
        select ${journeyRoutePoints.id} as id
        from ${journeyRoutePoints}
        where ${journeyRoutePoints.id} = ${input.routePointId}
          and ${journeyRoutePoints.journeyId} = ${targetJourneyId}
        for update
      `);
      if (lockedRoutePoint.rows.length === 0) return "route-point-not-found" as const;
    }

    const owned = await transaction
      .select({
        id: mediaAssets.id,
        mimeType: mediaAssets.mimeType,
        routePointId: mediaAssets.routePointId,
        sortOrder: mediaAssets.sortOrder,
      })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.journeyId, sourceJourneyId),
        inArray(mediaAssets.id, input.assetIds),
      ));
    if (owned.length !== input.assetIds.length) return "invalid-selection" as const;
    if (
      (crossJourney || input.routePointId)
      && owned.some((asset) => !ALLOWED_MIME_TYPES.has(asset.mimeType))
    ) {
      return "invalid-selection" as const;
    }

    const sourceAll = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, sourceJourneyId))
      .orderBy(mediaAssets.sortOrder);
    const moving = new Set(input.assetIds);
    const sourceOrder = sourceAll.map((asset) => asset.id);
    const movedInSourceOrder = sourceOrder.filter((id) => moving.has(id));

    if (!crossJourney) {
      const nextOrder = [
        ...sourceOrder.filter((id) => !moving.has(id)),
        ...movedInSourceOrder,
      ];
      await transaction
        .update(mediaAssets)
        .set({ sortOrder: sql`${mediaAssets.sortOrder} + 1000` })
        .where(eq(mediaAssets.journeyId, sourceJourneyId));
      for (let index = 0; index < nextOrder.length; index += 1) {
        await transaction
          .update(mediaAssets)
          .set({ sortOrder: index })
          .where(eq(mediaAssets.id, nextOrder[index]));
      }
      await transaction
        .update(mediaAssets)
        .set({ routePointId: input.routePointId })
        .where(inArray(mediaAssets.id, input.assetIds));
      return "ok" as const;
    }

    const targetAll = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, targetJourneyId))
      .orderBy(mediaAssets.sortOrder);
    if (sourceOrder.length > MAX_MOVE_UNDO_ORDER) return "undo-state-too-large" as const;
    const sourceNextOrder = sourceOrder.filter((id) => !moving.has(id));
    const targetNextOrder = [
      ...targetAll.map((asset) => asset.id),
      ...movedInSourceOrder,
    ];
    const ownedById = new Map(owned.map((asset) => [asset.id, asset]));
    const sourceCoverMediaAssetId = lockedJourneys.get(sourceJourneyId)?.coverMediaAssetId ?? null;
    const undo: MediaMoveUndo = {
      sourceJourneyId,
      targetJourneyId,
      assetIds: movedInSourceOrder,
      sourceOrder,
      sourceCoverMediaAssetId,
      placements: movedInSourceOrder.map((assetId) => ({
        assetId,
        routePointId: ownedById.get(assetId)?.routePointId ?? null,
      })),
    };

    await transaction
      .update(mediaAssets)
      .set({ sortOrder: sql`${mediaAssets.sortOrder} + 1000` })
      .where(or(
        eq(mediaAssets.journeyId, sourceJourneyId),
        eq(mediaAssets.journeyId, targetJourneyId),
      ));

    for (let index = 0; index < sourceNextOrder.length; index += 1) {
      await transaction
        .update(mediaAssets)
        .set({ sortOrder: index })
        .where(eq(mediaAssets.id, sourceNextOrder[index]));
    }
    for (let index = 0; index < targetNextOrder.length; index += 1) {
      const assetId = targetNextOrder[index];
      await transaction
        .update(mediaAssets)
        .set(moving.has(assetId)
          ? {
              journeyId: targetJourneyId,
              routePointId: input.routePointId,
              sortOrder: index,
            }
          : { sortOrder: index })
        .where(eq(mediaAssets.id, assetId));
    }

    if (sourceCoverMediaAssetId && moving.has(sourceCoverMediaAssetId)) {
      await transaction
        .update(journeys)
        .set({ coverMediaAssetId: null })
        .where(eq(journeys.id, sourceJourneyId));
    }
    return { kind: "ok" as const, undo };
  });

  if (result === "journey-not-found") {
    return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  }
  if (result === "destination-journey-not-found") {
    return context.json({ error: "DESTINATION_JOURNEY_NOT_FOUND" }, 404);
  }
  if (result === "route-point-not-found") {
    return context.json({ error: "ROUTE_POINT_NOT_FOUND" }, 404);
  }
  if (result === "undo-state-too-large") {
    return context.json(
      { error: "MEDIA_MOVE_TOO_LARGE", message: "Journey has too many media assets to create an undo-safe move" },
      409,
    );
  }
  if (result === "invalid-selection") {
    return context.json(
      {
        error: "INVALID_MEDIA_MOVE",
        message: "Media assets do not belong to the source journey, or the selected media cannot move to that destination",
      },
      400,
    );
  }

  const sourceJourney = await getJourneyForAtlas(sourceJourneyId, atlas.id);
  if (!crossJourney) {
    return context.json({ journey: sourceJourney });
  }
  const destinationJourney = await getJourneyForAtlas(targetJourneyId, atlas.id);
  const undo = typeof result === "object" ? result.undo : null;
  return context.json({
    journey: sourceJourney,
    sourceJourney,
    destinationJourney,
    undo,
  });
});


uploadRoutes.post("/assets/move/undo", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const input = parseUndoMediaMoveInput(await context.req.json<UndoMediaMoveInput>());
  if (!input) {
    return context.json(
      { error: "INVALID_MEDIA_MOVE_UNDO", message: "Invalid media move undo" },
      400,
    );
  }

  const result = await db.transaction(async (transaction) => {
    const lockedJourneys = new Map<string, { id: string; coverMediaAssetId: string | null }>();
    for (const journeyId of [input.sourceJourneyId, input.targetJourneyId].sort()) {
      const locked = await transaction.execute<{ id: string; coverMediaAssetId: string | null }>(sql`
        select
          ${journeys.id} as id,
          ${journeys.coverMediaAssetId} as "coverMediaAssetId"
        from ${journeys}
        where ${journeys.id} = ${journeyId}
          and ${journeys.atlasId} = ${atlas.id}
          and ${journeys.deletionStartedAt} is null
        for update
      `);
      const row = locked.rows[0];
      if (!row) {
        return journeyId === input.sourceJourneyId
          ? "journey-not-found" as const
          : "destination-journey-not-found" as const;
      }
      lockedJourneys.set(row.id, row);
    }

    const originalRoutePointIds = [...new Set(
      input.placements
        .map((placement) => placement.routePointId)
        .filter((routePointId): routePointId is string => routePointId !== null),
    )].sort();
    for (const routePointId of originalRoutePointIds) {
      const lockedRoutePoint = await transaction.execute<{ id: string }>(sql`
        select ${journeyRoutePoints.id} as id
        from ${journeyRoutePoints}
        where ${journeyRoutePoints.id} = ${routePointId}
          and ${journeyRoutePoints.journeyId} = ${input.sourceJourneyId}
        for update
      `);
      if (lockedRoutePoint.rows.length === 0) return "route-point-not-found" as const;
    }

    const movingRows = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.journeyId, input.targetJourneyId),
        inArray(mediaAssets.id, input.assetIds),
      ));
    if (movingRows.length !== input.assetIds.length) return "undo-conflict" as const;

    const moving = new Set(input.assetIds);
    const sourceCoverBeforeUndo = lockedJourneys.get(input.sourceJourneyId)?.coverMediaAssetId ?? null;
    const targetCoverBeforeUndo = lockedJourneys.get(input.targetJourneyId)?.coverMediaAssetId ?? null;
    const shouldRestoreSourceCover = input.sourceCoverMediaAssetId !== null
      && moving.has(input.sourceCoverMediaAssetId);
    if (shouldRestoreSourceCover && sourceCoverBeforeUndo !== null) return "undo-conflict" as const;
    if (targetCoverBeforeUndo !== null && moving.has(targetCoverBeforeUndo)) return "undo-conflict" as const;

    const sourceAll = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, input.sourceJourneyId))
      .orderBy(mediaAssets.sortOrder);
    const targetAll = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, input.targetJourneyId))
      .orderBy(mediaAssets.sortOrder);
    const currentSourceIds = sourceAll.map((asset) => asset.id);
    const originalSourceSet = new Set(input.sourceOrder);
    const currentSourceSet = new Set(currentSourceIds);
    const restoredSourceOrder = input.sourceOrder.filter(
      (assetId) => currentSourceSet.has(assetId) || moving.has(assetId),
    );
    const sourceNewcomers = currentSourceIds.filter((assetId) => !originalSourceSet.has(assetId));
    const sourceNextOrder = [...restoredSourceOrder, ...sourceNewcomers];
    const targetNextOrder = targetAll.map((asset) => asset.id).filter((assetId) => !moving.has(assetId));
    const placementByAsset = new Map(
      input.placements.map((placement) => [placement.assetId, placement.routePointId]),
    );

    await transaction
      .update(mediaAssets)
      .set({ sortOrder: sql`${mediaAssets.sortOrder} + 1000` })
      .where(or(
        eq(mediaAssets.journeyId, input.sourceJourneyId),
        eq(mediaAssets.journeyId, input.targetJourneyId),
      ));

    for (let index = 0; index < targetNextOrder.length; index += 1) {
      await transaction
        .update(mediaAssets)
        .set({ sortOrder: index })
        .where(eq(mediaAssets.id, targetNextOrder[index]));
    }
    for (let index = 0; index < sourceNextOrder.length; index += 1) {
      const assetId = sourceNextOrder[index];
      await transaction
        .update(mediaAssets)
        .set(moving.has(assetId)
          ? {
              journeyId: input.sourceJourneyId,
              routePointId: placementByAsset.get(assetId) ?? null,
              sortOrder: index,
            }
          : { sortOrder: index })
        .where(eq(mediaAssets.id, assetId));
    }

    if (shouldRestoreSourceCover) {
      await transaction
        .update(journeys)
        .set({ coverMediaAssetId: input.sourceCoverMediaAssetId })
        .where(eq(journeys.id, input.sourceJourneyId));
    }
    return "ok" as const;
  });

  if (result === "journey-not-found") {
    return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  }
  if (result === "destination-journey-not-found") {
    return context.json({ error: "DESTINATION_JOURNEY_NOT_FOUND" }, 404);
  }
  if (result === "route-point-not-found") {
    return context.json({ error: "ROUTE_POINT_NOT_FOUND" }, 404);
  }
  if (result === "undo-conflict") {
    return context.json(
      { error: "MEDIA_MOVE_UNDO_CONFLICT", message: "Media ownership or cover state changed after the move" },
      409,
    );
  }

  return context.json({
    sourceJourney: await getJourneyForAtlas(input.sourceJourneyId, atlas.id),
    destinationJourney: await getJourneyForAtlas(input.targetJourneyId, atlas.id),
  });
});
