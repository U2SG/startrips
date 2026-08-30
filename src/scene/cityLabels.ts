import { latLonToVector3 } from "./geo";

export type CityPoint = {
  name: string;
  /** Localized display name from the data pipeline (e.g. Chinese for Chinese
   *  cities), when the build produced one. Falls back to `name`. */
  localizedName?: string | null;
  latitude: number;
  longitude: number;
  population: number;
  /** Administrative containment rank: 0 national capital, 1 first-level
   *  capital (province), 2 second-level capital (prefecture), 3 others. */
  rank: number;
  /** Precomputed unit direction on the globe-local sphere (radius 1). */
  direction: readonly [number, number, number];
};

export type CityTier = "coarse" | "fine";

type CityFeature = {
  properties?: {
    NAME?: unknown;
    POP_MAX?: unknown;
  };
  geometry?: {
    coordinates?: unknown;
  };
};

export function parseCityFeatures(
  payload: { features?: unknown },
): CityPoint[] {
  if (!Array.isArray(payload.features)) return [];
  const cities: CityPoint[] = [];
  for (const raw of payload.features) {
    const feature = raw as CityFeature;
    const coordinates = feature.geometry?.coordinates;
    const name = typeof feature.properties?.NAME === "string"
      ? feature.properties.NAME.trim()
      : "";
    if (!Array.isArray(coordinates) || !name) continue;
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (
      !Number.isFinite(latitude)
      || latitude < -90
      || latitude > 90
      || !Number.isFinite(longitude)
      || longitude < -180
      || longitude > 180
    ) {
      continue;
    }
    const population = Number(feature.properties?.POP_MAX ?? 0);
    const vector = latLonToVector3(latitude, longitude, 1);
    cities.push({
      name,
      latitude,
      longitude,
      population: Number.isFinite(population) ? population : 0,
      // Natural Earth 110m populated places are capitals and major cities.
      rank: 1,
      direction: [vector.x, vector.y, vector.z],
    });
  }
  // Largest first so a bounded label budget keeps the most important cities.
  return cities.sort((left, right) => right.population - left.population);
}

/**
 * Parse the compact GeoNames build (public/earth/cities.json): an array of
 * { n: asciiname, z?: localized name, la: latitude, lo: longitude, p:
 * population, r: rank } objects, pre-sorted by population descending.
 * Directions are computed once here so per-frame view filtering is pure dot
 * products.
 */
export function parseCityList(payload: { cities?: unknown }): CityPoint[] {
  if (!Array.isArray(payload.cities)) return [];
  const cities: CityPoint[] = [];
  for (const raw of payload.cities) {
    const entry = raw as {
      n?: unknown;
      z?: unknown;
      la?: unknown;
      lo?: unknown;
      p?: unknown;
      r?: unknown;
    };
    const name = typeof entry.n === "string" ? entry.n.trim() : "";
    const latitude = Number(entry.la);
    const longitude = Number(entry.lo);
    const population = Number(entry.p);
    const rank = Number(entry.r);
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
    const vector = latLonToVector3(latitude, longitude, 1);
    const localizedName = typeof entry.z === "string" && entry.z.trim()
      ? entry.z.trim()
      : undefined;
    cities.push({
      name,
      ...(localizedName ? { localizedName } : {}),
      latitude,
      longitude,
      population,
      rank: Number.isFinite(rank) ? Math.max(0, Math.min(3, rank)) : 3,
      direction: [vector.x, vector.y, vector.z],
    });
  }
  return cities;
}

/**
 * #16: resolve a city's display label for the current UI locale. The data
 * pipeline provides `localizedName` (Chinese for Chinese cities); English
 * locales prefer the asciiname. This replaces any hand-maintained
 * english -> chinese dictionary: the mapping lives in the build data keyed by
 * stable GeoNames ids, not by string guessing.
 */
export function resolveCityDisplayName(
  city: Pick<CityPoint, "name" | "localizedName">,
  locale: string,
): string {
  if (locale.startsWith("zh")) {
    return city.localizedName ?? city.name;
  }
  return city.name;
}

