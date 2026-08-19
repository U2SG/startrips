/**
 * Builds public/earth/cities.json from the GeoNames cities15000 export
 * (https://download.geonames.org/export/dump/cities15000.zip, CC BY 4.0).
 * Keeps asciiname, latitude, longitude, population and administrative rank
 * for every city with a valid location, sorted by population descending so
 * bounded label budgets keep the most important cities first.
 *
 * Administrative rank encodes containment: 0 = national capital (PPLC),
 * 1 = first-level capital (PPLA, e.g. provincial capitals), 2 = second-level
 * capital (PPLA2, e.g. prefecture cities), 3 = everything else (counties,
 * towns). Zooming reveals ranks progressively.
 *
 * Usage: node scripts/build-city-data.mjs <cities15000.txt>
 */
import { readFileSync, writeFileSync } from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node scripts/build-city-data.mjs <cities15000.txt>");
  process.exit(1);
}

const RANK_BY_FEATURE = new Map([
  ["PPLC", 0],
  ["PPLA", 1],
  ["PPLA2", 2],
]);

const lines = readFileSync(inputPath, "utf8").split("\n");
const cities = [];
for (const line of lines) {
  if (!line) continue;
  const fields = line.split("\t");
  const name = (fields[1] ?? "").trim();
  const latitude = Number(fields[4]);
  const longitude = Number(fields[5]);
  const population = Number(fields[14]);
  const feature = fields[7] ?? "";
  if (
    !name
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || !Number.isFinite(population)
    || population <= 0
  ) {
    continue;
  }
  cities.push({
    n: name,
    la: latitude,
    lo: longitude,
    p: population,
    r: RANK_BY_FEATURE.get(feature) ?? 3,
  });
}

cities.sort((left, right) => right.p - left.p);

const output = "public/earth/cities.json";
writeFileSync(output, JSON.stringify({ cities }));
const rankCounts = [0, 1, 2, 3].map((rank) => (
  cities.filter((city) => city.r === rank).length
));
console.log(
  `wrote ${output}: ${cities.length} cities, ${Math.round(
    readFileSync(output).length / 1024,
  )} KiB (rank0=${rankCounts[0]} rank1=${rankCounts[1]} rank2=${rankCounts[2]} rank3=${rankCounts[3]})`,
);
