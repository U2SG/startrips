import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { createLocationSearch } from "../location/disabled-location-search";
import type { LocationSearch } from "../location/location-search";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;
const RESULT_LIMIT = 8;

export function createLocationRoutes(
  locationSearch: LocationSearch,
) {
  const routes = new Hono();

  routes.get("/search", async (context) => {
    await requireAtlasAccess(context.req.raw, "read");
    const query = context.req.query("q")?.trim() ?? "";
    if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
      return context.json(
        {
          error: "INVALID_LOCATION_QUERY",
          message: `Location query must contain ${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters`,
        },
        400,
      );
    }

    const results = await locationSearch.search(query, {
      limit: RESULT_LIMIT,
      signal: context.req.raw.signal,
    });
    return context.json({ results });
  });

  return routes;
}

export const locationRoutes = createLocationRoutes(
  createLocationSearch(serverConfig.locationSearchDriver),
);
