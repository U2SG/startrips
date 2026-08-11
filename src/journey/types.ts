export type JourneyMediaAsset = {
  id: string;
  journeyId: string;
  storageDriver: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  sortOrder: number;
  uploadedByUserId: string;
  createdAt: string;
};

export type RoutePoint = {
  id: string;
  journeyId: string;
  sortOrder: number;
  latitude: number;
  longitude: number;
  label: string;
  isStop: boolean;
  occurredAt: string | null;
  createdAt: string;
};

export type RoutePointInput = Pick<
  RoutePoint,
  "latitude" | "longitude" | "label" | "isStop" | "occurredAt"
>;

export type Journey = {
  id: string;
  atlasId: string;
  title: string;
  startedOn: string;
  endedOn: string | null;
  note: string;
  lightColor: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  routePoints: RoutePoint[];
  media: JourneyMediaAsset[];
};

export type JourneyInput = Pick<
  Journey,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor"
> & {
  routePoints: RoutePointInput[];
};

export type PrivateMediaRead = {
  url: string;
  expiresAt: string;
};

export type JourneyYearGroup = {
  year: number;
  journeys: Journey[];
};

export type JourneyRoute = {
  id: string;
  color: string;
  points: Array<{
    lat: number;
    lon: number;
    isStop: boolean;
  }>;
};

export type LocationSearchResult = {
  id: string;
  label: string;
  context: string;
  countryCode: string;
  latitude: number;
  longitude: number;
};
