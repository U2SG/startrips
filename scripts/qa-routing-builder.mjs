// Real routing-builder image against a fixture Overpass serving anonymous
// miniature roads; never contacts overpass-api.de and never uses Journey data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";

const image = "startrips-routing-builder:qa";
const docker = (args, timeout = 120_000) => execFileSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 20_000_000 }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let container = null;

// A 6 x 6 grid of residential streets near 1N 1E, usable by car, foot and bicycle.
function gridNetwork() {
  const nodes = [];
  const ways = [];
  const id = (row, column) => row * 10 + column + 1;
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      nodes.push(`<node id="${id(row, column)}" lat="${(1 + row * 0.002).toFixed(4)}" lon="${(1 + column * 0.002).toFixed(4)}"/>`);
    }
  }
  const way = (wayId, refs) => `<way id="${wayId}">${refs.map((ref) => `<nd ref="${ref}"/>`).join("")}<tag k="highway" v="residential"/></way>`;
  for (let index = 0; index < 6; index += 1) {
    ways.push(way(1_000 + index, Array.from({ length: 6 }, (_, column) => id(index, column))));
    ways.push(way(2_000 + index, Array.from({ length: 6 }, (_, row) => id(row, index))));
  }
  // A turn restriction exercises the rel(bw) output that osrm-extract must accept.
  const restriction = '<relation id="3000"><member type="way" ref="1000" role="from"/><member type="node" ref="2" role="via"/>'
    + '<member type="way" ref="2001" role="to"/><tag k="restriction" v="no_left_turn"/><tag k="type" v="restriction"/></relation>';
  // Same envelope as Overpass `[out:xml]` with `out;` (body): note, meta, then elements.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="Overpass API 0.7.62 fixture">\n`
    + "<note>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</note>\n"
    + '<meta osm_base="2026-10-08T00:00:00Z"/>\n'
    + `${nodes.join("\n")}\n${ways.join("\n")}\n${restriction}\n</osm>\n`;
}

const fixtureHits = { outage: 0, userAgents: new Set() };
const fixture = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    fixtureHits.userAgents.add(request.headers["user-agent"]);
    const query = new URLSearchParams(body).get("data") ?? "";
    const first = /around:\d+,(-?[\d.]+),(-?[\d.]+)\)/.exec(query);
    const lat = Number(first?.[1]);
    if (!query.startsWith("[out:xml][timeout:180][maxsize:536870912];") || !query.includes("rel(bw.roads)[type=restriction]")) {
      response.writeHead(400).end("unexpected query");
    } else if (lat === 5) {
      response.writeHead(200, { "Content-Type": "application/osm3s+xml" }).end('<?xml version="1.0"?><osm version="0.6"></osm>');
    } else if (lat === 6) {
      fixtureHits.outage += 1;
      response.writeHead(504).end("Gateway Timeout");
    } else if (lat === 7) {
      response.writeHead(200, { "Content-Type": "application/osm3s+xml" })
        .end('<?xml version="1.0"?><osm version="0.6"><remark> runtime error: Query run out of memory using about 512 MB of RAM. </remark></osm>');
    } else {
      response.writeHead(200, { "Content-Type": "application/osm3s+xml" }).end(gridNetwork());
    }
  });
});

