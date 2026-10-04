import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "../db/client";
import {
  atlases,
  journeyRoutePointBatchOperations,
  journeyRoutePoints,
  journeys,
  mediaAssets,
  mediaUploads,
} from "../db/app-schema";
import { routeSegmentSourceKey } from "../../src/journey/journeyModel";

export type JourneyValues = Pick<
  typeof journeys.$inferInsert,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "lightEffect"
> & {
  revision?: number;
  routePoints: Array<Pick<
    typeof journeyRoutePoints.$inferInsert,
    | "latitude"
    | "longitude"
    | "label"
    | "isStop"
    | "occurredAt"
    | "note"
    | "regionContext"
    | "placeRole"
    | "overviewVisibility"
    | "stayAnchorRoutePointId"
  > & { id?: string }>;
};

export class JourneyRouteChangedError extends Error {
  constructor() {
    super("Journey route changed while it was being edited");
    this.name = "JourneyRouteChangedError";
  }
}

export class JourneyRoutePointIdConflictError extends Error {
  constructor() {
    super("A supplied Route Point id is already in use");
    this.name = "JourneyRoutePointIdConflictError";
  }
}

export const JOURNEY_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The Atlas row lock every Atlas-scoped write serializes on. Taking it first
 * and refusing a `deletionStartedAt` Atlas in the same statement means a write
 * cannot interleave with an Atlas deletion: either this transaction holds the
 * row and the Atlas was alive when it did, or it waits and then sees the mark.
 *
 * Callers must take this lock before any other row lock, so every write path
 * acquires locks in the same order.
 */
export async function lockActiveAtlas(
  transaction: Transaction,
  atlasId: string,
): Promise<boolean> {
  const locked = await transaction.execute<{ id: string }>(sql`
    select ${atlases.id} as id
    from ${atlases}
    where ${atlases.id} = ${atlasId}
      and ${atlases.deletionStartedAt} is null
    for update
  `);
  return locked.rows.length > 0;
}

export async function lockActiveJourney(
  transaction: Transaction,
  journeyId: string,
  // Only persisted, already-authorized upload records use the unscoped null case.
  atlasId: string | null,
): Promise<{ id: string; coverMediaAssetId: string | null } | undefined> {
  const locked = await transaction.execute<{ id: string; coverMediaAssetId: string | null }>(sql`
    select ${journeys.id} as id, ${journeys.coverMediaAssetId} as "coverMediaAssetId"
    from ${journeys}
    where ${journeys.id} = ${journeyId}
      ${atlasId === null ? sql`` : sql`and ${journeys.atlasId} = ${atlasId}`}
      and ${journeys.deletionStartedAt} is null
    for update
  `);
  return locked.rows[0];
}

async function loadJourneys(atlasId: string, requestedIds?: readonly string[]) {
  if (requestedIds?.length === 0) return [];
  const atlasScope = requestedIds
    ? and(eq(journeys.atlasId, atlasId), inArray(journeys.id, [...requestedIds]))
    : eq(journeys.atlasId, atlasId);
  const journeyRows = await db
    .select({
      id: journeys.id,
      atlasId: journeys.atlasId,
      title: journeys.title,
      startedOn: journeys.startedOn,
      endedOn: journeys.endedOn,
      note: journeys.note,
      lightColor: journeys.lightColor,
      lightEffect: journeys.lightEffect,
      coverMediaAssetId: journeys.coverMediaAssetId,
      revision: journeys.revision,
      routeSegments: journeys.routeSegments,
      createdByUserId: journeys.createdByUserId,
      createdAt: journeys.createdAt,
      updatedAt: journeys.updatedAt,
    })
    .from(journeys)
    .where(and(atlasScope, isNull(journeys.deletionStartedAt)))
    .orderBy(asc(journeys.startedOn), asc(journeys.createdAt));
  if (journeyRows.length === 0) return [];

  const journeyIds = journeyRows.map((journey) => journey.id);
  const [routeRows, mediaRows] = await Promise.all([
    db
      .select()
      .from(journeyRoutePoints)
      .where(inArray(journeyRoutePoints.journeyId, journeyIds))
      .orderBy(
        asc(journeyRoutePoints.journeyId),
        asc(journeyRoutePoints.sortOrder),
      ),
    db
      .select()
      .from(mediaAssets)
      .where(inArray(mediaAssets.journeyId, journeyIds))
      .orderBy(asc(mediaAssets.journeyId), asc(mediaAssets.sortOrder)),
  ]);

  const routesByJourney = new Map<string, typeof routeRows>();
  routeRows.forEach((point) => {
    const points = routesByJourney.get(point.journeyId);
    if (points) points.push(point);
    else routesByJourney.set(point.journeyId, [point]);
  });
  const mediaByJourney = new Map<string, typeof mediaRows>();
  mediaRows.forEach((asset) => {
    // #234: `journeyId` is nullable now, because an Everyday Fragment can own
    // media instead. The `inArray` above already restricts this result to the
    // Journeys loaded here, so a null owner cannot appear — narrowed rather
    // than asserted so a future query that drops that predicate cannot group
    // a fragment's asset under a Journey.
    const journeyId = asset.journeyId;
    if (journeyId === null) return;
    const assets = mediaByJourney.get(journeyId);
    if (assets) assets.push(asset);
    else mediaByJourney.set(journeyId, [asset]);
  });

  return journeyRows.map((journey) => ({
    ...journey,
    routePoints: routesByJourney.get(journey.id) ?? [],
    media: mediaByJourney.get(journey.id) ?? [],
  }));
}

