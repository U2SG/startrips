import { motionTokens } from "../motion/tokens";

// A photograph yields to the next one inside a compact, stable depth stack.
// Shared by program navigation, direct manipulation and Playback presentation.
export const MEDIA_STACK_DURATION = motionTokens.tiers.ui + motionTokens.tiers.instant;
// Compatibility timing for a short tap's auxiliary reveal; spatial movement
// itself is integrated by springElementTo and has no fixed-duration timeline.
export const MEDIA_STACK_EASING = motionTokens.easings.easeOutSoft;

/** The two actual photographs visible behind the current card. */
export function mediaStackNeighbors(index: number, length: number, wrap: boolean): number[] {
  if (index < 0 || length < 2) return [];
  const offsets = index === 0 && !wrap ? [1, 2] : [-1, 1];
  return [...new Set(offsets.map((offset) => wrap ? (index + offset + length) % length : index + offset))]
    .filter((candidate) => candidate >= 0 && candidate < length && candidate !== index);
}

export function mediaStackRest(depth: number) {
  return `translate3d(${depth * 3.6}%, ${depth * 2.8}%, ${-depth * 12}px) rotateY(${-depth * 3}deg) scale(${1 - depth * 0.055})`;
}

export function mediaStackPull(distance: number, width: number) {
  // The pointer owns direction; resistance keeps the content inside its stage.
  const limit = Math.max(1, width) * 0.22;
  const displacement = Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) / limit));
  return `translate3d(${displacement}px, 0, 0) rotateY(${displacement / Math.max(1, width) * -4}deg) scale(1)`;
}

export function mediaStackOpacity(depth: number) { return Math.max(0.64, 1 - depth * 0.18); }

/** Rear photographs fit within the front photograph's visible aperture. */
export function mediaStackClip(page: HTMLElement, front: HTMLElement | null): [number, number] {
  if (!front || page === front) return [0, 0];
  const media = front.querySelector<HTMLImageElement | HTMLCanvasElement>('img:not([hidden]), canvas:not([hidden])');
  const width = media instanceof HTMLImageElement ? media.naturalWidth : media?.width;
  const height = media instanceof HTMLImageElement ? media.naturalHeight : media?.height;
  if (!width || !height || !page.clientWidth || !page.clientHeight) return [0, 0];
  const fit = Math.min(page.clientWidth / width, page.clientHeight / height);
  return [(1 - height * fit / page.clientHeight) * 50, (1 - width * fit / page.clientWidth) * 50];
}

export function mediaStackReveal(depth: number, progress: number) {
  return mediaStackRest(depth * (1 - Math.min(1, Math.max(0, progress))));
}
