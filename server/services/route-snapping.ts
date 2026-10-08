import { unsettledAutoRouteSegments, type AutoRouteSegment } from "../../src/journey/autoRouteSnapping";
import type { RouteSegmentRecord } from "../../src/journey/types";
import {
  AUTO_ROUTE_SCAN_PAGE_SIZE,
  listAutoRouteJourneys,
  writeAutoRouteSegment,
  type AutoRouteWrite,
} from "../repositories/route-segment-repository";
import { autoRouteSnappingEnabled, setAutoRouteSnappingTarget } from "../routing/auto-route-status";
import { RoutingPreparingError, type RouteCandidateProvider } from "../routing/route-candidate-provider";
import { routingProvider } from "../routing/routing-provider";

/**
 * Automatic road snapping (owner decision, 2026-10-08): the server gives every
 * Route Segment road geometry by itself; the candidate editor is a correction
 * entry only. One segment at a time, process-wide, so at most one on-demand
 * graph request is in flight. Member decisions are never overwritten: the
 * repository writes only while the segment is unchanged and still owed.
 */

/** Rest between steps while there is work; graph builds pace the queue anyway. */
export const ROUTE_SNAPPING_STEP_MS = 5_000;
/** Rest when no segment is owed a road. */
export const ROUTE_SNAPPING_IDLE_MS = 60_000;
/** Road data or the builder was unavailable: try this segment again after this. */
export const ROUTE_SNAPPING_RETRY_MS = 15 * 60_000;
/** A graph that stays "preparing" this long counts as unavailable data. */
export const ROUTE_SNAPPING_PREPARING_LIMIT_MS = 20 * 60_000;
const SCAN_PAGES = 40;
// Codes that will not change until the segment's points do.
const FINAL_CODES = new Set(["ROUTING_AREA_TOO_LARGE", "ROUTING_NO_ROADS", "ROUTING_NO_CANDIDATE"]);

type Target = AutoRouteSegment & { journeyId: string; revision: number; preparingSince: number | null };

export type RouteSnappingDependencies = {
  provider: Pick<RouteCandidateProvider, "supports" | "candidates">;
  listJourneys: (now: Date, offset: number) => Promise<{ id: string; routeSegments: RouteSegmentRecord[]; points: { id: string; lat: number; lon: number }[] }[]>;
  write: (journeyId: string, fromId: string, toId: string, expected: { sourceKey: string; revision: number }, write: AutoRouteWrite, now: Date) => Promise<boolean>;
  now: () => number;
  onTarget: (target: { journeyId: string; sourceKey: string } | null) => void;
  pageSize?: number;
};

export function createRouteSnapper(deps: RouteSnappingDependencies) {
  const pageSize = deps.pageSize ?? AUTO_ROUTE_SCAN_PAGE_SIZE;
  // Kept across steps while its graph is prepared, so no second graph is requested.
  let preparing: Target | null = null;
  // A write the repository refused for an unchanged segment state is not retried
  // in this process; any change gives the segment a new key.
  const refused = new Set<string>();
  const key = (target: Target) => JSON.stringify([target.journeyId, target.sourceKey, target.revision]);

  // The SQL prefilter cannot see profile support, so rows owing only
  // unsupported legs stay candidates forever. The scan therefore resumes where
  // the last pass stopped and wraps at the end, so such rows cannot starve it.
  let offset = 0;
  async function nextTarget(now: number): Promise<Target | null> {
    let wrapped = offset === 0;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const rows = await deps.listJourneys(new Date(now), offset);
      for (const row of rows) {
        for (const segment of unsettledAutoRouteSegments(row.points, row.routeSegments, now, deps.provider.supports)) {
          if (segment.state !== "pending") continue;
          const target = { ...segment, journeyId: row.id, revision: segment.record?.revision ?? 0, preparingSince: null };
          if (!refused.has(key(target))) return target;
        }
      }
      if (rows.length === pageSize) offset += pageSize;
      else {
        offset = 0;
        if (wrapped) return null;
        wrapped = true;
      }
    }
    return null;
  }

  async function persist(target: Target, write: AutoRouteWrite) {
    const written = await deps.write(target.journeyId, target.from.id, target.to.id,
      { sourceKey: target.sourceKey, revision: target.revision }, write, new Date(deps.now()));
    if (!written) {
      if (refused.size >= 1_000) refused.clear();
      refused.add(key(target));
    }
  }

  function attempt(code: string): AutoRouteWrite {
    const now = deps.now();
    return { kind: "attempt", attempt: {
      at: new Date(now).toISOString(), code,
      ...(FINAL_CODES.has(code) ? {} : { retryAt: new Date(now + ROUTE_SNAPPING_RETRY_MS).toISOString() }),
    } };
  }

  /** One unit of work. Resolves to the rest before the next step. */
  async function step(signal: AbortSignal): Promise<number> {
    const target = preparing ?? await nextTarget(deps.now());
    preparing = null;
    if (!target) return ROUTE_SNAPPING_IDLE_MS;
    deps.onTarget({ journeyId: target.journeyId, sourceKey: target.sourceKey });
    try {
      let write: AutoRouteWrite;
      try {
        // Auto mode never uses ferries; a member can still choose one in the editor.
        const [best] = await deps.provider.candidates({
          coordinates: [target.from, target.to], profile: target.profile,
          alternativesCount: 1, allowFerries: false, signal,
        });
        write = best ? { kind: "road", candidate: best } : attempt("ROUTING_NO_CANDIDATE");
      } catch (error) {
        if (signal.aborted) return ROUTE_SNAPPING_STEP_MS;
        if (error instanceof RoutingPreparingError) {
          const since = target.preparingSince ?? deps.now();
          if (deps.now() - since < ROUTE_SNAPPING_PREPARING_LIMIT_MS) {
            preparing = { ...target, preparingSince: since };
            return Math.max(2_000, error.retryAfterMs);
          }
          write = attempt("ROUTING_PREPARING_TIMEOUT");
        } else {
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code !== "string" || !code.startsWith("ROUTING_")) {
            console.error("Route snapping attempt failed", error instanceof Error ? error.message : "unknown error");
          }
          write = attempt(typeof code === "string" && code.startsWith("ROUTING_") ? code : "ROUTING_UNAVAILABLE");
        }
      }
      await persist(target, write);
      return ROUTE_SNAPPING_STEP_MS;
    } finally {
      if (!preparing) deps.onTarget(null);
    }
  }

  return { step };
}

/** Background reconciler; does nothing when no road profile it uses is configured. */
export function startRouteSnappingReconciler(): { stop(): Promise<void> } {
  if (!autoRouteSnappingEnabled()) return { stop: async () => {} };
  const controller = new AbortController();
  const snapper = createRouteSnapper({
    provider: routingProvider,
    listJourneys: listAutoRouteJourneys,
    write: writeAutoRouteSegment,
    now: Date.now,
    onTarget: setAutoRouteSnappingTarget,
  });
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = (async () => {
      let rest = ROUTE_SNAPPING_STEP_MS;
      try {
        rest = await snapper.step(controller.signal);
      } catch (error) {
        console.error("Route snapping step failed", error instanceof Error ? error.message : "unknown error");
      }
      if (controller.signal.aborted) return;
      timer = setTimeout(run, rest);
      timer.unref();
    })();
  };
  run();
  return {
    async stop() {
      controller.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
