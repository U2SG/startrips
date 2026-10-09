import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RoadProfile, RouteCandidate, RoutePointSuggestion } from "../../src/journey/types";
import { GRAPH_ERROR_MESSAGES } from "./graph-builder-client";
import { MAX_DIRECT_METERS } from "./osrm-route-candidate-provider";
import {
  RoutingGraphError,
  RoutingPreparingError,
  RoutingUnavailableError,
  type RouteCandidateProvider,
  type RouteCandidateRequest,
  type RoutePointSuggestionRequest,
  type RoutingCoordinate,
} from "./route-candidate-provider";
import { MAX_SELECTED_POINT_METERS, MAX_SNAP_METERS, routingDistanceMeters, validRoutingCoordinate } from "./routing-coordinates";

/**
 * Road routing on GitHub Actions (U2SG/startrips-routing-worker, private).
 * The host cannot reach road data, so it dispatches a workflow run per job
 * and the runner POSTs each item's result back, HMAC-signed. State is
 * in-memory and single-process: a restart forgets jobs, and their items are
 * dispatched again on the next request. Results stay inside this process.
 */

export const ROUTING_WORKER_RESULTS_PATH = "/api/internal/routing-worker/results";
/** A dispatched item without a result after this is retryable. */
export const ROUTING_WORKER_IN_FLIGHT_MS = 25 * 60_000;
export const ROUTING_WORKER_RESULT_TTL_MS = 2 * 60 * 60_000;
/** Transient failures are kept briefly so a retry is not blocked for hours. */
export const ROUTING_WORKER_RETRY_TTL_MS = 5 * 60_000;
export const ROUTING_WORKER_MAX_JOBS = 3;
/** Background snapping takes one slot, leaving the rest to members waiting on screen. */
export const ROUTING_WORKER_MAX_BACKGROUND_JOBS = 1;
/** Long corridors share one graph build per job: items and summed leg distance are both capped. */
export const ROUTING_WORKER_MAX_JOB_ITEMS = 6;
export const ROUTING_WORKER_MAX_JOB_METERS = 600_000;
// workflow_dispatch inputs are limited to 65,535 characters in total.
const MAX_REQUEST_CHARS = 60_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const RETRY_AFTER_MS = 15_000;
const FINAL_CODES = new Set(["ROUTING_AREA_TOO_LARGE", "ROUTING_NO_ROADS"]);
const RESULT_ID = /^[0-9a-f]{24}$/;

export type RoutingWorkerItem =
  | {
    kind: "candidates";
    profile: RoadProfile;
    coordinates: RoutingCoordinate[];
    routingCoordinates?: RoutingCoordinate[];
    alternativesCount: 1 | 2 | 3;
    allowFerries: boolean;
  }
  | {
    kind: "point-suggestions";
    profile: RoadProfile;
    coordinate: RoutingCoordinate;
    neighbors: { before?: RoutingCoordinate; after?: RoutingCoordinate };
    allowFerries: boolean;
  };

type StoredResult =
  | { ok: true; value: unknown[]; bytes: number; expiresAt: number }
  | { ok: false; code: string; bytes: number; expiresAt: number };
type Job = { id: string; items: Map<string, RoutingWorkerItem>; dispatchedAt: number; background: boolean };

