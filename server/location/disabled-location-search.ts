import {
  LocationSearchUnavailableError,
  type LocationSearch,
  type LocationSearchOptions,
  type LocationSearchResult,
  type ReverseLocationOptions,
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

  async reverse(
    _latitude: number,
    _longitude: number,
    _options: ReverseLocationOptions,
  ): Promise<LocationSearchResult | null> {
    throw new LocationSearchUnavailableError();
  }
}
