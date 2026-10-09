import { unsettledAutoRouteSegments, type AutoRouteSegment } from "../../src/journey/autoRouteSnapping";
import type { RouteSegmentRecord } from "../../src/journey/types";
import {
  AUTO_ROUTE_SCAN_PAGE_SIZE,
  listAutoRouteJourneys,
  writeAutoRouteSegment,
  type AutoRouteWrite,
} from "../repositories/route-segment-repository";
import { autoRoutePriorityJourneyIds, autoRouteSnappingEnabled, setAutoRouteSnappingTarget } from "../routing/auto-route-status";
import { MAX_DIRECT_METERS } from "../routing/osrm-route-candidate-provider";
import { RoutingPreparingError, type RouteCandidateProvider, type RouteCandidateRequest } from "../routing/route-candidate-provider";
import { routingDistanceMeters } from "../routing/routing-coordinates";
import { routingProvider } from "../routing/routing-provider";

/**
 * Automatic road snapping (owner decision, 2026-10-08): the server gives every
 * Route Segment road geometry by itself; the candidate editor is a correction
 * entry only. One segment at a time, process-wide, so at most one on-demand
 * graph request is in flight. Member decisions are never overwritten: the
 * repository writes only while the segment is unchanged and still owed.
 * Journeys a member recently read or edited go first, most recent first; the
 * oldest-first backfill takes what is left. Test Journeys are not scanned.
 * A batching provider (the GitHub Actions worker) is asked once for all of
 * the target Journey's pending segments; results then land per segment.
 */

/** Rest between steps while there is work; graph builds pace the queue anyway. */
export const ROUTE_SNAPPING_STEP_MS = 5_000;
/** Rest when no segment is owed a road. */
export const ROUTE_SNAPPING_IDLE_MS = 60_000;
/** Road data or the builder was unavailable: try this segment again after this. */
export const ROUTE_SNAPPING_RETRY_MS = 15 * 60_000;
/**
 * A graph that stays "preparing" this long counts as unavailable data. Longer
 * than the worker's 25-minute in-flight timeout, so a slow run is not cut off.
 */
export const ROUTE_SNAPPING_PREPARING_LIMIT_MS = 40 * 60_000;
const SCAN_PAGES = 40;
// Codes that will not change until the segment's points do.
const FINAL_CODES = new Set(["ROUTING_AREA_TOO_LARGE", "ROUTING_NO_ROADS", "ROUTING_NO_CANDIDATE"]);

type SnapRequest = Omit<RouteCandidateRequest, "signal">;
type Target = AutoRouteSegment & {
  journeyId: string;
  revision: number;
  preparingSince: number | null;
  /** Every pending segment of the target Journey, for a batching provider. */
  batch: SnapRequest[];
};

// Auto mode never uses ferries; a member can still choose one in the editor.
const snapRequest = (segment: AutoRouteSegment): SnapRequest => ({
  coordinates: [segment.from, segment.to], profile: segment.profile, alternativesCount: 1, allowFerries: false,
});
const tooLong = (segment: AutoRouteSegment) => routingDistanceMeters(segment.from, segment.to) > MAX_DIRECT_METERS;

export type RouteSnappingDependencies = {
  provider: Pick<RouteCandidateProvider, "supports" | "candidates" | "prepareCandidates">;
  /** The backfill scan; with `journeyIds`, only those Journeys. */
  listJourneys: (now: Date, offset: number, limit?: number, journeyIds?: readonly string[]) =>
    Promise<{ id: string; routeSegments: RouteSegmentRecord[]; points: { id: string; lat: number; lon: number }[] }[]>;
  /** Recently read or edited Journeys, most recent first. */
  priorityJourneyIds: (now: number) => string[];
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
  const key = (target: Pick<Target, "journeyId" | "sourceKey" | "revision">) => JSON.stringify([target.journeyId, target.sourceKey, target.revision]);

  function firstPending(rows: Awaited<ReturnType<RouteSnappingDependencies["listJourneys"]>>, now: number): Target | null {
    for (const row of rows) {
      const pending = unsettledAutoRouteSegments(row.points, row.routeSegments, now, deps.provider.supports)
        .filter((segment) => segment.state === "pending")
        .map((segment) => ({ ...segment, journeyId: row.id, revision: segment.record?.revision ?? 0 }))
        .filter((target) => !refused.has(key(target)));
      if (!pending.length) continue;
      return { ...pending[0], preparingSince: null, batch: pending.filter((target) => !tooLong(target)).map(snapRequest) };
    }
    return null;
  }

  async function priorityTarget(now: number, ids: readonly string[]): Promise<Target | null> {
    if (ids.length === 0) return null;
    const rows = await deps.listJourneys(new Date(now), 0, ids.length, ids);
    const rank = new Map(ids.map((id, index) => [id, index]));
    return firstPending(rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!), now);
  }

  // The SQL prefilter cannot see profile support, so rows owing only
  // unsupported legs stay candidates forever. The scan therefore resumes where
  // the last pass stopped and wraps at the end, so such rows cannot starve it.
  let offset = 0;
  async function nextTarget(now: number): Promise<Target | null> {
    let wrapped = offset === 0;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const rows = await deps.listJourneys(new Date(now), offset);
      const target = firstPending(rows, now);
      if (target) return target;
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
    const now = deps.now();
    const kept = preparing;
    preparing = null;
    const priorityIds = deps.priorityJourneyIds(now);
    // A priority Journey keeps its preparing graph; any other target gives way
    // to priority work and is found again by the backfill later.
    const target = kept && priorityIds.includes(kept.journeyId) ? kept
      : await priorityTarget(now, priorityIds) ?? kept ?? await nextTarget(now);
    if (!target) return ROUTE_SNAPPING_IDLE_MS;
    deps.onTarget({ journeyId: target.journeyId, sourceKey: target.sourceKey });
    try {
      let write: AutoRouteWrite;
      try {
        if (tooLong(target)) {
          // The provider answers no candidates here; record the real reason.
          write = attempt("ROUTING_AREA_TOO_LARGE");
        } else {
          const batching = Boolean(deps.provider.prepareCandidates);
          // Starts nothing for segments that already have a result or are in flight.
          if (batching) await deps.provider.prepareCandidates!(target.batch);
          const [best] = await deps.provider.candidates({ ...snapRequest(target), signal, ...(batching ? { background: true } : {}) });
          write = best ? { kind: "road", candidate: best } : attempt("ROUTING_NO_CANDIDATE");
        }
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
    priorityJourneyIds: autoRoutePriorityJourneyIds,
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