export type RoutingWorkerOptions = {
  repo: string;
  token: string;
  callbackUrl: string;
  callbackSecret: string;
  startripsRef?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

const point = ({ lat, lon }: RoutingCoordinate): RoutingCoordinate => ({ lat, lon });
const samePoint = (a: RoutingCoordinate, b: RoutingCoordinate) => a.lat === b.lat && a.lon === b.lon;

export function candidateItem(request: Omit<RouteCandidateRequest, "signal">): RoutingWorkerItem {
  const routing = request.routingCoordinates;
  // Routing on the Journey points themselves is the same item as no override.
  const override = routing && routing.some((entry, index) => !samePoint(entry, request.coordinates[index]));
  return {
    kind: "candidates",
    profile: request.profile,
    coordinates: request.coordinates.map(point),
    ...(override ? { routingCoordinates: routing.map(point) } : {}),
    alternativesCount: request.alternativesCount,
    allowFerries: request.allowFerries === true,
  };
}

export function pointSuggestionItem(request: Omit<RoutePointSuggestionRequest, "signal">): RoutingWorkerItem {
  return {
    kind: "point-suggestions",
    profile: request.profile,
    coordinate: point(request.coordinate),
    neighbors: {
      ...(request.neighbors.before ? { before: point(request.neighbors.before) } : {}),
      ...(request.neighbors.after ? { after: point(request.neighbors.after) } : {}),
    },
    allowFerries: request.allowFerries === true,
  };
}

/** Opaque and stable: the same normalized work always has the same key. */
export function routingWorkerItemKey(item: RoutingWorkerItem): string {
  return createHash("sha256").update(JSON.stringify(["routing-worker-item-v1", item])).digest("hex");
}

/** Summed direct leg distance: what the runner clips and builds a graph for. */
export function routingWorkerItemMeters(item: RoutingWorkerItem): number {
  const points = item.kind === "candidates" ? item.routingCoordinates ?? item.coordinates
    : [item.neighbors.before, item.coordinate, item.neighbors.after].filter((entry): entry is RoutingCoordinate => Boolean(entry));
  return points.slice(1).reduce((sum, entry, index) => sum + routingDistanceMeters(points[index], entry), 0);
}

function workerError(code: string): Error {
  return code in GRAPH_ERROR_MESSAGES
    ? new RoutingGraphError(code as RoutingGraphError["code"], GRAPH_ERROR_MESSAGES[code as RoutingGraphError["code"]])
    : new RoutingUnavailableError();
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;
function lonLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && validRoutingCoordinate({ lon: value[0], lat: value[1] });
}
const atPoint = (pair: [number, number], target: RoutingCoordinate) => pair[0] === target.lon && pair[1] === target.lat;

/** A worker result is trusted only as far as the HMAC; its shape must also fit the item. */
export function validWorkerCandidates(raw: unknown, item: Extract<RoutingWorkerItem, { kind: "candidates" }>): RouteCandidate[] | null {
  if (!Array.isArray(raw) || raw.length > item.alternativesCount) return null;
  const routing = item.routingCoordinates ?? item.coordinates;
  const candidates: RouteCandidate[] = [];
  for (const entry of raw) {
    const value = entry as Partial<RouteCandidate> | null;
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !RESULT_ID.test(value.id)
      || !Array.isArray(value.geometry) || value.geometry.length < 2 || value.geometry.length > 4_000
      || !value.geometry.every(lonLat)
      || !finite(value.distanceMeters) || !(value.distanceMeters > 0)
      || !finite(value.durationSeconds) || !(value.durationSeconds > 0)
      || value.provider !== "osrm" || value.profile !== item.profile || !finite(value.relevance)
      || !(value.includesFerry === undefined || (value.includesFerry === true && item.allowFerries))
      || !value.snapping || value.snapping.maxDistanceMeters !== MAX_SNAP_METERS[item.profile]
      || !Array.isArray(value.snapping.waypoints) || value.snapping.waypoints.length !== item.coordinates.length) return null;
    const waypoints: RouteCandidate["snapping"]["waypoints"] = [];
    for (const [index, waypoint] of value.snapping.waypoints.entries()) {
      const original = item.coordinates[index];
      const selected = !samePoint(routing[index], original);
      if (!waypoint || !lonLat(waypoint.requested) || !atPoint(waypoint.requested, original) || !lonLat(waypoint.snapped)
        || routingDistanceMeters(original, { lon: waypoint.snapped[0], lat: waypoint.snapped[1] }) > MAX_SELECTED_POINT_METERS
        || !nonNegative(waypoint.distanceMeters) || waypoint.distanceMeters > MAX_SELECTED_POINT_METERS
        || !nonNegative(waypoint.providerDistanceMeters)
        || (selected ? !lonLat(waypoint.selected) || !atPoint(waypoint.selected, routing[index]) : waypoint.selected !== undefined)) return null;
      waypoints.push({
        requested: [original.lon, original.lat],
        ...(selected ? { selected: [routing[index].lon, routing[index].lat] as [number, number] } : {}),
        snapped: [waypoint.snapped[0], waypoint.snapped[1]],
        distanceMeters: waypoint.distanceMeters,
        providerDistanceMeters: waypoint.providerDistanceMeters,
      });
    }
    candidates.push({
      id: value.id,
      geometry: value.geometry.map(([lon, lat]) => [lon, lat]),
      distanceMeters: value.distanceMeters,
      durationSeconds: value.durationSeconds,
      provider: "osrm",
      profile: item.profile,
      ...(value.includesFerry ? { includesFerry: true as const } : {}),
      relevance: value.relevance,
      snapping: { maxDistanceMeters: MAX_SNAP_METERS[item.profile], waypoints },
    });
  }
  return candidates;
}

