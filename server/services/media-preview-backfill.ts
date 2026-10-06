import { and, eq, inArray, isNull, like, lt, or } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { journeys, mediaAssets } from "../db/app-schema";
import { db } from "../db/client";
import { serverConfig } from "../config";
import type { PreviewCeilings, PreviewSpec } from "../media/preview-derivation";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  getMultipartStorage,
  hasConfiguredStorageBackends,
} from "../storage/storage-registry";
import {
  beginAssetPreview,
  completeAssetPreview,
  failAssetPreview,
  type MediaPreviewDependencies,
} from "./media-preview";

/**
 * Server-side preview production for originals the browser never finished.
 *
 * #260's design put the rasteriser in the browser, and the API stayed a
 * planner and a verifier that reads no pixels. That held until the browser
 * producer was found to have failed on every upload since #305, which left
 * every image uploaded before the fix as an original with no preview, and
 * Playback stalling on each of them. The owner's decision (2026-10-06) is that
 * the server decodes pixels for THIS job only: a slow, bounded sweep that gives
 * stuck originals the still they were planned.
 *
 * The sweep deliberately reuses the browser protocol end to end — begin, a
 * signed single-object write, complete — rather than writing the preview
 * columns itself. Every invariant (one live generation per asset, the write
 * record for the namespace sweep, both ceilings measured on the landed object)
 * stays in `media-preview.ts`, and a producer that is mid-flight in a browser
 * loses or wins the same compare-and-swap it always did.
 */

type MediaAsset = typeof mediaAssets.$inferSelect;

export type PreviewBackfillDependencies = MediaPreviewDependencies & {
  /** The PUT to the signed URL; injectable so a test can land the body in its fake store. */
  fetch: typeof fetch;
  now: () => Date;
};

