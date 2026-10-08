// Internal-only HTTP controller for on-demand corridor graphs. It has no
// authentication: it is reachable only on the Compose backend network, and it
// validates every input strictly instead.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { CorridorError, parseGraphRequest } from "./corridor.mjs";
import { createGraphStore, wipeDataDir } from "./graph-store.mjs";
import { fetchOverpass } from "./overpass.mjs";

const GRAPH_ID = /^[0-9a-f]{64}$/;
const PROXY_PATH = /^\/graphs\/([0-9a-f]{64})(\/(?:route|nearest)\/v1\/(?:driving|walking|cycling)\/[0-9.,;-]{3,2000})$/;
const MAX_BODY_BYTES = 16_384;
const MAX_QUERY_LENGTH = 8_192;

function integer(environment, name, fallback) {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadBuilderConfig(environment = process.env) {
  const overpassUrl = environment.ROUTING_BUILDER_OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter";
  const parsed = new URL(overpassUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("ROUTING_BUILDER_OVERPASS_URL must be an HTTP(S) URL without credentials");
  }
  const appOrigin = environment.APP_ORIGIN?.trim() || "unconfigured";
  return {
    port: integer(environment, "ROUTING_BUILDER_PORT", 8080),
    dataDir: environment.ROUTING_BUILDER_DATA_DIR?.trim() || "/data",
    profilesDir: environment.ROUTING_BUILDER_PROFILES_DIR?.trim() || "/profiles",
    overpassUrl,
    userAgent: `startrips-routing-builder/1 (+${appOrigin})`,
    maxOsmBytes: integer(environment, "ROUTING_BUILDER_MAX_OSM_BYTES", 400 * 1024 ** 2),
    fetchTimeoutMs: integer(environment, "ROUTING_BUILDER_FETCH_TIMEOUT_MS", 240_000),
    retryDelayMs: integer(environment, "ROUTING_BUILDER_RETRY_DELAY_MS", 15_000),
    sweepIntervalMs: integer(environment, "ROUTING_BUILDER_SWEEP_INTERVAL_MS", 60_000),
    limits: {
      idleTtlMs: integer(environment, "ROUTING_BUILDER_IDLE_TTL_MS", 30 * 60_000),
      maxLive: integer(environment, "ROUTING_BUILDER_MAX_LIVE", 4),
      maxDiskBytes: integer(environment, "ROUTING_BUILDER_MAX_DISK_BYTES", 3 * 1024 ** 3),
      failedTtlMs: integer(environment, "ROUTING_BUILDER_FAILED_TTL_MS", 60_000),
      maxQueue: integer(environment, "ROUTING_BUILDER_MAX_QUEUE", 8),
    },
  };
}

function runTool(binary, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => { output = (output + chunk).slice(-8_192); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => reject(Object.assign(error, { output })));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${binary} exited with ${code ?? signal}`), { output }));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startRouted({ dir, file }) {
  const port = await freePort();
  const child = spawn("osrm-routed", ["--algorithm", "mld", "--mmap", "--threads", "1",
    "--port", String(port), "--ip", "127.0.0.1", file], { cwd: dir, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let gone = false;
  exited.then(() => { gone = true; });
  const deadline = Date.now() + 60_000;
  while (!gone && Date.now() < deadline) {
    try {
      // Any HTTP answer, including a NoSegment 400, proves the graph is loaded.
      await fetch(`http://127.0.0.1:${port}/nearest/v1/driving/0,0`, { signal: AbortSignal.timeout(1_000) });
      return {
        port,
        exited,
        async stop() {
          if (gone) return;
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          await exited;
          clearTimeout(timer);
        },
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  child.kill("SIGKILL");
  throw new Error("osrm-routed did not become ready");
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new CorridorError("INVALID_GRAPH_REQUEST", "Body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function proxy(request, response, port, upstreamPath, search) {
  const upstream = http.request({ host: "127.0.0.1", port, method: "GET", path: upstreamPath + search, timeout: 15_000 }, (reply) => {
    const headers = { "Cache-Control": "no-store" };
    for (const name of ["content-type", "content-length"]) if (reply.headers[name]) headers[name] = reply.headers[name];
    response.writeHead(reply.statusCode ?? 502, headers);
    reply.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => { if (!response.headersSent) json(response, 502, { error: "ROUTING_GRAPH_UNAVAILABLE" }); else response.destroy(); });
  request.on("close", () => upstream.destroy());
  upstream.end();
}

export function createHandler(store) {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://routing-builder.internal");
      if (url.pathname === "/health" && request.method === "GET") return json(response, 200, { ok: true, ...store.stats() });
      if (url.pathname === "/graphs" && request.method === "POST") {
        if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          return json(response, 415, { error: "INVALID_GRAPH_REQUEST" });
        }
        let body;
        try { body = JSON.parse(await readBody(request)); }
        catch { return json(response, 400, { error: "INVALID_GRAPH_REQUEST" }); }
        const { profile, points } = parseGraphRequest(body);
        return json(response, 200, store.ensure(profile, points));
      }
      const graph = /^\/graphs\/([^/]+)$/.exec(url.pathname);
      if (graph && request.method === "GET") {
        const state = GRAPH_ID.test(graph[1]) ? store.get(graph[1]) : null;
        return state ? json(response, 200, state) : json(response, 404, { error: "GRAPH_NOT_FOUND" });
      }
      const proxied = PROXY_PATH.exec(url.pathname);
      if (proxied && request.method === "GET") {
        if (url.search.length > MAX_QUERY_LENGTH) return json(response, 400, { error: "INVALID_GRAPH_REQUEST" });
        const target = store.target(proxied[1]);
        if (target.status === 404) return json(response, 404, { error: "GRAPH_NOT_FOUND" });
        if (target.status === 409) return json(response, 409, { error: "GRAPH_NOT_READY", state: target.state });
        return proxy(request, response, target.port, proxied[2], url.search);
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof CorridorError) {
        const status = error.code === "INVALID_GRAPH_REQUEST" ? 400 : error.code === "ROUTING_BUILDER_BUSY" ? 503 : 422;
        return json(response, status, { error: error.code });
      }
      console.error("routing-builder request failed", error);
      if (!response.headersSent) json(response, 500, { error: "ROUTING_BUILDER_FAILED" });
    }
  };
}

async function main() {
  const config = loadBuilderConfig();
  // Graphs are disposable: anything left from a previous run is partial or stale.
  await wipeDataDir(config.dataDir);
  const store = createGraphStore({
    dataDir: config.dataDir,
    limits: config.limits,
    toolchain: { profilesDir: config.profilesDir },
    log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
    deps: {
      fetchOsm: ({ query, destination }) => fetchOverpass({
        url: config.overpassUrl, query, destination, maxBytes: config.maxOsmBytes,
        userAgent: config.userAgent, timeoutMs: config.fetchTimeoutMs, retryDelayMs: config.retryDelayMs,
      }),
      runTool,
      startRouted,
    },
  });
  const server = http.createServer(createHandler(store));
  const sweep = setInterval(() => { void store.sweep(); }, config.sweepIntervalMs);
  server.listen(config.port, "0.0.0.0", () => console.log(JSON.stringify({ event: "listening", port: config.port })));
  const shutdown = async () => {
    clearInterval(sweep);
    server.close();
    await store.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
