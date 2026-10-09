import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { RouteCandidate } from "../../src/journey/types";
import { createRoutingWorkerRoutes } from "../routes/routing-worker";
import {
  candidateItem,
  createRoutingWorker,
  ROUTING_WORKER_IN_FLIGHT_MS,
  ROUTING_WORKER_MAX_JOBS,
  routingWorkerItemKey,
} from "./github-worker";
import { RoutingGraphError, RoutingPreparingError } from "./route-candidate-provider";

const secret = "s".repeat(32);
const from = { lat: 0, lon: 0 };
const to = { lat: 0, lon: 0.03 };
const request = { coordinates: [from, to], profile: "driving" as const, alternativesCount: 1 as const, allowFerries: false };
const candidate: RouteCandidate = {
  id: "a".repeat(24),
  geometry: [[from.lon, from.lat], [to.lon, to.lat]],
  distanceMeters: 3_500,
  durationSeconds: 300,
  provider: "osrm",
  profile: "driving",
  relevance: 700,
  snapping: { maxDistanceMeters: 10_000, waypoints: [
    { requested: [from.lon, from.lat], snapped: [from.lon, from.lat], distanceMeters: 2, providerDistanceMeters: 2 },
    { requested: [to.lon, to.lat], snapped: [to.lon, to.lat], distanceMeters: 3, providerDistanceMeters: 3 },
  ] },
};

function setup() {
  let now = Date.parse("2026-10-09T00:00:00Z");
  const dispatched: { job: string; request: { items: { key: string }[] } }[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const inputs = JSON.parse(String(init?.body)).inputs;
    dispatched.push({ job: inputs.job, request: JSON.parse(Buffer.from(inputs.request, "base64").toString("utf8")) });
    return new Response(null, { status: 204 });
  });
  const worker = createRoutingWorker({
    repo: "U2SG/startrips-routing-worker", token: "token", callbackUrl: "https://host/api/internal/routing-worker/results",
    callbackSecret: secret, fetcher: fetcher as typeof fetch, now: () => now,
  });
  const signed = (message: unknown, key = secret) => {
    const raw = new TextEncoder().encode(JSON.stringify(message));
    return { raw, signature: `sha256=${createHmac("sha256", key).update(raw).digest("hex")}` };
  };
  const callback = (message: unknown, key = secret) => {
    const { raw, signature } = signed(message, key);
    return worker.receive(raw, signature);
  };
  return { worker, fetcher, dispatched, signed, callback, advance: (ms: number) => { now += ms; } };
}

const signal = new AbortController().signal;
const preparing = (promise: Promise<unknown>) => promise.then(() => null, (error) => error);

