import type { RoadProfile, RouteCandidate } from "../../src/journey/types";

export type RoutingCoordinate = { lat: number; lon: number };
export type RouteCandidateRequest = {
  coordinates: readonly RoutingCoordinate[];
  profile: RoadProfile;
  alternativesCount: 1 | 2 | 3;
  signal: AbortSignal;
};

export interface RouteCandidateProvider {
  readonly id: "osrm";
  supports(profile: RoadProfile): boolean;
  candidates(request: RouteCandidateRequest): Promise<RouteCandidate[]>;
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
