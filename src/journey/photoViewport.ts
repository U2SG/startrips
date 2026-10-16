/** Photo-local geometry. Offsets are CSS pixels from the fitted image centre. */
export type PhotoPoint = { x: number; y: number };
export type PhotoSize = { width: number; height: number };
export type PhotoTransform = PhotoPoint & { scale: number };
export type PhotoBounds = { viewport: PhotoSize; fitted: PhotoSize };
export const PHOTO_ZOOM_MAX = 4;
export const PHOTO_FIT: Readonly<PhotoTransform> = { scale: 1, x: 0, y: 0 };

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, finite(value)));

export function fitPhoto(viewport: PhotoSize, natural: PhotoSize): PhotoBounds | null {
  if (![viewport.width, viewport.height, natural.width, natural.height].every((n) => Number.isFinite(n) && n > 0)) return null;
  const fit = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  return { viewport, fitted: { width: natural.width * fit, height: natural.height * fit } };
}

export function clampPhoto(value: PhotoTransform, bounds: PhotoBounds): PhotoTransform {
  const scale = Math.max(1, Math.min(PHOTO_ZOOM_MAX, finite(value.scale, 1)));
  return { scale,
    x: clamp(value.x, Math.max(0, (bounds.fitted.width * scale - bounds.viewport.width) / 2)),
    y: clamp(value.y, Math.max(0, (bounds.fitted.height * scale - bounds.viewport.height) / 2)),
  };
}

/** Always derive from the pointer-down snapshot, never from the previous move. */
export function panPhoto(origin: PhotoTransform, delta: PhotoPoint, bounds: PhotoBounds): PhotoTransform {
  return clampPhoto({ ...origin, x: origin.x + finite(delta.x), y: origin.y + finite(delta.y) }, bounds);
}

/** Pinching may translate its midpoint as well as change scale. Clamp only once. */
export function pinchPhoto(origin: PhotoTransform, from: PhotoPoint, to: PhotoPoint, scale: number, bounds: PhotoBounds): PhotoTransform {
  const nextScale = Math.max(1, Math.min(PHOTO_ZOOM_MAX, finite(scale, 1)));
  const ratio = nextScale / Math.max(1, finite(origin.scale, 1));
  return clampPhoto({ scale: nextScale,
    x: finite(to.x) - (finite(from.x) - origin.x) * ratio,
    y: finite(to.y) - (finite(from.y) - origin.y) * ratio,
  }, bounds);
}

export function zoomPhotoAt(origin: PhotoTransform, scale: number, anchor: PhotoPoint, bounds: PhotoBounds): PhotoTransform {
  return pinchPhoto(origin, anchor, anchor, scale, bounds);
}
