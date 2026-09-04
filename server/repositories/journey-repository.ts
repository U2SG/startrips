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
  journeyRoutePoints,
  journeys,
  mediaAssets,
  mediaUploads,
} from "../db/app-schema";

export type JourneyValues = Pick<
  typeof journeys.$inferInsert,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "lightEffect"
> & {
  revision?: number;
  routePoints: Array<Pick<
    typeof journeyRoutePoints.$inferInsert,
    "latitude" | "longitude" | "label" | "isStop" | "occurredAt" | "note"
  > & { id?: string }>;
};

export class JourneyRouteChangedError extends Error {
  constructor() {
    super("Journey route changed while it was being edited");
    this.name = "JourneyRouteChangedError";
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

async function loadJourneys(atlasId: string, journeyId?: string) {
  const atlasScope = journeyId
    ? and(eq(journeys.atlasId, atlasId), eq(journeys.id, journeyId))
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
    const assets = mediaByJourney.get(asset.journeyId);
    if (assets) assets.push(asset);
    else mediaByJourney.set(asset.journeyId, [asset]);
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
  return (await loadJourneys(atlasId, journeyId))[0];
}

export async function createJourneyForAtlas(
  atlasId: string,
  createdByUserId: string,
  values: JourneyValues,
) {
  const journeyId = await db.transaction(async (transaction) => {
    if (!await lockActiveAtlas(transaction, atlasId)) return undefined;

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
      .returning({ id: journeys.id });
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
      .select({ id: journeyRoutePoints.id })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journey.id));
    const existingIds = new Set(existingPoints.map((point) => point.id));
    const retainedIds = values.routePoints.flatMap((point) => point.id ? [point.id] : []);
    if (retainedIds.some((id) => !existingIds.has(id))) {
      throw new JourneyRouteChangedError();
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
      };
      if (point.id) {
        await transaction
          .update(journeyRoutePoints)
          .set(pointValues)
          .where(and(
            eq(journeyRoutePoints.id, point.id),
            eq(journeyRoutePoints.journeyId, journey.id),
          ));
      } else {
        await transaction.insert(journeyRoutePoints).values({
          journeyId: journey.id,
          ...pointValues,
          ...(point.note === undefined ? { note: null } : {}),
        });
      }
    }
    return true;
  });
  return updated ? getJourneyForAtlas(journeyId, atlasId) : undefined;
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
      // An invalid cover target leaves the journey untouched.
      if (!asset || asset.journeyId !== journeyId || asset.mimeType.startsWith("audio/")) {
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
