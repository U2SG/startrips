import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { mediaAssets, mediaPreviewWrites } from "../db/app-schema";
import { db } from "../db/client";
import {
  planPreviewDerivation,
  previewObjectFitsCeiling,
  type PreviewCeilings,
  type PreviewSpec,
} from "../media/preview-derivation";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  getMultipartStorage,
  hasConfiguredStorageBackends,
} from "../storage/storage-registry";

/**
 * #260: the two state transitions of a derived preview, kept out of the route
 * so the object storage they touch is one injectable seam.
 *
 * The routes above them do authorization, the atlas-scoped asset lookup and
 * body validation; everything here is about the derived object itself.
 */
export type MediaPreviewDependencies = {
  storageForBackend: (backendId: string) => MultipartStorage;
};

const defaultDependencies: MediaPreviewDependencies = {
  storageForBackend: getMultipartStorage,
};

type MediaAsset = typeof mediaAssets.$inferSelect;

export type PreviewFailure = {
  ok: false;
  error:
    | "INVALID_PREVIEW_REQUEST"
    | "PREVIEW_UNSUPPORTED"
    | "PREVIEW_NOT_PENDING"
    | "PREVIEW_OBJECT_MISSING"
    | "PREVIEW_SUPERSEDED"
    | "PREVIEW_TOO_LARGE";
  status: 400 | 409;
};

export type PreviewBegun = {
  ok: true;
  upload: { url: string; headers: Record<string, string>; expiresAt: string };
  preview: PreviewSpec;
};

export type PreviewCompleted = {
  ok: true;
  preview: {
    mimeType: string;
    bytes: number;
    width: number | null;
    height: number | null;
  };
};

export type PreviewSourceValues = {
  sourceWidth: number;
  sourceHeight: number;
  exifOrientation: number | null;
};

/** Every preview column back to "there is nothing to serve", in one shape. */
const CLEARED_PREVIEW = {
  previewState: "failed",
  previewStorageKey: null,
  previewMimeType: null,
  previewBytes: null,
} as const;

/**
 * The row still holds the generation this call read.
 *
 * `previewStorageKey` is the generation marker for the whole protocol: begin
 * claims the row by swapping the key it read for the key it just signed,
 * complete promotes only the key it inspected, and the failure paths clear
 * only the key they measured. Every write is therefore a compare-and-swap on
 * one column, so of two concurrent derivations exactly one owns the row and
 * the other is told it lost rather than silently overwriting a newer intent.
 *
 * `IS NULL` and `=` are separate predicates because SQL equality against NULL
 * is never true, and a first-ever derivation reads a NULL key.
 */
function stillHoldsGeneration(assetId: string, storageKey: string | null) {
  return and(
    eq(mediaAssets.id, assetId),
    storageKey === null
      ? isNull(mediaAssets.previewStorageKey)
      : eq(mediaAssets.previewStorageKey, storageKey),
  );
}

/**
 * Drop the object a preview column used to point at, once no row references it
 * any more. Best-effort at the call sites that already hold a correct row, in
 * the same spirit as the deduplicated object cleanup in the upload pipeline:
 * a storage hiccup there costs an unreferenced object rather than a wrong
 * answer. It reports whether the object is gone so the sweep below, which has
 * nothing else to fall back on, can keep its record and try again.
 */
