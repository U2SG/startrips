/**
 * Browser-side precondition for a stationary Story paint sample, not a pixel
 * verdict. A decoded photo and an opaque article can still be under a delayed
 * motionStageIn layout. Inspect only the photo's paint ancestors, not unrelated
 * animated controls, and leave the caller's deadline and pixel checks intact.
 */
export function storyPaintReady(surfaceSelector) {
  const surface = document.querySelector(surfaceSelector);
  const media = surface?.querySelector('[data-media-page="current"] img[data-shared-media-id], video[data-shared-media-id]');
  if (!media || !surface.closest(".journey-story")) return false;
  for (let node = media; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible"
      || Number(style.opacity) < .99 || node.getClientRects().length === 0) return false;
    if (node.getAnimations().some((animation) => animation.pending
      || animation.playState === "running" || animation.playState === "paused")) return false;
  }
  return true;
}
