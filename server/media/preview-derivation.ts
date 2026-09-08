/**
 * #260: the derivation of one Route Point Media preview, as pure arithmetic.
 *
 * The server decides what the preview IS. Given the source pixel size and the
 * source's EXIF orientation it produces a spec — the orientation-corrected
 * display size, the exact pixel size of the still to produce, its format and
 * the byte ceiling it must respect — and the producer is an executor with no
 * latitude. Nothing downstream may widen that spec: `POST .../preview` signs a
 * single-object write for exactly this plan, and `POST .../preview/complete`
 * measures the produced object against `maxBytes` before the preview is ever
 * marked ready, so an oversized still cannot be served whoever produced it.
 *
 * Both ceilings are checked against the object that actually landed, not
 * against the plan: `POST .../preview/complete` measures the produced object's
 * byte size and reads it back to establish its encoded pixel size, so neither
 * an oversized file nor an oversized frame can reach `ready` whoever produced
 * it. The spec is what the server asks for; `MEDIA_PREVIEW_MAX_BYTES` and
 * `MEDIA_PREVIEW_MAX_EDGE_PIXELS` are what it enforces.
 *
 * Keeping the decision here, rather than inside the route, is what makes the
 * ceilings assertable on a pinned input with no storage, no database and no
 * network — which is the only place CI can assert them, since the `core` lane
 * runs with `STORAGE_DRIVER=disabled` and holds no object bytes at all.
 *
 * This module deliberately reads no pixels. Transcoding a photograph, and
 * still more decoding a video frame, needs a codec this deployment does not
 * carry, and #260 forbids taking on a third-party media service to get one.
 * Under the issue's own delegation ("字段由后端在现有模型上确定") the split is:
 * the backend owns the model, the contract, the ceilings and the lifecycle;
 * the pixels are rasterised where a decoder for both photographs and video
 * frames already exists.
 */

/**
 * Whether a produced still's encoded pixel size is inside the ceiling.
 *
 * The longest edge is what bounds a decode, so a portrait and a landscape
 * still are measured the same way — the same test `planPreviewDerivation`
 * applies to the size it asks for, applied here to the size that arrived.
 */
export function previewPixelsFitCeiling(
  pixels: { width: number; height: number },
  ceilings: PreviewCeilings,
): boolean {
  return Math.max(pixels.width, pixels.height) <= ceilings.maxEdgePixels;
}

/**
 * The lifecycle of the derived object beside an asset.
 *
 * - `none` — no preview was ever asked for. Every asset predating #260.
 * - `pending` — a spec was issued and the still is being produced or written.
 * - `ready` — an object exists, was measured, and may be signed.
 * - `failed` — this asset will not get a preview: an unsupported source, or a
 *   produced object that broke a ceiling. It is not a permanent loss of the
 *   media — the original keeps reading through the unchanged contract — and a
 *   later `POST .../preview` may still move the asset out of it.
 */
export const PREVIEW_STATES = ["none", "pending", "ready", "failed"] as const;

export type PreviewState = (typeof PREVIEW_STATES)[number];

export function isPreviewState(value: string): value is PreviewState {
  return (PREVIEW_STATES as readonly string[]).includes(value);
}

/**
 * One format, chosen by the server rather than negotiated.
 *
 * A fixed output is what makes the spec exactly reproducible: two producers
 * handed the same source cannot disagree about what they were asked for, and
 * the completion check compares against one known encoding. JPEG is the only
 * format every producer of both a photograph and a video frame can write.
 */
export const PREVIEW_MIME_TYPE = "image/jpeg";

/** Source kinds a still can be derived from at all. */
const PREVIEWABLE_SOURCE_PREFIXES = ["image/", "video/"] as const;

/**
 * A source dimension larger than this is not a photograph, it is a mistake or
 * a probe. The bound exists so the scale arithmetic below is never handed a
 * value whose square overflows anything.
 */
const MAX_SOURCE_EDGE_PIXELS = 100_000;

export type PreviewCeilings = {
  maxEdgePixels: number;
  maxBytes: number;
};

