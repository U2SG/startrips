import { DisabledLocationSearch } from "./disabled-location-search";
import type { LocationSearch } from "./location-search";
import { NominatimLocationSearch } from "./nominatim-location-search";
import { PhotonLocationSearch } from "./photon-location-search";

type CreateLocationSearchOptions = {
  driver: string;
  baseUrl: string;
  userAgent: string;
};

export function createLocationSearch(
  options: CreateLocationSearchOptions,
): LocationSearch {
  if (options.driver === "disabled") return new DisabledLocationSearch();
  if (options.driver === "nominatim") {
    return new NominatimLocationSearch({
      baseUrl: options.baseUrl,
      userAgent: options.userAgent,
    });
  }
  if (options.driver === "photon") {
    return new PhotonLocationSearch({
      baseUrl: options.baseUrl,
      userAgent: options.userAgent,
    });
  }
  throw new Error(
    `Location search driver "${options.driver}" has no installed adapter`,
  );
}
