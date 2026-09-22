import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapStyleRoutes } from "./mapstyle";

const cache = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => cache);
vi.mock("../config", () => ({
  serverConfig: { appOrigin: "https://startrips.example" },
}));

const app = new Hono().route("/api/mapstyle", mapStyleRoutes);
const upstream = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  cache.readFile.mockRejectedValue(new Error("cache miss"));
  cache.stat.mockResolvedValue({ mtimeMs: Date.now() });
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => vi.unstubAllGlobals());

describe("map resource HTTP contract", () => {
  it.each([
    "/api/mapstyle?path=styles%2F..%2Fsecret",
    "/api/mapstyle/sprite/fonts/font.json",
  ])("rejects invalid paths before cache or provider access: %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_MAP_PATH" });
    expect(cache.readFile).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("serves and caches rewritten styles with the short style lifetime", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sprite: "https://tiles.openfreemap.org/sprites/ofm/ofm",
      sources: { earth: { url: "https://tiles.openfreemap.org/planet" } },
    }), { headers: { "content-type": "application/json" } }));

    const response = await app.request("/api/mapstyle?path=styles%2Ffiord");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      glyphs: "https://startrips.example/api/mapstyle?path=fonts%2F{fontstack}%2F{range}.pbf",
      sprite: "https://startrips.example/api/mapstyle/sprite/sprites/ofm/ofm",
      sources: { earth: { url: "https://startrips.example/api/mapstyle?path=planet" } },
    });
    expect(cache.writeFile).toHaveBeenCalledWith(expect.any(String), Buffer.from(body));
  });

  it("serves fresh cached tiles without contacting the provider", async () => {
    cache.readFile.mockResolvedValue(Buffer.from([1, 2, 3]));
    const response = await app.request("/api/mapstyle?path=planet%2F2%2F0%2F1.pbf");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get("content-type")).toBe("application/vnd.mapbox-vector-tile");
    expect(response.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("replaces expired styles even while a tile of the same age remains usable", async () => {
    cache.readFile.mockResolvedValue(Buffer.from("cached"));
    cache.stat.mockResolvedValue({ mtimeMs: Date.now() - 10 * 60 * 1_000 });
    upstream.mockResolvedValue(new Response('{"version":8}', {
      headers: { "content-type": "application/json" },
    }));
    const style = await app.request("/api/mapstyle?path=styles%2Ffiord");
    expect(await style.json()).toEqual({ version: 8 });
    const tile = await app.request("/api/mapstyle?path=planet%2F2%2F0%2F1.pbf");
    expect(await tile.text()).toBe("cached");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("keeps sprite requests and cache entries distinct from query resources", async () => {
    upstream.mockImplementation(async () => new Response("sprite", {
      headers: { "content-type": "image/png" },
    }));
    const sprite = await app.request("/api/mapstyle/sprite/sprites/ofm/ofm@2x.png");
    expect(await sprite.text()).toBe("sprite");
    expect(sprite.headers.get("content-type")).toBe("image/png");
    expect(sprite.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(upstream.mock.calls[0][0].toString()).toBe("https://tiles.openfreemap.org/sprites/ofm/ofm@2x.png");
    expect(upstream.mock.calls[0][1]?.headers).toEqual({
      Accept: "application/json, image/*",
      "User-Agent": "Startrips/1.0 (map proxy)",
    });
    await app.request("/api/mapstyle?path=sprites%2Fofm%2Fofm%402x.png");
    expect(cache.readFile.mock.calls[0][0]).not.toBe(cache.readFile.mock.calls[1][0]);
  });

  it.each([
    ["json", "application/json; charset=utf-8"],
    ["png", "image/png"],
  ])("preserves cached sprite MIME for %s", async (extension, contentType) => {
    cache.readFile.mockResolvedValue(Buffer.from("cached sprite"));
    const response = await app.request(`/api/mapstyle/sprite/sprites/ofm/ofm.${extension}`);
    expect(await response.text()).toBe("cached sprite");
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["/api/mapstyle?path=planet", "/api/mapstyle/sprite/sprites/ofm/ofm.json"])(
    "preserves provider failure responses: %s", async (path) => {
      upstream.mockRejectedValueOnce(new Error("network unavailable"));
      const failed = await app.request(path);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({
        error: "MAP_STYLE_UNAVAILABLE", message: "Map style provider request failed",
      });
      upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
      const unavailable = await app.request(path);
      expect(unavailable.status).toBe(502);
      expect(await unavailable.json()).toEqual({
        error: "MAP_STYLE_UNAVAILABLE", message: "Map style provider returned 503",
      });
      expect(cache.writeFile).not.toHaveBeenCalled();
    },
  );

  it("allows the provider to fill the cache after the browser cancels", async () => {
    const browser = new AbortController();
    upstream.mockImplementation(async (_input, init) => {
      browser.abort();
      expect(init?.signal?.aborted).toBe(false);
      return new Response("tile");
    });
    const response = await app.request("/api/mapstyle?path=planet%2F2%2F0%2F1.pbf", {
      signal: browser.signal,
    });
    expect(await response.text()).toBe("tile");
    expect(cache.writeFile).toHaveBeenCalledWith(expect.any(String), Buffer.from("tile"));
  });
});
