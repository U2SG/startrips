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
const ZH_SIMPLIFIED_TAG = /^zh(?:[/_-](?:cn|hans|han))?$/i;

/** Parse one cities15000 TSV row into a compact city entry (or null). */
export function parseCityRow(fields) {
  const geonameId = fields[0] ?? "";
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
    },
  };
}

/**
 * Decide whether one alternate-name row is a Chinese candidate and, if so,
 * its priority. Returns a score or null: 0 = simplified-Chinese tag,
 * 1 = other Chinese tag, 2 = untagged CJK-script name.
 */
export function chineseAlternateScore(language, alternateName) {
  if (!alternateName) return null;
  if (ZH_TAG.test(language)) {
    return ZH_SIMPLIFIED_TAG.test(language) ? 0 : 1;
  }
  return /[\u4e00-\u9fff]/.test(alternateName) ? 2 : null;
}

/**
 * Build the Chinese-name join maps from alternateNamesV2 rows: preferred
 * (tagged) and fallback (first untagged CJK) candidates per geonameId.
 */
export function collectChineseCandidates(rows) {
  const preferred = new Map();
  const fallback = new Map();
  for (const fields of rows) {
    const geonameId = fields[1] ?? "";
    const language = fields[2] ?? "";
    const alternateName = (fields[3] ?? "").trim();
    const score = chineseAlternateScore(language, alternateName);
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
      cities[cityIndex].z = candidate.name;
      joined += 1;
    }
  }
  for (const [geonameId, name] of fallback) {
    const cityIndex = cityIndexByGeonameId.get(geonameId);
    if (cityIndex !== undefined && cities[cityIndex].z === undefined) {
      cities[cityIndex].z = name;
      joined += 1;
    }
  }
  return joined;
}
