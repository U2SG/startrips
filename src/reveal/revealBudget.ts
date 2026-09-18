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
