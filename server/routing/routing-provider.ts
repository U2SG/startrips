import { serverConfig } from "../config";
import { createRoutingBaseUrlResolver } from "./graph-builder-client";
import { createOsrmRouteCandidateProvider } from "./osrm-route-candidate-provider";

/** The one road routing provider: member candidate requests and automatic snapping share its graphs. */
export const routingProvider = createOsrmRouteCandidateProvider(createRoutingBaseUrlResolver({
  driving: serverConfig.routingOsrmDrivingBaseUrl,
  walking: serverConfig.routingOsrmWalkingBaseUrl,
  cycling: serverConfig.routingOsrmCyclingBaseUrl,
}, serverConfig.routingGraphBuilderUrl));
