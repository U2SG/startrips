export const MEDIA_SWIPE_DISTANCE_PX = 48;
export const MEDIA_SWIPE_FLICK_MIN_DISTANCE_PX = 36;
export const MEDIA_SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.45;
export const MEDIA_SWIPE_VELOCITY_MAX_AGE_MS = 80;

export function isMediaSwipeIntent(dx: number, velocityX: number): boolean {
  if (Math.abs(dx) >= MEDIA_SWIPE_DISTANCE_PX) return true;
  if (Math.abs(dx) < MEDIA_SWIPE_FLICK_MIN_DISTANCE_PX) return false;
  if (Math.abs(velocityX) < MEDIA_SWIPE_FLICK_VELOCITY_PX_PER_MS) return false;
  return Math.sign(dx) === Math.sign(velocityX);
}

export function shouldCommitMediaSwipe(dx: number, velocityX: number, hasNeighbor: boolean): boolean {
  return hasNeighbor && isMediaSwipeIntent(dx, velocityX);
}

export function nextMediaSwipeVelocity(previousVelocity: number, deltaX: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return previousVelocity;
  const sampleVelocity = deltaX / elapsedMs;
  if (previousVelocity === 0 || elapsedMs > MEDIA_SWIPE_VELOCITY_MAX_AGE_MS) return sampleVelocity;
  return previousVelocity * 0.35 + sampleVelocity * 0.65;
}
