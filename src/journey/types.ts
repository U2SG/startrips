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
  // #127/ST-058 + #311/ST-059: owner payloads may carry a persisted content
  // hash, but it is exact-byte identity only when the backend marks it verified.
  // Shared Journey projections intentionally omit both fields.
  contentHash?: string | null;
  contentHashVerified?: boolean;
  // #260: the presentable size of this asset with its EXIF orientation
  // already applied, and the state of the derived preview beside it. Null
  // dimensions and a `none` state are the normal shape of every asset
  // uploaded before #260; the original read is identical either way.
  // Optional rather than required: the owner payload always carries them,
  // while the guest payload built by `sharedAtlas.ts` deliberately projects a
  // narrower asset, and neither shape should have to invent the other's.
  displayWidth?: number | null;
  displayHeight?: number | null;
  previewState?: MediaPreviewState;
  previewMimeType?: string | null;
  createdAt: string;
};

/** #260. Only `ready` is ever served; see `server/media/preview-derivation.ts`. */
export type MediaPreviewState = "none" | "pending" | "ready" | "failed";

export type RoutePointPlaceRole =
  | "accommodation"
  | "attraction"
  | "transport"
  | "pure-transit"
  | "activity";

export type RoutePointOverviewVisibility = "auto" | "main" | "detail";

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
  // #514: optional presentation evidence. These fields never create a second
  // place/stay record and never change route geometry or stop identity.
  regionContext?: string | null;
  placeRole?: RoutePointPlaceRole | null;
  overviewVisibility?: RoutePointOverviewVisibility | null;
  // #514/ST-164: explicit membership of a non-stop Route Point in one exact
  // Stop-backed stay. This never changes route geometry or media ownership.
  stayAnchorRoutePointId?: string | null;
  createdAt: string;
};

export type RoutePointInput = Pick<
  RoutePoint,
  | "latitude"
  | "longitude"
  | "label"
  | "isStop"
  | "occurredAt"
  | "note"
  | "regionContext"
  | "placeRole"
  | "overviewVisibility"
  | "stayAnchorRoutePointId"
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
  /** Segment-scoped geometry choices. Shared reads project only granted segments. Never Journey nodes. */
  routeSegments?: RouteSegmentRecord[];
  /** Owner reads only, and only while automatic road snapping is configured. */
  autoRouteSegments?: AutoRouteSegmentStatus[];
  media: JourneyMediaAsset[];
};

export type JourneyInput = Pick<
  Journey,
  "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "lightEffect"
> & {
  revision?: number;
  routePoints: RoutePointInput[];
};

/**
 * #260: the same asset at a size that can be shown before the original
 * arrives. `width` and `height` are the asset's orientation-corrected display
 * size — the frame the preview and the original share — so the handover
 * between them moves nothing.
 */
export type MediaPreviewRead = {
  url: string;
  expiresAt: string;
  mimeType: string;
  width: number;
  height: number;
};

export type PrivateMediaRead = {
  url: string;
  expiresAt: string;
  /**
   * Present only when a preview of THIS asset is ready and signable. Absent
   * for every other state, and its absence is never an error: the original
   * `url` above is unaffected and remains authoritative.
   */
  preview?: MediaPreviewRead;
};

/** Owner-private media evidence wire contract. */
export type MediaSpatialSource = "exif" | "container-metadata" | "imported" | "unknown";
export type MediaSpatialGranularity = "coordinate" | "city" | "unknown";
export type MediaCaptureTimeSource =
  | "exif-original"
  | "exif-digitized"
  | "gps"
  | "container-metadata"
  | "imported"
  | "unknown";
export type MediaTimezoneState = "offset-known" | "local-only" | "unknown";

export type MediaRecordedEvidenceDocument = {
  spatial: {
    source: MediaSpatialSource;
    granularity: MediaSpatialGranularity;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    label: string | null;
  };
  captureTime: {
    source: MediaCaptureTimeSource;
    timezone: MediaTimezoneState;
    local: string | null;
    instant: string | null;
    offsetMinutes: number | null;
  };
};

export type MediaDisplayCorrection = {
  granularity: Exclude<MediaSpatialGranularity, "unknown">;
  latitude: number | null;
  longitude: number | null;
  label: string | null;
};

export type MediaDisplayState = {
  hidden: boolean;
  correction: MediaDisplayCorrection | null;
};