try {
  await new Promise((resolve) => fixture.listen(0, "0.0.0.0", resolve));
  const fixturePort = fixture.address().port;
  docker(["build", "-t", image, "-f", "routing-builder/Dockerfile", "."], 1_200_000);
  container = docker(["run", "--detach", "--rm", "-p", "127.0.0.1::8080",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `ROUTING_BUILDER_OVERPASS_URL=http://host.docker.internal:${fixturePort}/api/interpreter`,
    "-e", "APP_ORIGIN=https://qa.startrips.invalid",
    "-e", "ROUTING_BUILDER_IDLE_TTL_MS=8000",
    "-e", "ROUTING_BUILDER_SWEEP_INTERVAL_MS=1000",
    "-e", "ROUTING_BUILDER_RETRY_DELAY_MS=200",
    image]);
  const port = docker(["port", container, "8080/tcp"]).split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init) => {
    const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() };
  };
  const post = (body) => call("/graphs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
    try { healthy = (await call("/health")).status === 200; } catch { await sleep(250); }
  }
  assert.ok(healthy, "routing-builder did not become healthy");

  async function settle(id) {
    const phases = new Set();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const { body } = await call(`/graphs/${id}`);
      phases.add(body.state);
      if (body.state === "ready" || body.state === "failed") return { ...body, phases: [...phases] };
      await sleep(500);
    }
    throw new Error(`graph ${id} did not settle`);
  }

  const points = [{ lat: 1.0005, lon: 1.0005 }, { lat: 1.0095, lon: 1.0095 }];
  const ready = {};
  for (const profile of ["driving", "walking", "cycling"]) {
    const created = await post({ profile, points });
    assert.equal(created.status, 200);
    assert.match(created.body.id, /^[0-9a-f]{64}$/);
    const settled = await settle(created.body.id);
    assert.equal(settled.state, "ready", `${profile} graph failed: ${settled.error}`);
    const again = await post({ profile, points });
    assert.deepEqual(again.body, { id: created.body.id, state: "ready" }, "same corridor must reuse its graph");
    const route = await call(`/graphs/${created.body.id}/route/v1/${profile}/1.0005,1.0005;1.0095,1.0095?overview=false&steps=true`);
    assert.equal(route.body.code, "Ok", `${profile} route through the proxy`);
    assert.ok(route.body.routes[0].legs.every((leg) => leg.steps.every((step) => step.mode === profile || step.mode === "pushing bike")));
    const nearest = await call(`/graphs/${created.body.id}/nearest/v1/${profile}/1.0011,1.0049?number=3`);
    assert.equal(nearest.body.code, "Ok", `${profile} nearest through the proxy`);
    ready[profile] = created.body.id;
    evidence.push({ profile, phases: settled.phases, route: route.body.code, nearest: nearest.body.code });
  }

  // The escalation tier is a separate graph for the same points.
  const extended = await post({ profile: "driving", points, detail: "extended" });
  assert.equal(extended.status, 200);
  assert.notEqual(extended.body.id, ready.driving, "the extended tier must have its own graph identity");
  assert.equal((await settle(extended.body.id)).state, "ready", "extended driving graph");
  ready.extended = extended.body.id;
  evidence.push({ scenario: "extended", id: extended.body.id });

  assert.equal((await post({ profile: "driving", points: [{ lat: 1, lon: 1, extra: true }] })).status, 400);
  assert.equal((await post({ profile: "driving", points, detail: "maximal" })).status, 400);
  assert.equal((await call(`/graphs/${ready.driving}/table/v1/driving/1,1;1.01,1.01`)).status, 404, "only route/nearest are proxied");
  const tooFar = await post({ profile: "driving", points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 4 }] });
  assert.deepEqual(tooFar, { status: 422, body: { error: "ROUTING_AREA_TOO_LARGE" } });
  evidence.push({ scenario: "too-far", status: tooFar.status });

  for (const [lat, code] of [[5, "ROUTING_NO_ROADS"], [6, "ROUTING_DATA_UNAVAILABLE"], [7, "ROUTING_AREA_TOO_LARGE"]]) {
    const created = await post({ profile: "walking", points: [{ lat, lon: 1 }, { lat, lon: 1.01 }] });
    const settled = await settle(created.body.id);
    assert.deepEqual([settled.state, settled.error], ["failed", code], `fixture lat ${lat}`);
    assert.deepEqual((await post({ profile: "walking", points: [{ lat, lon: 1 }, { lat, lon: 1.01 }] })).body.state, "failed", "failures are cached");
    evidence.push({ scenario: `fixture-${lat}`, error: settled.error });
  }
  assert.equal(fixtureHits.outage, 2, "a 504 is retried exactly once");
  assert.deepEqual([...fixtureHits.userAgents], ["startrips-routing-builder/1 (+https://qa.startrips.invalid)"]);

  // Status reads do not count as use, so polling them cannot keep a graph alive.
  let evicted = false;
  for (let attempt = 0; attempt < 80 && !evicted; attempt += 1) {
    await sleep(500);
    const statuses = await Promise.all(Object.values(ready).map(async (id) => (await call(`/graphs/${id}`)).status));
    evicted = statuses.every((status) => status === 404);
  }
  assert.ok(evicted, "idle graph was not evicted");
  assert.equal((await call(`/graphs/${ready.driving}/route/v1/driving/1.0005,1.0005;1.0095,1.0095`)).status, 404);
  const health = await call("/health");
  assert.equal(health.body.ready, 0);
  assert.equal(health.body.diskBytes, 0);
  evidence.push({ scenario: "idle-eviction", health: health.body });

  await fs.mkdir("artifacts/routing-builder", { recursive: true });
  await fs.writeFile("artifacts/routing-builder/evidence.json", JSON.stringify({ image, results: evidence }, null, 2));
  console.log(`Routing builder QA passed: ${evidence.length} checks`);
} finally {
  if (container) { try { docker(["stop", "--time", "5", container]); } catch {} }
  fixture.close();
}
