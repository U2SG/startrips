export type TerrainReliefQuality = "low" | "high";

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function terrainReliefStrength(
  zoom: number,
  quality: TerrainReliefQuality = "high",
): number {
  const clamped = Math.max(0.72, Math.min(3, zoom));
  const regional = smoothstep(1.35, 2.15, clamped);
  const local = smoothstep(2.05, 2.75, clamped);
  const qualityScale = quality === "low" ? 0.5 : 1;
  return Math.min(1, (regional * 0.62 + local * 0.38) * qualityScale);
}

export function terrainReliefOpacity(
  zoom: number,
  quality: TerrainReliefQuality = "high",
): number {
  const strength = terrainReliefStrength(zoom, quality);
  return 0.006 + strength * 0.052;
}

export function terrainReliefBumpScale(
  zoom: number,
  quality: TerrainReliefQuality = "high",
): number {
  return 0.001 + terrainReliefStrength(zoom, quality) * 0.0045;
}