export function listJourneysForAtlas(atlasId: string) {
  return loadJourneys(atlasId);
}

export async function getJourneyForAtlas(journeyId: string, atlasId: string) {
  return (await loadJourneys(atlasId, [journeyId]))[0];
}

export function getJourneysForAtlas(journeyIds: readonly string[], atlasId: string) {
  return loadJourneys(atlasId, journeyIds);
}

export async function createJourneyForAtlas(
  atlasId: string,
  createdByUserId: string,
  values: JourneyValues,
) {
  const journeyId = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;

    // #514/ST-164: the Composer may allocate UUIDs before the first save so an
    // unsaved child can point at an exact unsaved Stop in the same POST. Keep
    // those stable ids, but fail closed if any client-supplied id is already a
    // persisted Route Point anywhere rather than surfacing a PK error or
    // accidentally binding ownership to somebody else's record.
    const providedIds = values.routePoints.flatMap((point) => point.id ? [point.id] : []);
    if (providedIds.length > 0) {
      const collidingPoints = await transaction
        .select({ id: journeyRoutePoints.id })
        .from(journeyRoutePoints)
        .where(inArray(journeyRoutePoints.id, providedIds));
      if (collidingPoints.length > 0) throw new JourneyRoutePointIdConflictError();
    }

    const [journey] = await transaction
      .insert(journeys)
      .values({
        atlasId,
        createdByUserId,
        title: values.title,
        startedOn: values.startedOn,
        endedOn: values.endedOn,
        note: values.note,
        lightColor: values.lightColor,
        lightEffect: values.lightEffect ?? null,
      })
      .returning({ id: journeys.id });
    await transaction.insert(journeyRoutePoints).values(
      values.routePoints.map((point, sortOrder) => ({
        journeyId: journey.id,
        sortOrder,
        ...point,
      })),
    );
    return journey.id;
  });
  return journeyId ? getJourneyForAtlas(journeyId, atlasId) : undefined;
}

