import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { journeys, mediaAssets, mediaPersonClassifications } from "../db/app-schema";
import { db } from "../db/client";
import type { ShareMediaFilterAsset } from "../intents/share-media-filter";

/**
 * The media the share media filter may judge: every media of the named live
 * Journeys of this Atlas, in the order given and then each Journey's own
 * media order, with the cached person answer of `model` when there is one.
 *
 * `null` when any id is not a live Journey of this Atlas, so a member can
 * never have media of another Atlas, or of a Journey being deleted, sent to
 * a provider.
 */
export async function listShareMediaFilterAssets(
  atlasId: string,
  journeyIds: readonly string[],
  model: string,
): Promise<ShareMediaFilterAsset[] | null> {
  const live = await db
    .select({ id: journeys.id })
    .from(journeys)
    .where(and(
      eq(journeys.atlasId, atlasId),
      inArray(journeys.id, [...journeyIds]),
      isNull(journeys.deletionStartedAt),
    ));
  if (live.length !== journeyIds.length) return null;

  const rows = await db
    .select({
      id: mediaAssets.id,
      journeyId: mediaAssets.journeyId,
      mimeType: mediaAssets.mimeType,
      storageDriver: mediaAssets.storageDriver,
      previewStorageKey: mediaAssets.previewStorageKey,
      previewMimeType: mediaAssets.previewMimeType,
      previewState: mediaAssets.previewState,
      cachedHasPerson: mediaPersonClassifications.hasPerson,
    })
    .from(mediaAssets)
    .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
    .leftJoin(
      mediaPersonClassifications,
      and(
        eq(mediaPersonClassifications.assetId, mediaAssets.id),
        eq(mediaPersonClassifications.model, model),
      ),
    )
    .where(and(
      eq(journeys.atlasId, atlasId),
      inArray(mediaAssets.journeyId, [...journeyIds]),
      isNull(journeys.deletionStartedAt),
    ))
    .orderBy(asc(mediaAssets.journeyId), asc(mediaAssets.sortOrder));

  const position = new Map(journeyIds.map((id, index) => [id, index]));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((first, second) =>
      (position.get(first.row.journeyId ?? "") ?? 0) - (position.get(second.row.journeyId ?? "") ?? 0)
      || first.index - second.index)
    .map(({ row: { journeyId: _journeyId, ...asset } }) => asset);
}

/** Record successful answers; a repeat replaces the earlier answer. */
export async function saveShareMediaClassifications(
  results: ReadonlyArray<{ assetId: string; hasPerson: boolean }>,
  model: string,
): Promise<void> {
  if (results.length === 0) return;
  await db
    .insert(mediaPersonClassifications)
    .values(results.map((result) => ({ ...result, model })))
    .onConflictDoUpdate({
      target: mediaPersonClassifications.assetId,
      set: {
        hasPerson: sql`excluded.has_person`,
        model: sql`excluded.model`,
        classifiedAt: sql`now()`,
      },
    });
}
