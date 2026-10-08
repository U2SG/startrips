// Streams one Overpass result to disk and classifies every failure into a
// builder error code. A 200 response can still carry a runtime error remark.
import fs from "node:fs";
import { BuildError } from "./errors.mjs";

const RETRY_STATUSES = new Set([429, 504]);
const TAIL_BYTES = 4_096;

/** Classifies a scanned Overpass body; returns a BuildError or null when usable. */
export function classifyOverpassBody({ remark, sawWay }) {
  if (remark) {
    if (/out of memory|maxsize|exceed/i.test(remark)) return new BuildError("ROUTING_AREA_TOO_LARGE", remark);
    return new BuildError("ROUTING_DATA_UNAVAILABLE", remark);
  }
  if (!sawWay) return new BuildError("ROUTING_NO_ROADS", "The corridor contains no roads for this profile");
  return null;
}

/** Incremental scanner; tolerant of markers split across chunk boundaries. */
export function createOverpassScanner() {
  let carry = "";
  let remark = null;
  let sawWay = false;
  let sawEnd = false;
  return {
    push(text) {
      const window = carry + text;
      if (!sawWay && window.includes("<way ")) sawWay = true;
      if (window.includes("</osm>")) sawEnd = true;
      if (remark === null) {
        // Overpass also emits informational "runtime remark" lines; only errors fail.
        const match = /<remark>([\s\S]*?)<\/remark>/.exec(window);
        if (match && /runtime error/i.test(match[1])) remark = match[1].trim().slice(0, 300);
      }
      // Keep enough tail to find a remark or marker that straddles chunks.
      carry = window.slice(-TAIL_BYTES);
    },
    result() { return { remark, sawWay, sawEnd }; },
  };
}

export async function fetchOverpass({
  url, query, destination, maxBytes, userAgent, timeoutMs, retryDelayMs,
  fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal,
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
        body: new URLSearchParams({ data: query }).toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BuildError("ROUTING_DATA_UNAVAILABLE", "Overpass is unreachable");
    }
    if (RETRY_STATUSES.has(response.status) && attempt === 0) {
      await response.body?.cancel().catch(() => {});
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 60_000) : retryDelayMs);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 400) throw new BuildError("ROUTING_GRAPH_BUILD_FAILED", "Overpass rejected the corridor query");
      throw new BuildError("ROUTING_DATA_UNAVAILABLE", `Overpass returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new BuildError("ROUTING_AREA_TOO_LARGE", "Overpass result exceeds the byte limit");
    }
    const scanner = createOverpassScanner();
    const decoder = new TextDecoder();
    const file = fs.createWriteStream(destination);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new BuildError("ROUTING_AREA_TOO_LARGE", "Overpass result exceeds the byte limit");
        scanner.push(decoder.decode(chunk, { stream: true }));
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
      }
    } catch (error) {
      file.destroy();
      if (error instanceof BuildError) throw error;
      throw new BuildError("ROUTING_DATA_UNAVAILABLE", "Overpass transfer was interrupted");
    }
    await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
    const scanned = scanner.result();
    const failure = classifyOverpassBody(scanned);
    if (failure) throw failure;
    if (!scanned.sawEnd) throw new BuildError("ROUTING_DATA_UNAVAILABLE", "Overpass result is truncated");
    return { bytes };
  }
  throw new BuildError("ROUTING_DATA_UNAVAILABLE", "Overpass is rate limited");
}
