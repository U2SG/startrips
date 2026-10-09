import type { RoadProfile } from "../../src/journey/types";
import {
  RoutingGraphError,
  RoutingPreparingError,
  RoutingUnavailableError,
  staticOsrmBaseUrls,
  type OsrmBaseUrlResolver,
  type RoutingCoordinate,
  type RoutingGraphDetail,
} from "./route-candidate-provider";

const GRAPH_ID = /^[0-9a-f]{64}$/;
const GRAPH_ERRORS = new Set<RoutingGraphError["code"]>([
  "ROUTING_DATA_UNAVAILABLE", "ROUTING_AREA_TOO_LARGE", "ROUTING_GRAPH_BUILD_FAILED", "ROUTING_NO_ROADS",
]);
const RETRY_AFTER_MS = { queued: 3_000, fetching: 2_000, building: 2_000 } as const;
export const GRAPH_ERROR_MESSAGES: Record<RoutingGraphError["code"], string> = {
  ROUTING_DATA_UNAVAILABLE: "Road data for this route is temporarily unavailable",
  ROUTING_AREA_TOO_LARGE: "This route covers too large an area for an on-demand road graph",
  ROUTING_GRAPH_BUILD_FAILED: "The road graph for this route could not be built",
  ROUTING_NO_ROADS: "No roads for this mode were found around this route",
};

function graphError(code: unknown): Error {
  return typeof code === "string" && GRAPH_ERRORS.has(code as RoutingGraphError["code"])
    ? new RoutingGraphError(code as RoutingGraphError["code"], GRAPH_ERROR_MESSAGES[code as RoutingGraphError["code"]])
    : new RoutingUnavailableError("The road graph builder is temporarily unavailable");
}

/**
 * Asks the routing-builder sidecar for the corridor graph of these points.
 * Returns an OSRM base URL once the graph is ready; while it is prepared,
 * throws RoutingPreparingError so the route can answer 202.
 */
export function createGraphBuilderResolver(builderUrl: string, fetcher: typeof fetch = fetch) {
  return async (
    profile: RoadProfile,
    points: readonly RoutingCoordinate[],
    signal: AbortSignal,
    detail: RoutingGraphDetail = "standard",
  ): Promise<string> => {
    let response: Response;
    try {
      response = await fetcher(`${builderUrl}/graphs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          points: points.map(({ lat, lon }) => ({ lat, lon })),
          ...(detail === "extended" ? { detail } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
    } catch {
      throw new RoutingUnavailableError("The road graph builder is temporarily unavailable");
    }
    let payload: { id?: unknown; state?: unknown; error?: unknown } | null = null;
    try {
      const text = await response.text();
      if (text.length <= 4_096) payload = JSON.parse(text);
    } catch { /* classified below */ }
    if (!payload || typeof payload !== "object") throw new RoutingUnavailableError("The road graph builder response is invalid");
    if (!response.ok) throw graphError(payload.error);
    if (typeof payload.id !== "string" || !GRAPH_ID.test(payload.id)) {
      throw new RoutingUnavailableError("The road graph builder response is invalid");
    }
    switch (payload.state) {
      case "ready": return `${builderUrl}/graphs/${payload.id}`;
      case "queued":
      case "fetching":
      case "building": throw new RoutingPreparingError(payload.state, RETRY_AFTER_MS[payload.state]);
      case "failed": throw graphError(payload.error);
      default: throw new RoutingUnavailableError("The road graph builder response is invalid");
    }
  };
}

/**
 * Per profile, a static OSRM URL keeps today's behaviour. Otherwise the
 * builder (when configured) prepares an on-demand graph. Otherwise the
 * profile is unavailable.
 */
export function createRoutingBaseUrlResolver(
  staticUrls: Partial<Record<RoadProfile, string | null>>,
  builderUrl: string | null,
  fetcher: typeof fetch = fetch,
): OsrmBaseUrlResolver {
  const fixed = staticOsrmBaseUrls(staticUrls);
  const onDemand = builderUrl ? createGraphBuilderResolver(builderUrl, fetcher) : null;
  return {
    supports: (profile) => fixed.supports(profile) || Boolean(onDemand),
    canExtend: (profile) => !fixed.supports(profile) && Boolean(onDemand),
    resolve: (profile, points, signal, detail) => fixed.supports(profile) || !onDemand
      ? fixed.resolve(profile, points, signal)
      : onDemand(profile, points, signal, detail),
  };
}
