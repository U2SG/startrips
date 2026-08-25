/**
 * Builds public/earth/cities.json from the GeoNames cities15000 export
 * (https://download.geonames.org/export/dump/cities15000.zip, CC BY 4.0) and
 * the alternateNamesV2 export (same site, same license).
 *
 * The fine tier keeps asciiname, latitude, longitude, population, and
 * administrative rank for every city with a valid location, sorted by
 * population descending so bounded label budgets keep the most important
 * cities first. Localization (#16): alternateNamesV2 rows are joined by
 * geonameId and, for cities that carry a Chinese alternate name, the build
 * writes a compact `z` field with the display name (preferring zh-CN /
 * zh-Hans / zh language tags, then any CJK-script alternate). Rows without a
 * Chinese name get no `z`, so the browser payload does not grow with every
 * alternate name; runtime display falls back to the asciiname. There is no
 * hand-maintained dictionary — the mapping is data-driven by stable
 * GeoNames ids.
 *
 * Usage: node scripts/build-city-data.mjs <cities15000.txt> [alternateNamesV2.txt]
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  applyChineseCandidates,
  chineseAlternateScore,
  parseCityRow,
} from "./build-city-data-lib.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node scripts/build-city-data.mjs <cities15000.txt> [alternateNamesV2.txt]");
  process.exit(1);
}
const alternatesPath = process.argv[3] ?? null;

const lines = readFileSync(inputPath, "utf8").split("\n");
const cities = [];
// geonameId -> array index, for joining alternate names by id.
const cityIndexByGeonameId = new Map();
for (const line of lines) {
  if (!line) continue;
  const parsed = parseCityRow(line.split("\t"));
  if (!parsed) continue;
  cityIndexByGeonameId.set(parsed.geonameId, cities.length);
  cities.push(parsed.entry);
}

// Join Chinese alternate names by geonameId, streaming the large V2 file
// without buffering every row (the dump is ~780 MB).
if (alternatesPath) {
  const preferred = new Map();
  const fallback = new Map();
  await new Promise((resolve, reject) => {
    const reader = createInterface({
      input: createReadStream(alternatesPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    reader.on("line", (line) => {
      if (!line) return;
      const fields = line.split("\t");
      const geonameId = fields[1] ?? "";
      const language = fields[2] ?? "";
      const alternateName = (fields[3] ?? "").trim();
      if (!geonameId) return;
      const score = chineseAlternateScore(language, alternateName);
      if (score === null) return;
      if (score <= 1) {
        const existing = preferred.get(geonameId);
        if (!existing || score < existing.score) {
          preferred.set(geonameId, { name: alternateName, score });
        }
      } else if (!fallback.has(geonameId)) {
        fallback.set(geonameId, alternateName);
      }
    });
    reader.on("close", resolve);
    reader.on("error", reject);
  });
  const joined = applyChineseCandidates(cities, cityIndexByGeonameId, preferred, fallback);
  console.log(`joined ${joined} Chinese names from ${alternatesPath}`);
}

cities.sort((left, right) => right.p - left.p);

const output = "public/earth/cities.json";
writeFileSync(output, JSON.stringify({ cities }));
const rankCounts = [0, 1, 2, 3].map((rank) => (
  cities.filter((city) => city.r === rank).length
));
const withChinese = cities.filter((city) => city.z).length;
console.log(
  `wrote ${output}: ${cities.length} cities (${withChinese} with Chinese names), ${Math.round(
    readFileSync(output).length / 1024,
  )} KiB (rank0=${rankCounts[0]} rank1=${rankCounts[1]} rank2=${rankCounts[2]} rank3=${rankCounts[3]})`,
);
