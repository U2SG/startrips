import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";

const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const ALLOWED_PATH_PREFIXES = [
  "styles/",
  "planet/",
  "fonts/",
  "sprites/",
  "natural_earth/",
];
const CACHE_DIR = "/tmp/mapstyle-cache";
const STYLE_CACHE_TTL_MS = 5 * 60 * 1_000;
const TILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export function rewriteOpenFreemapUrls(body: string): string {
  const pattern = new RegExp(
    `${OPENFREEMAP_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^"?]+)`,
    "g",
  );
  return body.replace(pattern, (_match, path: string) =>
    `/api/mapstyle?path=${encodeURIComponent(path)}`);
}

export function isAllowedOpenFreemapPath(path: string): boolean {
  if (!path || path.length > 200 || path.includes("..") || path.includes("//")) {
    return false;
  }
  return ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function cacheKeyFor(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

async function readCached(path: string, ttlMs: number) {
  const file = join(CACHE_DIR, cacheKeyFor(path));
  try {
    const [data, meta] = await Promise.all([readFile(file), stat(file)]);
    if (Date.now() - meta.mtimeMs > ttlMs) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCached(path: string, data: Buffer) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, cacheKeyFor(path)), data);
  } catch (error) {
    console.error(
      "Map style cache write failed",
      path,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export const mapStyleRoutes = new Hono();

mapStyleRoutes.get("/", async (context) => {
  const path = context.req.query("path")?.trim() ?? "";
  if (!isAllowedOpenFreemapPath(path)) {
    return context.json({ error: "INVALID_MAP_PATH" }, 400);
  }

  const isJson = path.startsWith("styles/") || path === "planet";
  const ttlMs = isJson ? STYLE_CACHE_TTL_MS : TILE_CACHE_TTL_MS;
  const cached = await readCached(path, ttlMs);
  if (cached) {
    const contentType = isJson
      ? "application/json; charset=utf-8"
      : path.endsWith(".pbf")
        ? "application/vnd.mapbox-vector-tile"
        : path.endsWith(".png") || path === "planet"
          ? "image/png"
          : "application/octet-stream";
    return context.body(cached, 200, {
      "content-type": contentType,
      "cache-control": `public, max-age=${Math.round(ttlMs / 1000)}`,
    });
  }

  const url = new URL(`${OPENFREEMAP_ORIGIN}/${path}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json, application/x-protobuf, image/*, */*",
        "User-Agent": "Startrips/1.0 (map proxy)",
      },
      signal: context.req.raw.signal,
    });
  } catch {
    return context.json(
      { error: "MAP_STYLE_UNAVAILABLE", message: "Map style provider request failed" },
      502,
    );
  }
  if (!response.ok) {
    return context.json(
      { error: "MAP_STYLE_UNAVAILABLE", message: `Map style provider returned ${response.status}` },
      502,
    );
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (isJson) {
    const text = await response.text();
    const rewritten = rewriteOpenFreemapUrls(text);
    await writeCached(path, Buffer.from(rewritten, "utf8"));
    return context.body(rewritten, 200, {
      "content-type": contentType,
      "cache-control": `public, max-age=${Math.round(STYLE_CACHE_TTL_MS / 1000)}`,
    });
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeCached(path, body);
  return context.body(body, 200, {
    "content-type": contentType,
    "cache-control": `public, max-age=${Math.round(TILE_CACHE_TTL_MS / 1000)}`,
  });
});

export function startMapStyleCacheSweeper() {
  const sweep = async () => {
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      const { readdir, rm } = await import("node:fs/promises");
      const entries = await readdir(CACHE_DIR);
      const now = Date.now();
      await Promise.all(entries.map(async (entry) => {
        try {
          const meta = await stat(join(CACHE_DIR, entry));
          if (now - meta.mtimeMs > TILE_CACHE_TTL_MS) {
            await rm(join(CACHE_DIR, entry), { force: true });
          }
        } catch {
          // Missing or unreadable cache entries are ignored.
        }
      }));
    } catch (error) {
      console.error(
        "Map style cache sweep failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  };
  void sweep();
  const interval = setInterval(() => void sweep(), CACHE_SWEEP_INTERVAL_MS);
  interval.unref();
}