export type MediaEvidenceRecord = {
  mediaAssetId: string;
  revision: number;
  recorded: MediaRecordedEvidenceDocument;
  display: MediaDisplayState;
  effective: null | {
    source: "recorded" | "user-correction";
    provenance: MediaSpatialSource | null;
    granularity: Exclude<MediaSpatialGranularity, "unknown">;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    label: string | null;
  };
  updatedAt: string | null;
};

export type JourneyYearGroup = {
  year: number;
  journeys: Journey[];
};

export type RouteProvenanceTier =
  | "recorded-track"
  | "user-confirmed-route"
  | "user-shaped-route"
  | "suggested-route"
  | "sparse-relation";

export type RoadProfile = "driving" | "walking" | "cycling";
export type RoutingPoint = { lat: number; lon: number };
export type RoutePointSuggestion = {
  id: string;
  coordinate: RoutingPoint;
  label: string;
  distanceMeters: number;
  /** Network connectivity, never evidence that the member visited this point. */
  connected: boolean | null;
};
export type RouteAccessPoints = { from?: RoutingPoint; to?: RoutingPoint };
export type RouteShapePoint = { id: string; lat: number; lon: number; label?: string };
export type RouteCandidate = {
  id: string;
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  provider: "osrm";
  profile: RoadProfile;
  /** Only present when the member explicitly allowed this mixed route. */
  includesFerry?: true;
  /** Candidate relevance for presentation only; never historical confidence. */
  relevance: number;
  snapping: {
    maxDistanceMeters: number;
    waypoints: {
      requested: [number, number];
      /** A nearby road point explicitly chosen for routing; Journey coordinates stay unchanged. */
      selected?: [number, number];
      snapped: [number, number];
      distanceMeters: number;
      providerDistanceMeters: number;
    }[];
  };
};
export type RouteSegmentRecord = {
  fromRoutePointId: string;
  toRoutePointId: string;
  sourceKey: string;
  revision: number;
  shapePoints: RouteShapePoint[];
  decision: "open" | "none" | "confirmed";
  confirmedCandidate: RouteCandidate | null;
  /**
   * Absent for every member decision. "auto" marks road geometry the server
   * chose by itself: a suggestion, never a member-confirmed route. Any member
   * write replaces the whole record, so it becomes a member decision.
   */
  confirmedBy?: "auto";
  /** The last automatic attempt that produced no road; `retryAt` absent means not until the segment changes. */
  autoAttempt?: { at: string; code: string; retryAt?: string };
};

/** Automatic road snapping of one segment that is not done; done segments carry `confirmedBy: "auto"`. */
export type AutoRouteSegmentStatus = {
  sourceKey: string;
  state: "pending" | "snapping" | "failed";
  code?: string;
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
    /** Atlas overview label only; detailed map/story keep the canonical place label. */
    overviewLabel?: string;
  }>;
  /**
   * Optional evidence tier for each point-to-point leg. The index is the
   * source point index. Geometry alone never supplies or upgrades this value.
   */
  segmentProvenance?: readonly RouteProvenanceTier[];
  /** Same index as point-to-point legs; holes have no stored decision. */
  routeSegments?: readonly (RouteSegmentRecord | null)[];
  /** Same index as point-to-point legs; null when automatic snapping has nothing to report. */
  autoRouteSegments?: readonly (AutoRouteSegmentStatus | null)[];
  /** Owner-private recorded evidence. Each server segment stays independent so
   * gaps are never bridged by presentation code. */
  recordedTrackSegments?: readonly {
    id: string;
    points: readonly {
      lat: number;
      lon: number;
      recordedAt?: string | null;
    }[];
  }[];
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

/**
 * #200 owner share grants. `atlas-unavailable` exists in the server union and
 * is mirrored here so a status the owner list could theoretically carry has a
 * label, but `requireAtlasAccess` refuses a deleting Atlas before the owner
 * route runs, so it cannot appear on this side today.
 */
export type ShareGrantStatus = "active" | "revoked" | "expired" | "atlas-unavailable";

export type ShareGrantJourney = {
  id: string;
  title: string;
};

/**
 * One row of `GET /api/shares`. There is no token field because the server
 * stores only a hash and can never return one.
 */
export type ShareGrantSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  status: ShareGrantStatus;
  journeyCount: number;
  journeys: ShareGrantJourney[];
};

/**
 * The `POST /api/shares` response: the only moment a raw token exists outside
 * the recipient's browser.
 */
export type CreatedShareGrant = {
  share: {
    id: string;
    createdAt: string;
    expiresAt: string;
    journeyCount: number;
  };
  token: string;
};
