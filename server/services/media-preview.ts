import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mediaAssets } from "../db/app-schema";
import { db } from "../db/client";
import {
  planPreviewDerivation,
  previewObjectFitsCeiling,
  type PreviewCeilings,
  type PreviewSpec,
} from "../media/preview-derivation";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";

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
 * Drop the object a preview column used to point at, once no row references it
 * any more. Best-effort on purpose, in the same spirit as the deduplicated
 * object cleanup in the upload pipeline: the row is already correct, so a
 * storage hiccup here costs an unreferenced object rather than a wrong answer.
 */
async function discardPreviewObject(
  storageDriver: string,
  storageKey: string | null,
  dependencies: MediaPreviewDependencies,
) {
  if (!storageKey) return;
  try {
    await dependencies.storageForBackend(storageDriver).deleteObject({
      key: storageKey,
    });
  } catch (error) {
    console.error(
      "Preview object cleanup failed",
      storageKey,
      error instanceof Error ? error.message : "unknown error",
    );
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
    await db
      .update(mediaAssets)
      .set(CLEARED_PREVIEW)
      .where(eq(mediaAssets.id, asset.id));
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
  await db
    .update(mediaAssets)
    .set({
      displayWidth: spec.displayWidth,
      displayHeight: spec.displayHeight,
      previewStorageKey,
      previewMimeType: spec.mimeType,
      previewBytes: null,
      previewState: "pending",
    })
    .where(eq(mediaAssets.id, asset.id));
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
      .where(and(
        eq(mediaAssets.id, asset.id),
        eq(mediaAssets.previewStorageKey, asset.previewStorageKey),
      ))
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
    .where(and(
      eq(mediaAssets.id, asset.id),
      eq(mediaAssets.previewStorageKey, asset.previewStorageKey),
    ))
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
