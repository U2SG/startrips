import type { RoadProfile, RouteCandidate, RoutePointSuggestion } from "../../src/journey/types";

export type RoutingCoordinate = { lat: number; lon: number };
export type RouteCandidateRequest = {
  coordinates: readonly RoutingCoordinate[];
  profile: RoadProfile;
  alternativesCount: 1 | 2 | 3;
  signal: AbortSignal;
  allowFerries?: boolean;
  routingCoordinates?: readonly RoutingCoordinate[];
  /**
   * Background work prepared through `prepareCandidates`: a provider that
   * batches must not start separate work for this request.
   */
  background?: boolean;
};
export type RoutePointSuggestionRequest = {
  coordinate: RoutingCoordinate;
  neighbors: { before?: RoutingCoordinate; after?: RoutingCoordinate };
  profile: RoadProfile;
  allowFerries?: boolean;
  signal: AbortSignal;
};

export interface RouteCandidateProvider {
  readonly id: "osrm";
  supports(profile: RoadProfile): boolean;
  candidates(request: RouteCandidateRequest): Promise<RouteCandidate[]>;
  pointSuggestions(request: RoutePointSuggestionRequest): Promise<RoutePointSuggestion[]>;
  /**
   * Optional batching: starts work for every request at once (one Journey's
   * pending segments). "queued" means nothing could be started yet.
   */
  prepareCandidates?(requests: readonly Omit<RouteCandidateRequest, "signal">[]): Promise<"started" | "queued">;
}

export class RoutingUnavailableError extends Error {
  readonly code = "ROUTING_UNAVAILABLE";
  readonly status = 503;
  constructor(message = "Road routing is temporarily unavailable") {
    super(message);
  }
}

export class RoutingInvalidError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type RoutingGraphPhase = "queued" | "fetching" | "building";

/** The road graph for this request is still being prepared; not a failure. */
export class RoutingPreparingError extends Error {
  readonly code = "ROUTING_PREPARING";
  readonly phase: RoutingGraphPhase;
  readonly retryAfterMs: number;
  constructor(phase: RoutingGraphPhase, retryAfterMs: number) {
    super("Road graph is being prepared");
    this.phase = phase;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A specific reason the on-demand road graph could not be prepared. */
export class RoutingGraphError extends Error {
  readonly code: "ROUTING_DATA_UNAVAILABLE" | "ROUTING_AREA_TOO_LARGE" | "ROUTING_GRAPH_BUILD_FAILED" | "ROUTING_NO_ROADS";
  readonly status: 422 | 503;
  constructor(code: RoutingGraphError["code"], message: string) {
    super(message);
    this.code = code;
    this.status = code === "ROUTING_AREA_TOO_LARGE" || code === "ROUTING_NO_ROADS" ? 422 : 503;
  }
}

/** "extended" asks for a richer on-demand graph when the standard one is disconnected. */
export type RoutingGraphDetail = "standard" | "extended";

/**
 * Resolves the OSRM base URL serving one profile for one request. A static
 * graph ignores the points; an on-demand graph is chosen by them.
 */
export interface OsrmBaseUrlResolver {
  supports(profile: RoadProfile): boolean;
  /** True when an extended graph exists for this profile, i.e. one escalation is worth trying. */
  canExtend?(profile: RoadProfile): boolean;
  resolve(profile: RoadProfile, points: readonly RoutingCoordinate[], signal: AbortSignal, detail?: RoutingGraphDetail): Promise<string>;
}

export function staticOsrmBaseUrls(baseUrls: Partial<Record<RoadProfile, string | null>>): OsrmBaseUrlResolver {
  return {
    supports: (profile) => Boolean(baseUrls[profile]),
    async resolve(profile) {
      const baseUrl = baseUrls[profile];
      if (!baseUrl) throw new RoutingUnavailableError("This road profile is not configured");
      return baseUrl;
    },
  };
}

export function osrmBaseUrlResolver(
  value: Partial<Record<RoadProfile, string | null>> | OsrmBaseUrlResolver,
): OsrmBaseUrlResolver {
  return typeof (value as OsrmBaseUrlResolver).resolve === "function"
    ? value as OsrmBaseUrlResolver
    : staticOsrmBaseUrls(value as Partial<Record<RoadProfile, string | null>>);
}