describe("GitHub Actions routing worker", () => {
  it("answers 202-style preparing, dispatches once, and returns the signed result", async () => {
    const { worker, fetcher, dispatched, callback } = setup();
    const first = await preparing(worker.provider.candidates({ ...request, signal }));
    expect(first).toBeInstanceOf(RoutingPreparingError);
    expect(first.phase).toBe("building");
    // The same item is never dispatched twice while in flight.
    await preparing(worker.provider.candidates({ ...request, routingCoordinates: [from, to], signal }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [{ job, request: sent }] = dispatched;
    expect(sent.items.map((item) => item.key)).toEqual([routingWorkerItemKey(candidateItem(request))]);
    expect(callback({ job, key: sent.items[0].key, kind: "candidates", ok: true, result: [{ ...candidate, extra: "dropped" }] }).status).toBe(200);
    expect(await worker.provider.candidates({ ...request, signal })).toEqual([candidate]);
    expect(callback({ job, kind: "done" }).status).toBe(200);
  });

  it("verifies the HMAC over the raw body before anything else, and refuses unknown jobs and items", async () => {
    const { worker, dispatched, callback, signed } = setup();
    await preparing(worker.provider.candidates({ ...request, signal }));
    const [{ job, request: sent }] = dispatched;
    const message = { job, key: sent.items[0].key, kind: "candidates", ok: true, result: [candidate] };
    expect(callback(message, "x".repeat(32))).toMatchObject({ status: 401 });
    expect(worker.receive(new TextEncoder().encode("not json"), undefined)).toMatchObject({ status: 401 });
    const { raw, signature } = signed(message);
    const tampered = new Uint8Array(raw);
    tampered[tampered.length - 2] ^= 1;
    expect(worker.receive(tampered, signature)).toMatchObject({ status: 401 });
    expect(callback({ ...message, job: "stale-job" })).toMatchObject({ status: 409, body: { error: "ROUTING_WORKER_JOB_UNKNOWN" } });
    expect(callback({ ...message, key: "f".repeat(64) })).toMatchObject({ status: 409, body: { error: "ROUTING_WORKER_ITEM_UNKNOWN" } });
    expect(callback(message)).toMatchObject({ status: 200 });
    // A repeated delivery of an answered item is not stored twice.
    expect(callback(message)).toMatchObject({ status: 409 });
  });

  it("rejects results that do not fit the item and fails unanswered items when the run is done", async () => {
    const { worker, dispatched, callback } = setup();
    await preparing(worker.provider.candidates({ ...request, signal }));
    await preparing(worker.provider.candidates({ ...request, alternativesCount: 2, signal }));
    const [one, two] = dispatched;
    const wrongProfile = { ...candidate, profile: "walking" };
    expect(callback({ job: one.job, key: one.request.items[0].key, kind: "candidates", ok: true, result: [wrongProfile] }))
      .toMatchObject({ status: 422 });
    await expect(worker.provider.candidates({ ...request, signal })).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE" });
    expect(callback({ job: two.job, kind: "done" }).status).toBe(200);
    await expect(worker.provider.candidates({ ...request, alternativesCount: 2, signal })).rejects.toMatchObject({ code: "ROUTING_UNAVAILABLE" });
  });

  it("maps worker failure codes to the existing routing errors", async () => {
    const { worker, dispatched, callback } = setup();
    await preparing(worker.provider.candidates({ ...request, signal }));
    const [{ job, request: sent }] = dispatched;
    callback({ job, key: sent.items[0].key, kind: "candidates", ok: false, error: { code: "ROUTING_NO_ROADS" } });
    const error = await preparing(worker.provider.candidates({ ...request, signal }));
    expect(error).toBeInstanceOf(RoutingGraphError);
    expect(error.code).toBe("ROUTING_NO_ROADS");
  });

  it("re-dispatches an item whose run timed out and runs at most three jobs", async () => {
    const { worker, fetcher, advance } = setup();
    const at = (lat: number) => ({ ...request, coordinates: [{ lat, lon: 0 }, { lat: lat + 0.01, lon: 0 }], signal });
    for (let index = 0; index < ROUTING_WORKER_MAX_JOBS + 1; index += 1) await preparing(worker.provider.candidates(at(index / 10)));
    expect(fetcher).toHaveBeenCalledTimes(ROUTING_WORKER_MAX_JOBS);
    const queued = await preparing(worker.provider.candidates(at(0.3)));
    expect(queued.phase).toBe("queued");
    advance(ROUTING_WORKER_IN_FLIGHT_MS);
    await preparing(worker.provider.candidates(at(0)));
    expect(fetcher).toHaveBeenCalledTimes(ROUTING_WORKER_MAX_JOBS + 1);
  });

  it("batches background requests into one job, takes one background slot, and never dispatches for a background read", async () => {
    const { worker, fetcher, dispatched } = setup();
    const legs = [0, 1, 2].map((index) => ({ ...request, coordinates: [{ lat: index / 10, lon: 0 }, { lat: 0.05 + index / 10, lon: 0 }] }));
    expect(await worker.provider.prepareCandidates!(legs)).toBe("started");
    expect(dispatched[0].request.items).toHaveLength(3);
    const other = [{ ...request, coordinates: [{ lat: 1, lon: 1 }, { lat: 1.05, lon: 1 }] }];
    expect(await worker.provider.prepareCandidates!(other)).toBe("queued");
    const read = await preparing(worker.provider.candidates({ ...other[0], background: true, signal }));
    expect(read.phase).toBe("queued");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("splits background work into jobs of at most 6 items and about 600 km of summed legs", async () => {
    const { worker, dispatched, callback } = setup();
    const leg = (index: number, lon: number) => ({ ...request, coordinates: [{ lat: index / 10, lon: 0 }, { lat: index / 10, lon }] });
    // Eight short legs: 6 in the first job, 2 in the next once the background slot frees.
    expect(await worker.provider.prepareCandidates!(Array.from({ length: 8 }, (_, index) => leg(index, 0.05)))).toBe("queued");
    expect(dispatched.map((job) => job.request.items.length)).toEqual([6]);
    callback({ job: dispatched[0].job, kind: "done" });
    expect(await worker.provider.prepareCandidates!(Array.from({ length: 8 }, (_, index) => leg(index, 0.05)))).toBe("started");
    expect(dispatched.map((job) => job.request.items.length)).toEqual([6, 2]);
    callback({ job: dispatched[1].job, kind: "done" });
    // Three legs of about 250 km: two fit under 600 km, the third gets its own job.
    const long = [20, 21, 22].map((index) => leg(index, 2.25));
    expect(await worker.provider.prepareCandidates!(long)).toBe("queued");
    expect(dispatched[2].request.items).toHaveLength(2);
    callback({ job: dispatched[2].job, kind: "done" });
    // The first two now hold (failed) results; only the third is dispatched again.
    expect(await worker.provider.prepareCandidates!(long)).toBe("started");
    expect(dispatched[3].request.items).toHaveLength(1);
  });

  it("serves the callback with its own 2 MB limit and the raw body", async () => {
    const { worker, dispatched, signed } = setup();
    await preparing(worker.provider.candidates({ ...request, signal }));
    const [{ job, request: sent }] = dispatched;
    const app = new Hono().route("/api/internal/routing-worker", createRoutingWorkerRoutes(worker));
    const { raw, signature } = signed({ job, key: sent.items[0].key, kind: "candidates", ok: true, result: [candidate] });
    const response = await app.request("/api/internal/routing-worker/results", {
      method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-Startrips-Signature": signature },
    });
    expect(response.status).toBe(200);
    const big = await app.request("/api/internal/routing-worker/results", {
      method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1), headers: { "X-Startrips-Signature": signature },
    });
    expect(big.status).toBe(413);
    const disabled = new Hono().route("/x", createRoutingWorkerRoutes(null));
    expect((await disabled.request("/x/results", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
