import { motionTokens } from "../motion/tokens";

// A photograph yields to the next one inside a compact, stable depth stack.
// Shared by program navigation, direct manipulation and Playback presentation.
export const MEDIA_STACK_DURATION = motionTokens.tiers.ui + motionTokens.tiers.instant;
// Sample a damped spring once, outside the render loop. Both CSS gesture
// settling and WAAPI navigation consume exactly the same response curve.
const springSamples = Array.from({ length: 33 }, (_, index) => {
  const time = index / 32 * MEDIA_STACK_DURATION / 1000;
  const damping = 14;
  const frequency = Math.sqrt(300 - damping * damping);
  return 1 - Math.exp(-damping * time)
    * (Math.cos(frequency * time) + damping / frequency * Math.sin(frequency * time));
});
export const MEDIA_STACK_EASING = `linear(${springSamples.map((value, index) =>
  index === 32 ? "1" : value.toFixed(5)).join(", ")})`;

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

/** Keep the leaving asset recognizable, then tuck it behind the new one. */
export function mediaStackDeparture(direction: -1 | 1, width: number, depth = 1): Keyframe[] {
  return [
    { transform: mediaStackRest(0), opacity: 1, zIndex: 5, offset: 0 },
    { transform: mediaStackPull(-direction * width * 0.18, width), opacity: 0.82, zIndex: 5, offset: 0.32 },
    { transform: mediaStackRest(depth), opacity: mediaStackOpacity(depth), zIndex: 1, offset: 1 },
  ];
}

export function mediaStackReveal(depth: number, progress: number) {
  return mediaStackRest(depth * (1 - Math.min(1, Math.max(0, progress))));
}