export async function updateJourneyForAtlas(
  journeyId: string,
  atlasId: string,
  values: JourneyValues,
) {
  const updated = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return false;

    const [journey] = await transaction
      .update(journeys)
      .set({
        title: values.title,
        startedOn: values.startedOn,
        endedOn: values.endedOn,
        note: values.note,
        lightColor: values.lightColor,
        lightEffect: values.lightEffect ?? null,
        revision: sql`${journeys.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(journeys.id, journeyId),
        eq(journeys.atlasId, atlasId),
        eq(journeys.revision, values.revision ?? -1),
        isNull(journeys.deletionStartedAt),
      ))
      .returning({ id: journeys.id, routeSegments: journeys.routeSegments });
    if (!journey) {
      const [activeJourney] = await transaction
        .select({ id: journeys.id })
        .from(journeys)
        .where(and(
          eq(journeys.id, journeyId),
          eq(journeys.atlasId, atlasId),
          isNull(journeys.deletionStartedAt),
        ))
        .limit(1);
      if (activeJourney) throw new JourneyRouteChangedError();
      return false;
    }

    const existingPoints = await transaction
      .select({
        id: journeyRoutePoints.id,
        isStop: journeyRoutePoints.isStop,
        stayAnchorRoutePointId: journeyRoutePoints.stayAnchorRoutePointId,
      })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journey.id));
    const existingIds = new Set(existingPoints.map((point) => point.id));
    const existingPointById = new Map(existingPoints.map((point) => [point.id, point] as const));
    const retainedIds = values.routePoints.flatMap((point) => point.id ? [point.id] : []);
    // #514/ST-164: assigning a not-yet-saved Stop requires giving it a stable
    // client UUID before the PATCH, otherwise a child cannot persist an exact
    // ownership relation to that Stop in the same atomic route replacement.
    // A supplied id that is not already in this Journey is therefore a legal
    // new Route Point id, but it must not collide with any existing Route Point
    // anywhere else.
    const newProvidedIds = retainedIds.filter((id) => !existingIds.has(id));
    if (newProvidedIds.length > 0) {
      const collidingPoints = await transaction
        .select({ id: journeyRoutePoints.id })
        .from(journeyRoutePoints)
        .where(inArray(journeyRoutePoints.id, newProvidedIds));
      if (collidingPoints.length > 0) throw new JourneyRouteChangedError();
    }

    // Older/partial clients legitimately omit the optional ownership field. In
    // that case the repository preserves the stored exact Stop id, so validate
    // the effective post-PATCH relation before deleting/demoting/reordering any
    // target. Otherwise an old client could leave a child pointing at a removed
    // or non-Stop Route Point even though parseJourneyInput never saw the field.
    const effectiveRoutePoints = values.routePoints.map((point) => ({
      id: point.id ?? null,
      isStop: point.isStop,
      stayAnchorRoutePointId: point.stayAnchorRoutePointId !== undefined
        ? point.stayAnchorRoutePointId
        : point.id
          ? existingPointById.get(point.id)?.stayAnchorRoutePointId ?? null
          : null,
    }));
    const effectiveIndexById = new Map(effectiveRoutePoints.flatMap((point, index) =>
      point.id ? [[point.id, index] as const] : []));
    for (let index = 0; index < effectiveRoutePoints.length; index += 1) {
      const point = effectiveRoutePoints[index];
      const anchorId = point.stayAnchorRoutePointId;
      if (!anchorId) continue;
      if (point.isStop) throw new JourneyRouteChangedError();
      const anchorIndex = effectiveIndexById.get(anchorId);
      if (anchorIndex === undefined || !effectiveRoutePoints[anchorIndex]?.isStop) {
        throw new JourneyRouteChangedError();
      }
      let previousStopId: string | null = null;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = effectiveRoutePoints[cursor];
        if (candidate.isStop) {
          previousStopId = candidate.id;
          break;
        }
      }
      let nextStopId: string | null = null;
      for (let cursor = index + 1; cursor < effectiveRoutePoints.length; cursor += 1) {
        const candidate = effectiveRoutePoints[cursor];
        if (candidate.isStop) {
          nextStopId = candidate.id;
          break;
        }
      }
      if (anchorId !== previousStopId && anchorId !== nextStopId) {
        throw new JourneyRouteChangedError();
      }
    }

    await transaction
      .update(journeyRoutePoints)
      .set({ sortOrder: sql`${journeyRoutePoints.sortOrder} + 1000` })
      .where(eq(journeyRoutePoints.journeyId, journey.id));

    if (retainedIds.length === 0) {
      await transaction
        .delete(journeyRoutePoints)
        .where(eq(journeyRoutePoints.journeyId, journey.id));
    } else {
      await transaction
        .delete(journeyRoutePoints)
        .where(and(
          eq(journeyRoutePoints.journeyId, journey.id),
          notInArray(journeyRoutePoints.id, retainedIds),
        ));
    }

    for (let sortOrder = 0; sortOrder < values.routePoints.length; sortOrder += 1) {
      const point = values.routePoints[sortOrder];
      const pointValues = {
        sortOrder,
        latitude: point.latitude,
        longitude: point.longitude,
        label: point.label,
        isStop: point.isStop,
        occurredAt: point.occurredAt,
        // #10 + review fix: `undefined` means "preserve the stored note" —
        // an older/partial client that omits note must never wipe it. Only
        // explicit null/empty (parsed to null) clears. New points default to
        // null (no note) because the column is nullable.
        ...(point.note !== undefined ? { note: point.note ?? null } : {}),
        // #514: optional presentation evidence follows the same preservation
        // rule as notes. Omitted fields from an older/partial client do not
        // erase persisted corrections; explicit null clears them.
        ...(point.regionContext !== undefined ? { regionContext: point.regionContext ?? null } : {}),
        ...(point.placeRole !== undefined ? { placeRole: point.placeRole ?? null } : {}),
        ...(point.overviewVisibility !== undefined
          ? { overviewVisibility: point.overviewVisibility ?? null }
          : {}),
        ...(point.stayAnchorRoutePointId !== undefined
          ? { stayAnchorRoutePointId: point.stayAnchorRoutePointId ?? null }
          : {}),
      };
      if (point.id && existingIds.has(point.id)) {
        await transaction
          .update(journeyRoutePoints)
          .set(pointValues)
          .where(and(
            eq(journeyRoutePoints.id, point.id),
            eq(journeyRoutePoints.journeyId, journey.id),
          ));
      } else {
        await transaction.insert(journeyRoutePoints).values({
          ...(point.id ? { id: point.id } : {}),
          journeyId: journey.id,
          ...pointValues,
          ...(point.note === undefined ? { note: null } : {}),
          ...(point.regionContext === undefined ? { regionContext: null } : {}),
          ...(point.placeRole === undefined ? { placeRole: null } : {}),
          ...(point.overviewVisibility === undefined ? { overviewVisibility: null } : {}),
          ...(point.stayAnchorRoutePointId === undefined ? { stayAnchorRoutePointId: null } : {}),
        });
      }
    }
    await pruneStaleRouteSegments(transaction, journey.id, journey.routeSegments);
    return true;
  });
  return updated ? getJourneyForAtlas(journeyId, atlasId) : undefined;
}

// Saved route geometry is keyed by the legs of the current route. Any write that
// removes or reorders Route Points drops the segments whose leg no longer exists.
async function pruneStaleRouteSegments(
  transaction: Transaction,
  journeyId: string,
  routeSegments: (typeof journeys.$inferSelect)["routeSegments"],
) {
  const savedRoutePoints = await transaction
    .select({ id: journeyRoutePoints.id, lat: journeyRoutePoints.latitude, lon: journeyRoutePoints.longitude })
    .from(journeyRoutePoints)
    .where(eq(journeyRoutePoints.journeyId, journeyId))
    .orderBy(asc(journeyRoutePoints.sortOrder));
  const currentSources = new Set(savedRoutePoints.slice(0, -1).map((_, index) => (
    routeSegmentSourceKey(savedRoutePoints, index)
  )));
  const retainedSegments = routeSegments.filter((segment) => currentSources.has(segment.sourceKey));
  if (retainedSegments.length !== routeSegments.length) {
    await transaction.update(journeys)
      .set({ routeSegments: retainedSegments })
      .where(eq(journeys.id, journeyId));
  }
}

export const ROUTE_POINT_BATCH_UNDO_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ROUTE_POINT_BATCH_MAX_POINTS = 64;

export type JourneyRoutePointBatchPoint = {
  candidateId: string;
  latitude: number;
  longitude: number;
  label: string;
  isStop: boolean;
  occurredAt: Date | null;
};

export type JourneyRoutePointBatchAttachment = {
  assetId?: string;
  uploadId?: string;
  routePointId?: string;
  candidateId?: string;
  intentionalReuse: boolean;
};

export type JourneyRoutePointBatchInput = {
  operationId: string;
  baseRevision: number;
  points: JourneyRoutePointBatchPoint[];
  attachments: JourneyRoutePointBatchAttachment[];
};

type RoutePointBatchReceipt = {
  pointMappings: Array<{ candidateId: string; routePointId: string }>;
  createdPoints: Array<{ id: string; sortOrder: number }>;
  placements: Array<{
    assetId: string;
    previousRoutePointId: string | null;
    previousSortOrder: number;
    targetRoutePointId: string;
  }>;
  appliedRevision: number;
};

export class JourneyRoutePointBatchError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JourneyRoutePointBatchError";
  }
}

function normalizedRoutePointBatchRequest(input: JourneyRoutePointBatchInput) {
  return {
    operationId: input.operationId,
    baseRevision: input.baseRevision,
    points: input.points.map((point) => ({
      ...point,
      occurredAt: point.occurredAt?.toISOString() ?? null,
    })),
    attachments: input.attachments,
  };
}

function routePointBatchFingerprint(request: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function routePointBatchView(operation: typeof journeyRoutePointBatchOperations.$inferSelect) {
  const expiresAt = operation.expiresAt?.toISOString() ?? null;
  const eligible = operation.status === "applied"
    && operation.expiresAt !== null
    && operation.expiresAt.valueOf() > Date.now();
  return {
    operationId: operation.operationId,
    status: operation.status,
    baseRevision: operation.baseRevision,
    appliedRevision: operation.appliedRevision,
    receipt: operation.receipt as RoutePointBatchReceipt | null,
    outcome: operation.outcome,
    undo: {
      eligible,
      expiresAt,
      reason: eligible ? null : operation.status === "applied" ? "expired"
        : operation.status === "staged" ? "not-applied" : "already-resolved",
    },
  };
}

async function lockRoutePointBatchJourney(
  transaction: Transaction,
  journeyId: string,
  atlasId: string,
) {
  if (!await lockActiveAtlas(transaction, atlasId)) return undefined;
  const locked = await transaction.execute<{ id: string; revision: number }>(sql`
    select ${journeys.id} as id, ${journeys.revision} as revision
    from ${journeys}
    where ${journeys.id} = ${journeyId}
      and ${journeys.atlasId} = ${atlasId}
      and ${journeys.deletionStartedAt} is null
    for update
  `);
  return locked.rows[0];
}

async function loadRoutePointBatchOperation(
  transaction: Transaction,
  journeyId: string,
  operationId: string,
) {
  const [operation] = await transaction
    .select()
    .from(journeyRoutePointBatchOperations)
    .where(and(
      eq(journeyRoutePointBatchOperations.journeyId, journeyId),
      eq(journeyRoutePointBatchOperations.operationId, operationId),
    ))
    .limit(1);
  return operation;
}

export async function applyJourneyRoutePointBatchForAtlas(
  journeyId: string,
  atlasId: string,
  input: JourneyRoutePointBatchInput,
) {
  const request = normalizedRoutePointBatchRequest(input) as Record<string, unknown>;
  const requestFingerprint = routePointBatchFingerprint(request);
  const operation = await db.transaction(async (transaction) => {
    const journey = await lockRoutePointBatchJourney(transaction, journeyId, atlasId);
    if (!journey) return undefined;
    const existingOperation = await loadRoutePointBatchOperation(transaction, journeyId, input.operationId);
    if (existingOperation && existingOperation.requestFingerprint !== requestFingerprint) {
      throw new JourneyRoutePointBatchError(409, "ROUTE_POINT_BATCH_ID_REUSED", "This operation id was already used with a different batch");
    }
    if (existingOperation && existingOperation.status !== "staged") return existingOperation;
    if (journey.revision !== input.baseRevision) {
      throw new JourneyRouteChangedError();
    }

    const routePoints = await transaction.select().from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    if (routePoints.length + input.points.length > ROUTE_POINT_BATCH_MAX_POINTS) {
      throw new JourneyRoutePointBatchError(400, "ROUTE_POINT_BATCH_TOO_LARGE", "Too many Route Points");
    }
    const routePointIds = new Set(routePoints.map((point) => point.id));
    const candidateIds = new Set(input.points.map((point) => point.candidateId));
    if (candidateIds.size !== input.points.length) {
      throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH", "Duplicate candidate id");
    }
    for (const attachment of input.attachments) {
      if (attachment.routePointId && !routePointIds.has(attachment.routePointId)) {
        throw new JourneyRoutePointBatchError(404, "ROUTE_POINT_BATCH_TARGET_NOT_FOUND", "Route Point target not found");
      }
      if (attachment.candidateId && !candidateIds.has(attachment.candidateId)) {
        throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH", "Unknown Route Point candidate");
      }
    }
    for (const candidateId of candidateIds) {
      if (!input.attachments.some((attachment) => attachment.candidateId === candidateId)) {
        throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH", "Every new Route Point needs media");
      }
    }

    const directAssetIds = input.attachments.flatMap((attachment) => attachment.assetId ? [attachment.assetId] : []);
    const uploadIds = input.attachments.flatMap((attachment) => attachment.uploadId ? [attachment.uploadId] : []);
    const directAssets = directAssetIds.length > 0
      ? await transaction.select().from(mediaAssets).where(inArray(mediaAssets.id, directAssetIds))
      : [];
    if (new Set(directAssets.map((asset) => asset.id)).size !== new Set(directAssetIds).size
      || directAssets.some((asset) => asset.journeyId !== journeyId)) {
      throw new JourneyRoutePointBatchError(404, "ROUTE_POINT_BATCH_MEDIA_NOT_FOUND", "Media asset not found in this Journey");
    }
    const uploads = uploadIds.length > 0
      ? await transaction.select().from(mediaUploads).where(inArray(mediaUploads.id, uploadIds))
      : [];
    if (new Set(uploads.map((upload) => upload.id)).size !== new Set(uploadIds).size
      || uploads.some((upload) => upload.atlasId !== atlasId || upload.journeyId !== journeyId)) {
      throw new JourneyRoutePointBatchError(404, "ROUTE_POINT_BATCH_UPLOAD_NOT_FOUND", "Upload not found in this Journey");
    }

    const pendingUploads = uploads
      .filter((upload) => upload.status !== "completed" && upload.status !== "aborted")
      .map((upload) => ({ uploadId: upload.id, status: upload.status }));
    const failedUploads = uploads
      .filter((upload) => upload.status === "aborted" || (upload.status === "completed" && !upload.mediaAssetId))
      .map((upload) => ({ uploadId: upload.id, status: upload.status }));
    if (pendingUploads.length > 0 || failedUploads.length > 0) {
      const outcome = { status: failedUploads.length > 0 ? "partial" : "staged", mounted: false, pendingUploads, failedUploads };
      if (existingOperation) {
        const [updated] = await transaction.update(journeyRoutePointBatchOperations)
          .set({ outcome, updatedAt: new Date() })
          .where(eq(journeyRoutePointBatchOperations.id, existingOperation.id)).returning();
        return updated;
      }
      const [staged] = await transaction.insert(journeyRoutePointBatchOperations).values({
        atlasId, journeyId, operationId: input.operationId, requestFingerprint, request,
        status: "staged", baseRevision: input.baseRevision, outcome,
      }).returning();
      return staged;
    }

    const completedUploadAssetIds = uploads.flatMap((upload) => upload.mediaAssetId ? [upload.mediaAssetId] : []);
    const allAssetIds = [...new Set([...directAssetIds, ...completedUploadAssetIds])];
    const allAssets = allAssetIds.length > 0
      ? await transaction.select().from(mediaAssets).where(inArray(mediaAssets.id, allAssetIds))
      : [];
    if (allAssets.length !== allAssetIds.length
      || allAssets.some((asset) => asset.journeyId !== journeyId || asset.mimeType.startsWith("audio/"))) {
      throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH_MEDIA", "Batch media is unavailable or not placeable");
    }
    const uploadAssetByUploadId = new Map(uploads.map((upload) => [upload.id, upload.mediaAssetId!] as const));
    const assetById = new Map(allAssets.map((asset) => [asset.id, asset] as const));
    const resolvedAttachments = input.attachments.map((attachment) => {
      const assetId = attachment.assetId ?? uploadAssetByUploadId.get(attachment.uploadId!);
      const asset = assetId ? assetById.get(assetId) : undefined;
      if (!asset) {
        throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH_MEDIA", "Completed upload has no usable media asset");
      }
      return { ...attachment, asset };
    });
    if (new Set(resolvedAttachments.map((attachment) => attachment.asset.id)).size !== resolvedAttachments.length) {
      throw new JourneyRoutePointBatchError(400, "INVALID_ROUTE_POINT_BATCH", "A media asset can appear only once in one batch");
    }

    const verifiedHashes = [...new Set(resolvedAttachments.flatMap((attachment) =>
      attachment.asset.contentHashVerified && attachment.asset.contentHash ? [attachment.asset.contentHash] : [],
    ))];
    const sameHashAssets = verifiedHashes.length > 0
      ? await transaction
        .select({ id: mediaAssets.id, contentHash: mediaAssets.contentHash, routePointId: mediaAssets.routePointId })
        .from(mediaAssets)
        .where(and(
          eq(mediaAssets.journeyId, journeyId),
          eq(mediaAssets.contentHashVerified, true),
          inArray(mediaAssets.contentHash, verifiedHashes),
        ))
      : [];
    for (const attachment of resolvedAttachments) {
      if (!attachment.candidateId || attachment.intentionalReuse) continue;
      const asset = attachment.asset;
      const duplicateAlreadyPlaced = asset.routePointId !== null
        || (asset.contentHashVerified === true && asset.contentHash !== null
          && sameHashAssets.some((candidate) =>
            candidate.id !== asset.id
            && candidate.contentHash === asset.contentHash
            && candidate.routePointId !== null));
      if (duplicateAlreadyPlaced) {
        throw new JourneyRoutePointBatchError(409, "ROUTE_POINT_BATCH_DUPLICATE_MEDIA", "Verified duplicate media is already placed; explicit intentional reuse is required");
      }
    }

    const pointMappings = input.points.map((point) => ({ candidateId: point.candidateId, routePointId: randomUUID() }));
    const routePointIdByCandidate = new Map(pointMappings.map((mapping) => [mapping.candidateId, mapping.routePointId] as const));
    const nextRoutePointSortOrder = routePoints.reduce((max, point) => Math.max(max, point.sortOrder), -1) + 1;
    const createdPoints = input.points.map((point, index) => ({
      id: routePointIdByCandidate.get(point.candidateId)!,
      journeyId,
      // After a partial undo the surviving orders can have gaps, so allocate
      // after the highest order rather than at the count.
      sortOrder: nextRoutePointSortOrder + index,
      latitude: point.latitude,
      longitude: point.longitude,
      label: point.label,
      isStop: point.isStop,
      occurredAt: point.occurredAt,
    }));
    if (createdPoints.length > 0) await transaction.insert(journeyRoutePoints).values(createdPoints);

    const placements: RoutePointBatchReceipt["placements"] = [];
    for (const attachment of resolvedAttachments) {
      const targetRoutePointId = attachment.routePointId ?? routePointIdByCandidate.get(attachment.candidateId!)!;
      placements.push({
        assetId: attachment.asset.id,
        previousRoutePointId: attachment.asset.routePointId,
        previousSortOrder: attachment.asset.sortOrder,
        targetRoutePointId,
      });
      await transaction.update(mediaAssets).set({ routePointId: targetRoutePointId }).where(and(
        eq(mediaAssets.id, attachment.asset.id),
        eq(mediaAssets.journeyId, journeyId),
      ));
    }

    const [revisionUpdate] = await transaction.update(journeys)
      .set({ revision: sql`${journeys.revision} + 1`, updatedAt: new Date() })
      .where(and(
        eq(journeys.id, journeyId),
        eq(journeys.atlasId, atlasId),
        eq(journeys.revision, input.baseRevision),
        isNull(journeys.deletionStartedAt),
      ))
      .returning({ revision: journeys.revision });
    if (!revisionUpdate) throw new JourneyRouteChangedError();

    const receipt: RoutePointBatchReceipt = {
      pointMappings,
      createdPoints: createdPoints.map((point) => ({ id: point.id, sortOrder: point.sortOrder })),
      placements,
      appliedRevision: revisionUpdate.revision,
    };
    const expiresAt = new Date(Date.now() + ROUTE_POINT_BATCH_UNDO_RETENTION_MS);
    const outcome = { status: "applied", mounted: true };
    if (existingOperation) {
      const [updated] = await transaction.update(journeyRoutePointBatchOperations)
        .set({
          status: "applied", appliedRevision: revisionUpdate.revision, receipt, outcome, expiresAt, updatedAt: new Date(),
        })
        .where(eq(journeyRoutePointBatchOperations.id, existingOperation.id))
        .returning();
      return updated;
    }
    const [applied] = await transaction.insert(journeyRoutePointBatchOperations).values({
      atlasId, journeyId, operationId: input.operationId, requestFingerprint, request,
      status: "applied", baseRevision: input.baseRevision, appliedRevision: revisionUpdate.revision,
      receipt, outcome, expiresAt,
    }).returning();
    return applied;
  });
  return operation ? routePointBatchView(operation) : undefined;
}

export async function getJourneyRoutePointBatchForAtlas(
  journeyId: string,
  atlasId: string,
  operationId: string,
) {
  const rows = await db
    .select({ operation: journeyRoutePointBatchOperations })
    .from(journeyRoutePointBatchOperations)
    .innerJoin(journeys, eq(journeys.id, journeyRoutePointBatchOperations.journeyId))
    .where(and(
      eq(journeyRoutePointBatchOperations.journeyId, journeyId),
      eq(journeyRoutePointBatchOperations.operationId, operationId),
      eq(journeyRoutePointBatchOperations.atlasId, atlasId),
      eq(journeys.atlasId, atlasId),
      isNull(journeys.deletionStartedAt),
    ))
    .limit(1);
  return rows[0] ? routePointBatchView(rows[0].operation) : undefined;
}

export async function undoJourneyRoutePointBatchForAtlas(
  journeyId: string,
  atlasId: string,
  operationId: string,
) {
  const operation = await db.transaction(async (transaction) => {
    const journey = await lockRoutePointBatchJourney(transaction, journeyId, atlasId);
    if (!journey) return undefined;
    const existing = await loadRoutePointBatchOperation(transaction, journeyId, operationId);
    if (!existing || existing.atlasId !== atlasId) return undefined;
    if (existing.status === "undone" || existing.status === "partially-undone") return existing;
    if (existing.status !== "applied" || !existing.receipt || existing.appliedRevision === null) {
      throw new JourneyRoutePointBatchError(409, "ROUTE_POINT_BATCH_NOT_APPLIED", "Batch has not been applied");
    }
    if (!existing.expiresAt || existing.expiresAt.valueOf() <= Date.now()) {
      throw new JourneyRoutePointBatchError(410, "ROUTE_POINT_BATCH_UNDO_EXPIRED", "Batch undo retention window expired");
    }
    if (journey.revision !== existing.appliedRevision) {
      throw new JourneyRoutePointBatchError(
        409,
        "ROUTE_POINT_BATCH_UNDO_CONFLICT",
        "Journey route changed after the batch; undo would overwrite a later edit",
      );
    }

    const receipt = existing.receipt as unknown as RoutePointBatchReceipt;
    const placementIds = receipt.placements.map((placement) => placement.assetId);
    const currentAssets = placementIds.length > 0
      ? await transaction.select().from(mediaAssets).where(inArray(mediaAssets.id, placementIds))
      : [];
    const currentAssetById = new Map(currentAssets.map((asset) => [asset.id, asset] as const));
    const conflicts: Array<{ kind: string; id: string }> = [];
    const restoredAssetIds: string[] = [];
    for (const placement of receipt.placements) {
      const current = currentAssetById.get(placement.assetId);
      if (!current
        || current.journeyId !== journeyId
        || current.routePointId !== placement.targetRoutePointId
        || current.sortOrder !== placement.previousSortOrder) {
        conflicts.push({ kind: "media-changed", id: placement.assetId });
        continue;
      }
      await transaction.update(mediaAssets)
        .set({ routePointId: placement.previousRoutePointId })
        .where(and(eq(mediaAssets.id, placement.assetId), eq(mediaAssets.journeyId, journeyId)));
      restoredAssetIds.push(placement.assetId);
    }

    const createdPointIds = receipt.createdPoints.map((point) => point.id);
    const currentCreatedPoints = createdPointIds.length > 0
      ? await transaction.select().from(journeyRoutePoints).where(inArray(journeyRoutePoints.id, createdPointIds))
      : [];
    const currentCreatedPointIds = new Set(currentCreatedPoints.map((point) => point.id));
    for (const pointId of createdPointIds) {
      if (!currentCreatedPointIds.has(pointId)) conflicts.push({ kind: "route-point-missing", id: pointId });
    }
    const mediaStillOnCreatedPoints = createdPointIds.length > 0
      ? await transaction.select({ id: mediaAssets.id, routePointId: mediaAssets.routePointId })
        .from(mediaAssets).where(inArray(mediaAssets.routePointId, createdPointIds))
      : [];
    const mediaByCreatedPoint = new Map<string, string[]>();
    for (const media of mediaStillOnCreatedPoints) {
      if (!media.routePointId) continue;
      const ids = mediaByCreatedPoint.get(media.routePointId) ?? [];
      ids.push(media.id);
      mediaByCreatedPoint.set(media.routePointId, ids);
    }
    const removedRoutePointIds: string[] = [];
    for (const point of receipt.createdPoints) {
      if (!currentCreatedPointIds.has(point.id)) continue;
      const remaining = mediaByCreatedPoint.get(point.id) ?? [];
      if (remaining.length > 0) {
        conflicts.push({ kind: "route-point-referenced", id: point.id });
        continue;
      }
      await transaction.delete(journeyRoutePoints).where(and(
        eq(journeyRoutePoints.id, point.id),
        eq(journeyRoutePoints.journeyId, journeyId),
      ));
      removedRoutePointIds.push(point.id);
    }
    if (removedRoutePointIds.length > 0) {
      const [segments] = await transaction.select({ routeSegments: journeys.routeSegments })
        .from(journeys).where(eq(journeys.id, journeyId));
      if (segments) await pruneStaleRouteSegments(transaction, journeyId, segments.routeSegments);
    }

    const changed = restoredAssetIds.length > 0 || removedRoutePointIds.length > 0;
    if (!changed && conflicts.length > 0) {
      throw new JourneyRoutePointBatchError(409, "ROUTE_POINT_BATCH_UNDO_CONFLICT", "Later media changes prevent safe undo");
    }
    let revision = journey.revision;
    if (changed) {
      const [updatedJourney] = await transaction.update(journeys)
        .set({ revision: sql`${journeys.revision} + 1`, updatedAt: new Date() })
        .where(and(
          eq(journeys.id, journeyId),
          eq(journeys.atlasId, atlasId),
          eq(journeys.revision, journey.revision),
          isNull(journeys.deletionStartedAt),
        ))
        .returning({ revision: journeys.revision });
      if (!updatedJourney) throw new JourneyRouteChangedError();
      revision = updatedJourney.revision;
    }
    const full = conflicts.length === 0
      && restoredAssetIds.length === receipt.placements.length
      && removedRoutePointIds.length === receipt.createdPoints.length;
    const outcome = {
      status: full ? "undone" : "partial",
      restoredAssetIds,
      removedRoutePointIds,
      conflicts,
      revision,
    };
    const [updatedOperation] = await transaction.update(journeyRoutePointBatchOperations)
      .set({
        status: full ? "undone" : "partially-undone",
        outcome,
        updatedAt: new Date(),
      })
      .where(eq(journeyRoutePointBatchOperations.id, existing.id))
      .returning();
    return updatedOperation;
  });
  return operation ? routePointBatchView(operation) : undefined;
}

// #14: set (or clear) a journey's explicit cover media. The asset must belong
// to this journey's atlas and must be visual (image/video) — a soundtrack can
// never become a cover. Returns the journey (unchanged when the asset was
// rejected), or undefined when the journey does not exist.
export async function setJourneyCoverForAtlas(
  journeyId: string,
  atlasId: string,
  coverMediaAssetId: string | null,
) {
  const journeyExists = await db.transaction(async (transaction) => {
    const [journey] = await transaction
      .select({ id: journeys.id })
      .from(journeys)
      .where(and(
        eq(journeys.id, journeyId),
        eq(journeys.atlasId, atlasId),
        isNull(journeys.deletionStartedAt),
      ))
      .limit(1);
    if (!journey) return false;

    if (coverMediaAssetId !== null) {
      const [asset] = await transaction
        .select({
          id: mediaAssets.id,
          journeyId: mediaAssets.journeyId,
          mimeType: mediaAssets.mimeType,
        })
        .from(mediaAssets)
        .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
        .where(and(
          eq(mediaAssets.id, coverMediaAssetId),
          eq(journeys.atlasId, atlasId),
          isNull(journeys.deletionStartedAt),
        ))
        .limit(1);
      // An invalid cover target leaves the journey untouched. #234: a
      // fragment-owned asset has no `journeyId` at all, and is refused here
      // explicitly rather than by a null-versus-string comparison happening
      // to be unequal — a Journey cover must be media this Journey owns.
      if (
        !asset
        || asset.journeyId === null
        || asset.journeyId !== journeyId
        || asset.mimeType.startsWith("audio/")
      ) {
        return true;
      }
    }

    await transaction
      .update(journeys)
      .set({
        coverMediaAssetId,
        revision: sql`${journeys.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(journeys.id, journeyId));
    return true;
  });
  return journeyExists ? getJourneyForAtlas(journeyId, atlasId) : undefined;
}

