export type PlaceMediaRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PlaceMediaViewport = { width: number; height: number };

function finiteRect(rect: PlaceMediaRect) {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 1
    && rect.height > 1;
}

/**
 * Presentation-only geography -> media aperture. The Route Point remains the
 * semantic object; this small frame merely gives the same media asset a spatial
 * place to depart from / return to. It is measured from live viewport geometry
 * on every intent, never stored as an x/y business state.
 */
export function resolvePlaceMediaObservationRect(
  marker: PlaceMediaRect,
  media: PlaceMediaRect,
  viewport: PlaceMediaViewport,
  compact: boolean,
): PlaceMediaRect | null {
  if (!finiteRect(marker) || !finiteRect(media) || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const markerRight = marker.left + marker.width;
  const markerBottom = marker.top + marker.height;
  if (markerRight <= 0 || markerBottom <= 0 || marker.left >= viewport.width || marker.top >= viewport.height) {
    return null;
  }

  const margin = compact ? 10 : 12;
  const gap = compact ? 10 : 16;
  const maxWidth = compact ? 92 : 112;
  const width = Math.min(maxWidth, Math.max(72, media.width * 1.35));
  const aspect = media.width / media.height;
  const maxHeight = compact ? 78 : 90;
  const height = Math.min(maxHeight, width / Math.max(0.45, Math.min(2.4, aspect)));
  const centerX = marker.left + marker.width / 2;
  const centerY = marker.top + marker.height / 2;
  const preferRight = centerX < viewport.width * 0.58;
  const unclampedLeft = preferRight ? centerX + gap : centerX - gap - width;
  const left = Math.max(margin, Math.min(viewport.width - margin - width, unclampedLeft));
  const top = Math.max(margin, Math.min(viewport.height - margin - height, centerY - height / 2));
  return { left, top, width, height };
}