export function validWorkerSuggestions(raw: unknown, item: Extract<RoutingWorkerItem, { kind: "point-suggestions" }>): RoutePointSuggestion[] | null {
  if (!Array.isArray(raw) || raw.length > 3) return null;
  const suggestions: RoutePointSuggestion[] = [];
  for (const entry of raw) {
    const value = entry as Partial<RoutePointSuggestion> | null;
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !RESULT_ID.test(value.id)
      || !validRoutingCoordinate(value.coordinate)
      || routingDistanceMeters(item.coordinate, value.coordinate) > MAX_SELECTED_POINT_METERS
      || typeof value.label !== "string" || value.label.length > 120
      || !nonNegative(value.distanceMeters) || value.distanceMeters > MAX_SELECTED_POINT_METERS
      || !(value.connected === null || typeof value.connected === "boolean")) return null;
    suggestions.push({ id: value.id, coordinate: point(value.coordinate), label: value.label,
      distanceMeters: value.distanceMeters, connected: value.connected });
  }
  return suggestions;
}

export type RoutingWorker = ReturnType<typeof createRoutingWorker>;

export function createRoutingWorker(options: RoutingWorkerOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const inFlight = new Map<string, string>();
  const results = new Map<string, StoredResult>();
  let cacheBytes = 0;

  function forget(key: string) {
    const stored = results.get(key);
    if (!stored) return;
    cacheBytes -= stored.bytes;
    results.delete(key);
  }

  function store(key: string, result: { ok: true; value: unknown[] } | { ok: false; code: string }) {
    forget(key);
    const bytes = result.ok ? JSON.stringify(result.value).length : 64;
    const ttl = result.ok || FINAL_CODES.has(result.code) ? ROUTING_WORKER_RESULT_TTL_MS : ROUTING_WORKER_RETRY_TTL_MS;
    results.set(key, { ...result, bytes, expiresAt: now() + ttl });
    cacheBytes += bytes;
    // Insertion order is age order: the bound drops the oldest results first.
    for (const oldest of results.keys()) {
      if (cacheBytes <= MAX_CACHE_BYTES) break;
      forget(oldest);
    }
  }

  function sweep() {
    const at = now();
    for (const [id, job] of jobs) {
      if (at - job.dispatchedAt < ROUTING_WORKER_IN_FLIGHT_MS) continue;
      for (const key of job.items.keys()) if (inFlight.get(key) === id) inFlight.delete(key);
      jobs.delete(id);
    }
    for (const [key, stored] of results) if (stored.expiresAt <= at) forget(key);
  }

  function encode(items: readonly [string, RoutingWorkerItem][]) {
    const request = { version: 1, startripsRef: options.startripsRef ?? "main", items: items.map(([key, item]) => ({ key, ...item })) };
    return Buffer.from(JSON.stringify(request)).toString("base64");
  }

  /** Splits work into jobs bounded by item count, summed leg distance and dispatch input size. */
  function chunks(items: readonly [string, RoutingWorkerItem][]) {
    const result: [string, RoutingWorkerItem][][] = [];
    let current: [string, RoutingWorkerItem][] = [];
    let meters = 0;
    for (const entry of items) {
      const next = [...current, entry];
      const length = routingWorkerItemMeters(entry[1]);
      if (current.length && (next.length > ROUTING_WORKER_MAX_JOB_ITEMS || meters + length > ROUTING_WORKER_MAX_JOB_METERS
        || encode(next).length > MAX_REQUEST_CHARS)) {
        result.push(current);
        current = [entry];
        meters = length;
      } else {
        current = next;
        meters += length;
      }
    }
    if (current.length) result.push(current);
    return result;
  }

  async function post(job: Job, request: string) {
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com/repos/${options.repo}/actions/workflows/route.yml/dispatches`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { job: job.id, callback: options.callbackUrl, request } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RoutingUnavailableError("The road routing worker could not be reached");
    }
    if (!response.ok) {
      console.error("Routing worker dispatch failed", response.status);
      throw new RoutingUnavailableError("The road routing worker could not be started");
    }
  }

  /**
   * Dispatches every item that has no result and is not in flight. Never
   * dispatches an item twice while it is in flight; at most three jobs run.
   */
  async function dispatch(entries: readonly [string, RoutingWorkerItem][], background: boolean): Promise<"started" | "queued"> {
    sweep();
    const fresh = [...new Map(entries.filter(([key]) => !results.has(key) && !inFlight.has(key))).entries()];
    for (const chunk of chunks(fresh)) {
      const running = [...jobs.values()];
      if (running.length >= ROUTING_WORKER_MAX_JOBS
        || (background && running.filter((job) => job.background).length >= ROUTING_WORKER_MAX_BACKGROUND_JOBS)) return "queued";
      // Registered before the request leaves, so a concurrent call cannot dispatch the same item.
      const job: Job = { id: randomUUID(), items: new Map(chunk), dispatchedAt: now(), background };
      jobs.set(job.id, job);
      for (const [key] of chunk) inFlight.set(key, job.id);
      try {
        await post(job, encode(chunk));
      } catch (error) {
        jobs.delete(job.id);
        for (const [key] of chunk) if (inFlight.get(key) === job.id) inFlight.delete(key);
        throw error;
      }
    }
    return "started";
  }

  async function answer<T>(item: RoutingWorkerItem, background: boolean): Promise<T[]> {
    const key = routingWorkerItemKey(item);
    sweep();
    const stored = results.get(key);
    if (stored) {
      if (stored.ok) return stored.value as T[];
      throw workerError(stored.code);
    }
    if (inFlight.has(key)) throw new RoutingPreparingError("building", RETRY_AFTER_MS);
    // Background work is dispatched in batches by prepareCandidates only.
    if (background) throw new RoutingPreparingError("queued", RETRY_AFTER_MS);
    const state = await dispatch([[key, item]], false);
    throw new RoutingPreparingError(state === "started" ? "building" : "queued", RETRY_AFTER_MS);
  }

  function validCandidateRequest(request: Omit<RouteCandidateRequest, "signal">) {
    const routing = request.routingCoordinates ?? request.coordinates;
    if (request.coordinates.length < 2 || request.coordinates.length > 18 || ![1, 2, 3].includes(request.alternativesCount)
      || !request.coordinates.every(validRoutingCoordinate) || routing.length !== request.coordinates.length
      || routing.some((entry, index) => !validRoutingCoordinate(entry)
        || routingDistanceMeters(entry, request.coordinates[index]) > MAX_SELECTED_POINT_METERS)) {
      throw new RoutingUnavailableError("Road route request exceeds provider limits");
    }
    const direct = request.coordinates.slice(1).reduce((sum, entry, index) => sum + routingDistanceMeters(request.coordinates[index], entry), 0);
    // Same outcome as the OSRM provider: nothing to route, nothing to dispatch.
    return direct > 0 && direct <= MAX_DIRECT_METERS;
  }

  const provider: RouteCandidateProvider = {
    id: "osrm",
    supports: () => true,
    async candidates(request) {
      if (!validCandidateRequest(request)) return [];
      return answer<RouteCandidate>(candidateItem(request), request.background === true);
    },
    async pointSuggestions(request) {
      if (!validRoutingCoordinate(request.coordinate) || Object.values(request.neighbors).some((entry) => !validRoutingCoordinate(entry))) {
        throw new RoutingUnavailableError("Road point coordinates are invalid");
      }
      const item = pointSuggestionItem(request);
      // Neighbours are unbounded, so one lookup could exceed a whole job's corridor budget.
      if (routingWorkerItemMeters(item) > ROUTING_WORKER_MAX_JOB_METERS) throw workerError("ROUTING_AREA_TOO_LARGE");
      return answer<RoutePointSuggestion>(item, false);
    },
    async prepareCandidates(requests) {
      const entries = requests.filter(validCandidateRequest).map((request) => {
        const item = candidateItem(request);
        return [routingWorkerItemKey(item), item] as [string, RoutingWorkerItem];
      });
      return dispatch(entries, true);
    },
  };

  /** Verifies and stores one signed callback. The HMAC is checked before the body is parsed. */
  function receive(raw: Uint8Array, signature: string | undefined): { status: 200 | 400 | 401 | 409 | 422; body: Record<string, unknown> } {
    const supplied = /^sha256=([0-9a-f]{64})$/.exec(signature ?? "");
    const expected = createHmac("sha256", options.callbackSecret).update(raw).digest();
    if (!supplied || !timingSafeEqual(expected, Buffer.from(supplied[1], "hex"))) {
      return { status: 401, body: { error: "ROUTING_WORKER_SIGNATURE_INVALID" } };
    }
    let message: { job?: unknown; key?: unknown; kind?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown } } | null;
    try {
      message = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { status: 400, body: { error: "INVALID_JSON" } };
    }
    sweep();
    const job = typeof message?.job === "string" ? jobs.get(message.job) : undefined;
    if (!message || !job) return { status: 409, body: { error: "ROUTING_WORKER_JOB_UNKNOWN" } };
    if (message.kind === "done") {
      // Anything the run did not answer fails now rather than after the timeout.
      for (const key of job.items.keys()) {
        if (inFlight.get(key) !== job.id) continue;
        inFlight.delete(key);
        store(key, { ok: false, code: "ROUTING_UNAVAILABLE" });
      }
      jobs.delete(job.id);
      return { status: 200, body: { ok: true } };
    }
    const key = typeof message.key === "string" ? message.key : "";
    const item = job.items.get(key);
    if (!item || item.kind !== message.kind || inFlight.get(key) !== job.id) {
      return { status: 409, body: { error: "ROUTING_WORKER_ITEM_UNKNOWN" } };
    }
    inFlight.delete(key);
    if (message.ok === true) {
      const value = item.kind === "candidates" ? validWorkerCandidates(message.result, item) : validWorkerSuggestions(message.result, item);
      if (!value) {
        store(key, { ok: false, code: "ROUTING_UNAVAILABLE" });
        return { status: 422, body: { error: "ROUTING_WORKER_RESULT_INVALID" } };
      }
      store(key, { ok: true, value });
      return { status: 200, body: { ok: true } };
    }
    const code = typeof message.error?.code === "string" && /^ROUTING_[A-Z_]{1,60}$/.test(message.error.code)
      ? message.error.code : "ROUTING_UNAVAILABLE";
    store(key, { ok: false, code });
    return { status: 200, body: { ok: true } };
  }

  return { provider, receive };
}

/**
 * Per profile, a static OSRM URL keeps serving that profile; the worker
 * serves every other one.
 */
export function withRoutingWorker(
  fixed: RouteCandidateProvider,
  hasStatic: (profile: RoadProfile) => boolean,
  worker: RouteCandidateProvider,
): RouteCandidateProvider {
  const pick = (profile: RoadProfile) => (hasStatic(profile) ? fixed : worker);
  return {
    id: "osrm",
    supports: (profile) => pick(profile).supports(profile),
    candidates: (request) => pick(request.profile).candidates(request),
    pointSuggestions: (request) => pick(request.profile).pointSuggestions(request),
    prepareCandidates: async (requests) => {
      const forWorker = requests.filter((request) => !hasStatic(request.profile));
      return forWorker.length && worker.prepareCandidates ? worker.prepareCandidates(forWorker) : "started";
    },
  };
}
