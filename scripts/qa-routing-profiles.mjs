// Real extraction and routing on anonymous roads; never publishes Journey data.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const image = "ghcr.io/project-osrm/osrm-backend@sha256:c29a50d67b9be17d10773fa2b52bb045ee3fbb8f42e5f9d1c671ce0d9bb21f37";
const expectedConfig = "sha256:dcb9227f93ebcfe9b645b71308fc2b3a6084e62616b45402348c212c711a301d";
const profiles = path.resolve("deploy/routing-profiles");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "startrips-routing-profile-"));
const evidence = [];
const containers = [];
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 }).trim();
const node = (id, lat, lon) => `<node id="${id}" lat="${lat}" lon="${lon}"/>`;
const way = (id, refs, tags) => `<way id="${id}">${refs.map((ref) => `<nd ref="${ref}"/>`).join("")}${Object.entries(tags).map(([key, value]) => `<tag k="${key}" v="${value}"/>`).join("")}</way>`;

try {
  docker("pull", image);
  assert.equal(docker("image", "inspect", "--format", "{{.Id}}", image), expectedConfig,
    "CI and production must use the same pinned OSRM runtime configuration");
  for (const profile of ["walking", "cycling"]) {
    const modeTag = profile === "walking" ? "foot" : "bicycle";
    const separated = profile === "walking" ? "sidewalk" : "cycleway";
    const cases = [
      { name: "permitted-trunk", tags: { highway: "trunk" }, connected: true },
      { name: "permitted-trunk-link", tags: { highway: "trunk_link" }, connected: true },
      { name: "motorroad", tags: { highway: "trunk", motorroad: "yes" }, connected: false },
      { name: "private", tags: { highway: "trunk", access: "private" }, connected: false },
      { name: "access-no", tags: { highway: "trunk", access: "no" }, connected: false },
      { name: "mode-no", tags: { highway: "trunk", [modeTag]: "no" }, connected: false },
      { name: "motorway", tags: { highway: "motorway" }, connected: false },
      { name: "use-sidepath", tags: { highway: "trunk", [modeTag]: "use_sidepath" }, connected: false },
      { name: "separate-path", tags: { highway: "trunk", [separated]: "separate" }, connected: false },
      { name: "oneway", tags: { highway: "trunk", [profile === "walking" ? "oneway:foot" : "oneway"]: "yes", ...(profile === "cycling" ? { foot: "no" } : {}) }, connected: true, reverse: false },
      // Extract these after permitted ways to detect profile state leaking.
      { name: "unknown-region", tags: { highway: "trunk" }, connected: false, unknown: true },
      { name: "unknown-explicit-yes", tags: { highway: "trunk", [modeTag]: "yes" }, connected: true, unknown: true },
    ];
    const nodes = [];
    const ways = [];
    for (const [index, entry] of cases.entries()) {
      const lat = entry.unknown ? 1 + index * 0.03 : -43.5 + index * 0.03;
      const lon = entry.unknown ? 1 : 172.5;
      const ids = [0, 1, 2, 3].map((offset) => index * 10 + offset + 1);
      ids.forEach((id, offset) => nodes.push(node(id, lat, lon + offset * 0.002)));
      ways.push(way(index * 10 + 1, ids.slice(0, 2), { highway: "residential" }),
        way(index * 10 + 2, ids.slice(1, 3), entry.tags),
        way(index * 10 + 3, ids.slice(2), { highway: "residential" }));
      entry.coordinates = `${lon + 0.0005},${lat};${lon + 0.0055},${lat}`;
    }
    const data = path.join(work, profile);
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, "test.osm"), `<?xml version="1.0"?><osm version="0.6">${nodes.join("")}${ways.join("")}</osm>`);
    const run = (binary, ...args) => docker("run", "--rm", "--network", "none", "-v", `${data}:/data`, "-v", `${profiles}:/profiles:ro`, image, binary, "--threads", "1", ...args);
    run("osrm-extract", "-p", `/profiles/${profile}.lua`, "--location-dependent-data=/profiles/country-access.geojson", "/data/test.osm");
    run("osrm-partition", "/data/test.osrm");
    run("osrm-customize", "/data/test.osrm");
    const id = docker("run", "--detach", "--rm", "-p", "127.0.0.1::5000", "-v", `${data}:/data:ro`, image,
      "osrm-routed", "--algorithm", "mld", "--threads", "1", "/data/test.osrm");
    containers.push(id);
    const port = docker("port", id, "5000/tcp").split(":").at(-1);
    const route = async (coordinates) => {
      const response = await fetch(`http://127.0.0.1:${port}/route/v1/${profile}/${coordinates}?overview=false&steps=true&radiuses=5;5`, { signal: AbortSignal.timeout(5_000) });
      assert.ok([200, 400].includes(response.status), `OSRM HTTP failure: ${response.status}`);
      return response.json();
    };
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      try { await route(cases[0].coordinates); ready = true; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "OSRM did not start for profile QA");
    for (const entry of cases) {
      const result = await route(entry.coordinates);
      assert.equal(result.code === "Ok", entry.connected, `${profile} ${entry.name}: ${result.code}`);
      if (entry.connected) assert.ok(result.routes[0].legs.every((leg) => leg.steps.every((step) => step.mode === profile)),
        `${profile} ${entry.name} used another transport mode`);
      evidence.push({ profile, scenario: entry.name, code: result.code });
      if (entry.reverse === false) {
        const reverse = await route(entry.coordinates.split(";").reverse().join(";"));
        assert.notEqual(reverse.code, "Ok", `${profile} one-way restriction was ignored`);
        evidence.push({ profile, scenario: "oneway-reverse", code: reverse.code });
      }
    }
    docker("stop", "--time", "5", id);
    containers.pop();
  }
  await fs.mkdir("artifacts/route-candidates", { recursive: true });
  await fs.writeFile("artifacts/route-candidates/routing-profile-evidence.json", JSON.stringify({ image, expectedConfig, results: evidence }, null, 2));
  console.log(`Country routing profile QA passed: ${evidence.length} real graph checks`);
} finally {
  for (const id of containers) { try { docker("stop", "--time", "5", id); } catch {} }
  // Only the exact temporary directory created by this process is removed.
  if (path.dirname(work) === os.tmpdir() && path.basename(work).startsWith("startrips-routing-profile-")) {
    // Docker owns generated files on hosted Linux; remove via the same scoped mount.
    try { docker("run", "--rm", "--network", "none", "-v", `${work}:/cleanup`, image, "sh", "-c", "rm -f /cleanup/walking/test.osrm* /cleanup/cycling/test.osrm*"); } catch {}
    await fs.rm(work, { recursive: true, force: true });
  }
}
