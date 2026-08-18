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
    fetcher("/earth/ne_50m_populated_places.geojson", { cache: "force-cache" }),
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
    fine: parseCityFeatures(finePayload as { features?: unknown }),
  };
  return cityCache;
}
