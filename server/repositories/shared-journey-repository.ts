import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ActiveShareGrant } from "../authorization/share-access";
import {
  journeyRoutePoints,
  journeys,
  mediaAssets,
  shareGrantJourneys,
} from "../db/app-schema";
import { db } from "../db/client";

/**
 * #200 phase B: the guest read model.
 *
 * These types are written out rather than derived from the owner journey rows
 * on purpose. An owner DTO with private fields deleted at the edge stays one
 * forgotten `select()` away from leaking `storageKey`, `atlasId` or
 * `createdByUserId`; a hand-written guest shape leaks only what someone typed
 * into it. Every field below is content the recipient is already looking at.
 */
export type SharedRoutePoint = {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  isStop: boolean;
  occurredAt: Date | null;
  note: string | null;
};

/**
 * Media attached to a shared journey, and optionally to one of its route
 * points. Deliberately without `storageDriver`, `storageKey`, `contentHash`
 * and `uploadedByUserId`: a guest reads media through a signed URL issued by
 * phase C, never through a storage key.
 */
export type SharedJourneyMedia = {
  id: string;
  routePointId: string | null;
  fileName: string;
  mimeType: string;
  bytes: number;
};

export type SharedJourney = {
  id: string;
  title: string;
  startedOn: string;
  endedOn: string | null;
  note: string;
  lightColor: string;
  lightEffect: string | null;
  coverMediaAssetId: string | null;
  revision: number;
  /**
   * The scope-closure invariant made explicit rather than left to the client.
   * Both ids are always members of this same payload, and the first and last
   * shared journey carry `null` — there is no neighbour outside the grant, and
   * no hint that one exists.
   */
  previousJourneyId: string | null;
  nextJourneyId: string | null;
  routePoints: SharedRoutePoint[];
  media: SharedJourneyMedia[];
};

export type SharedJourneyView = {
  share: {
    expiresAt: Date;
    /**
     * The number of journeys in this payload, which is the number of granted
     * journeys currently readable. It never counts anything the grant does
     * not select, so it discloses no private inventory.
     */
    journeyCount: number;
  };
  journeys: SharedJourney[];
};

type SharedJourneyRow = Omit<
  SharedJourney,
  "previousJourneyId" | "nextJourneyId" | "routePoints" | "media"
>;

export type SharedJourneyRows = {
  journeys: SharedJourneyRow[];
  routePoints: Array<SharedRoutePoint & { journeyId: string }>;
  media: Array<SharedJourneyMedia & { journeyId: string }>;
};

function groupByJourney<T extends { journeyId: string }>(
  rows: T[],
  allowedJourneyIds: Set<string>,
): Map<string, Array<Omit<T, "journeyId">>> {
  const grouped = new Map<string, Array<Omit<T, "journeyId">>>();
  for (const row of rows) {
    // A row for a journey outside the grant is dropped instead of grouped.
    // The queries below already scope by the granted ids; this is the second
    // place the scope has to be wrong before anything leaks.
    if (!allowedJourneyIds.has(row.journeyId)) continue;
    const { journeyId, ...rest } = row;
    const existing = grouped.get(journeyId);
    if (existing) existing.push(rest);
    else grouped.set(journeyId, [rest]);
  }
  return grouped;
}

/**
 * Shape the guest payload from rows that were already scoped to one grant.
 *
 * Pure, so the scope-closure and navigation rules are testable without a
 * database. The incoming journey order is the order the payload keeps: it is
 * the grant's own recorded selection order, and every neighbour reference is
 * resolved inside that array.
 */
export function buildSharedJourneyView(
  grant: { expiresAt: Date },
  rows: SharedJourneyRows,
): SharedJourneyView {
  const journeyIds = new Set(rows.journeys.map((journey) => journey.id));
  const routePointsByJourney = groupByJourney(rows.routePoints, journeyIds);
  const mediaByJourney = groupByJourney(rows.media, journeyIds);

  return {
    share: { expiresAt: grant.expiresAt, journeyCount: rows.journeys.length },
    journeys: rows.journeys.map((journey, index) => ({
      ...journey,
      previousJourneyId: index > 0 ? rows.journeys[index - 1].id : null,
      nextJourneyId: index < rows.journeys.length - 1
        ? rows.journeys[index + 1].id
        : null,
      routePoints: routePointsByJourney.get(journey.id) ?? [],
      media: mediaByJourney.get(journey.id) ?? [],
    })),
  };
}

/**
 * Read the granted journeys of one active grant.
 *
 * Membership is live: a journey that started deleting drops out of the scope
 * immediately, and content is whatever the owner's journey holds right now.
 * Sequence is not live — it is `share_grant_journeys.sortOrder`, the canonical
 * chronology recorded when the grant was created. That is the one order the
 * owner's own share list already reports, so editing a shared journey's dates
 * cannot make one grant read as two different sequences on two surfaces, and a
 * shared link's ordering stays as auditable as its scope.
 *
 * `atlasId` is compared as well as the grant join, so a grant can only ever
 * reach journeys of the atlas that issued it even if the join table were
 * wrong.
 */
export async function loadSharedJourneyView(
  grant: ActiveShareGrant,
): Promise<SharedJourneyView> {
  const journeyRows = await db
    .select({
      id: journeys.id,
      title: journeys.title,
      startedOn: journeys.startedOn,
      endedOn: journeys.endedOn,
      note: journeys.note,
      lightColor: journeys.lightColor,
      lightEffect: journeys.lightEffect,
      coverMediaAssetId: journeys.coverMediaAssetId,
      revision: journeys.revision,
    })
    .from(shareGrantJourneys)
    .innerJoin(journeys, eq(journeys.id, shareGrantJourneys.journeyId))
    .where(and(
      eq(shareGrantJourneys.shareGrantId, grant.id),
      eq(journeys.atlasId, grant.atlasId),
      isNull(journeys.deletionStartedAt),
    ))
    .orderBy(asc(shareGrantJourneys.sortOrder));

  if (journeyRows.length === 0) {
    return buildSharedJourneyView(grant, {
      journeys: [],
      routePoints: [],
      media: [],
    });
  }

  const journeyIds = journeyRows.map((journey) => journey.id);
  const [routePointRows, mediaRows] = await Promise.all([
    db
      .select({
        journeyId: journeyRoutePoints.journeyId,
        id: journeyRoutePoints.id,
        latitude: journeyRoutePoints.latitude,
        longitude: journeyRoutePoints.longitude,
        label: journeyRoutePoints.label,
        isStop: journeyRoutePoints.isStop,
        occurredAt: journeyRoutePoints.occurredAt,
        note: journeyRoutePoints.note,
      })
      .from(journeyRoutePoints)
      .where(inArray(journeyRoutePoints.journeyId, journeyIds))
      .orderBy(
        asc(journeyRoutePoints.journeyId),
        asc(journeyRoutePoints.sortOrder),
      ),
    db
      .select({
        journeyId: mediaAssets.journeyId,
        id: mediaAssets.id,
        routePointId: mediaAssets.routePointId,
        fileName: mediaAssets.fileName,
        mimeType: mediaAssets.mimeType,
        bytes: mediaAssets.bytes,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.journeyId, journeyIds))
      .orderBy(asc(mediaAssets.journeyId), asc(mediaAssets.sortOrder)),
  ]);

  return buildSharedJourneyView(grant, {
    journeys: journeyRows,
    routePoints: routePointRows,
    media: mediaRows,
  });
}
