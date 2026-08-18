export type CityPoint = {
  name: string;
  latitude: number;
  longitude: number;
  population: number;
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
    cities.push({
      name,
      latitude,
      longitude,
      population: Number.isFinite(population) ? population : 0,
    });
  }
  // Largest first so a bounded label budget keeps the most important cities.
  return cities.sort((left, right) => right.population - left.population);
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
