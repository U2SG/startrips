import type { ParticleAnchorFrame } from "./detailedEarthModel";
import {
  EARTH_DIVE_BLEND_ENTER_PROGRESS,
  EARTH_DIVE_DETAIL_EXIT_PROGRESS,
  type EarthDiveStage,
} from "./earthDive";
import type { SemanticZoomSnapshot } from "./semanticZoom";

export const EARTH_DIVE_REVEAL_FEATHER_PX = 84;

export type EarthDiveRevealBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type EarthDiveRevealGeometry = {
  anchorX: number;
  anchorY: number;
  coreRadius: number;
  edgeRadius: number;
  progress: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Spatial reveal consumes the existing semantic-zoom authority. It owns no
 * timer and no additional transition state: wheel/pinch progress is the motion.
 * The keyboard fallback has no local-progress path, so it keeps the existing
 * full-frame blend instead of inventing a fake zoom trajectory.
 */
export function earthDiveSpatialRevealProgress(
  stage: EarthDiveStage,
  snapshot: SemanticZoomSnapshot,
) {
  if (stage !== "blending") return stage === "detail" ? 1 : 0;
  if (snapshot.level !== "local") return 1;
  const span = EARTH_DIVE_DETAIL_EXIT_PROGRESS - EARTH_DIVE_BLEND_ENTER_PROGRESS;
  if (!(span > 0)) return 1;
  return clamp(
    (snapshot.localProgress - EARTH_DIVE_BLEND_ENTER_PROGRESS) / span,
    0,
    1,
  );
}

/**
 * Convert the particle anchor's VIEWPORT pixels into the detail layer's local
 * coordinates, then choose a radius that fully covers every corner at progress
 * 1. The feather sits outside that full-coverage radius, so committed detail
 * never leaves dim corners.
 */
export function resolveEarthDiveRevealGeometry(
  frame: ParticleAnchorFrame | null | undefined,
  bounds: EarthDiveRevealBounds,
  stage: EarthDiveStage,
  snapshot: SemanticZoomSnapshot,
  featherPx = EARTH_DIVE_REVEAL_FEATHER_PX,
): EarthDiveRevealGeometry | null {
  if (
    !frame
    || !Number.isFinite(frame.screen.x)
    || !Number.isFinite(frame.screen.y)
    || !Number.isFinite(bounds.left)
    || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) return null;

  // A whole-Journey focus may legitimately project its fitted centre beyond
  // the viewport while the visible route spans the screen. Preserve that real
  // direction: radial-gradient centres are allowed outside the element.
  const anchorX = frame.screen.x - bounds.left;
  const anchorY = frame.screen.y - bounds.top;
  const fullCoverageRadius = Math.max(
    Math.hypot(anchorX, anchorY),
    Math.hypot(bounds.width - anchorX, anchorY),
    Math.hypot(anchorX, bounds.height - anchorY),
    Math.hypot(bounds.width - anchorX, bounds.height - anchorY),
  );
  const progress = earthDiveSpatialRevealProgress(stage, snapshot);
  const edgeRadius = (fullCoverageRadius + Math.max(0, featherPx)) * progress;
  const coreRadius = Math.max(0, edgeRadius - Math.max(0, featherPx));
  return { anchorX, anchorY, coreRadius, edgeRadius, progress };
}
