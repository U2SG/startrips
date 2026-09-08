export type ScreenPoint = { x: number; y: number };

export const GLOBE_DRAG_THRESHOLD_PX = 6;
export const GLOBE_ZOOM_MIN = 0.72;
export const GLOBE_ZOOM_MAX = 3.0;
export const GLOBE_MAX_INERTIA_SCREEN_SPEED_PX_PER_SECOND = 640;

export function isGlobeDrag(distance: number) {
  return distance >= GLOBE_DRAG_THRESHOLD_PX;
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

export function rebaseGlobeDragSample(
  pointerId: number,
  pointer: ScreenPoint,
  timeStamp: number,
  alreadyConsumed: boolean,
) {
  return {
    pointerId,
    lastX: pointer.x,
    lastY: pointer.y,
    lastTime: timeStamp,
    travel: alreadyConsumed ? GLOBE_DRAG_THRESHOLD_PX : 0,
    started: alreadyConsumed,
  };
}
