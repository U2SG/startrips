import { parseRecordedEvidenceDocument } from "./media-evidence";
import type { MultipartPart } from "../storage/multipart-storage";
import type { PreviewSourceValues } from "../services/media-preview";

export const PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2_000_000_000;
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_REORDER_ASSETS = 256;
export const MAX_MOVE_UNDO_ORDER = 10_000;

export function moveUndoOrdersFitLimit(...orders: readonly string[][]) {
  return orders.every((order) => order.length <= MAX_MOVE_UNDO_ORDER);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ALLOWED_MIME_TYPES = new Set([
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
  recordedEvidence?: unknown;
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

  // #428: the optional recorded evidence this upload carries, normalized by
  // the one evidence parser the server already owns. It is metadata about the
  // bytes and never a source of authority: the Atlas, Journey and Route Point
  // this upload may touch are still decided entirely by the fields above.
  const recordedEvidence = body.recordedEvidence === undefined
    || body.recordedEvidence === null
    ? null
    : (parseRecordedEvidenceDocument(body.recordedEvidence) ?? "invalid");

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
    contentHash === "invalid" ||
    recordedEvidence === "invalid"
  ) {
    return null;
  }

  return {
    journeyId,
    routePointId,
    fileName,
    mimeType,
    bytes,
    partCount,
    contentHash,
    recordedEvidence,
  };
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

export function mediaOrderAfterMove(
  existingOrder: readonly string[],
  assetIds: readonly string[],
) {
  const moving = new Set(assetIds);
  return [
    ...existingOrder.filter((id) => !moving.has(id)),
    ...existingOrder.filter((id) => moving.has(id)),
  ];
}

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
  targetRoutePointId: string | null;
  sourceOrder: string[];
  targetOrder: string[];
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
    || !(body.targetRoutePointId === null || typeof body.targetRoutePointId === "string")
    || (typeof body.targetRoutePointId === "string" && !UUID_PATTERN.test(body.targetRoutePointId))
    || !Array.isArray(body.assetIds)
    || body.assetIds.length < 1
    || body.assetIds.length > MAX_REORDER_ASSETS
    || !Array.isArray(body.sourceOrder)
    || body.sourceOrder.length < body.assetIds.length
    || body.sourceOrder.length > MAX_MOVE_UNDO_ORDER
    || !Array.isArray(body.targetOrder)
    || body.targetOrder.length < body.assetIds.length
    || body.targetOrder.length > MAX_MOVE_UNDO_ORDER
    || !Array.isArray(body.placements)
    || body.placements.length !== body.assetIds.length
    || !(body.sourceCoverMediaAssetId === null || typeof body.sourceCoverMediaAssetId === "string")
    || (typeof body.sourceCoverMediaAssetId === "string" && !UUID_PATTERN.test(body.sourceCoverMediaAssetId))
  ) return null;

  const assetIds = [...body.assetIds];
  const sourceOrder = [...body.sourceOrder];
  const targetOrder = [...body.targetOrder];
  if (
    assetIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || sourceOrder.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || targetOrder.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || new Set(assetIds).size !== assetIds.length
    || new Set(sourceOrder).size !== sourceOrder.length
    || new Set(targetOrder).size !== targetOrder.length
    || assetIds.some((id) => !sourceOrder.includes(id) || !targetOrder.includes(id))
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
    targetRoutePointId: body.targetRoutePointId ?? null,
    sourceOrder,
    targetOrder,
    sourceCoverMediaAssetId: body.sourceCoverMediaAssetId ?? null,
    placements: assetIds.map((assetId) => ({ assetId, routePointId: placementByAsset.get(assetId) ?? null })),
  };
}

type UndoMoveMediaInput = {
  journeyId?: unknown;
  expectedRoutePointId?: unknown;
  assignments?: unknown;
  assetOrder?: unknown;
};

type UndoMoveAssignment = {
  assetId: string;
  routePointId: string | null;
};

export function parseUndoMoveMediaInput(body: UndoMoveMediaInput) {
  const journeyId = typeof body.journeyId === "string" ? body.journeyId : "";
  const expectedRoutePointId = body.expectedRoutePointId === undefined || body.expectedRoutePointId === null
    ? null
    : typeof body.expectedRoutePointId === "string"
      ? body.expectedRoutePointId
      : "invalid";
  if (
    !UUID_PATTERN.test(journeyId)
    || expectedRoutePointId === "invalid"
    || (expectedRoutePointId !== null && !UUID_PATTERN.test(expectedRoutePointId))
    || !Array.isArray(body.assignments)
    || body.assignments.length < 1
    || body.assignments.length > MAX_REORDER_ASSETS
    || !Array.isArray(body.assetOrder)
    || body.assetOrder.length < 1
    || body.assetOrder.length > MAX_MOVE_UNDO_ORDER
  ) return null;

  const assignments: UndoMoveAssignment[] = [];
  for (const raw of body.assignments) {
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw as { assetId?: unknown; routePointId?: unknown };
    if (typeof candidate.assetId !== "string" || !UUID_PATTERN.test(candidate.assetId)) return null;
    const routePointId = candidate.routePointId === undefined || candidate.routePointId === null
      ? null
      : typeof candidate.routePointId === "string"
        ? candidate.routePointId
        : "invalid";
    if (routePointId === "invalid" || (routePointId !== null && !UUID_PATTERN.test(routePointId))) return null;
    assignments.push({ assetId: candidate.assetId, routePointId });
  }
  if (new Set(assignments.map((assignment) => assignment.assetId)).size !== assignments.length) return null;

  const assetOrder: string[] = [];
  for (const raw of body.assetOrder) {
    if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) return null;
    assetOrder.push(raw);
  }
  if (new Set(assetOrder).size !== assetOrder.length) return null;
  if (assignments.some((assignment) => !assetOrder.includes(assignment.assetId))) return null;

  return { journeyId, expectedRoutePointId, assignments, assetOrder };
}

type PreviewRequest = {
  sourceWidth?: unknown;
  sourceHeight?: unknown;
  exifOrientation?: unknown;
};

/**
 * The only three things a producer is allowed to say about the source. Shape
 * only: whether the numbers describe a real image is
 * `planPreviewDerivation`'s decision, so there is exactly one place that knows
 * what a derivable source is.
 */
export function readPreviewRequest(
  parsed: unknown,
): PreviewSourceValues | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as PreviewRequest;
  const exifOrientation = body.exifOrientation;
  if (
    typeof body.sourceWidth !== "number"
    || typeof body.sourceHeight !== "number"
    || (exifOrientation !== undefined
      && exifOrientation !== null
      && typeof exifOrientation !== "number")
  ) {
    return null;
  }
  return {
    sourceWidth: body.sourceWidth,
    sourceHeight: body.sourceHeight,
    exifOrientation: (exifOrientation ?? null) as number | null,
  };
}
