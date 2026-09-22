import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { journeyRoutePoints, mediaAssets, mediaUploads, journeys } from "../db/app-schema";
import {
  parseRecordedEvidenceDocument,
  serializeRecordedEvidence,
  type MediaRecordedEvidence,
} from "../media/media-evidence";
import { PART_SIZE, mediaKindOf, parseParts, type parseStartUpload } from "../media/upload-protocol";
import { lockActiveAtlas, lockActiveJourney } from "../repositories/journey-repository";
import { attachRecordedEvidenceToNewAsset } from "../repositories/media-evidence-repository";
import { getMultipartStorage, hasConfiguredStorageBackends } from "../storage/storage-registry";
import { CompletedObjectIntegrityError, type MultipartStorage } from "../storage/multipart-storage";

const FINALIZATION_LEASE_MS = 20_000;
const FINALIZATION_HEARTBEAT_MS = 5_000;
const STALE_UPLOAD_AFTER_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1_000;
const RECONCILE_BATCH_SIZE = 25;

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
  verifiedContentHash: string,
  lease?: CompletionLease,
) {
  if (!/^[0-9a-f]{64}$/.test(verifiedContentHash)) {
    throw new Error("Verified content identity must be a lowercase SHA-256");
  }
  // The evidence the accepted upload carried, read back through the same
  // parser that accepted it. Every finalization path — the direct completion,
  // the lost-response `completion_unknown` recovery and stale reconciliation —
  // reaches this one function with the upload row, so none of them can finalize
  // the bytes while dropping the document. A stored document that no longer
  // parses is unreachable for rows this code wrote; it throws rather than
  // silently degrading to an asset with no evidence at all.
  let recordedEvidence: MediaRecordedEvidence | null = null;
  if (upload.recordedEvidence !== null && upload.recordedEvidence !== undefined) {
    recordedEvidence = parseRecordedEvidenceDocument(upload.recordedEvidence);
    if (!recordedEvidence) {
      throw new Error("Stored upload evidence is not a recorded evidence document");
    }
  }
  const result = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, upload.atlasId)) {
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
    if (!await lockActiveJourney(transaction, upload.journeyId, null)) {
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
    const [duplicate] = await transaction
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(
          eq(mediaAssets.journeyId, upload.journeyId),
          eq(mediaAssets.contentHash, verifiedContentHash),
          eq(mediaAssets.contentHashVerified, true),
          like(mediaAssets.mimeType, `${mediaKindOf(upload.mimeType)}/%`),
          upload.routePointId
            ? eq(mediaAssets.routePointId, upload.routePointId)
            : isNull(mediaAssets.routePointId),
        ))
        .limit(1);

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
          contentHash: verifiedContentHash,
          contentHashVerified: true,
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
      // #234: an asset with no `journeyId` is owned by an Everyday Fragment,
      // so it can never be the asset this Journey upload just completed. Named
      // as its own condition rather than left to `null !== <id>`, which would
      // reach the same refusal by accident instead of by rule.
      if (
        !asset
        || asset.journeyId === null
        || asset.journeyId !== upload.journeyId
      ) {
        throw new Error("Completed media asset could not be reconciled");
      }
    }
    // #428: evidence belongs to the asset, so it is attached exactly when this
    // upload is the one that created the asset — inside this same transaction,
    // so a rollback commits neither the asset nor its evidence.
    //
    // A deduplicated completion deliberately writes nothing: the asset it
    // answers with already existed and already owns whatever evidence its own
    // upload carried, and "leave it unchanged" includes not promoting an asset
    // that has no evidence row to revision 1 from another upload's document.
    // Correcting or supplying evidence for an existing asset is what the
    // owner-only `/api/media-evidence` route is for.
    if (!deduplicated && recordedEvidence) {
      await attachRecordedEvidenceToNewAsset(
        transaction,
        asset.id,
        recordedEvidence,
      );
    }
    // #428: the upload column holds the document only until the asset that owns
    // it exists, so the completing transaction is where it stops being needed.
    // Clearing it here keeps `media_asset_evidence` the single durable owner: a
    // later correction or withdrawal through `/api/media-evidence` cannot leave
    // a divergent copy of the original coordinates and capture time behind, and
    // a deduplicated completion — which deliberately attaches nothing — does not
    // retain a document describing an asset it does not own. Only this terminal
    // transition clears it, so an aborted or retried attempt still carries the
    // document: `reconcileStaleUploads` claims only `initiated`, `finalizing`,
    // `completion_unknown` and `reconciling`, and the lost-response recovery
    // this route runs for `finalizing` / `completion_unknown` reaches the same
    // rows, so both still finalize with exactly the normalized document the
    // accepted upload carried.
    //
    // One path does re-enter finalization on an already `completed` row: the
    // `/:id/complete` replay whose asset has since been deleted, which nulls
    // `mediaAssetId` and recreates the asset from the stored object. That
    // recreated asset deliberately gets no evidence row. Deleting the asset
    // cascaded its evidence away, and this column is a transport copy rather
    // than a second durable record, so resurrecting the original coordinates
    // and capture time would reinstate evidence the owner already removed.
    await transaction
      .update(mediaUploads)
      .set({
        status: "completed",
        mediaAssetId: asset.id,
        completionAttemptId: null,
        recordedEvidence: null,
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

async function verifiedContentHashForUpload(
  upload: UploadRecord,
  storage: MultipartStorage = getMultipartStorage(upload.storageDriver),
) {
  const identity = await storage.hashObject({ key: upload.storageKey });
  if (!identity.exists) return null;
  return identity.sha256;
}

async function recoverCompletedUpload(upload: UploadRecord) {
  const storage = getMultipartStorage(upload.storageDriver);
  const inspected = await storage.inspectObject({ key: upload.storageKey });
  if (!inspected.exists) return null;
  if (inspected.bytes !== upload.bytes) {
    throw new Error("Completed object size does not match the upload record");
  }
  const verifiedContentHash = await verifiedContentHashForUpload(upload, storage);
  if (!verifiedContentHash) return null;
  return finalizeUpload(upload, verifiedContentHash);
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
    verifiedContentHash: string,
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
        const verifiedContentHash = await verifiedContentHashForUpload(claimed, storage);
        if (!verifiedContentHash) {
          await dependencies.markRetryable(claimed.id, attemptId);
          continue;
        }
        await dependencies.finalize(claimed, verifiedContentHash, {
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

export async function startUploadForAtlas(
  atlasId: string,
  createdByUserId: string,
  input: NonNullable<ReturnType<typeof parseStartUpload>>,
) {
  const storage = getMultipartStorage();
  const storageKey = `${atlasId}/${input.journeyId}/${randomUUID()}`;
  let started: { providerUploadId: string } | undefined;

  try {
    const upload = await db.transaction(async (transaction) => {
      if (!await lockActiveAtlas(transaction, atlasId)) return undefined;
      if (!await lockActiveJourney(transaction, input.journeyId, atlasId)) return undefined;

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
          atlasId,
          journeyId: input.journeyId,
          routePointId: input.routePointId,
          storageDriver: storage.driver,
          storageKey,
          providerUploadId: started.providerUploadId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          bytes: input.bytes,
          contentHash: input.contentHash,
          recordedEvidence: input.recordedEvidence
            ? serializeRecordedEvidence(input.recordedEvidence)
            : null,
          partSize: PART_SIZE,
          partCount: input.partCount,
          createdByUserId,
        })
        .returning();
      return created;
    });
    if (!upload) return { body: { error: "JOURNEY_NOT_FOUND" }, status: 404 as const };
    return {
      body: {
        uploadId: upload.id,
        partSize: upload.partSize,
        partCount: upload.partCount,
      },
      status: 201 as const,
    };
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
}

export async function signUploadPartForAtlas(
  atlasId: string,
  uploadId: string,
  partNumberValue: string,
) {
  const upload = await findUpload(uploadId, atlasId);
  if (!upload) return { body: { error: "UPLOAD_NOT_FOUND" }, status: 404 as const };
  if (upload.status !== "initiated") {
    return { body: { error: "UPLOAD_NOT_ACTIVE" }, status: 409 as const };
  }

  const partNumber = Number(partNumberValue);
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > upload.partCount
  ) {
    return { body: { error: "INVALID_PART_NUMBER" }, status: 400 as const };
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
      eq(mediaUploads.atlasId, atlasId),
      eq(mediaUploads.status, "initiated"),
    ))
    .returning({ id: mediaUploads.id });
  if (!active) return { body: { error: "UPLOAD_NOT_ACTIVE" }, status: 409 as const };

  const signed = await getMultipartStorage(upload.storageDriver).signUploadPart({
    key: upload.storageKey,
    providerUploadId: upload.providerUploadId,
    partNumber,
    bytes,
  });
  return {
    body: {
      url: signed.url,
      headers: signed.headers ?? {},
      expiresAt: signed.expiresAt.toISOString(),
    },
    status: 200 as const,
  };
}

export async function completeUploadForAtlas(
  atlasId: string,
  uploadId: string,
  // Preserve replay/recovery and ownership checks before consuming the request.
  readBody: () => Promise<Record<string, unknown> | null>,
) {
  const upload = await findUpload(uploadId, atlasId);
  if (!upload) return { body: { error: "UPLOAD_NOT_FOUND" }, status: 404 as const };

  if (upload.status === "completed") {
    const [asset] = upload.mediaAssetId
      ? await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, upload.mediaAssetId))
        .limit(1)
      : [];
    if (asset) return { body: { asset, completed: true }, status: 200 as const };
    const recovered = await recoverCompletedUpload(upload);
    if (recovered) return { body: { asset: recovered, completed: true }, status: 200 as const };
    throw new Error("Completed upload object is missing");
  }
  if (upload.status === "finalizing" || upload.status === "completion_unknown") {
    const recovered = await recoverCompletedUpload(upload);
    if (recovered) {
      return { body: { asset: recovered, completed: true }, status: 200 as const };
    }
    if (
      upload.status === "finalizing" &&
      upload.updatedAt.getTime() > Date.now() - FINALIZATION_LEASE_MS
    ) {
      return { body: { error: "UPLOAD_COMPLETION_PENDING", status: upload.status }, status: 409 as const };
    }
  }
  if (
    upload.status !== "initiated" &&
    upload.status !== "completion_unknown" &&
    upload.status !== "finalizing"
  ) {
    return { body: { error: "UPLOAD_NOT_COMPLETABLE", status: upload.status }, status: 409 as const };
  }

  const body = await readBody();
  const parts = body && parseParts(body.parts, upload.partCount);
  if (!parts) return { body: { error: "INVALID_UPLOAD_PARTS" }, status: 400 as const };

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
        eq(mediaUploads.atlasId, atlasId),
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
  if (!claimed) return { body: { error: "UPLOAD_ALREADY_FINALIZING" }, status: 409 as const };

  let verifiedContentHash: string | null = null;
  const storage = getMultipartStorage(upload.storageDriver);
  try {
    await db.transaction(async (transaction) => {
      if (!await lockActiveAtlas(transaction, atlasId)) {
        throw new JourneyUnavailableForUploadError();
      }

      if (!await lockActiveJourney(transaction, upload.journeyId, null)) {
        throw new JourneyUnavailableForUploadError();
      }
      verifiedContentHash = await withCompletionLease(upload.id, attemptId, async () => {
        await storage.completeMultipartUpload({
          key: upload.storageKey,
          providerUploadId: upload.providerUploadId,
          parts,
          bytes: upload.bytes,
        });
        const hash = await verifiedContentHashForUpload(upload, storage);
        if (!hash) {
          throw new CompletedObjectIntegrityError("Completed upload object is missing");
        }
        return hash;
      });
    });
  } catch (error) {
    if (error instanceof JourneyUnavailableForUploadError) {
      await markCompletionUnknown(upload.id, attemptId);
      return { body: { error: "JOURNEY_DELETING" }, status: 409 as const };
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
      return { body: { asset: recovered, completed: true }, status: 200 as const };
    }
    throw error;
  }

  let asset;
  try {
    if (!verifiedContentHash) {
      throw new CompletedObjectIntegrityError("Completed upload identity was not verified");
    }
    asset = await finalizeUpload(upload, verifiedContentHash, {
      status: "finalizing",
      attemptId,
    });
  } catch (error) {
    await markCompletionUnknown(upload.id, attemptId);
    throw error;
  }

  return { body: { asset, completed: true }, status: 201 as const };
}

export async function abortUploadForAtlas(
  atlasId: string,
  uploadId: string,
) {
  const upload = await findUpload(uploadId, atlasId);
  if (!upload) return { body: { error: "UPLOAD_NOT_FOUND" }, status: 404 as const };
  if (upload.status === "completed" || upload.status === "finalizing") {
    return { body: { error: "UPLOAD_NOT_ABORTABLE" }, status: 409 as const };
  }

  await getMultipartStorage(upload.storageDriver).abortMultipartUpload({
    key: upload.storageKey,
    providerUploadId: upload.providerUploadId,
  });
  await db
    .update(mediaUploads)
    .set({ status: "aborted", updatedAt: new Date() })
    .where(
      and(eq(mediaUploads.id, upload.id), eq(mediaUploads.atlasId, atlasId)),
    );
  return null;
}