export type PreviewSource = {
  mimeType: string;
  sourceWidth: number;
  sourceHeight: number;
  /** EXIF orientation 1-8; 1 (or absent) means the pixels are already upright. */
  exifOrientation?: number | null;
};

export type PreviewSpec = {
  /** The asset's presentable size, EXIF orientation already applied. */
  displayWidth: number;
  displayHeight: number;
  /** The exact pixel size of the still to produce. */
  width: number;
  height: number;
  mimeType: typeof PREVIEW_MIME_TYPE;
  maxBytes: number;
};

export type PreviewPlan =
  | { ok: true; spec: PreviewSpec }
  /** The request was not describable: a size or an orientation that is not one. */
  | { ok: false; reason: "invalid-source" }
  /** Describable, but nothing can be derived from this kind of source. */
  | { ok: false; reason: "unsupported-source" };

function isPositiveDimension(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_SOURCE_EDGE_PIXELS;
}

/**
 * EXIF orientations 5-8 store the image rotated a quarter turn, so the stored
 * pixel grid is the transpose of what a viewer must see. Everything else
 * (mirrors and the half turn) keeps the axes as they are.
 */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * One scaled edge: rounded to the nearest pixel, never below one and never
 * above the ceiling.
 *
 * Rounding rather than truncating is what keeps the aspect ratio honest — the
 * scale factor is a binary fraction, so flooring turns a shorter edge that
 * lands on 48.000000000000004 into 47 and visibly reshapes the frame. The
 * clamp is the guarantee the rounding cannot break: the longest edge rounds to
 * exactly the ceiling by construction, and `Math.min` makes that true for any
 * ceiling, not just the ones that divide evenly.
 */
function clampEdge(value: number, maxEdgePixels: number): number {
  return Math.max(1, Math.min(maxEdgePixels, Math.round(value)));
}

/**
 * Plan the derived still, or say why there is none.
 *
 * Each edge is scaled through `clampEdge`, so the result never exceeds
 * `maxEdgePixels` in either direction and a very thin source still yields a
 * real image. A source already inside the ceiling is planned at its own size: a preview is a bound, not a mandatory resample, and upscaling
 * would spend bytes inventing detail the original does not have.
 */
export function planPreviewDerivation(
  source: PreviewSource,
  ceilings: PreviewCeilings,
): PreviewPlan {
  const orientation = source.exifOrientation ?? 1;
  if (
    !isPositiveDimension(source.sourceWidth)
    || !isPositiveDimension(source.sourceHeight)
    || !Number.isInteger(orientation)
    || orientation < 1
    || orientation > 8
  ) {
    return { ok: false, reason: "invalid-source" };
  }
  if (
    !PREVIEWABLE_SOURCE_PREFIXES.some((prefix) =>
      source.mimeType.startsWith(prefix)
    )
  ) {
    return { ok: false, reason: "unsupported-source" };
  }

  const swap = orientationSwapsAxes(orientation);
  const displayWidth = swap ? source.sourceHeight : source.sourceWidth;
  const displayHeight = swap ? source.sourceWidth : source.sourceHeight;

  const longestEdge = Math.max(displayWidth, displayHeight);
  const scale = longestEdge > ceilings.maxEdgePixels
    ? ceilings.maxEdgePixels / longestEdge
    : 1;
  const width = clampEdge(displayWidth * scale, ceilings.maxEdgePixels);
  const height = clampEdge(displayHeight * scale, ceilings.maxEdgePixels);

  return {
    ok: true,
    spec: {
      displayWidth,
      displayHeight,
      width,
      height,
      mimeType: PREVIEW_MIME_TYPE,
      maxBytes: ceilings.maxBytes,
    },
  };
}

