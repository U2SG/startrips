import type { ParticleAnchorFrame } from "./detailedEarthModel";
import type { SemanticZoomSnapshot } from "./semanticZoom";

export const EARTH_DIVE_COMMIT_ANCHOR_TOLERANCE_PX = 2;
export const EARTH_DIVE_COMMIT_LOCAL_SCALE_TOLERANCE = 0.03;
export const EARTH_DIVE_FRAME_ZOOM_TOLERANCE = 0.0025;

export type EarthDiveScreenFrame = {
  screen: { x: number; y: number };
  pxPerDegreeLat: number;
};

export type EarthDiveAlignment = {
  aligned: boolean;
  anchorDeltaPx: number;
  localScaleError: number;
};

export function resolveEarthDiveAlignment(
  particle: EarthDiveScreenFrame | null | undefined,
  detail: EarthDiveScreenFrame | null | undefined,
  anchorTolerancePx = EARTH_DIVE_COMMIT_ANCHOR_TOLERANCE_PX,
  scaleTolerance = EARTH_DIVE_COMMIT_LOCAL_SCALE_TOLERANCE,
): EarthDiveAlignment | null {
  if (
    !particle
    || !detail
    || !Number.isFinite(particle.screen.x)
    || !Number.isFinite(particle.screen.y)
    || !Number.isFinite(detail.screen.x)
    || !Number.isFinite(detail.screen.y)
    || !(particle.pxPerDegreeLat > 0)
    || !(detail.pxPerDegreeLat > 0)
  ) return null;

  const anchorDeltaPx = Math.hypot(
    particle.screen.x - detail.screen.x,
    particle.screen.y - detail.screen.y,
  );
  const localScaleError = Math.abs(detail.pxPerDegreeLat / particle.pxPerDegreeLat - 1);
  return {
    aligned: anchorDeltaPx <= anchorTolerancePx && localScaleError <= scaleTolerance,
    anchorDeltaPx,
    localScaleError,
  };
}

export function particleAnchorFrameMatchesSemanticZoom(
  frame: ParticleAnchorFrame | null | undefined,
  snapshot: SemanticZoomSnapshot,
  tolerance = EARTH_DIVE_FRAME_ZOOM_TOLERANCE,
) {
  if (!frame || !Number.isFinite(frame.zoom)) return false;
  return Math.abs((frame.zoom as number) - snapshot.zoom) <= tolerance;
}