const defaultDependencies: PreviewBackfillDependencies = {
  storageForBackend: getMultipartStorage,
  configuredStorage: () => getMultipartStorage(),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

/** Fresh uploads keep first claim: the browser producer runs right after completion. */
export const PREVIEW_BACKFILL_MIN_AGE_MS = 10 * 60 * 1_000;
export const PREVIEW_BACKFILL_BATCH_SIZE = 8;
/** An original above this is not decoded here; phones do not produce them. */
export const PREVIEW_BACKFILL_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const PREVIEW_BACKFILL_INTERVAL_MS = 5 * 60 * 1_000;
/** Same ladder the browser producer walks, so byte ceilings bite identically. */
const JPEG_QUALITY_LADDER = [82, 70, 58, 46, 34, 24, 16, 10];

export type PreviewBackfillOutcome =
  | "ready"
  | "failed"
  | "skipped"
  | "superseded";

export function previewCeilingsFromConfig(): PreviewCeilings {
  return {
    maxEdgePixels: serverConfig.mediaPreviewMaxEdgePixels,
    maxBytes: serverConfig.mediaPreviewMaxBytes,
  };
}

/**
 * Image assets that never reached a servable preview: `none` (uploaded before
 * previews existed) and `pending` (a producer began and never completed).
 * Media whose Journey is marked for deletion is left alone; the deletion
 * reconciler owns it. Everyday Fragment media has no Journey and is included.
 */
export async function listPreviewBackfillCandidates(
  now: Date,
  limit = PREVIEW_BACKFILL_BATCH_SIZE,
): Promise<MediaAsset[]> {
  const cutoff = new Date(now.getTime() - PREVIEW_BACKFILL_MIN_AGE_MS);
  const rows = await db
    .select({ asset: mediaAssets })
    .from(mediaAssets)
    .leftJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
    .where(
      and(
        like(mediaAssets.mimeType, "image/%"),
        inArray(mediaAssets.previewState, ["none", "pending"]),
        lt(mediaAssets.createdAt, cutoff),
        or(isNull(mediaAssets.journeyId), isNull(journeys.deletionStartedAt)),
      ),
    )
    .orderBy(mediaAssets.createdAt)
    .limit(limit);
  return rows.map((row) => row.asset);
}

async function renderWithinBudget(
  original: Uint8Array,
  spec: PreviewSpec,
): Promise<Buffer | null> {
  for (const quality of JPEG_QUALITY_LADDER) {
    const rendered = await sharp(original)
      // EXIF orientation is applied here, so the still is upright and its
      // encoded size is the display size the plan was made from.
      .rotate()
      .resize({
        width: spec.width,
        height: spec.height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality })
      .toBuffer();
    if (rendered.byteLength <= spec.maxBytes) return rendered;
  }
  return null;
}

async function readOriginal(
  storage: MultipartStorage,
  asset: MediaAsset,
): Promise<Uint8Array | "missing" | "oversized"> {
  const stored = await storage.readObjectHead({
    key: asset.storageKey,
    maxBytes: PREVIEW_BACKFILL_SOURCE_MAX_BYTES,
  });
  if (!stored.exists) return "missing";
  // The window is inclusive of the bound: a read that fills it may have been
  // cut, and a truncated JPEG must not be decoded as if it were whole.
  if (stored.bytes.byteLength >= PREVIEW_BACKFILL_SOURCE_MAX_BYTES) return "oversized";
  return stored.bytes;
}

/**
 * Derive one asset's preview on the server. Returns what happened so a pass
 * can log a summary; nothing here throws for a decided outcome.
 */
export async function backfillAssetPreview(
  asset: MediaAsset,
  ceilings: PreviewCeilings,
  dependencies: PreviewBackfillDependencies = defaultDependencies,
): Promise<PreviewBackfillOutcome> {
  const storage = dependencies.storageForBackend(asset.storageDriver);
  const original = await readOriginal(storage, asset);
  if (original === "missing") {
    console.error("Preview backfill: original object is missing", asset.id);
    return "skipped";
  }
  if (original === "oversized") {
    await failAssetPreview(asset, dependencies);
    return "failed";
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(original).metadata();
  } catch (error) {
    console.error(
      "Preview backfill: original could not be decoded",
      asset.id,
      error instanceof Error ? error.message : "unknown error",
    );
    await failAssetPreview(asset, dependencies);
    return "failed";
  }
  if (!metadata.width || !metadata.height) {
    await failAssetPreview(asset, dependencies);
    return "failed";
  }

  const begun = await beginAssetPreview(
    asset,
    {
      // Stored pixel axes plus the EXIF tag, exactly what a browser reports
      // before presentation; `planPreviewDerivation` applies the swap.
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      exifOrientation: metadata.orientation ?? null,
    },
    ceilings,
    serverConfig.mediaPreviewUploadExpiresInSeconds,
    dependencies,
  );
  if (!begun.ok) {
    // PREVIEW_UNSUPPORTED already cleared the row to `failed`; a lost swap
    // means another producer owns this asset now.
    return begun.error === "PREVIEW_UNSUPPORTED" ? "failed" : "superseded";
  }

  const rendered = await renderWithinBudget(original, begun.preview);
  if (!rendered) {
    const [claimed] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, asset.id))
      .limit(1);
    if (claimed) await failAssetPreview(claimed, dependencies);
    return "failed";
  }

  const written = await dependencies.fetch(begun.upload.url, {
    method: "PUT",
    headers: begun.upload.headers,
    body: new Uint8Array(rendered),
  });
  if (!written.ok) {
    // The write record and the pending row are exactly what the namespace
    // sweep and a later pass expect; nothing is cleared for a transient store.
    console.error("Preview backfill: preview write failed", asset.id, written.status);
    return "skipped";
  }

  const [claimed] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, asset.id))
    .limit(1);
  if (!claimed) return "superseded";
  const completed = await completeAssetPreview(claimed, ceilings, dependencies);
  if (completed.ok) return "ready";
  return completed.error === "PREVIEW_NOT_PENDING" || completed.error === "PREVIEW_SUPERSEDED"
    ? "superseded"
    : "failed";
}

export async function runPreviewBackfillPass(
  dependencies: PreviewBackfillDependencies = defaultDependencies,
  ceilings: PreviewCeilings = previewCeilingsFromConfig(),
) {
  const candidates = await listPreviewBackfillCandidates(dependencies.now());
  const summary: Record<PreviewBackfillOutcome, number> = {
    ready: 0,
    failed: 0,
    skipped: 0,
    superseded: 0,
  };
  for (const asset of candidates) {
    try {
      summary[await backfillAssetPreview(asset, ceilings, dependencies)] += 1;
    } catch (error) {
      summary.skipped += 1;
      console.error(
        "Preview backfill: asset pass failed",
        asset.id,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  if (candidates.length > 0) {
    console.info(
      `Preview backfill: ${candidates.length} candidate(s); ready=${summary.ready} failed=${summary.failed} skipped=${summary.skipped} superseded=${summary.superseded}`,
    );
  }
  return { candidates: candidates.length, ...summary };
}

export function startPreviewBackfill() {
  if (!serverConfig.mediaPreviewBackfillEnabled) return;
  if (!hasConfiguredStorageBackends()) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runPreviewBackfillPass();
    } catch (error) {
      console.error(
        "Preview backfill pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  void run();
  const interval = setInterval(run, PREVIEW_BACKFILL_INTERVAL_MS);
  interval.unref();
}
