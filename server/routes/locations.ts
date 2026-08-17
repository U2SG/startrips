import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { createLocationSearch } from "../location/create-location-search";
import type { LocationSearch } from "../location/location-search";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;
const RESULT_LIMIT = 8;

function coordinateValue(
  raw: string | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate)
    && coordinate >= minimum
    && coordinate <= maximum
    ? coordinate
    : null;
}

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
    return context.json({ results, attribution: locationSearch.attribution });
  });

  routes.get("/reverse", async (context) => {
    await requireAtlasAccess(context.req.raw, "read");
    const latitude = coordinateValue(
      context.req.query("latitude"),
      -90,
      90,
    );
    const longitude = coordinateValue(
      context.req.query("longitude"),
      -180,
      180,
    );
    if (latitude === null || longitude === null) {
      return context.json(
        {
          error: "INVALID_LOCATION_COORDINATES",
          message: "Reverse lookup needs a valid latitude and longitude",
        },
        400,
      );
    }
    const result = await locationSearch.reverse(latitude, longitude, {
      signal: context.req.raw.signal,
    });
    return context.json({ result, attribution: locationSearch.attribution });
  });

  return routes;
}

export const locationRoutes = createLocationRoutes(
  createLocationSearch({
    driver: serverConfig.locationSearchDriver,
    baseUrl: serverConfig.locationSearchBaseUrl,
    userAgent: serverConfig.locationSearchUserAgent,
  }),
);
