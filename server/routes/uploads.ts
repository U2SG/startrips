import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { db } from "../db/client";
import {
  journeyRoutePoints,
  mediaAssets,
  mediaUploads,
  journeys,
} from "../db/app-schema";
import { deleteMediaAssetForAtlas } from "../services/delete-media";
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
const MAX_PARTS = 10_000;
const FINALIZATION_LEASE_MS = 20_000;
const FINALIZATION_HEARTBEAT_MS = 5_000;
const STALE_UPLOAD_AFTER_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1_000;
const RECONCILE_BATCH_SIZE = 25;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

type StartUploadInput = {
  journeyId?: unknown;
  routePointId?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  bytes?: unknown;
};

function parseStartUpload(body: StartUploadInput) {
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

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      journeyId,
    ) ||
    (routePointId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routePointId)) ||
    !fileName ||
    fileName.length > 180 ||
    !ALLOWED_MIME_TYPES.has(mimeType) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_UPLOAD_BYTES ||
    partCount < 1 ||
    partCount > MAX_PARTS
  ) {
    return null;
  }

  return { journeyId, routePointId, fileName, mimeType, bytes, partCount };
}

function parseParts(value: unknown, expectedCount: number): MultipartPart[] | null {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;

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
  return db.transaction(async (transaction) => {
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
        sortOrder: (lastAsset?.sortOrder ?? -1) + 1,
        uploadedByUserId: upload.createdByUserId,
      })
      .onConflictDoNothing({ target: mediaAssets.storageKey })
      .returning();
    const asset = created ?? (
      await transaction
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.storageKey, upload.storageKey))
        .limit(1)
    )[0];
    if (!asset || asset.journeyId !== upload.journeyId) {
      throw new Error("Completed media asset could not be reconciled");
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
    return asset;
  });
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
    expiresInSeconds: 15 * 60,
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
