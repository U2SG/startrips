import {
  LocationSearchUnavailableError,
  type LocationSearch,
  type LocationSearchOptions,
  type LocationSearchResult,
} from "./location-search";

export class DisabledLocationSearch implements LocationSearch {
  readonly driver = "disabled";
  readonly attribution = null;

  async search(
    _query: string,
    _options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]> {
    throw new LocationSearchUnavailableError();
  }
}
