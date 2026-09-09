import { readFileSync } from "node:fs";

/**
 * Shared logic for the city-data build (#16). Kept module-level so the
 * localization pipeline is unit-testable without re-running the full
 * multi-hundred-MB GeoNames join.
 */

/** Administrative rank by GeoNames feature code. */
export const RANK_BY_FEATURE = new Map([
  ["PPLC", 0],
  ["PPLA", 1],
  ["PPLA2", 2],
]);

/** Any Chinese language tag: zh, zh-CN, zh-Hans, zh-Hant, zh-TW, ... */
const ZH_TAG = /^zh(?:[/_-][a-zA-Z]+)?$/i;
/** Simplified-Chinese tags rank highest in the candidate pick. */
const ZH_SIMPLIFIED_TAG = /^zh[/_-](?:cn|hans|han)$/i;
const HAN_SCRIPT = /[\u3400-\u4dbf\u4e00-\u9fff]/;
export const CHINESE_REGION_CODES = new Set(["CN", "HK", "MO", "TW"]);
export const PRD_COVERAGE_BOUNDS = Object.freeze({ south: 21.5, north: 24.5, west: 112, east: 115.5 });
export const PRD_RANK3_MIN_LOCALIZATION = 0.65;

const UNIHAN_SIMPLIFIED_VARIANTS = JSON.parse(readFileSync(
  new URL("./data/unihan-simplified-variants.json", import.meta.url),
  "utf8",
));
const SIMPLIFIED_VARIANT_BY_CHARACTER = new Map(Object.entries(UNIHAN_SIMPLIFIED_VARIANTS.map ?? {}));

/**
 * Normalize a build-time Chinese-region label to the single zh-CN display
 * script. The checked-in map is generated from Unicode 17.0 Unihan
 * kSimplifiedVariant data (Unicode-3.0) and intentionally contains only
 * single-target mappings, so the build never guesses between ambiguous forms.
 */
export function normalizeZhCnLabel(value) {
  return [...String(value ?? "")].map((character) => (
    SIMPLIFIED_VARIANT_BY_CHARACTER.get(character) ?? character
  )).join("");
}

export function isZhCnNormalizedLabel(value) {
  const label = String(value ?? "");
  return label === normalizeZhCnLabel(label);
}

export function isChineseRegion(countryCode) {
  return CHINESE_REGION_CODES.has(String(countryCode ?? "").toUpperCase());
}

export function containsHanScript(value) {
  return HAN_SCRIPT.test(String(value ?? ""));
}

/** Parse one cities15000 TSV row into a compact city entry (or null). */
export function parseCityRow(fields) {
  const geonameId = fields[0] ?? "";
  const name = (fields[1] ?? "").trim();
  const latitude = Number(fields[4]);
  const longitude = Number(fields[5]);
  const population = Number(fields[14]);
  const feature = fields[7] ?? "";
  const countryCode = (fields[8] ?? "").trim().toUpperCase();
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
    return null;
  }
  return {
    geonameId,
    entry: {
      n: name,
      la: latitude,
      lo: longitude,
      p: population,
      r: RANK_BY_FEATURE.get(feature) ?? 3,
      ...(isChineseRegion(countryCode) ? { c: countryCode } : {}),
      ...(isChineseRegion(countryCode) && containsHanScript(name) ? { z: normalizeZhCnLabel(name) } : {}),
    },
  };
}

/**
 * Decide whether one alternate-name row is a Chinese candidate and, if so,
 * its priority. Returns a score or null: 0 = simplified-Chinese tag,
 * 1 = other Chinese tag, 2 = untagged CJK-script name.
 */
export function chineseAlternateScore(language, alternateName, countryCode = "") {
  if (!alternateName || !containsHanScript(alternateName)) return null;
  const normalizedLanguage = language.trim();
  if (ZH_TAG.test(normalizedLanguage)) {
    return ZH_SIMPLIFIED_TAG.test(normalizedLanguage) ? 0 : 1;
  }
  // GeoNames contains Cantonese labels under `yue`. They are a truthful Han
  // fallback for the Chinese-region records this build is localizing, but never
  // for an unrelated country that merely shares Han/Kanji glyphs.
  if (isChineseRegion(countryCode) && /^yue(?:[/_-][a-zA-Z]+)?$/i.test(normalizedLanguage)) return 1;
  // Script-only fallback is intentionally both untagged AND country-scoped.
  // Tagged Japanese/Korean rows, and untagged Han outside CN/HK/MO/TW, cannot
  // silently become zh-CN display names.
  return !normalizedLanguage && isChineseRegion(countryCode) ? 2 : null;
}

/**
 * Build the Chinese-name join maps from alternateNamesV2 rows: preferred
 * (tagged) and fallback (first untagged CJK) candidates per geonameId.
 */