async function discardPreviewObject(
  storageDriver: string,
  storageKey: string | null,
  dependencies: MediaPreviewDependencies,
) {
  if (!storageKey) return true;
  try {
    await dependencies.storageForBackend(storageDriver).deleteObject({
      key: storageKey,
    });
    return true;
  } catch (error) {
    console.error(
      "Preview object cleanup failed",
      storageKey,
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}

/**
 * Plan the preview and hand back a write for exactly that plan.
 *
 * The caller supplies only what it can measure about the source — its pixel
 * size and its EXIF orientation. Every decision after that is the server's:
 * the orientation-corrected display size, the pixel size of the still, its
 * format, and the byte ceiling it must respect. The response is a signed
 * single-object write plus the spec that write has to satisfy, so a producer
 * has no room to widen anything, and completion measures what actually landed.
 *
 * Re-deriving is allowed from any state. The previous derived object is
 * dropped as soon as the row stops referencing it, so a second derivation
 * replaces the first rather than orphaning it.
 *
 * A source nothing can be derived from — an audio soundtrack, a video whose
 * frame no producer can rasterise — is an explicit, recorded degradation:
 * `failed`, with the original's read contract untouched and the Journey saving
 * exactly as it did before.
 */
export async function beginAssetPreview(
  asset: MediaAsset,
  atlasId: string,
  values: PreviewSourceValues,
  ceilings: PreviewCeilings,
  uploadExpiresInSeconds: number,
  dependencies: MediaPreviewDependencies = defaultDependencies,
): Promise<PreviewBegun | PreviewFailure> {
  const planned = planPreviewDerivation(
    { mimeType: asset.mimeType, ...values },
    ceilings,
  );
  if (!planned.ok) {
    if (planned.reason === "invalid-source") {
      return { ok: false, error: "INVALID_PREVIEW_REQUEST", status: 400 };
    }
    const [cleared] = await db
      .update(mediaAssets)
      .set(CLEARED_PREVIEW)
      .where(stillHoldsGeneration(asset.id, asset.previewStorageKey))
      .returning({ id: mediaAssets.id });
    if (!cleared) {
      return { ok: false, error: "PREVIEW_SUPERSEDED", status: 409 };
    }
    await discardPreviewObject(
      asset.storageDriver,
      asset.previewStorageKey,
      dependencies,
    );
    return { ok: false, error: "PREVIEW_UNSUPPORTED", status: 409 };
  }

  const { spec } = planned;
  // No file name, no capture time, no coordinates: a derived key is an opaque
  // identity under the Journey that owns it, exactly like the original's.
  const previewStorageKey = `${atlasId}/${asset.journeyId}/previews/${randomUUID()}`;
  const signed = await dependencies
    .storageForBackend(asset.storageDriver)
    .signObjectUpload({
      key: previewStorageKey,
      mimeType: spec.mimeType,
      expiresInSeconds: uploadExpiresInSeconds,
    });
  // The write is recorded before the claim, and before any caller could hold
  // the URL. From here on this key has an owner that no cascade can take
  // away, so whatever happens next — a lost swap, a completion, or the media,
  // its Journey or its Atlas being deleted a moment later — the sweep below
  // can still find the object and retire it.
  await db.insert(mediaPreviewWrites).values({
    mediaAssetId: asset.id,
    storageDriver: asset.storageDriver,
    storageKey: previewStorageKey,
    expiresAt: signed.expiresAt,
  });
  // The claim is what makes this generation authoritative, and it happens
  // AFTER the presign because signing has no effect on storage: a begin that
  // loses the swap has handed nobody a URL that was ever usable, because it
  // answers 409 instead of returning it. Two begins racing from one snapshot
  // therefore leave exactly one live key, not two.
  const [claimed] = await db
    .update(mediaAssets)
    .set({
      displayWidth: spec.displayWidth,
      displayHeight: spec.displayHeight,
      previewStorageKey,
      previewMimeType: spec.mimeType,
      previewBytes: null,
      previewState: "pending",
    })
    .where(stillHoldsGeneration(asset.id, asset.previewStorageKey))
    .returning({ id: mediaAssets.id });
  if (!claimed) {
    return { ok: false, error: "PREVIEW_SUPERSEDED", status: 409 };
  }
  await discardPreviewObject(
    asset.storageDriver,
    asset.previewStorageKey,
    dependencies,
  );

  return {
    ok: true,
    upload: {
      url: signed.url,
      headers: signed.headers ?? {},
      expiresAt: signed.expiresAt.toISOString(),
    },
    preview: spec,
  };
}

/**
 * Measure what was written, then make it servable — or not.
 *
 * The produced object is inspected rather than trusted. A write that never
 * landed leaves the asset `pending`, because that is a retryable state and
 * turning a retryable fault into a permanent loss is exactly what #260
 * forbids. A write that landed but broke the byte ceiling is a decided
 * outcome: the object is dropped and the asset is `failed`, so no oversized
 * still can ever be signed.
 */
export async function completeAssetPreview(
  asset: MediaAsset,
  ceilings: PreviewCeilings,
  dependencies: MediaPreviewDependencies = defaultDependencies,
): Promise<PreviewCompleted | PreviewFailure> {
  if (asset.previewState !== "pending" || !asset.previewStorageKey) {
    return { ok: false, error: "PREVIEW_NOT_PENDING", status: 409 };
  }

  const storage = dependencies.storageForBackend(asset.storageDriver);
  const inspected = await storage.inspectObject({
    key: asset.previewStorageKey,
  });
  if (!inspected.exists) {
    return { ok: false, error: "PREVIEW_OBJECT_MISSING", status: 409 };
  }
  if (!previewObjectFitsCeiling(inspected.bytes, ceilings)) {
    // Guarded by the key that was actually inspected, exactly like the success
    // path below. Without it, a completion that measured generation A would
    // clear generation B out of a row a concurrent re-derivation had already
    // moved on, stranding B's object and leaving its producer holding an
    // upload URL it could never complete.
    const [cleared] = await db
      .update(mediaAssets)
      .set(CLEARED_PREVIEW)
      .where(stillHoldsGeneration(asset.id, asset.previewStorageKey))
      .returning({ id: mediaAssets.id });
    if (cleared) {
      await discardPreviewObject(
        asset.storageDriver,
        asset.previewStorageKey,
        dependencies,
      );
      return { ok: false, error: "PREVIEW_TOO_LARGE", status: 409 };
    }
    return { ok: false, error: "PREVIEW_NOT_PENDING", status: 409 };
  }

  const [updated] = await db
    .update(mediaAssets)
    .set({ previewBytes: inspected.bytes, previewState: "ready" })
    .where(stillHoldsGeneration(asset.id, asset.previewStorageKey))
    .returning();
  // A concurrent re-derivation moved the key out from under this completion;
  // the object it measured belongs to that round, not this one.
  if (!updated) {
    return { ok: false, error: "PREVIEW_NOT_PENDING", status: 409 };
  }
  return {
    ok: true,
    preview: {
      mimeType: updated.previewMimeType as string,
      bytes: updated.previewBytes as number,
      width: updated.displayWidth,
      height: updated.displayHeight,
    },
  };
}

/**
 * How long after a preview write's own expiry the sweep first looks at it.
 *
 * A presigned signature is checked when the request starts, so past the
 * expiry no new PUT can begin. It says nothing about a PUT that began just
 * before it and is still streaming, which is why the expiry is a starting
 * point here and not a terminal state.
 */
const PREVIEW_WRITE_GRACE_MS = 5 * 60 * 1_000;
/**
 * How long a key must stay absent before its record may be forgotten.
 *
 * The sweep never concludes anything from one look. It acts, records when it
 * acted, and only drops the record when a later pass — at least this far
 * after that — still finds nothing under the key. A write that was streaming
 * at the first look has by then either finished, in which case the object is
 * there and is deleted and the clock restarts, or it never landed at all. A
 * preview is at most `MEDIA_PREVIEW_MAX_BYTES` of a size-bounded still, so
 * half an hour is far past any request that could still be running.
 */
const PREVIEW_WRITE_SETTLE_MS = 30 * 60 * 1_000;
const PREVIEW_WRITE_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const PREVIEW_WRITE_BATCH_SIZE = 50;

/**
 * Retire the objects that issued preview writes may have left behind.
 *
 * An expired signature is not a terminal write state, so this pass is a
 * repeated-retirement contract rather than a single sweep. For every record
 * past its expiry it looks at what is actually under the key:
 *
 *  - the key is referenced by an asset and the object is there — the write
 *    completed and has a live owner, so the record has nothing left to do and
 *    the deletion paths take it from here;
 *  - the key is not referenced and the object is there — a superseded
 *    generation, a begin that lost its swap, or a PUT that landed after the
 *    media, Journey or Atlas cascaded away. The object is deleted, the
 *    attempt is stamped, and the record is KEPT so a later pass can confirm
 *    nothing came back;
 *  - nothing is under the key — either nothing ever landed, or a PUT is still
 *    streaming. The attempt is stamped and the record is kept, and only once
 *    a later pass a full settle interval afterwards still finds nothing is
 *    the record dropped.
 *
 * So a write is only forgotten after the key has been observed empty across a
 * window longer than any request that could still have been in flight, and a
 * failed storage delete keeps its record too, because this sweep is the last
 * owner able to name that key.
 */
export async function reconcilePreviewWrites(
  now = new Date(),
  dependencies: MediaPreviewDependencies = defaultDependencies,
) {
  const cutoff = new Date(now.getTime() - PREVIEW_WRITE_GRACE_MS);
  const writes = await db
    .select()
    .from(mediaPreviewWrites)
    .where(lt(mediaPreviewWrites.expiresAt, cutoff))
    // Oldest signature first, so a backlog larger than one batch drains in the
    // order the writes were issued rather than in whatever order the heap
    // hands back, and the record that has waited longest is never the one a
    // batch limit keeps skipping.
    .orderBy(mediaPreviewWrites.expiresAt)
    .limit(PREVIEW_WRITE_BATCH_SIZE);

  let retired = 0;
  let settled = 0;
  for (const write of writes) {
    const [referencing] = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.previewStorageKey, write.storageKey))
      .limit(1);

    let present: boolean;
    try {
      present = (
        await dependencies
          .storageForBackend(write.storageDriver)
          .inspectObject({ key: write.storageKey })
      ).exists;
    } catch (error) {
      console.error(
        "Preview write inspection failed",
        write.storageKey,
        error instanceof Error ? error.message : "unknown error",
      );
      continue;
    }

    if (referencing && present) {
      settled += 1;
      await db
        .delete(mediaPreviewWrites)
        .where(eq(mediaPreviewWrites.id, write.id));
      continue;
    }

    if (!referencing && present) {
      const discarded = await discardPreviewObject(
        write.storageDriver,
        write.storageKey,
        dependencies,
      );
      if (!discarded) continue;
      retired += 1;
      await db
        .update(mediaPreviewWrites)
        .set({ retireAttemptedAt: now })
        .where(eq(mediaPreviewWrites.id, write.id));
      continue;
    }

    // Nothing under the key. One empty look proves nothing; two, far enough
    // apart, do.
    const settledSince = write.retireAttemptedAt;
    if (
      settledSince
      && now.getTime() - settledSince.getTime() >= PREVIEW_WRITE_SETTLE_MS
    ) {
      settled += 1;
      await db
        .delete(mediaPreviewWrites)
        .where(eq(mediaPreviewWrites.id, write.id));
      continue;
    }
    if (!settledSince) {
      await db
        .update(mediaPreviewWrites)
        .set({ retireAttemptedAt: now })
        .where(eq(mediaPreviewWrites.id, write.id));
    }
  }
  return { examined: writes.length, retired, settled };
}

export function startPreviewWriteReconciler() {
  // The guard lives here rather than inside the pass, so a deployment with no
  // object storage never schedules it while the pass itself stays callable
  // against an injected backend.
  if (!hasConfiguredStorageBackends()) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePreviewWrites();
    } catch (error) {
      console.error(
        "Preview write reconciliation pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  void run();
  const interval = setInterval(run, PREVIEW_WRITE_RECONCILE_INTERVAL_MS);
  interval.unref();
}
