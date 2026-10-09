import type { RoadProfile } from "../../src/journey/types";
import { serverConfig } from "../config";
import { createRoutingBaseUrlResolver } from "./graph-builder-client";
import { createRoutingWorker, withRoutingWorker } from "./github-worker";
import { createOsrmRouteCandidateProvider } from "./osrm-route-candidate-provider";

const staticUrls: Record<RoadProfile, string | null> = {
  driving: serverConfig.routingOsrmDrivingBaseUrl,
  walking: serverConfig.routingOsrmWalkingBaseUrl,
  cycling: serverConfig.routingOsrmCyclingBaseUrl,
};

/** The GitHub Actions routing worker, when configured; it receives signed results. */
export const routingWorker = serverConfig.routingWorker ? createRoutingWorker(serverConfig.routingWorker) : null;

/**
 * The one road routing provider: member candidate requests and automatic
 * snapping share it. A static OSRM URL wins per profile; otherwise the
 * worker, or without it the routing-builder sidecar.
 */
export const routingProvider = routingWorker
  ? withRoutingWorker(createOsrmRouteCandidateProvider(staticUrls), (profile) => Boolean(staticUrls[profile]), routingWorker.provider)
  : createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver(staticUrls, serverConfig.routingGraphBuilderUrl));
