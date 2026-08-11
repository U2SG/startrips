export type LocationSearchResult = {
  id: string;
  label: string;
  context: string;
  countryCode: string;
  latitude: number;
  longitude: number;
};

export type LocationSearchOptions = {
  limit: number;
  signal?: AbortSignal;
};

export interface LocationSearch {
  readonly driver: string;
  search(
    query: string,
    options: LocationSearchOptions,
  ): Promise<LocationSearchResult[]>;
}

export class LocationSearchUnavailableError extends Error {
  constructor(message = "Location search is not configured") {
    super(message);
    this.name = "LocationSearchUnavailableError";
  }
}
