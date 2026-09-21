import { sql } from "drizzle-orm";
import { journeys, mediaAssets } from "../db/app-schema";
import type { db } from "../db/client";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MediaReassignment = {
  sourceJourneyId: string;
  placements: readonly { assetId: string; routePointId: string | null }[];
};

// The caller owns validation and the Journey locks. Only listed placements
// change owner/Route Point; all other assets retain their existing placement.
export async function writeJourneyMediaOrder(
  transaction: Transaction,
  atlasId: string,
  journeyId: string,
  assetIds: readonly string[],
  reassignment?: MediaReassignment,
) {
  if (assetIds.length === 0) return;
  const placements = new Map(
    reassignment?.placements.map((placement) => [placement.assetId, placement.routePointId]),
  );
  const rows = assetIds.map((assetId, sortOrder) => ({
    id: assetId,
    source_journey_id: placements.has(assetId) && reassignment ? reassignment.sourceJourneyId : journeyId,
    route_point_id: placements.get(assetId) ?? null,
    replace_placement: placements.has(assetId),
    sort_order: sortOrder,
  }));

  // One JSON parameter keeps even a 10,000-asset order well below PostgreSQL's
  // parameter limit. Journey, Route Point and order change in the same UPDATE.
  await transaction.execute(sql`
    update ${mediaAssets}
    set journey_id = ${journeyId}::uuid,
        route_point_id = case when ordered.replace_placement
          then ordered.route_point_id else ${mediaAssets.routePointId} end,
        sort_order = ordered.sort_order
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as ordered(
      id uuid, source_journey_id uuid, route_point_id uuid,
      replace_placement boolean, sort_order integer
    ), ${journeys} as source_journey, ${journeys} as target_journey
    where ${mediaAssets.id} = ordered.id
      and ${mediaAssets.journeyId} = ordered.source_journey_id
      and source_journey.id = ${mediaAssets.journeyId}
      and source_journey.atlas_id = ${atlasId}
      and source_journey.deletion_started_at is null
      and target_journey.id = ${journeyId}::uuid
      and target_journey.atlas_id = ${atlasId}
      and target_journey.deletion_started_at is null
  `);
}
