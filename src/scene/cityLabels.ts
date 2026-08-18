import { latLonToVector3 } from "./geo";

export type CityPoint = {
  name: string;
  latitude: number;
  longitude: number;
  population: number;
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
      direction: [vector.x, vector.y, vector.z],
    });
  }
  // Largest first so a bounded label budget keeps the most important cities.
  return cities.sort((left, right) => right.population - left.population);
}

/**
 * Parse the compact GeoNames build (public/earth/cities.json): an array of
 * { n: asciiname, la: latitude, lo: longitude, p: population } objects,
 * pre-sorted by population descending. Directions are computed once here so
 * per-frame view filtering is pure dot products.
 */
export function parseCityList(payload: { cities?: unknown }): CityPoint[] {
  if (!Array.isArray(payload.cities)) return [];
  const cities: CityPoint[] = [];
  for (const raw of payload.cities) {
    const entry = raw as { n?: unknown; la?: unknown; lo?: unknown; p?: unknown };
    const name = typeof entry.n === "string" ? entry.n.trim() : "";
    const latitude = Number(entry.la);
    const longitude = Number(entry.lo);
    const population = Number(entry.p);
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
    cities.push({
      name,
      latitude,
      longitude,
      population: Number.isFinite(population) ? population : 0,
      direction: [vector.x, vector.y, vector.z],
    });
  }
  return cities;
}

/**
 * Pick the cities worth labeling for the current view. `facingDirection` is
 * the globe-local unit vector from the globe center toward the camera; cities
 * are filtered by how directly they face the camera (the threshold tightens
 * as the globe zooms in) and then sorted nearest-to-view-center first, with
 * population breaking ties. This is what makes zooming reveal nearby cities
 * instead of always the world's largest ones.
 */
export function selectCityCandidates(
  cities: readonly CityPoint[],
  facingDirection: readonly [number, number, number],
  facingThreshold: number,
  limit: number,
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
  const candidates: Array<{ city: CityPoint; facing: number }> = [];
  for (const city of cities) {
    const facing = city.direction[0] * directionX
      + city.direction[1] * directionY
      + city.direction[2] * directionZ;
    if (facing < facingThreshold) continue;
    candidates.push({ city, facing });
  }
  candidates.sort(
    (left, right) => right.facing - left.facing
      || right.city.population - left.city.population,
  );
  return candidates.slice(0, limit).map((candidate) => candidate.city);
}

let cityCache: { coarse: CityPoint[]; fine: CityPoint[] } | null = null;

export async function loadCityTiers(
  fetcher: typeof fetch = fetch,
): Promise<{ coarse: CityPoint[]; fine: CityPoint[] }> {
  if (cityCache) return cityCache;
  const [coarseResponse, fineResponse] = await Promise.all([
    fetcher("/earth/ne_110m_populated_places.geojson", { cache: "force-cache" }),
    fetcher("/earth/cities.json", { cache: "force-cache" }),
  ]);
  if (!coarseResponse.ok || !fineResponse.ok) {
    throw new Error("City label data is unavailable");
  }
  const [coarsePayload, finePayload] = await Promise.all([
    coarseResponse.json(),
    fineResponse.json(),
  ]);
  cityCache = {
    coarse: parseCityFeatures(coarsePayload as { features?: unknown }),
    fine: parseCityList(finePayload as { cities?: unknown }),
  };
  return cityCache;
}
