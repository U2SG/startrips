export const MEDIA_SWIPE_DISTANCE_PX = 48;
export const MEDIA_SWIPE_FLICK_MIN_DISTANCE_PX = 36;
export const MEDIA_SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.45;

export function isMediaSwipeIntent(dx: number, velocityX: number): boolean {
  if (Math.abs(dx) >= MEDIA_SWIPE_DISTANCE_PX) return true;
  if (Math.abs(dx) < MEDIA_SWIPE_FLICK_MIN_DISTANCE_PX) return false;
  if (Math.abs(velocityX) < MEDIA_SWIPE_FLICK_VELOCITY_PX_PER_MS) return false;
  return Math.sign(dx) === Math.sign(velocityX);
}

export function shouldCommitMediaSwipe(dx: number, velocityX: number, hasNeighbor: boolean): boolean {
  return hasNeighbor && isMediaSwipeIntent(dx, velocityX);
}