export async function getJourneyDeletionCandidateForAtlas(
  journeyId: string,
  atlasId: string,
) {
  const [journey] = await db
    .select({ id: journeys.id })
    .from(journeys)
    .where(and(
      eq(journeys.id, journeyId),
      eq(journeys.atlasId, atlasId),
      isNotNull(journeys.deletionStartedAt),
    ))
    .limit(1);
  if (!journey) return undefined;

  const [media, uploads] = await Promise.all([
    db
      .select({
        storageDriver: mediaAssets.storageDriver,
        storageKey: mediaAssets.storageKey,
        // #260: a hard Journey deletion has to reach the derived preview too,
        // and this select is the only place its key is ever read for cleanup.
        previewStorageKey: mediaAssets.previewStorageKey,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, journey.id)),
    db
      .select({
        storageDriver: mediaUploads.storageDriver,
        storageKey: mediaUploads.storageKey,
        providerUploadId: mediaUploads.providerUploadId,
        status: mediaUploads.status,
      })
      .from(mediaUploads)
      .where(and(
        eq(mediaUploads.journeyId, journey.id),
        notInArray(mediaUploads.status, ["completed", "aborted"]),
      )),
  ]);

  return { id: journey.id, media, uploads };
}

export async function markJourneyForDeletionForAtlas(
  journeyId: string,
  atlasId: string,
): Promise<{ id: string } | undefined> {
  const [journey] = await db
    .update(journeys)
    .set({ deletionStartedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(journeys.id, journeyId),
      eq(journeys.atlasId, atlasId),
      isNull(journeys.deletionStartedAt),
    ))
    .returning({ id: journeys.id });
  return journey;
}

