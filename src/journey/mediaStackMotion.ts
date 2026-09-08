import { motionTokens } from "../motion/tokens";

// A card leaves the top of the pile while the next card straightens beneath it.
// Shared by program navigation, direct manipulation and Playback presentation.
export const MEDIA_STACK_DURATION = motionTokens.tiers.content;
export const MEDIA_STACK_EASING = motionTokens.easings.easeOutSoft;

/** The two actual photographs visible behind the current card. */
export function mediaStackNeighbors(index: number, length: number, wrap: boolean): number[] {
  if (index < 0 || length < 2) return [];
  const offsets = index === 0 && !wrap ? [1, 2] : [-1, 1];
  return [...new Set(offsets.map((offset) => wrap ? (index + offset + length) % length : index + offset))]
    .filter((candidate) => candidate >= 0 && candidate < length && candidate !== index);
}

export function mediaStackRest(depth: number) {
  return `translate3d(${depth * 3.2}%, ${depth * 1.2}%, 0) rotate(${depth * 5}deg) scale(${1 - depth * 0.035})`;
}

export function mediaStackPull(distance: number, width: number) {
  const progress = Math.min(1.4, Math.abs(distance) / Math.max(1, width));
  return `translate3d(${distance}px, ${progress * 18}px, 0) rotate(${Math.sign(distance) * progress * 2}deg) scale(1)`;
}

export function mediaStackReveal(depth: number, progress: number) {
  return mediaStackRest(depth * (1 - Math.min(1, Math.max(0, progress))));
}
