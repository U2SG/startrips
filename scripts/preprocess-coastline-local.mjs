import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const LOCAL_COASTLINE_GRID_DEGREES = 2;
export const LOCAL_COASTLINE_COVERAGE = { west: 110, south: 18, east: 118, north: 26 };
export const LOCAL_COASTLINE_CHUNK_SEGMENT_LIMIT = 4_000;

function chunkKey(latSouth, lonWest) {
  const lat = `${latSouth >= 0 ? "+" : "-"}${String(Math.abs(latSouth)).padStart(2, "0")}`;
  const lon = `${lonWest >= 0 ? "+" : "-"}${String(Math.abs(lonWest)).padStart(3, "0")}`;
  return `${lat}_${lon}`;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function polygonsForGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export function buildLocalCoastlineChunks(collection) {
  const chunks = new Map();
  const grid = LOCAL_COASTLINE_GRID_DEGREES;
  const coverage = LOCAL_COASTLINE_COVERAGE;

  for (const feature of collection.features ?? []) {
    for (const polygon of polygonsForGeometry(feature.geometry)) {
      for (const ring of polygon) {
        for (let index = 0; index + 1 < ring.length; index += 1) {
          const current = ring[index];
          const next = ring[index + 1];
          const lon = (current[0] + next[0]) / 2;
          const lat = (current[1] + next[1]) / 2;
          if (
            lon < coverage.west || lon >= coverage.east
            || lat < coverage.south || lat >= coverage.north
          ) continue;

          const lonWest = Math.floor(lon / grid) * grid;
          const latSouth = Math.floor(lat / grid) * grid;
          const id = chunkKey(latSouth, lonWest);
          const chunk = chunks.get(id) ?? {
            id,
            bounds: {
              west: lonWest,
              south: latSouth,
              east: lonWest + grid,
              north: latSouth + grid,
            },
            segments: [],
          };
          chunk.segments.push(
            rounded(current[0]), rounded(current[1]),
            rounded(next[0]), rounded(next[1]),
          );
          chunks.set(id, chunk);
        }
      }
    }
  }

  const ordered = [...chunks.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const chunk of ordered) {
    const segmentCount = chunk.segments.length / 4;
    if (segmentCount > LOCAL_COASTLINE_CHUNK_SEGMENT_LIMIT) {
      throw new Error(`Local coastline chunk ${chunk.id} has ${segmentCount} segments, above ${LOCAL_COASTLINE_CHUNK_SEGMENT_LIMIT}`);
    }
  }
  return ordered;
}

export async function writeLocalCoastlineChunks(inputPath, outputDir) {
  const collection = JSON.parse(await readFile(inputPath, "utf8"));
  const chunks = buildLocalCoastlineChunks(collection);
  await mkdir(outputDir, { recursive: true });

  const manifest = {
    version: 1,
    source: {
      name: "Natural Earth land",
      scale: "10m",
      license: "public-domain",
      upstream: "https://www.naturalearthdata.com/",
    },
    gridDegrees: LOCAL_COASTLINE_GRID_DEGREES,
    coverage: LOCAL_COASTLINE_COVERAGE,
    chunkSegmentLimit: LOCAL_COASTLINE_CHUNK_SEGMENT_LIMIT,
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      bounds: chunk.bounds,
      path: `${chunk.id}.json`,
      segmentCount: chunk.segments.length / 4,
    })),
  };

  for (const chunk of chunks) {
    await writeFile(
      path.join(outputDir, `${chunk.id}.json`),
      `${JSON.stringify({
        version: 1,
        id: chunk.id,
        bounds: chunk.bounds,
        sourceScale: "10m",
        segments: chunk.segments,
      })}\n`,
      "utf8",
    );
  }
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] ?? "public/earth/coastline-10m";
  if (!inputPath) {
    console.error("Usage: node scripts/preprocess-coastline-local.mjs <ne_10m_land.geojson> [output-dir]");
    process.exitCode = 2;
  } else {
    await rm(outputDir, { recursive: true, force: true });
    const manifest = await writeLocalCoastlineChunks(inputPath, outputDir);
    console.log(`[coastline-local] wrote ${manifest.chunks.length} chunks to ${outputDir}`);
    console.log(`[coastline-local] ${manifest.chunks.reduce((sum, chunk) => sum + chunk.segmentCount, 0)} source segments`);
  }
}
