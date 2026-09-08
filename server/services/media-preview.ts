import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { mediaAssets, mediaPreviewWrites } from "../db/app-schema";
import { db } from "../db/client";
import {
  issuedStillSize,
  planPreviewDerivation,
  previewObjectFitsCeiling,
  previewPixelsFitCeiling,
  previewPixelsWithinPlan,
  type PreviewCeilings,
  type PreviewSpec,
} from "../media/preview-derivation";
import {
  JPEG_HEADER_WINDOW_BYTES,
  readJpegPixelSize,
} from "../media/preview-image";
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
  /**
   * The backend whose preview namespace the prefix sweep enumerates: the one
   * this deployment writes to now. Separate from `storageForBackend` because
   * the sweep is not answering a question about a known key — it is asking a
   * whole backend what it holds.
   */
  configuredStorage: () => MultipartStorage;
};

const defaultDependencies: MediaPreviewDependencies = {
  storageForBackend: getMultipartStorage,
  configuredStorage: () => getMultipartStorage(),
};

type MediaAsset = typeof mediaAssets.$inferSelect;

/**
 * Every derived preview object lives directly under this one prefix.
 *
 * The layout is flat and global on purpose. A key used to carry the Atlas and
 * the Journey that owned it, which reads well but makes the namespace
 * un-enumerable: a sweep would have to know every Atlas id that ever existed
 * to look for objects belonging to Atlases that no longer do — exactly the
 * objects it is looking for. One prefix can be enumerated with no knowledge of
 * any tenant at all, and ownership is answered where it is actually
 * authoritative: `media_assets.preview_storage_key`.
 *
 * Nothing is lost in the move, because the key was never an authorization
 * input. Both read paths resolve the asset first — the owner read through
 * `requireAtlasAccess`, the guest read through the share grant — and sign the
 * key the row hands them. And the key still carries nothing about the
 * original: no name, no capture time, no coordinates, and now not even the
 * Journey it belongs to.
 */
export const PREVIEW_KEY_PREFIX = "previews/";

