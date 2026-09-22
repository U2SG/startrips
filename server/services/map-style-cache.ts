import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// MapLibre appends .json/.png/@2x.png to the sprite URL, so sprites need a
// path-style endpoint instead of a query parameter.
function spriteProxyUrlFor(path: string, origin: string): string {
  return `${origin}/api/mapstyle/sprite/${path}`;
}

export function rewriteOpenFreemapUrls(body: string, origin: string): string {
  const rewrite = (value: string) =>
    value.replace(URL_PATTERN, (_match, path: string) => proxyUrlFor(path, origin));

  try {
    const style = JSON.parse(body) as {
      glyphs?: unknown;
      sprite?: unknown;
      tiles?: unknown;
      sources?: Record<string, { url?: unknown; tiles?: unknown }>;
    };
    if (typeof style.glyphs === "string") style.glyphs = rewrite(style.glyphs);
    if (typeof style.sprite === "string" && style.sprite.startsWith(OPENFREEMAP_ORIGIN)) {
      const path = style.sprite.slice(OPENFREEMAP_ORIGIN.length + 1);
      style.sprite = spriteProxyUrlFor(path, origin);
    }
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

type MapStyleReadResult =
  | { ok: true; body: Buffer | string; contentType: string; maxAgeSeconds: number }
  | { ok: false; message: string };

async function fetchMapAsset(path: string, accept: string): Promise<
  { ok: true; response: Response } | { ok: false; message: string }
> {
  const url = new URL(`${OPENFREEMAP_ORIGIN}/${path}`);
  // The upstream request outlives browser cancellations so MapLibre retries can
  // still use the populated cache. Only this service owns its timeout signal.
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": "Startrips/1.0 (map proxy)" },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, message: "Map style provider request failed" };
  } finally {
    globalThis.clearTimeout(timeout);
  }
  return response.ok
    ? { ok: true, response }
    : { ok: false, message: `Map style provider returned ${response.status}` };
}

export async function readMapStyleAsset(path: string): Promise<MapStyleReadResult> {
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
    return { ok: true, body: cached, contentType, maxAgeSeconds: Math.round(ttlMs / 1000) };
  }
  const upstream = await fetchMapAsset(path, "application/json, application/x-protobuf, image/*, */*");
  if (!upstream.ok) return upstream;
  const { response } = upstream;
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (isJson) {
    const text = await response.text();
    const rewritten = rewriteOpenFreemapUrls(text, serverConfig.appOrigin);
    await writeCached(path, Buffer.from(rewritten, "utf8"));
    return { ok: true, body: rewritten, contentType, maxAgeSeconds: Math.round(STYLE_CACHE_TTL_MS / 1000) };
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeCached(path, body);
  return { ok: true, body, contentType, maxAgeSeconds: Math.round(TILE_CACHE_TTL_MS / 1000) };
}

export async function readMapStyleSprite(path: string): Promise<MapStyleReadResult> {
  const ttlMs = TILE_CACHE_TTL_MS;
  const cached = await readCached(`sprite/${path}`, ttlMs);
  if (cached) {
    return {
      ok: true,
      body: cached,
      contentType: path.endsWith(".json") ? "application/json; charset=utf-8" : "image/png",
      maxAgeSeconds: Math.round(ttlMs / 1000),
    };
  }
  const upstream = await fetchMapAsset(path, "application/json, image/*");
  if (!upstream.ok) return upstream;
  const { response } = upstream;
  const body = Buffer.from(await response.arrayBuffer());
  await writeCached(`sprite/${path}`, body);
  return {
    ok: true,
    body,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    maxAgeSeconds: Math.round(ttlMs / 1000),
  };
}

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