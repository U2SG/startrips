import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PrivateMediaRead } from "../../src/journey/types";
import { db } from "../db/client";
import { journeyRoutePoints, mediaAssets, journeys } from "../db/app-schema";
import { servablePreview } from "../media/preview-derivation";
import {
  ALLOWED_MIME_TYPES,
  mediaOrderAfterMove,
  moveUndoOrdersFitLimit,
  type MediaMoveUndo,
  type parseMoveMediaInput,
  type parseReorderInput,
  type parseUndoMoveMediaInput,
} from "../media/upload-protocol";
import { getJourneyForAtlas, getJourneysForAtlas, lockActiveJourney } from "../repositories/journey-repository";
import { writeJourneyMediaOrder } from "../repositories/media-order";
import { getMultipartStorage } from "../storage/storage-registry";
import type { MultipartStorage } from "../storage/multipart-storage";

/**
 * #260: sign the owner read of one asset, and its preview when there is one.
 *
 * The original is signed first and is never conditional: whatever happens to
 * the preview, this function either returns the original or throws the same
 * `StorageUnavailableError` the route threw before #260, so a preview can
 * neither add a failure mode nor change an existing one.
 *
 * The preview signature, by contrast, is best-effort by construction. A
 * preview is an optimisation over an original that already works, so a backend
 * that cannot sign the derived key must produce a response without the block
 * rather than an error: the alternative would let a stale or unreachable
 * derived object take down a read of media that is perfectly available.
 *
 * `resolveStorage` is injectable for tests only, the same seam
 * `signSharedMediaRead` uses; the route always passes the real registry.
 */
export async function signPrivateMediaRead(
  asset: typeof mediaAssets.$inferSelect,
  expiresInSeconds: number,
  resolveStorage: (driver: string) => MultipartStorage = getMultipartStorage,
): Promise<PrivateMediaRead> {
  const storage = resolveStorage(asset.storageDriver);
  const signed = await storage.createPrivateReadUrl({
    key: asset.storageKey,
    expiresInSeconds,
  });
  const read: PrivateMediaRead = {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
  };

  const preview = servablePreview(asset);
  if (!preview) return read;
  try {
    const signedPreview = await storage.createPrivateReadUrl({
      key: preview.storageKey,
      expiresInSeconds,
    });
    read.preview = {
      url: signedPreview.url,
      expiresAt: signedPreview.expiresAt.toISOString(),
      mimeType: preview.mimeType,
      width: preview.width,
      height: preview.height,
    };
  } catch (error) {
    console.error(
      "Preview read URL signing failed",
      asset.id,
      error instanceof Error ? error.message : "unknown error",
    );
  }
  return read;
}

/** One asset of this Atlas, in a Journey that is not deleting. */
export async function findAssetForAtlas(assetId: string, atlasId: string) {
  const [row] = await db
    .select({ asset: mediaAssets })
    .from(mediaAssets)
    .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
    .where(
      and(
        eq(mediaAssets.id, assetId),
        eq(journeys.atlasId, atlasId),
        isNull(journeys.deletionStartedAt),
      ),
    )
    .limit(1);
  return row?.asset;
}

