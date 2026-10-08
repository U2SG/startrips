// Graph lifecycle: queued -> fetching -> building -> ready | failed.
// One build runs at a time; graphs are disposable and evicted by LRU, idle
// TTL, live-process count and total disk bytes. Network and process work is
// injected so the state machine can be tested with fakes.
import fs from "node:fs/promises";
import path from "node:path";
import { buildCorridorQuery, CorridorError, graphId } from "./corridor.mjs";
import { BuildError } from "./errors.mjs";

export const DEFAULT_LIMITS = {
  idleTtlMs: 30 * 60_000,
  maxLive: 4,
  maxDiskBytes: 3 * 1024 ** 3,
  failedTtlMs: 60_000,
  maxQueue: 8,
};

const OSM_FILE = "map.osm";
const GRAPH_FILE = "map.osrm";

export async function directoryBytes(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(dir, entry.name);
    total += entry.isDirectory() ? await directoryBytes(target) : (await fs.stat(target)).size;
  }
  return total;
}

/** Removes every entry inside dataDir (never dataDir itself). */
export async function wipeDataDir(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  for (const name of await fs.readdir(dataDir)) {
    await fs.rm(path.join(dataDir, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

export function extractArguments(profile, osmPath, { profilesDir = "/profiles", stockProfilesDir = "/opt" } = {}) {
  // Driving uses the stock car profile, matching the static production graph.
  // Walking/cycling use the country-access wrappers exactly as documented.
  if (profile === "driving") return ["--threads", "2", "-p", `${stockProfilesDir}/car.lua`, osmPath];
  return ["--threads", "2", "-p", `${profilesDir}/${profile}.lua`,
    `--location-dependent-data=${profilesDir}/country-access.geojson`, osmPath];
}

export function createGraphStore({ dataDir, limits: overrides = {}, deps, now = Date.now, log = () => {}, toolchain = {} }) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const graphs = new Map();
  const queue = [];
  let running = null;
  let closed = false;

  const view = (entry) => ({ id: entry.id, state: entry.state, ...(entry.error ? { error: entry.error } : {}) });
  const ready = () => [...graphs.values()].filter((entry) => entry.state === "ready");

  async function evict(entry, reason) {
    if (graphs.get(entry.id) !== entry) return;
    graphs.delete(entry.id);
    entry.evicted = true;
    log("evict", { id: entry.id, reason });
    await entry.routed?.stop().catch(() => {});
    await fs.rm(entry.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  async function makeRoom(entry) {
    const byAge = () => ready().filter((other) => other !== entry).sort((a, b) => a.lastUsed - b.lastUsed);
    while (ready().length >= limits.maxLive && byAge().length) await evict(byAge()[0], "max-live");
    const diskTotal = () => [...graphs.values()].reduce((sum, other) => sum + (other.state === "ready" ? other.bytes : 0), 0);
    while (diskTotal() + entry.bytes > limits.maxDiskBytes && byAge().length) await evict(byAge()[0], "disk-cap");
  }

  async function build(entry) {
    entry.state = "fetching";
    await fs.rm(entry.dir, { recursive: true, force: true, maxRetries: 3 });
    await fs.mkdir(entry.dir, { recursive: true });
    await deps.fetchOsm({ query: entry.query, destination: path.join(entry.dir, OSM_FILE) });
    if (entry.evicted) return;
    entry.state = "building";
    const run = async (binary, args, cwd = entry.dir) => {
      try { await deps.runTool(binary, args, { cwd }); }
      catch (error) {
        if (/no edges|no nodes/i.test(String(error?.output ?? error?.message ?? ""))) {
          throw new BuildError("ROUTING_NO_ROADS", "The corridor contains no routable roads");
        }
        throw Object.assign(new BuildError("ROUTING_GRAPH_BUILD_FAILED", `${binary} failed`), { output: String(error?.output ?? "").slice(-1_500) });
      }
    };
    // Stock profiles require("lib/...") relative to the working directory, so
    // extraction runs in the stock profile directory, as the image defaults to.
    await run("osrm-extract", extractArguments(entry.profile, path.join(entry.dir, OSM_FILE), toolchain),
      toolchain.stockProfilesDir ?? "/opt");
    await run("osrm-partition", ["--threads", "2", GRAPH_FILE]);
    await run("osrm-customize", ["--threads", "2", GRAPH_FILE]);
    await fs.rm(path.join(entry.dir, OSM_FILE), { force: true });
    entry.bytes = await directoryBytes(entry.dir);
    if (entry.bytes > limits.maxDiskBytes) throw new BuildError("ROUTING_AREA_TOO_LARGE", "Graph exceeds the disk cap");
    await makeRoom(entry);
    if (entry.evicted || closed) return;
    const routed = await deps.startRouted({ dir: entry.dir, file: GRAPH_FILE }).catch(() => {
      throw new BuildError("ROUTING_GRAPH_BUILD_FAILED", "osrm-routed did not start");
    });
    entry.routed = routed;
    entry.state = "ready";
    entry.lastUsed = now();
    routed.exited.then(() => {
      // An unexpected exit leaves no usable graph; the next request rebuilds it.
      if (!entry.evicted && graphs.get(entry.id) === entry) void evict(entry, "routed-exit");
    });
  }

  function pump() {
    if (running || closed) return;
    const id = queue.shift();
    const entry = id && graphs.get(id);
    if (!entry) { if (queue.length) pump(); return; }
    running = build(entry).catch(async (error) => {
      const code = error instanceof BuildError ? error.code : "ROUTING_GRAPH_BUILD_FAILED";
      log("failed", { id: entry.id, code, message: error?.message, ...(error?.output ? { output: error.output } : {}) });
      await entry.routed?.stop().catch(() => {});
      entry.routed = null;
      await fs.rm(entry.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      if (graphs.get(entry.id) === entry) {
        entry.state = "failed";
        entry.error = code;
        entry.failedAt = now();
      }
    }).finally(() => {
      running = null;
      pump();
    });
  }

  function enqueue(entry) {
    entry.state = "queued";
    entry.error = undefined;
    entry.evicted = false;
    queue.push(entry.id);
    pump();
  }

  return {
    limits,
    /** Validated input in; throws CorridorError for area limits or a full queue. */
    ensure(profile, points, detail = "standard") {
      if (closed) throw new CorridorError("ROUTING_BUILDER_BUSY", "Builder is shutting down");
      const query = buildCorridorQuery(profile, points, detail);
      const id = graphId(profile, query, detail);
      let entry = graphs.get(id);
      if (entry?.state === "failed" && now() - entry.failedAt >= limits.failedTtlMs) {
        graphs.delete(id);
        entry = undefined;
      }
      if (!entry) {
        if (queue.length >= limits.maxQueue) throw new CorridorError("ROUTING_BUILDER_BUSY", "Too many graphs are queued");
        entry = { id, profile, query, dir: path.join(dataDir, id), state: "queued", bytes: 0, lastUsed: now(), routed: null };
        graphs.set(id, entry);
        enqueue(entry);
      }
      entry.lastUsed = now();
      return view(entry);
    },
    get(id) {
      const entry = graphs.get(id);
      if (!entry) return null;
      // A status read is not use: only ensure() and proxied queries keep a graph alive.
      return view(entry);
    },
    /** The local routed port of a ready graph, touching its LRU timestamp. */
    target(id) {
      const entry = graphs.get(id);
      if (!entry) return { status: 404 };
      if (entry.state !== "ready" || !entry.routed) return { status: 409, state: entry.state };
      entry.lastUsed = now();
      return { status: 200, port: entry.routed.port };
    },
    async sweep() {
      const time = now();
      for (const entry of [...graphs.values()]) {
        if (entry.state === "ready" && time - entry.lastUsed >= limits.idleTtlMs) await evict(entry, "idle");
        else if (entry.state === "failed" && time - entry.failedAt >= limits.failedTtlMs) graphs.delete(entry.id);
      }
    },
    stats() {
      const values = [...graphs.values()];
      return {
        graphs: values.length,
        ready: values.filter((entry) => entry.state === "ready").length,
        queued: queue.length,
        building: running ? 1 : 0,
        diskBytes: values.reduce((sum, entry) => sum + (entry.state === "ready" ? entry.bytes : 0), 0),
      };
    },
    /** Resolves when the current build (if any) settles; used by tests and drain. */
    idle: async () => { while (running) await running; },
    async close() {
      closed = true;
      queue.length = 0;
      // A running build is abandoned with the container; its directory is
      // wiped at the next boot.
      for (const entry of [...graphs.values()]) await evict(entry, "shutdown");
    },
  };
}
