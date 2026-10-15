/** Native transports own their whole retargeted surface, not a guessed controls band. */
export const STREAM_NATIVE_INPUT = "video, audio, input, textarea, select, a[href], [contenteditable]:not([contenteditable='false']), button:not([data-stream-shot]), [role='button']:not([data-stream-shot])";

export function canStartStreamPointer(input: {
  isPrimary: boolean; button: number; blocked: boolean; activePointerId: number | null;
}): boolean {
  return input.isPrimary && input.button === 0 && !input.blocked && input.activePointerId === null;
}

/** Only a completed intentional horizontal drag can change Journey. */
export function streamSwipeDirection(dx: number, dy: number, moved: boolean, cancelled: boolean): -1 | 1 | null {
  if (cancelled || !moved || !Number.isFinite(dx) || !Number.isFinite(dy)
    || Math.abs(dx) <= 70 || Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 1 : -1;
}

/** Once a drag claims capture, native loss ends ownership before any later event. */
export function streamPointerHasLostCapture(moved: boolean, captured: boolean): boolean {
  return moved && !captured;
}
