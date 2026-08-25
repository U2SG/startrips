import type { LightEffectId } from "./lightEffects";

export type JourneyMediaAsset = {
  id: string;
  journeyId: string;
  routePointId: string | null;
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
  // #10: a short personal note for this route point (plain text, nullable).
  note?: string | null;
  createdAt: string;
};

export type RoutePointInput = Pick<
  RoutePoint,
  "latitude" | "longitude" | "label" | "isStop" | "occurredAt" | "note"
> & {
  id?: string;
};

export type Journey = {
  id: string;
  atlasId: string;
  title: string;
  startedOn: string;
  endedOn: string | null;
  note: string;
  lightColor: string;
  lightEffect?: LightEffectId | null;
  // #14: explicit journey cover. Falls back to the first visual media by
  // sortOrder when null.
  coverMediaAssetId?: string | null;
  revision: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  routePoints: RoutePoint[];
  media: JourneyMediaAsset[];
};

export type JourneyInput = Pick<
  Journey,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "lightEffect"
> & {
  revision?: number;
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
  lightEffect?: LightEffectId | null;
  points: Array<{
    id?: string;
    lat: number;
    lon: number;
    isStop: boolean;
    label?: string;
  }>;
};

export type LocationSearchResult = {
  id: string;
  label: string;
  labelEnglish?: string;
  labelLocal?: string;
  context: string;
  countryCode: string;
  latitude: number;
  longitude: number;
};

export type LocationSearchResponse = {
  results: LocationSearchResult[];
  attribution: { label: string; url: string } | null;
};