/**
 * Pick the cities worth labeling for the current view. `facingDirection` is
 * the globe-local unit vector from the globe center toward the camera; cities
 * are filtered by how directly they face the camera (the threshold tightens
 * as the globe zooms in) and then sorted nearest-to-view-center first, with
 * population breaking ties. This is what makes zooming reveal nearby cities
 * instead of always the world's largest ones.
 *
 * `maxRank` enforces containment-aware zoom levels: pass 1 to show only
 * national/provincial capitals, 2 to add prefecture cities, or 3 (or omit)
 * for every city.
 */
export function cityStableKey(city: Pick<CityPoint, "name" | "latitude" | "longitude">): string {
  return `${city.name}\u0000${city.latitude.toFixed(4)}\u0000${city.longitude.toFixed(4)}`;
}

/**
 * Candidate coverage must not shrink as the user zooms in. Screen-space
 * magnification already creates more room between nearby labels; tightening
 * the angular window at the same time made local context disappear exactly
 * when the user asked for more detail. Keep one stable regional window and
 * let zoom tiers add lower-rank places monotonically.
 */
export function cityLabelFacingThreshold(_scale: number): number {
  return 0.3;
}

export function cityCandidateScore(
  city: CityPoint,
  facing: number,
  facingThreshold: number,
  persistent = false,
): number {
  const normalizedFacing = Math.max(0, Math.min(1,
    (facing - facingThreshold) / Math.max(0.0001, 1 - facingThreshold),
  ));
  // View proximity must dominate administrative rank. Large rank bonuses made
  // distant capitals consume the fixed candidate budget before centered local
  // cities could even reach screen-space collision placement. Rank remains a
  // useful preference among similarly positioned cities, but never outweighs
  // a materially better-facing lower-rank place.
  const rankBonus = [60, 40, 20, 0][Math.max(0, Math.min(3, city.rank))] ?? 0;
  const populationBonus = Math.min(180, Math.log10(Math.max(1, city.population)) * 24);
  const persistenceBonus = persistent ? 70 : 0;
  return normalizedFacing * 320 + rankBonus + populationBonus + persistenceBonus;
}

export function selectCityCandidates(
  cities: readonly CityPoint[],
  facingDirection: readonly [number, number, number],
  facingThreshold: number,
  limit: number,
  maxRank = 3,
  persistentCityKeys: ReadonlySet<string> = new Set(),
): CityPoint[] {
  if (limit <= 0) return [];
  const facingLength = Math.hypot(
    facingDirection[0],
    facingDirection[1],
    facingDirection[2],
  );
  if (facingLength === 0) return [];
  const directionX = facingDirection[0] / facingLength;
  const directionY = facingDirection[1] / facingLength;
  const directionZ = facingDirection[2] / facingLength;
  const candidates: Array<{ city: CityPoint; facing: number; score: number }> = [];
  for (const city of cities) {
    if (city.rank > maxRank) continue;
    const facing = city.direction[0] * directionX
      + city.direction[1] * directionY
      + city.direction[2] * directionZ;
    if (facing < facingThreshold) continue;
    candidates.push({
      city,
      facing,
      score: cityCandidateScore(
        city,
        facing,
        facingThreshold,
        persistentCityKeys.has(cityStableKey(city)),
      ),
    });
  }
  candidates.sort(
    (left, right) => right.score - left.score
      || right.facing - left.facing
      || right.city.population - left.city.population
      || left.city.name.localeCompare(right.city.name),
  );
  return candidates.slice(0, limit).map((candidate) => candidate.city);
}

let cityCache: { cities: CityPoint[] } | null = null;

export async function loadCityTiers(
  fetcher: typeof fetch = fetch,
): Promise<{ cities: CityPoint[] }> {
  if (cityCache) return cityCache;
  const response = await fetcher("/earth/cities.json", { cache: "force-cache" });
  if (!response.ok) {
    throw new Error("City label data is unavailable");
  }
  const payload = await response.json();
  cityCache = { cities: parseCityList(payload as { cities?: unknown }) };
  return cityCache;
}
