import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { serverConfig } from "../config";

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

const URL_PATTERN = new RegExp(
  `${OPENFREEMAP_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^"?]+)`,
  "g",
);

function proxyUrlFor(path: string, origin: string): string {
  return `${origin}/api/mapstyle?path=${encodeURIComponent(path)
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")}`;
}

export function rewriteOpenFreemapUrls(body: string, origin: string): string {
  const rewrite = (value: string) =>
    value.replace(URL_PATTERN, (_match, path: string) => proxyUrlFor(path, origin));

  try {
    const style = JSON.parse(body) as {
      glyphs?: unknown;
      tiles?: unknown;
      sources?: Record<string, { url?: unknown; tiles?: unknown }>;
    };
    if (typeof style.glyphs === "string") style.glyphs = rewrite(style.glyphs);
    // The sprite URL is intentionally left direct: MapLibre appends
    // .json/.png/@2x.png suffixes that a query-style proxy URL cannot serve,
    // and the sprite files are small and browser-cacheable.
    if (Array.isArray(style.tiles)) {
      style.tiles = style.tiles.map((tile) =>
        typeof tile === "string" ? rewrite(tile) : tile);
    }
    for (const source of Object.values(style.sources ?? {})) {
      if (typeof source.url === "string") source.url = rewrite(source.url);
      if (Array.isArray(source.tiles)) {
        source.tiles = source.tiles.map((tile) =>
          typeof tile === "string" ? rewrite(tile) : tile);
      }
    }
    return JSON.stringify(style);
  } catch {
    return body.replace(URL_PATTERN, (_match, path: string) =>
      proxyUrlFor(path, origin));
  }
}

export function isAllowedOpenFreemapPath(path: string): boolean {
  if (!path || path.length > 200 || path.includes("..") || path.includes("//")) {
    return false;
  }
  return path === "planet"
    || ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
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
        : path.endsWith(".png")
          ? "image/png"
          : "application/octet-stream";
    return context.body(cached, 200, {
      "content-type": contentType,
      "cache-control": `public, max-age=${Math.round(ttlMs / 1000)}`,
      "access-control-allow-origin": "*",
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
    const rewritten = rewriteOpenFreemapUrls(text, serverConfig.appOrigin);
    await writeCached(path, Buffer.from(rewritten, "utf8"));
    return context.body(rewritten, 200, {
      "content-type": contentType,
      "cache-control": `public, max-age=${Math.round(STYLE_CACHE_TTL_MS / 1000)}`,
      "access-control-allow-origin": "*",
    });
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeCached(path, body);
  return context.body(body, 200, {
    "content-type": contentType,
    "cache-control": `public, max-age=${Math.round(TILE_CACHE_TTL_MS / 1000)}`,
      "access-control-allow-origin": "*",
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