import { resolveRenderBudget, type ResolvedRenderBudget } from "../scene/renderBudget";

/**
 * #367 slice 3: the cover reveal's share of the device's render cost.
 *
 * The persistent Particle Earth is the app's standing GPU tenant (#247). A
 * reveal is a short, foreground, full-stage effect that can appear while that
 * globe still holds its own context, so its budget is defined as strictly
 * smaller than the globe's *cheapest* profile rather than as a second,
 * independently tuned budget. `resolveRenderBudget` stays the single owner of
 * the DPR/area arithmetic; this module only supplies the reveal's caps and adds
 * the texture bound the globe resolver has no opinion about.
 */
export const REVEAL_RENDER_BUDGET = {
  maxDpr: 1,
  maxDrawingBufferPixels: 1_000_000,
  /**
   * Caps the decoded source textures. Two images are uploaded at once, so this
   * is deliberately half the vendored renderer's own 2048 default.
   */
  maxTextureSize: 1024,
} as const;

/**
 * The vendored renderer ROUNDS each drawing-buffer dimension after applying the
 * pixel ratio, while `resolveRenderBudget` deliberately FLOORS. Rounding can add
 * up to half a pixel per dimension, so a cap handed straight to the renderer can
 * be overshot: at 1440x900 with a 1,000,000 cap it allocates 1265x791, i.e.
 * 1,000,615 pixels.
 *
 * The overshoot is bounded: `round(w*d) * round(h*d)` is at most
 * `(w*d + 0.5) * (h*d + 0.5) = w*h*d^2 + 0.5*d*(w + h) + 0.25`. The cap can only
 * be the binding constraint when `w*h` exceeds it, and there `d = sqrt(C/(w*h))`,
 * so the excess is `0.5*sqrt(C)*(w + h)/sqrt(w*h)` - about `sqrt(C)`, i.e. ~1000
 * pixels, for a squarish container, and under this headroom for every aspect
 * ratio a real viewport produces. When the cap is NOT binding, `d` is 1 and the
 * rounding is exact. `revealBudget.test.ts` sweeps the realistic range against
 * the renderer's own arithmetic rather than trusting the algebra.
 */
export const REVEAL_ROUNDING_HEADROOM_PIXELS = 4_096;

export const RENDERER_MAX_PIXELS =
  REVEAL_RENDER_BUDGET.maxDrawingBufferPixels - REVEAL_ROUNDING_HEADROOM_PIXELS;

/**
 * The drawing buffer the vendored renderer will actually allocate, using its own
 * `min(dpr, maxDpr, sqrt(maxPixels / area))` and rounding. Exported so the cap
 * can be asserted against the renderer's real arithmetic rather than ours.
 */
export function rendererDrawingBufferPixels(
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number,
): number {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const dpr = Math.min(
    deviceDpr,
    REVEAL_RENDER_BUDGET.maxDpr,
    Math.sqrt(RENDERER_MAX_PIXELS / (width * height)),
  );
  return Math.max(1, Math.round(width * dpr)) * Math.max(1, Math.round(height * dpr));
}

export type ResolvedRevealBudget = ResolvedRenderBudget & {
  maxTextureSize: number;
};

export type RevealBudgetInput = {
  viewportWidth: number;
  viewportHeight: number;
  deviceDpr: number;
};

export function resolveRevealBudget(input: RevealBudgetInput): ResolvedRevealBudget {
  const resolved = resolveRenderBudget({
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    deviceDpr: input.deviceDpr,
    qualityProfile: {
      maxDpr: REVEAL_RENDER_BUDGET.maxDpr,
      maxDrawingBufferPixels: REVEAL_RENDER_BUDGET.maxDrawingBufferPixels,
    },
  });
  return { ...resolved, maxTextureSize: REVEAL_RENDER_BUDGET.maxTextureSize };
}