export function collectChineseCandidates(rows, countryByGeonameId = new Map()) {
  const preferred = new Map();
  const fallback = new Map();
  for (const fields of rows) {
    const geonameId = fields[1] ?? "";
    const language = fields[2] ?? "";
    const alternateName = (fields[3] ?? "").trim();
    const score = chineseAlternateScore(language, alternateName, countryByGeonameId.get(geonameId));
    if (score === null || !geonameId) continue;
    if (score <= 1) {
      const existing = preferred.get(geonameId);
      if (!existing || score < existing.score) {
        preferred.set(geonameId, { name: alternateName, score });
      }
    } else if (!fallback.has(geonameId)) {
      fallback.set(geonameId, alternateName);
    }
  }
  return { preferred, fallback };
}

/**
 * Apply the collected candidates onto the cities array (by the geonameId ->
 * array-index map built by the caller). Returns the count of cities that
 * received a `z` field.
 */
export function applyChineseCandidates(cities, cityIndexByGeonameId, preferred, fallback) {
  let joined = 0;
  for (const [geonameId, candidate] of preferred) {
    const cityIndex = cityIndexByGeonameId.get(geonameId);
    if (cityIndex !== undefined) {
      cities[cityIndex].z = normalizeZhCnLabel(candidate.name);
      joined += 1;
    }
  }
  for (const [geonameId, name] of fallback) {
    const cityIndex = cityIndexByGeonameId.get(geonameId);
    if (cityIndex !== undefined && cities[cityIndex].z === undefined) {
      cities[cityIndex].z = normalizeZhCnLabel(name);
      joined += 1;
    }
  }
  return joined;
}


/** Apply a checked-in, offline authoritative fallback by the target GeoNames id. */
export function applyAuthoritativeChineseFallback(cities, cityIndexByGeonameId, entries) {
  let joined = 0;
  for (const source of entries ?? []) {
    const cityIndex = cityIndexByGeonameId.get(String(source.geonameId ?? ""));
    if (cityIndex === undefined) continue;
    const city = cities[cityIndex];
    const country = String(source.country ?? "").toUpperCase();
    const label = String(source.label ?? "").trim();
    if (city.z !== undefined || city.c !== country || !isChineseRegion(country) || !containsHanScript(label)) continue;
    city.z = normalizeZhCnLabel(label);
    joined += 1;
  }
  return joined;
}

export function chineseRegionCoverage(cities) {
  const ranks = [0, 1, 2, 3].map((rank) => ({ rank, total: 0, localized: 0 }));
  let prdRank3Total = 0;
  let prdRank3Localized = 0;
  for (const city of cities) {
    if (!isChineseRegion(city.c)) continue;
    const rank = Math.max(0, Math.min(3, Number(city.r) || 0));
    ranks[rank].total += 1;
    if (containsHanScript(city.z)) ranks[rank].localized += 1;
    if (
      rank === 3
      && city.la >= PRD_COVERAGE_BOUNDS.south && city.la <= PRD_COVERAGE_BOUNDS.north
      && city.lo >= PRD_COVERAGE_BOUNDS.west && city.lo <= PRD_COVERAGE_BOUNDS.east
    ) {
      prdRank3Total += 1;
      if (containsHanScript(city.z)) prdRank3Localized += 1;
    }
  }
  return {
    ranks,
    prdRank3: {
      total: prdRank3Total,
      localized: prdRank3Localized,
      ratio: prdRank3Total === 0 ? 1 : prdRank3Localized / prdRank3Total,
    },
  };
}

export function assertChineseRegionCoverage(cities, requiredNames = []) {
  const coverage = chineseRegionCoverage(cities);
  for (const city of cities) {
    if (!containsHanScript(city.z)) continue;
    if (!isZhCnNormalizedLabel(city.z)) {
      throw new Error(`zh-CN asset label is not simplified: ${city.n} -> ${city.z}`);
    }
  }
  for (const rank of coverage.ranks.slice(0, 3)) {
    if (rank.total > 0 && rank.localized !== rank.total) {
      throw new Error(`Chinese-region rank ${rank.rank} localization regressed: ${rank.localized}/${rank.total}`);
    }
  }
  if (coverage.prdRank3.ratio < PRD_RANK3_MIN_LOCALIZATION) {
    throw new Error(`PRD rank-3 localization ${coverage.prdRank3.localized}/${coverage.prdRank3.total} (${coverage.prdRank3.ratio.toFixed(3)}) is below ${PRD_RANK3_MIN_LOCALIZATION}`);
  }
  for (const name of requiredNames) {
    const city = cities.find((candidate) => candidate.n === name);
    if (!city || !containsHanScript(city.z)) throw new Error(`required Chinese city label is missing: ${name}`);
  }
  return coverage;
}
