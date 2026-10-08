import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchOverpass } from "./overpass.mjs";

const body = '<?xml version="1.0"?><osm><node id="1" lat="0" lon="0"/><way id="2"><nd ref="1"/></way></osm>';

async function run(responses, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "startrips-overpass-"));
  const requests = [];
  const sleeps = [];
  try {
    const result = await fetchOverpass({
      url: "http://overpass.test/api/interpreter", query: "[out:xml];way;out;", destination: path.join(dir, "map.osm"),
      maxBytes: 1_000, userAgent: "startrips-routing-builder/1 (+https://example.test)", timeoutMs: 1_000, retryDelayMs: 7,
      fetcher: async (url, init) => { requests.push(init); const next = responses.shift(); if (next instanceof Error) throw next; return next; },
      sleep: async (ms) => { sleeps.push(ms); },
      ...options,
    });
    return { result, requests, sleeps, text: await fs.readFile(path.join(dir, "map.osm"), "utf8") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Overpass fetch", () => {
  it("posts the query with the identifying User-Agent and streams the result to disk", async () => {
    const { result, requests, text } = await run([new Response(body)]);
    expect(text).toBe(body);
    expect(result.bytes).toBe(body.length);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers["User-Agent"]).toBe("startrips-routing-builder/1 (+https://example.test)");
    expect(new URLSearchParams(requests[0].body).get("data")).toBe("[out:xml];way;out;");
  });
  it("retries a 429 or 504 once after a backoff", async () => {
    const { sleeps, requests } = await run([new Response("busy", { status: 429 }), new Response(body)]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([7]);
    await expect(run([new Response("", { status: 504 }), new Response("", { status: 504 })]))
      .rejects.toMatchObject({ code: "ROUTING_DATA_UNAVAILABLE" });
  });
  it.each([
    [[new TypeError("fetch failed")], "ROUTING_DATA_UNAVAILABLE"],
    [[new Response("", { status: 502 })], "ROUTING_DATA_UNAVAILABLE"],
    [[new Response("bad", { status: 400 })], "ROUTING_GRAPH_BUILD_FAILED"],
    [[new Response(`<osm>${"<way id=\"1\"></way>".repeat(80)}</osm>`)], "ROUTING_AREA_TOO_LARGE"],
    [[new Response("<osm><node id=\"1\"/>")], "ROUTING_NO_ROADS"],
    [[new Response("<osm><way id=\"1\"></way>")], "ROUTING_DATA_UNAVAILABLE"],
  ])("classifies failure %#", async (responses, code) => {
    await expect(run(responses)).rejects.toMatchObject({ code });
  });
});