/**
 * #265: the still THIS generation's producer was issued, as the row records it.
 *
 * `POST .../preview` writes the planned pixel size beside the storage key that
 * identifies the generation, so completion reads an instruction rather than
 * reconstructing one. Reconstruction was the defect: the plan is a function of
 * the display size AND `MEDIA_PREVIEW_MAX_EDGE_PIXELS`, so a ceiling raised
 * between begin and completion — a rolling deployment is enough — would
 * re-derive a larger plan and retroactively widen what an already-issued
 * producer was authorized to create. The asymmetry is the point: a later
 * policy may tighten what is servable, through the live ceiling gate that
 * still applies independently, but it may not rewrite an earlier generation's
 * instructions. It is the same rule `previewStorageKey` already enforces —
 * newer state supersedes a generation, it does not redefine one.
 *
 * `null` means the row cannot state what it issued. Nothing can be verified
 * against that, and the caller refuses rather than promoting an unverified
 * object.
 */
export function issuedStillSize(
  columns: { previewWidth: number | null; previewHeight: number | null },
): { width: number; height: number } | null {
  const { previewWidth, previewHeight } = columns;
  if (previewWidth === null || previewHeight === null) return null;
  if (previewWidth < 1 || previewHeight < 1) return null;
  return { width: previewWidth, height: previewHeight };
}

/**
 * Whether a produced still is inside the still that was issued.
 *
 * The ceiling above bounds the longest edge, so it bounds a decode's cost at
 * the ceiling SQUARED however small the still the server actually asked for.
 * This bounds it at the issued area instead: a presigned PUT binds only the
 * content type, so a producer handed a spec for a 320x240 still can write a
 * highly compressible 640x640 one that is under every byte ceiling and pass
 * the pixel ceiling untouched, and a share guest then pays the decode.
 *
 * Neither edge may EXCEED the issued size, and equality is deliberately not
 * required. The contract is a bound, not an encoder specification: a producer
 * that rounds a scaled edge one pixel differently, or hands back a source
 * already smaller than the plan rather than upscaling it, has broken nothing a
 * reader can see. That boundary is the one #263's review settled for the
 * ceilings, applied here to the issued plan.
 */
export function previewPixelsWithinPlan(
  pixels: { width: number; height: number },
  issued: { width: number; height: number },
): boolean {
  return pixels.width <= issued.width && pixels.height <= issued.height;
}

/** The completion gate: what was actually written, against the plan's ceiling. */
export function previewObjectFitsCeiling(
  bytes: number,
  ceilings: PreviewCeilings,
): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= ceilings.maxBytes;
}

/**
 * The preview half of a read-url response.
 *
 * `width` and `height` are the asset's orientation-corrected DISPLAY size, not
 * the still's own pixel size, because that is the number a reader needs: the
 * frame the preview and the original both occupy, so the handover between them
 * cannot move or reshape anything. The still's pixel size is an artefact of
 * the ceiling and is deliberately not part of the contract.
 *
 * There is no field here derived from the original file: no name, no path, no
 * capture time, no coordinates. #260 requires that the derived resource carry
 * no EXIF, GPS or local path, and the shape is the enforcement.
 */
export type MediaPreviewRead = {
  url: string;
  expiresAt: string;
  mimeType: string;
  width: number;
  height: number;
};

/** The stored columns a preview read needs, as read back from `media_assets`. */
export type PreviewColumns = {
  previewStorageKey: string | null;
  previewMimeType: string | null;
  previewState: string;
  displayWidth: number | null;
  displayHeight: number | null;
};

/**
 * A preview is servable only when every part of it is present and ready.
 *
 * A `ready` row missing a key or a display size would be a contradiction, and
 * the honest answer to a contradiction is no preview rather than a guess: the
 * caller omits the block and the original read is untouched.
 */
export function servablePreview(
  columns: PreviewColumns,
): { storageKey: string; mimeType: string; width: number; height: number } | null {
  if (columns.previewState !== "ready") return null;
  if (!columns.previewStorageKey || !columns.previewMimeType) return null;
  if (columns.displayWidth === null || columns.displayHeight === null) {
    return null;
  }
  return {
    storageKey: columns.previewStorageKey,
    mimeType: columns.previewMimeType,
    width: columns.displayWidth,
    height: columns.displayHeight,
  };
}
