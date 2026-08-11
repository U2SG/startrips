import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  journeyRoutePoints,
  journeys,
  mediaAssets,
} from "../db/app-schema";

export type JourneyValues = Pick<
  typeof journeys.$inferInsert,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor"
> & {
  routePoints: Array<Pick<
    typeof journeyRoutePoints.$inferInsert,
    "latitude" | "longitude" | "label" | "isStop" | "occurredAt"
  >>;
};

async function loadJourneys(atlasId: string, journeyId?: string) {
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(
      journeyId
        ? and(eq(journeys.atlasId, atlasId), eq(journeys.id, journeyId))
        : eq(journeys.atlasId, atlasId),
    )
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
  return getJourneyForAtlas(journeyId, atlasId);
}

export async function updateJourneyForAtlas(
  journeyId: string,
  atlasId: string,
  values: JourneyValues,
) {
  const updated = await db.transaction(async (transaction) => {
    const [journey] = await transaction
      .update(journeys)
      .set({
        title: values.title,
        startedOn: values.startedOn,
        endedOn: values.endedOn,
        note: values.note,
        lightColor: values.lightColor,
        updatedAt: new Date(),
      })
      .where(and(eq(journeys.id, journeyId), eq(journeys.atlasId, atlasId)))
      .returning({ id: journeys.id });
    if (!journey) return false;

    await transaction
      .delete(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journey.id));
    await transaction.insert(journeyRoutePoints).values(
      values.routePoints.map((point, sortOrder) => ({
        journeyId: journey.id,
        sortOrder,
        ...point,
      })),
    );
    return true;
  });
  return updated ? getJourneyForAtlas(journeyId, atlasId) : undefined;
}

export async function deleteJourneyForAtlas(journeyId: string, atlasId: string) {
  const [journey] = await db
    .delete(journeys)
    .where(and(eq(journeys.id, journeyId), eq(journeys.atlasId, atlasId)))
    .returning({ id: journeys.id });
  return journey;
}
