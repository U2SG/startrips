import {
  LocationSearchUnavailableError,
  type LocationSearch,
  type LocationSearchOptions,
  type LocationSearchResult,
} from "./location-search";

export class DisabledLocationSearch implements LocationSearch {
  readonly driver = "disabled";

  async search(
    _query: string,
    _options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]> {
    throw new LocationSearchUnavailableError();
  }
}

export function createLocationSearch(driver: string): LocationSearch {
  if (driver === "disabled") return new DisabledLocationSearch();
  throw new Error(`Location search driver "${driver}" has no installed adapter`);
}
