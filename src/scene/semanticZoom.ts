export type GlobeSemanticZoom = "planet" | "macro" | "regional" | "local";
export type GlobeQualityProfile = "low" | "high";
export type GlobeCityTier = "capitals" | "prefectures" | "all";
export type GlobeCoastlineLod = "far" | "mid" | "near";

export interface GlobeSemanticZoomContext {
  zoom: number;
  previous?: GlobeSemanticZoom;
  qualityProfile?: GlobeQualityProfile;
}

export interface GlobeSemanticZoomState {
  state: GlobeSemanticZoom;
  cityTier: GlobeCityTier;
  coastlineWeights: Record<GlobeCoastlineLod, number>;
  coastlineLod: GlobeCoastlineLod;
}

const ORDER: GlobeSemanticZoom[] = ["planet", "macro", "regional", "local"];
const BOUNDARIES = [1.22, 1.72, 2.32] as const;
const HYSTERESIS = 0.08;

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function resolveGlobeSemanticZoom({
  zoom,
  previous,
  qualityProfile = "high",
}: GlobeSemanticZoomContext): GlobeSemanticZoomState {
  const clampedZoom = Math.max(0.72, Math.min(3, zoom));
  let index = previous ? ORDER.indexOf(previous) : 0;

  if (!previous) {
    while (index < BOUNDARIES.length && clampedZoom >= BOUNDARIES[index]) index += 1;
  } else {
    while (index < BOUNDARIES.length && clampedZoom >= BOUNDARIES[index] + HYSTERESIS) index += 1;
    while (index > 0 && clampedZoom < BOUNDARIES[index - 1] - HYSTERESIS) index -= 1;
  }

  const state = ORDER[index];
  const mid = smoothstep(1.12, 1.5, clampedZoom);
  const near = qualityProfile === "low" ? 0 : smoothstep(1.95, 2.45, clampedZoom);
  const coastlineWeights = {
    far: 1 - mid,
    mid: mid * (1 - near),
    near,
  };
  const coastlineLod = (Object.keys(coastlineWeights) as GlobeCoastlineLod[])
    .reduce((best, lod) => coastlineWeights[lod] > coastlineWeights[best] ? lod : best, "far");
  const cityTier: GlobeCityTier = state === "planet"
    ? "capitals"
    : state === "macro"
      ? "prefectures"
      : "all";

  return { state, cityTier, coastlineWeights, coastlineLod };
}
