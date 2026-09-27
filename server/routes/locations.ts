import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { createLocationSearch } from "../location/create-location-search";
import {
  LocationSearchInvalidError,
  type LocationSearch,
  type LocationSearchFocus,
} from "../location/location-search";
import { searchLocationVariants } from "../location/search-location-variants";

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

/**
 * #546: the optional Journey-context bias. Both coordinates or neither; a
 * half-given, non-numeric or out-of-range focus is refused rather than
 * silently searched without a bias.
 */
export function parseLocationSearchFocus(
  rawLatitude: string | undefined,
  rawLongitude: string | undefined,
): LocationSearchFocus | undefined {
  const latitudeText = rawLatitude?.trim() ?? "";
  const longitudeText = rawLongitude?.trim() ?? "";
  if (!latitudeText && !longitudeText) return undefined;
  const latitude = coordinateValue(latitudeText, -90, 90);
  const longitude = coordinateValue(longitudeText, -180, 180);
  if (latitude === null || longitude === null) {
    throw new LocationSearchInvalidError(
      "INVALID_LOCATION_FOCUS",
      "Search focus needs a valid lat and lon together",
    );
  }
  return { latitude, longitude };
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

    const aliases = context.req.queries("alias") ?? [];
    const searchArea = context.req.query("area")?.trim() ?? "";
    const countryCode = context.req.query("country")?.trim().toUpperCase() ?? "";
    if (aliases.length > 3
      || aliases.some((alias) => alias.trim().length < MIN_QUERY_LENGTH
        || alias.trim().length > MAX_QUERY_LENGTH)
      || searchArea.length > MAX_QUERY_LENGTH
      || (countryCode !== "" && !/^[A-Z]{2}$/.test(countryCode))) {
      return context.json({
        error: "INVALID_LOCATION_HINTS",
        message: "Location aliases, area or country are invalid",
      }, 400);
    }

    const focus = parseLocationSearchFocus(
      context.req.query("lat"),
      context.req.query("lon"),
    );
    const options = {
      limit: RESULT_LIMIT,
      signal: context.req.raw.signal,
      ...(focus ? { focus } : {}),
    };
    const results = aliases.length || searchArea
      ? await searchLocationVariants(locationSearch, query, options, {
        aliases,
        searchArea,
        countryCode,
      })
      : await locationSearch.search(query, options);
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
    fallbackBaseUrl: serverConfig.locationSearchFallbackBaseUrl,
  }),
);
