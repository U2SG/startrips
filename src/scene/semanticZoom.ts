export type GlobeSemanticZoom = "planet" | "macro" | "regional" | "local";
export type GlobeQualityProfile = "low" | "high";
export type GlobeCityTier = "capitals" | "prefectures" | "all";
export type GlobeCoastlineLod = "far" | "mid" | "near";

export interface GlobeSemanticZoomContext {
  zoom: number;
  previous?: GlobeSemanticZoom;
  qualityProfile?: GlobeQualityProfile;
}

/**
 * The continuous reading of the same zoom this module classifies.
 *
 * #252 asks the Semantic Earth Dive to occupy a real band rather than one enum
 * edge, and the owner's constraint is "one zoom authority", not "throw the
 * continuous zoom away". So the snapshot is derived HERE, once, from the
 * boundary that opens `local` and the ceiling of the range this module already
 * clamps to. A consumer takes the snapshot and never re-derives a band, which
 * is what keeps a second numeric zoom scale out of the scene components.
 */
export interface SemanticZoomSnapshot {
  level: GlobeSemanticZoom;
  /** The canonical zoom: the caller's zoom clamped to this module's range. */
  zoom: number;
  /** 0..1 depth inside the `local` band; 0 at every other level. */
  localProgress: number;
}

export interface GlobeSemanticZoomState {
  state: GlobeSemanticZoom;
  cityTier: GlobeCityTier;
  coastlineWeights: Record<GlobeCoastlineLod, number>;
  coastlineLod: GlobeCoastlineLod;
  /** The published continuous progress reading alongside the band. */
  snapshot: SemanticZoomSnapshot;
}

const ORDER: GlobeSemanticZoom[] = ["planet", "macro", "regional", "local"];
const BOUNDARIES = [1.3, 2.1, 2.55] as const;
const HYSTERESIS = 0.08;
// The zoom range this module is the authority for.
export const GLOBE_SEMANTIC_ZOOM_FLOOR = 0.72;
export const GLOBE_SEMANTIC_ZOOM_CEILING = 3;
// Where the `local` band opens. It is the same value the state machine reads,
// so "how deep inside `local` are we?" can never drift from the boundary that
// decided the band.
export const LOCAL_BAND_ENTRY_ZOOM = BOUNDARIES[2];
/**
 * The zoom this authority is set back to when a detail owner hands the camera
 * home. It sits a full hysteresis width below the `local` edge, so the band
 * actually reopens as `regional` instead of re-entering `local` on the next
 * frame. Leaving the dive entirely is still the band's decision, not this
 * value's: `regional` holds the prewarm.
 */
export const SEMANTIC_ZOOM_RELEASE_ZOOM = LOCAL_BAND_ENTRY_ZOOM - HYSTERESIS * 2;

export function clampSemanticZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return GLOBE_SEMANTIC_ZOOM_FLOOR;
  return Math.max(GLOBE_SEMANTIC_ZOOM_FLOOR, Math.min(GLOBE_SEMANTIC_ZOOM_CEILING, zoom));
}

/**
 * Normalized depth inside the `local` band, clamped to [0,1]: 0 at the
 * boundary that opens the band and 1 at the ceiling of the range.
 */
export function localBandProgress(zoom: number): number {
  const span = GLOBE_SEMANTIC_ZOOM_CEILING - LOCAL_BAND_ENTRY_ZOOM;
  if (span <= 0) return 0;
  const progress = (clampSemanticZoom(zoom) - LOCAL_BAND_ENTRY_ZOOM) / span;
  return Math.min(1, Math.max(0, progress));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function resolveGlobeSemanticZoomForFrame({
  zoom,
  current,
  qualityProfile = "high",
  focusFlightActive = false,
}: {
  zoom: number;
  current: GlobeSemanticZoomState;
  qualityProfile?: GlobeQualityProfile;
  focusFlightActive?: boolean;
}): GlobeSemanticZoomState {
  if (focusFlightActive) return current;
  return resolveGlobeSemanticZoom({
    zoom,
    previous: current.state,
    qualityProfile,
  });
}

export function resolveGlobeSemanticZoom({
  zoom,
  previous,
  qualityProfile = "high",
}: GlobeSemanticZoomContext): GlobeSemanticZoomState {
  const clampedZoom = clampSemanticZoom(zoom);
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

  return {
    state,
    cityTier,
    coastlineWeights,
    coastlineLod,
    snapshot: {
      level: state,
      zoom: clampedZoom,
      // Progress is meaningful only inside `local`. Below it the band has not
      // opened, and publishing a partial value there would let a consumer act
      // on a depth the state machine has not granted.
      localProgress: state === "local" ? localBandProgress(clampedZoom) : 0,
    },
  };
}