export async function reorderJourneyMediaForAtlas(
  atlasId: string,
  input: NonNullable<ReturnType<typeof parseReorderInput>>,
) {
  const ordered = await db.transaction(async (transaction) => {
    if (!await lockActiveJourney(transaction, input.journeyId, atlasId)) return undefined;

    const owned = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.journeyId, input.journeyId),
        inArray(mediaAssets.id, input.assetIds),
      ));
    if (owned.length !== input.assetIds.length) return false;

    // Reorder accepts a subset: omitted assets keep their relative order and
    // receive the existing offset, even when their order already has gaps.
    await transaction
      .update(mediaAssets)
      .set({ sortOrder: sql`${mediaAssets.sortOrder} + 1000` })
      .where(eq(mediaAssets.journeyId, input.journeyId));
    await writeJourneyMediaOrder(transaction, atlasId, input.journeyId, input.assetIds);
    return true;
  });

  if (ordered === undefined) {
    return { body: { error: "JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (ordered === false) {
    return {
      body: {
        error: "INVALID_MEDIA_ORDER",
        message: "Media assets do not belong to this journey",
      },
      status: 400 as const,
    };
  }
  return {
    body: {
      journey: await getJourneyForAtlas(input.journeyId, atlasId),
    },
    status: 200 as const,
  };
}

export async function moveJourneyMediaForAtlas(
  atlasId: string,
  input: NonNullable<ReturnType<typeof parseMoveMediaInput>>,
) {
  const sourceJourneyId = input.journeyId;
  const targetJourneyId = input.targetJourneyId ?? input.journeyId;
  const crossJourney = sourceJourneyId !== targetJourneyId;

  const result = await db.transaction(async (transaction) => {
    const lockedJourneys = new Map<string, { id: string; coverMediaAssetId: string | null }>();
    for (const journeyId of [...new Set([sourceJourneyId, targetJourneyId])].sort()) {
      const row = await lockActiveJourney(transaction, journeyId, atlasId);
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
    const sourceOrder = sourceAll.map((asset) => asset.id);

    if (!crossJourney) {
      if (!moveUndoOrdersFitLimit(sourceOrder)) {
        return "undo-state-too-large" as const;
      }
      const nextOrder = mediaOrderAfterMove(sourceOrder, input.assetIds);
      await writeJourneyMediaOrder(transaction, atlasId, sourceJourneyId, nextOrder, {
        sourceJourneyId,
        placements: input.assetIds.map((assetId) => ({ assetId, routePointId: input.routePointId })),
      });
      return "ok" as const;
    }

    const moving = new Set(input.assetIds);
    const movedInSourceOrder = sourceOrder.filter((id) => moving.has(id));
    const targetAll = await transaction
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, targetJourneyId))
      .orderBy(mediaAssets.sortOrder);
    const sourceNextOrder = sourceOrder.filter((id) => !moving.has(id));
    const targetNextOrder = [
      ...targetAll.map((asset) => asset.id),
      ...movedInSourceOrder,
    ];
    if (!moveUndoOrdersFitLimit(sourceOrder, targetNextOrder)) {
      return "undo-state-too-large" as const;
    }
    const ownedById = new Map(owned.map((asset) => [asset.id, asset]));
    const sourceCoverMediaAssetId = lockedJourneys.get(sourceJourneyId)?.coverMediaAssetId ?? null;
    const undo: MediaMoveUndo = {
      sourceJourneyId,
      targetJourneyId,
      assetIds: movedInSourceOrder,
      targetRoutePointId: input.routePointId,
      sourceOrder,
      targetOrder: targetNextOrder,
      sourceCoverMediaAssetId,
      placements: movedInSourceOrder.map((assetId) => ({
        assetId,
        routePointId: ownedById.get(assetId)?.routePointId ?? null,
      })),
    };

    await writeJourneyMediaOrder(transaction, atlasId, sourceJourneyId, sourceNextOrder);
    await writeJourneyMediaOrder(transaction, atlasId, targetJourneyId, targetNextOrder, {
      sourceJourneyId,
      placements: input.assetIds.map((assetId) => ({ assetId, routePointId: input.routePointId })),
    });

    if (sourceCoverMediaAssetId && moving.has(sourceCoverMediaAssetId)) {
      await transaction
        .update(journeys)
        .set({ coverMediaAssetId: null })
        .where(eq(journeys.id, sourceJourneyId));
    }
    return { kind: "ok" as const, undo };
  });

  if (result === "journey-not-found") {
    return { body: { error: "JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "destination-journey-not-found") {
    return { body: { error: "DESTINATION_JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "route-point-not-found") {
    return { body: { error: "ROUTE_POINT_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "undo-state-too-large") {
    return { body: { error: "MEDIA_MOVE_TOO_LARGE", message: "Journey has too many media assets to create an undo-safe move" }, status: 409 as const };
  }
  if (result === "invalid-selection") {
    return {
      body: {
        error: "INVALID_MEDIA_MOVE",
        message: "Media assets do not belong to the source journey, or the selected media cannot move to that destination",
      },
      status: 400 as const,
    };
  }

  if (!crossJourney) {
    return { body: { journey: await getJourneyForAtlas(sourceJourneyId, atlasId) }, status: 200 as const };
  }
  const updatedJourneys = await getJourneysForAtlas([sourceJourneyId, targetJourneyId], atlasId);
  const sourceJourney = updatedJourneys.find((journey) => journey.id === sourceJourneyId);
  const destinationJourney = updatedJourneys.find((journey) => journey.id === targetJourneyId);
  const undo = typeof result === "object" ? result.undo : null;
  return {
    body: {
      journey: sourceJourney,
      sourceJourney,
      destinationJourney,
      undo,
    },
    status: 200 as const,
  };
}

export async function undoJourneyMediaMoveForAtlas(
  atlasId: string,
  sameJourneyInput: NonNullable<ReturnType<typeof parseUndoMoveMediaInput>>,
) {
  const result = await db.transaction(async (transaction) => {
    if (!await lockActiveJourney(transaction, sameJourneyInput.journeyId, atlasId)) {
      return "journey-not-found" as const;
    }

    const lockedMedia = await transaction.execute<{
      id: string;
      routePointId: string | null;
      mimeType: string;
    }>(sql`
      select
        ${mediaAssets.id} as id,
        ${mediaAssets.routePointId} as "routePointId",
        ${mediaAssets.mimeType} as "mimeType"
      from ${mediaAssets}
      where ${mediaAssets.journeyId} = ${sameJourneyInput.journeyId}
      order by ${mediaAssets.sortOrder}
      for update
    `);
    const all = lockedMedia.rows;
    const currentIds = new Set(all.map((asset) => asset.id));
    if (
      all.length !== sameJourneyInput.assetOrder.length
      || sameJourneyInput.assetOrder.some((assetId) => !currentIds.has(assetId))
    ) return "stale" as const;
    const expectedCurrentOrder = mediaOrderAfterMove(
      sameJourneyInput.assetOrder,
      sameJourneyInput.assignments.map((assignment) => assignment.assetId),
    );
    if (all.some((asset, index) => asset.id !== expectedCurrentOrder[index])) {
      return "stale" as const;
    }

    const currentById = new Map(all.map((asset) => [asset.id, asset]));
    for (const assignment of sameJourneyInput.assignments) {
      const current = currentById.get(assignment.assetId);
      if (!current || current.routePointId !== sameJourneyInput.expectedRoutePointId) return "stale" as const;
      if (assignment.routePointId !== null && !ALLOWED_MIME_TYPES.has(current.mimeType)) {
        return "invalid-selection" as const;
      }
    }

    const restoreRoutePointIds = [...new Set(
      sameJourneyInput.assignments
        .map((assignment) => assignment.routePointId)
        .filter((routePointId): routePointId is string => routePointId !== null),
    )];
    if (restoreRoutePointIds.length > 0) {
      const routePoints = await transaction
        .select({ id: journeyRoutePoints.id })
        .from(journeyRoutePoints)
        .where(and(
          eq(journeyRoutePoints.journeyId, sameJourneyInput.journeyId),
          inArray(journeyRoutePoints.id, restoreRoutePointIds),
        ));
      if (routePoints.length !== restoreRoutePointIds.length) return "stale" as const;
    }

    await writeJourneyMediaOrder(
      transaction, atlasId, sameJourneyInput.journeyId, sameJourneyInput.assetOrder,
      { sourceJourneyId: sameJourneyInput.journeyId, placements: sameJourneyInput.assignments },
    );
    return "ok" as const;
  });

  if (result === "journey-not-found") {
    return { body: { error: "JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "invalid-selection") {
    return {
      body: {
        error: "INVALID_MEDIA_MOVE_UNDO",
        message: "A soundtrack cannot be restored onto a route point",
      },
      status: 400 as const,
    };
  }
  if (result === "stale") {
    return {
      body: {
        error: "MEDIA_MOVE_UNDO_STALE",
        message: "Media changed after this move and can no longer be safely undone",
      },
      status: 409 as const,
    };
  }
  return {
    body: {
      journey: await getJourneyForAtlas(sameJourneyInput.journeyId, atlasId),
    },
    status: 200 as const,
  };
}

export async function undoCrossJourneyMediaMoveForAtlas(
  atlasId: string,
  input: MediaMoveUndo,
) {
  const result = await db.transaction(async (transaction) => {
    const lockedJourneys = new Map<string, { id: string; coverMediaAssetId: string | null }>();
    for (const journeyId of [input.sourceJourneyId, input.targetJourneyId].sort()) {
      const row = await lockActiveJourney(transaction, journeyId, atlasId);
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
      .select({ id: mediaAssets.id, routePointId: mediaAssets.routePointId })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.journeyId, input.targetJourneyId),
        inArray(mediaAssets.id, input.assetIds),
      ));
    if (movingRows.length !== input.assetIds.length) return "undo-conflict" as const;
    if (movingRows.some((asset) => asset.routePointId !== input.targetRoutePointId)) {
      return "undo-conflict" as const;
    }

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
    const expectedPostMoveSourceOrder = input.sourceOrder.filter((assetId) => !moving.has(assetId));
    if (
      currentSourceIds.length !== expectedPostMoveSourceOrder.length
      || currentSourceIds.some((assetId, index) => assetId !== expectedPostMoveSourceOrder[index])
    ) {
      return "undo-conflict" as const;
    }
    const currentTargetIds = targetAll.map((asset) => asset.id);
    if (
      currentTargetIds.length !== input.targetOrder.length
      || currentTargetIds.some((assetId, index) => assetId !== input.targetOrder[index])
    ) {
      return "undo-conflict" as const;
    }
    const sourceNextOrder = input.sourceOrder;
    const targetNextOrder = currentTargetIds.filter((assetId) => !moving.has(assetId));
    await writeJourneyMediaOrder(transaction, atlasId, input.targetJourneyId, targetNextOrder);
    await writeJourneyMediaOrder(transaction, atlasId, input.sourceJourneyId, sourceNextOrder, {
      sourceJourneyId: input.targetJourneyId,
      placements: input.placements,
    });

    if (shouldRestoreSourceCover) {
      await transaction
        .update(journeys)
        .set({ coverMediaAssetId: input.sourceCoverMediaAssetId })
        .where(eq(journeys.id, input.sourceJourneyId));
    }
    return "ok" as const;
  });

  if (result === "journey-not-found") {
    return { body: { error: "JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "destination-journey-not-found") {
    return { body: { error: "DESTINATION_JOURNEY_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "route-point-not-found") {
    return { body: { error: "ROUTE_POINT_NOT_FOUND" }, status: 404 as const };
  }
  if (result === "undo-conflict") {
    return { body: { error: "MEDIA_MOVE_UNDO_CONFLICT", message: "Media ownership or cover state changed after the move" }, status: 409 as const };
  }

  const updatedJourneys = await getJourneysForAtlas([input.sourceJourneyId, input.targetJourneyId], atlasId);
  return {
    body: {
      sourceJourney: updatedJourneys.find((journey) => journey.id === input.sourceJourneyId),
      destinationJourney: updatedJourneys.find((journey) => journey.id === input.targetJourneyId),
    },
    status: 200 as const,
  };
}
