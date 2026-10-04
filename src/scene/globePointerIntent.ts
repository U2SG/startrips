export type ScreenPoint = { x: number; y: number };

export const GLOBE_DRAG_THRESHOLD_PX = 6;
export const GLOBE_ZOOM_MIN = 0.72;
export const GLOBE_ZOOM_MAX = 3.0;
/** Wheel zoom is multiplicative: zoom *= exp(-deltaY * speed), applied unsmoothed. */
export const GLOBE_WHEEL_ZOOM_SPEED = 0.0012;
/** A standard mouse wheel notch. */
export const GLOBE_WHEEL_NOTCH_DELTA_Y = 100;
export const GLOBE_MAX_INERTIA_SCREEN_SPEED_PX_PER_SECOND = 640;

export function isGlobeDrag(distance: number) {
  return distance >= GLOBE_DRAG_THRESHOLD_PX;
}

/**
 * How far the pointer has strayed from where this contact started.
 *
 * The threshold must be measured against the press point, not against the
 * accumulated path length. Summing per-move distances counts a slow wander as
 * travel: a trackpad two-finger nudge, or a hand resting on a trackpad, traces
 * far more than 6px of arc while the pointer never leaves a 2px neighbourhood
 * of where it went down. That misreads an intended tap as a drag, claims manual
 * camera ownership, and consumes the gesture so the tap never activates the
 * Route Point underneath.
 */
export function globeDragDisplacementPx(origin: ScreenPoint, current: ScreenPoint) {
  return Math.hypot(current.x - origin.x, current.y - origin.y);
}

export function isPrimaryPointerActivation(
  event: Pick<PointerEvent, "button" | "isPrimary" | "pointerType">,
) {
  return event.isPrimary
    && (event.pointerType !== "mouse" || event.button === 0);
}

export function clampGlobeZoom(zoom: number) {
  return Math.max(GLOBE_ZOOM_MIN, Math.min(GLOBE_ZOOM_MAX, zoom));
}

export function projectedRadiusRotationDelta(
  previous: ScreenPoint,
  current: ScreenPoint,
  radius: number,
) {
  const safeRadius = Math.max(1, radius);
  const rotationX = (current.y - previous.y) / safeRadius;
  const rotationY = (current.x - previous.x) / safeRadius;
  return {
    rotationX,
    rotationY,
    angularDelta: Math.hypot(rotationX, rotationY),
  };
}

export function getGlobeInertiaSpeedLimit(interactionRadiusPx: number) {
  return GLOBE_MAX_INERTIA_SCREEN_SPEED_PX_PER_SECOND
    / Math.max(1, interactionRadiusPx);
}

export function shouldRetainGlobeInertia(
  lastSampleAt: number,
  releaseAt: number,
  angularDelta: number,
) {
  return releaseAt - lastSampleAt <= 80 && angularDelta >= 0.0002;
}

export function isReliablePinchAnchor(
  point: ScreenPoint,
  globeCenter: ScreenPoint,
  projectedGlobeRadiusPx: number,
) {
  return Number.isFinite(projectedGlobeRadiusPx)
    && projectedGlobeRadiusPx > 0
    && Math.hypot(point.x - globeCenter.x, point.y - globeCenter.y)
      <= projectedGlobeRadiusPx * 0.98;
}

export function canTrackGlobePointer(activePointerCount: number) {
  return activePointerCount < 2;
}

export function shouldSuppressUntrackedPointerActivation(
  rejectedByGestureCapacity: boolean,
  activePointerCount: number,
) {
  return rejectedByGestureCapacity || activePointerCount > 0;
}

export function shouldRememberUntrackedPointerStart(activePointerCount: number) {
  return activePointerCount > 0;
}

/**
 * Start (or re-anchor, when a second finger joins) one contact's drag.
 *
 * `origin` is where the contact began and is the only thing the threshold is
 * measured against. `alreadyConsumed` means a pinch collapsed into a one-finger
 * drag that had already claimed the camera; that gesture stays started, so the
 * threshold is never re-tested for it and the origin needs no fudging.
 */
export function rebaseGlobeDragSample(
  pointerId: number,
  pointer: ScreenPoint,
  timeStamp: number,
  alreadyConsumed: boolean,
) {
  return {
    pointerId,
    origin: { x: pointer.x, y: pointer.y },
    lastX: pointer.x,
    lastY: pointer.y,
    lastTime: timeStamp,
    started: alreadyConsumed,
  };
}