export async function restoreJourneyForAtlas(journeyId: string, atlasId: string) {
  const graceCutoff = new Date(Date.now() - JOURNEY_DELETION_GRACE_MS);
  const [journey] = await db
    .update(journeys)
    .set({ deletionStartedAt: null, updatedAt: new Date() })
    .where(and(
      eq(journeys.id, journeyId),
      eq(journeys.atlasId, atlasId),
      isNotNull(journeys.deletionStartedAt),
      gt(journeys.deletionStartedAt, graceCutoff),
    ))
    .returning({ id: journeys.id });
  if (!journey) return undefined;
  return getJourneyForAtlas(journey.id, atlasId);
}

export async function listJourneysPendingDeletion(
  limit = 25,
  now = new Date(),
) {
  const graceCutoff = new Date(now.getTime() - JOURNEY_DELETION_GRACE_MS);
  return db
    .select({ id: journeys.id, atlasId: journeys.atlasId })
    .from(journeys)
    .where(and(
      isNotNull(journeys.deletionStartedAt),
      lte(journeys.deletionStartedAt, graceCutoff),
    ))
    .orderBy(asc(journeys.updatedAt))
    .limit(limit);
}

export async function deferJourneyDeletionRetryForAtlas(
  journeyId: string,
  atlasId: string,
) {
  const [journey] = await db
    .update(journeys)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(journeys.id, journeyId),
      eq(journeys.atlasId, atlasId),
      isNotNull(journeys.deletionStartedAt),
    ))
    .returning({ id: journeys.id });
  return journey;
}

export async function deleteJourneyForAtlas(journeyId: string, atlasId: string) {
  const [journey] = await db
    .delete(journeys)
    .where(and(
      eq(journeys.id, journeyId),
      eq(journeys.atlasId, atlasId),
      isNotNull(journeys.deletionStartedAt),
    ))
    .returning({ id: journeys.id });
  return journey;
}
