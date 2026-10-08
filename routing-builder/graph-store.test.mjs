import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BuildError } from "./errors.mjs";
import { createGraphStore, wipeDataDir } from "./graph-store.mjs";

let dataDir;
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "startrips-graph-store-")); });
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }); });

function harness({ limits = {}, graphBytes = 1_000, fetchOsm } = {}) {
  let time = 0;
  const calls = [];
  const routed = [];
  const store = createGraphStore({
    dataDir,
    limits,
    now: () => time,
    deps: {
      fetchOsm: fetchOsm ?? (async ({ destination }) => { calls.push("fetch"); await fs.writeFile(destination, "<osm/>"); }),
      async runTool(binary, args, { cwd }) {
        calls.push(binary);
        if (binary === "osrm-extract") {
          expect(cwd).toBe("/opt");
          expect(await fs.readFile(args.at(-1), "utf8")).toBe("<osm/>");
          await fs.writeFile(path.join(path.dirname(args.at(-1)), "map.osrm"), Buffer.alloc(graphBytes));
        }
      },
      async startRouted({ dir }) {
        let exit;
        const handle = { port: 5_000 + routed.length, dir, stopped: false,
          exited: new Promise((resolve) => { exit = resolve; }),
          crash: () => exit(1),
          async stop() { handle.stopped = true; exit(0); } };
        routed.push(handle);
        return handle;
      },
    },
  });
  return { store, calls, routed, advance: (ms) => { time += ms; } };
}

const leg = (offset) => [{ lat: 0, lon: offset }, { lat: 0, lon: offset + 0.05 }];

describe("graph store lifecycle", () => {
  it("builds once, deletes the extract, serves the graph and stays idempotent", async () => {
    const { store, calls, routed } = harness();
    const first = store.ensure("walking", leg(0));
    expect(["queued", "fetching"]).toContain(first.state);
    expect(store.ensure("walking", leg(0)).id).toBe(first.id);
    await store.idle();
    expect(store.ensure("walking", leg(0))).toEqual({ id: first.id, state: "ready" });
    expect(calls).toEqual(["fetch", "osrm-extract", "osrm-partition", "osrm-customize"]);
    expect(routed).toHaveLength(1);
    await expect(fs.access(path.join(dataDir, first.id, "map.osm"))).rejects.toThrow();
    expect(store.target(first.id)).toEqual({ status: 200, port: 5_000 });
    expect(store.target("f".repeat(64))).toEqual({ status: 404 });
  });

  it("builds one graph at a time in FIFO order", async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { store } = harness({ fetchOsm: async ({ destination }) => {
      order.push(path.basename(path.dirname(destination)));
      if (order.length === 1) await gate;
      await fs.writeFile(destination, "<osm/>");
    } });
    const a = store.ensure("driving", leg(0));
    const b = store.ensure("driving", leg(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get(a.id).state).toBe("fetching");
    expect(store.get(b.id).state).toBe("queued");
    release();
    await store.idle();
    expect(order).toEqual([a.id, b.id]);
  });

  it("evicts idle graphs after the TTL and stops their routed process", async () => {
    const { store, routed, advance } = harness({ limits: { idleTtlMs: 1_000 } });
    const { id } = store.ensure("cycling", leg(0));
    await store.idle();
    advance(999);
    store.target(id);
    advance(999);
    await store.sweep();
    expect(store.get(id).state).toBe("ready");
    advance(1_000);
    await store.sweep();
    expect(store.get(id)).toBeNull();
    expect(routed[0].stopped).toBe(true);
    await expect(fs.access(path.join(dataDir, id))).rejects.toThrow();
  });

  it("keeps at most the live-process limit by evicting the least recently used graph", async () => {
    const { store, advance } = harness({ limits: { maxLive: 2 } });
    const ids = [];
    for (const offset of [0, 1, 2]) {
      ids.push(store.ensure("driving", leg(offset)).id);
      await store.idle();
      advance(10);
    }
    expect(store.get(ids[0])).toBeNull();
    expect(store.stats().ready).toBe(2);
  });

  it("enforces the total disk cap with LRU eviction and fails a single oversized graph", async () => {
    const { store, advance } = harness({ limits: { maxDiskBytes: 2_500 }, graphBytes: 1_000 });
    const a = store.ensure("driving", leg(0)).id; await store.idle(); advance(10);
    const b = store.ensure("driving", leg(1)).id; await store.idle(); advance(10);
    store.target(a); advance(10);
    const c = store.ensure("driving", leg(2)).id; await store.idle();
    expect(store.get(b)).toBeNull();
    expect(store.get(a).state).toBe("ready");
    expect(store.get(c).state).toBe("ready");
    const big = harness({ limits: { maxDiskBytes: 500 } });
    const huge = big.store.ensure("walking", leg(5)).id;
    await big.store.idle();
    expect(big.store.get(huge)).toEqual({ id: huge, state: "failed", error: "ROUTING_AREA_TOO_LARGE" });
    expect(big.routed).toHaveLength(0);
  });

  it("caches a failure for the failed TTL, cleans its directory, then retries", async () => {
    let attempts = 0;
    const { store, advance } = harness({ limits: { failedTtlMs: 60_000 }, fetchOsm: async ({ destination }) => {
      attempts += 1;
      if (attempts === 1) throw new BuildError("ROUTING_DATA_UNAVAILABLE", "down");
      await fs.writeFile(destination, "<osm/>");
    } });
    const { id } = store.ensure("walking", leg(0));
    await store.idle();
    expect(store.ensure("walking", leg(0))).toEqual({ id, state: "failed", error: "ROUTING_DATA_UNAVAILABLE" });
    await expect(fs.access(path.join(dataDir, id))).rejects.toThrow();
    advance(59_999);
    expect(store.ensure("walking", leg(0)).state).toBe("failed");
    advance(1);
    expect(store.ensure("walking", leg(0)).state).not.toBe("failed");
    await store.idle();
    expect(store.get(id).state).toBe("ready");
  });

  it("maps an empty extraction to no roads and drops a graph whose routed process exits", async () => {
    const noRoads = harness();
    noRoads.store.ensure("walking", leg(0));
    const empty = createGraphStore({ dataDir, deps: {
      fetchOsm: async ({ destination }) => fs.writeFile(destination, "<osm/>"),
      runTool: async () => { throw Object.assign(new Error("exit 1"), { output: "[error] There are no edges remaining after parsing." }); },
      startRouted: async () => { throw new Error("unreachable"); },
    } });
    const { id } = empty.ensure("cycling", leg(3));
    await empty.idle();
    expect(empty.get(id).error).toBe("ROUTING_NO_ROADS");
    await noRoads.store.idle();
    const [handle] = noRoads.routed;
    handle.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(noRoads.store.stats().ready).toBe(0);
  });

  it("refuses work past the queue cap and wipes stale data at boot", async () => {
    const { store } = harness({ limits: { maxQueue: 1 }, fetchOsm: () => new Promise(() => {}) });
    store.ensure("driving", leg(0));
    store.ensure("driving", leg(1));
    expect(() => store.ensure("driving", leg(2))).toThrow(expect.objectContaining({ code: "ROUTING_BUILDER_BUSY" }));
    await fs.mkdir(path.join(dataDir, "partial"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "partial", "map.osm"), "x");
    await wipeDataDir(dataDir);
    expect(await fs.readdir(dataDir)).toEqual([]);
  });
});