export type PreviewFailure = {
  ok: false;
  error:
    | "INVALID_PREVIEW_REQUEST"
    | "PREVIEW_UNSUPPORTED"
    | "PREVIEW_NOT_PENDING"
    | "PREVIEW_OBJECT_MISSING"
    | "PREVIEW_SUPERSEDED"
    | "PREVIEW_TOO_LARGE"
    | "PREVIEW_PIXELS_TOO_LARGE"
    | "PREVIEW_PIXELS_MISMATCH"
    | "PREVIEW_UNREADABLE";
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
  // #265: the issued pixel size belongs to the generation, so it goes when the
  // key that identifies that generation goes.
  previewWidth: null,
  previewHeight: null,
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
  const previewStorageKey = `${PREVIEW_KEY_PREFIX}${randomUUID()}`;
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
      // #265: recorded here, with the key, because this is the instruction the
      // producer about to hold that URL is issued. Completion compares against
      // it and never against a plan re-derived from a later config.
      previewWidth: spec.width,
      previewHeight: spec.height,
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
 * The produced object is inspected and READ rather than trusted, so both
 * ceilings are established from the bytes that arrived. A write that never
 * landed leaves the asset `pending`, because that is a retryable state and
 * turning a retryable fault into a permanent loss is exactly what #260
 * forbids. Four things are decided outcomes instead — a file over the byte
 * ceiling, a frame over the pixel ceiling, a frame larger than the still this
 * asset was planned, and bytes that are not a readable JPEG at all: the object
 * is dropped and the asset is `failed`, so nothing oversized, unplanned or
 * unreadable can ever be signed, whoever produced it.
 *
 * Only the frame header is read back, bounded by `JPEG_HEADER_WINDOW_BYTES`,
 * so the memory this path costs is the window rather than whatever
 * `MEDIA_PREVIEW_MAX_BYTES` a deployment allows.
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
  /**
   * One decided failure: clear this generation's columns and drop its object.
   *
   * Guarded by the key that was actually measured, exactly like the success
   * path below. Without that guard, a completion that measured generation A
   * would clear generation B out of a row a concurrent re-derivation had
   * already moved on, stranding B's object and leaving its producer holding an
   * upload URL it could never complete.
   */
  const rejectPreview = async (
    error:
      | "PREVIEW_TOO_LARGE"
      | "PREVIEW_PIXELS_TOO_LARGE"
      | "PREVIEW_PIXELS_MISMATCH"
      | "PREVIEW_UNREADABLE",
  ): Promise<PreviewFailure> => {
    const [cleared] = await db
      .update(mediaAssets)
      .set(CLEARED_PREVIEW)
      .where(stillHoldsGeneration(asset.id, asset.previewStorageKey))
      .returning({ id: mediaAssets.id });
    if (!cleared) {
      return { ok: false, error: "PREVIEW_NOT_PENDING", status: 409 };
    }
    await discardPreviewObject(
      asset.storageDriver,
      asset.previewStorageKey,
      dependencies,
    );
    return { ok: false, error, status: 409 };
  };

  if (!previewObjectFitsCeiling(inspected.bytes, ceilings)) {
    return rejectPreview("PREVIEW_TOO_LARGE");
  }

  // The pixel size, established from the object rather than from the spec.
  // Only the frame header is needed, so only a window of the object is asked
  // for; a read that comes back empty is the same retryable "nothing landed"
  // state the inspection above answers, not a decided failure.
  const stored = await storage.readObjectHead({
    key: asset.previewStorageKey,
    maxBytes: JPEG_HEADER_WINDOW_BYTES,
  });
  if (!stored.exists) {
    return { ok: false, error: "PREVIEW_OBJECT_MISSING", status: 409 };
  }
  const pixels = readJpegPixelSize(stored.bytes);
  if (!pixels) {
    return rejectPreview("PREVIEW_UNREADABLE");
  }
  if (!previewPixelsFitCeiling(pixels, ceilings)) {
    return rejectPreview("PREVIEW_PIXELS_TOO_LARGE");
  }
  // #265: and then against the still this generation's producer was ISSUED,
  // read from the row rather than re-derived. The two gates are deliberately
  // independent and both bind: the ceiling above is the deployment's current
  // safety policy, which a later config may tighten, and this is the earlier
  // instruction, which a later config may not widen. A row that cannot state
  // what it issued is refused rather than promoted unverified — fail closed,
  // since the object is about to become servable to a share guest.
  const issued = issuedStillSize(asset);
  if (!issued || !previewPixelsWithinPlan(pixels, issued)) {
    return rejectPreview("PREVIEW_PIXELS_MISMATCH");
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
 * How long after a preview write's own expiry its record is retired.
 *
 * A presigned signature is checked when the request starts, so past the
 * expiry no new PUT can begin. It says nothing about a PUT that began just
 * before it and is still streaming, which is why nothing here concludes that a
 * write has finished: the margin only makes the window this record describes a
 * closed one, and what a late write leaves behind is the namespace sweep's
 * job rather than this clock's.
 */
const PREVIEW_WRITE_GRACE_MS = 5 * 60 * 1_000;
const PREVIEW_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const PREVIEW_WRITE_BATCH_SIZE = 50;
/**
 * Pages of the preview namespace one pass enumerates before yielding.
 *
 * The sweep is a background pass over a whole bucket, so it is bounded per
 * pass and resumes from the provider's continuation token on the next one. A
 * namespace larger than this drains across several passes instead of holding
 * one pass open over tens of thousands of keys.
 */
const PREVIEW_NAMESPACE_PAGES_PER_PASS = 10;

/**
 * Retire the record of every preview write whose signature has closed.
 *
 * This pass is the prompt half of the contract: it knows the exact keys that
 * were issued, so a superseded generation, a begin that lost its swap, or a
 * write whose media, Journey or Atlas cascaded away is retired within minutes
 * rather than waiting for a bucket-wide enumeration.
 *
 * For each record past its expiry plus the grace margin:
 *
 *  - the key is referenced by an asset — the write completed and has a live
 *    owner, so the deletion paths take it from here and the record is dropped;
 *  - the key is not referenced — a superseded generation, a lost swap, or a
 *    cascade. Whatever is under it belongs to nobody, so it is deleted and the
 *    record is dropped. A delete of an absent key succeeds, so this covers the
 *    write that never landed as well as the one that did.
 *
 * Dropping the record of a write that may still be in flight is only sound
 * because it is not the last word. Nothing on this storage interface proves an
 * in-flight PUT has finished, and waiting out a fixed interval does not prove
 * it either — a slow enough request crosses any interval — so the previous
 * shape of this pass, which kept a record until its key had stayed empty for
 * half an hour, was a clock dressed as a proof. Keeping records forever
 * instead would trade a storage orphan for an unbounded Postgres one, since a
 * producer may begin a derivation and never write at all.
 * `reconcilePreviewNamespace` below closes it properly: a late object is
 * discoverable from the namespace itself long after every record that could
 * name it is gone, so a record may be forgotten freely.
 *
 * A failed storage delete keeps its record, so the prompt path retries a key
 * it still knows by name rather than handing it to a bucket-wide pass.
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

    if (referencing) {
      settled += 1;
    } else {
      const discarded = await discardPreviewObject(
        write.storageDriver,
        write.storageKey,
        dependencies,
      );
      if (!discarded) continue;
      retired += 1;
    }
    await db
      .delete(mediaPreviewWrites)
      .where(eq(mediaPreviewWrites.id, write.id));
  }
  return { examined: writes.length, retired, settled };
}

/**
 * Delete every object in the preview namespace that no asset references.
 *
 * This is the half that needs no records and no clock. It asks storage what is
 * actually under `PREVIEW_KEY_PREFIX` and deletes whatever nothing points at,
 * so an object that landed after its write record was forgotten — a PUT
 * authorised just before a Journey was deleted and still streaming well
 * afterwards — is found by a later pass and retired, however long it took to
 * arrive.
 *
 * The reference check is the whole authority, and it is terminal in one
 * direction only. An enumerated key cannot become referenced after the fact:
 * `beginAssetPreview` mints a fresh UUID and claims it before any producer
 * holds a URL for it, so a key with an object under it has already been
 * claimed, and a claim it has since lost it can never regain. "Nothing
 * references this" therefore stays true, which is why deletion may be driven
 * by that fact alone and never by how old an object is.
 *
 * One pass is bounded and resumable: it hands back the provider's continuation
 * token so the next pass carries on instead of restarting at the first page.
 */
export async function reconcilePreviewNamespace(
  continuationToken?: string,
  dependencies: MediaPreviewDependencies = defaultDependencies,
) {
  const storage = dependencies.configuredStorage();
  let cursor = continuationToken;
  let examined = 0;
  let retired = 0;

  for (let page = 0; page < PREVIEW_NAMESPACE_PAGES_PER_PASS; page += 1) {
    const listed = await storage.listObjects({
      prefix: PREVIEW_KEY_PREFIX,
      ...(cursor ? { continuationToken: cursor } : {}),
    });
    examined += listed.keys.length;
    if (listed.keys.length > 0) {
      const referenced = new Set(
        (
          await db
            .select({ key: mediaAssets.previewStorageKey })
            .from(mediaAssets)
            .where(inArray(mediaAssets.previewStorageKey, listed.keys))
        ).map((row) => row.key),
      );
      for (const key of listed.keys) {
        if (referenced.has(key)) continue;
        const discarded = await discardPreviewObject(
          storage.driver,
          key,
          dependencies,
        );
        if (discarded) retired += 1;
      }
    }
    cursor = listed.continuationToken;
    // The listing ran out. The next pass starts from the first page again,
    // which is what makes this a repeated contract and not a one-off cleanup.
    if (!cursor) break;
  }

  return { examined, retired, continuationToken: cursor };
}

export function startPreviewReconciler() {
  // The guard lives here rather than inside the passes, so a deployment with
  // no object storage never schedules them while the passes themselves stay
  // callable against an injected backend.
  if (!hasConfiguredStorageBackends()) return;
  let running = false;
  let namespaceCursor: string | undefined;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // The record pass runs first: it retires the keys it knows by name, so
      // the enumeration behind it has less to find.
      await reconcilePreviewWrites();
    } catch (error) {
      console.error(
        "Preview write reconciliation pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }
    try {
      namespaceCursor = (
        await reconcilePreviewNamespace(namespaceCursor)
      ).continuationToken;
    } catch (error) {
      // A failed listing leaves the cursor where it was, so the next pass
      // retries that page rather than skipping past it.
      console.error(
        "Preview namespace reconciliation pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }
    running = false;
  };
  void run();
  const interval = setInterval(run, PREVIEW_RECONCILE_INTERVAL_MS);
  interval.unref();
}
