import { and, eq, isNull, like, lt, notInArray, or } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { journeys, mediaAssets, mediaPreviewWrites } from "../db/app-schema";
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
/**
 * One page of candidates. A pass drains page after page until the queue is
 * empty or `MEDIA_PREVIEW_BACKFILL_PASS_LIMIT` is reached; one asset costs the
 * API well under a second (a bounded download plus one `sharp` resize), so the
 * page size only bounds how much is held in memory at once, not the pace.
 */
export const PREVIEW_BACKFILL_BATCH_SIZE = 8;
/** An original above this is not decoded here; phones do not produce them. */
export const PREVIEW_BACKFILL_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
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
 * Image assets that never reached a servable preview.
 *
 * `none` (uploaded before previews existed) is stale by the asset's own age.
 * `pending` is stale by the age of its CURRENT generation, not the asset's: a
 * duplicate upload deduplicates onto an old asset and the browser begins a
 * fresh preview for it seconds later, and that live generation must keep its
 * claim. The generation's clock is its `media_preview_writes` record — issued
 * by `beginAssetPreview` with the key — so a pending row is a candidate only
 * once that record has expired past the grace, or no longer exists (the write
 * reconciler retires expired records well after any producer could still be
 * completing against them).
 *
 * Media whose Journey is marked for deletion is left alone; the deletion
 * reconciler owns it. Everyday Fragment media has no Journey and is included.
 */
export async function listPreviewBackfillCandidates(
  now: Date,
  limit = PREVIEW_BACKFILL_BATCH_SIZE,
  /** Assets this pass already attempted; a skipped one stays a candidate and must not be re-selected within the pass. */
  excludeIds: readonly string[] = [],
): Promise<MediaAsset[]> {
  const cutoff = new Date(now.getTime() - PREVIEW_BACKFILL_MIN_AGE_MS);
  const rows = await db
    .select({ asset: mediaAssets })
    .from(mediaAssets)
    .leftJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
    .leftJoin(
      mediaPreviewWrites,
      eq(mediaPreviewWrites.storageKey, mediaAssets.previewStorageKey),
    )
    .where(
      and(
        like(mediaAssets.mimeType, "image/%"),
        excludeIds.length > 0 ? notInArray(mediaAssets.id, [...excludeIds]) : undefined,
        or(isNull(mediaAssets.journeyId), isNull(journeys.deletionStartedAt)),
        or(
          and(eq(mediaAssets.previewState, "none"), lt(mediaAssets.createdAt, cutoff)),
          and(
            eq(mediaAssets.previewState, "pending"),
            or(isNull(mediaPreviewWrites.id), lt(mediaPreviewWrites.expiresAt, cutoff)),
          ),
        ),
      ),
    )
    .orderBy(mediaAssets.createdAt)
    .limit(limit);
  return rows.map((row) => row.asset);
}

/**
 * `null` when no quality fits the byte ceiling; throws when the pixel payload
 * does not decode. The two are both decided failures for the caller, but a
 * decode error is worth its own log line because `metadata()` succeeding on
 * a truncated file is exactly how a corrupt original gets this far.
 */
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
    switch (begun.error) {
      case "PREVIEW_UNSUPPORTED":
        // Already cleared to `failed` by begin.
        return "failed";
      case "INVALID_PREVIEW_REQUEST":
        // These dimensions came from the stored object, not from a request,
        // so the condition is permanent: record it instead of re-downloading
        // and re-measuring the same original every pass.
        console.error("Preview backfill: original has unplannable dimensions", asset.id, metadata.width, metadata.height);
        return (await failAssetPreview(asset, dependencies)) ? "failed" : "superseded";
      default:
        // A lost swap: another producer owns this asset now.
        return "superseded";
    }
  }

  // The generation THIS pass claimed, built from what begin issued rather than
  // read back from the row. Every write below is a compare-and-swap on this
  // key, so if a browser producer supersedes it meanwhile, the row is left
  // exactly as that producer set it and this pass reports `superseded`.
  const claimed: MediaAsset = {
    ...asset,
    displayWidth: begun.preview.displayWidth,
    displayHeight: begun.preview.displayHeight,
    previewStorageKey: begun.storageKey,
    previewMimeType: begun.preview.mimeType,
    previewBytes: null,
    previewWidth: begun.preview.width,
    previewHeight: begun.preview.height,
    previewState: "pending",
  };

  let rendered: Buffer | null;
  try {
    rendered = await renderWithinBudget(original, begun.preview);
  } catch (error) {
    console.error(
      "Preview backfill: original pixels could not be decoded",
      asset.id,
      error instanceof Error ? error.message : "unknown error",
    );
    rendered = null;
  }
  if (!rendered) {
    return (await failAssetPreview(claimed, dependencies)) ? "failed" : "superseded";
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

  const completed = await completeAssetPreview(claimed, ceilings, dependencies);
  if (completed.ok) return "ready";
  return completed.error === "PREVIEW_NOT_PENDING" || completed.error === "PREVIEW_SUPERSEDED"
    ? "superseded"
    : "failed";
}

/**
 * Drain the queue: page through candidates until none are left or the pass
 * limit is reached. Every attempted asset is excluded from the pass's later
 * pages, because a `skipped` outcome (a missing original, a transient store
 * error) leaves the row a candidate and would otherwise be re-selected by the
 * very next page.
 */
export async function runPreviewBackfillPass(
  dependencies: PreviewBackfillDependencies = defaultDependencies,
  ceilings: PreviewCeilings = previewCeilingsFromConfig(),
  passLimit: number = serverConfig.mediaPreviewBackfillPassLimit,
) {
  const summary: Record<PreviewBackfillOutcome, number> = {
    ready: 0,
    failed: 0,
    skipped: 0,
    superseded: 0,
  };
  const attempted: string[] = [];
  while (attempted.length < passLimit) {
    const page = await listPreviewBackfillCandidates(
      dependencies.now(),
      Math.min(PREVIEW_BACKFILL_BATCH_SIZE, passLimit - attempted.length),
      attempted,
    );
    if (page.length === 0) break;
    for (const asset of page) {
      attempted.push(asset.id);
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
  }
  if (attempted.length > 0) {
    console.info(
      `Preview backfill: ${attempted.length} candidate(s); ready=${summary.ready} failed=${summary.failed} skipped=${summary.skipped} superseded=${summary.superseded}`,
    );
  }
  return { candidates: attempted.length, ...summary };
}

/**
 * The interval is a rest BETWEEN passes, so the next pass is scheduled only
 * after the current one has finished. A fixed `setInterval` would keep its
 * ticks aligned to process start, and a long draining pass that ended just
 * before a tick would get no rest before the next one.
 */
export function startPreviewBackfill() {
  if (!serverConfig.mediaPreviewBackfillEnabled) return;
  if (!hasConfiguredStorageBackends()) return;
  const restMs = serverConfig.mediaPreviewBackfillIntervalSeconds * 1_000;
  const run = async () => {
    try {
      await runPreviewBackfillPass();
    } catch (error) {
      console.error(
        "Preview backfill pass failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      setTimeout(() => void run(), restMs).unref();
    }
  };
  void run();
}
