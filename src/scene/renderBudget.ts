export type RenderQualityBudget = {
  maxDpr: number;
  maxDrawingBufferPixels: number;
};

export type RenderBudgetInput = {
  viewportWidth: number;
  viewportHeight: number;
  deviceDpr: number;
  qualityProfile: RenderQualityBudget;
};

export type ResolvedRenderBudget = {
  effectiveDpr: number;
  drawingBufferPixels: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
};

const finitePositive = (value: number, fallback: number) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

/** #247: one finite owner for both DPR and viewport-area render cost. */
export function resolveRenderBudget({
  viewportWidth,
  viewportHeight,
  deviceDpr,
  qualityProfile,
}: RenderBudgetInput): ResolvedRenderBudget {
  const width = Math.max(1, finitePositive(viewportWidth, 1));
  const height = Math.max(1, finitePositive(viewportHeight, 1));
  const maxDpr = finitePositive(qualityProfile.maxDpr, 1);
  const maxPixels = Math.max(1, finitePositive(qualityProfile.maxDrawingBufferPixels, width * height));
  const requestedDpr = Math.min(finitePositive(deviceDpr, 1), maxDpr);
  const areaDpr = Math.sqrt(maxPixels / (width * height));
  // The area budget is authoritative even when it requires sub-0.5 DPR on a
  // very large viewport. A visual-quality floor here would make the advertised
  // pixel cap false exactly on the expensive screens this resolver protects.
  const effectiveDpr = Math.min(requestedDpr, areaDpr);
  // Three.js floors drawing-buffer dimensions after applying pixel ratio. Mirror
  // that contract so the published pixel count cannot round above maxPixels.
  const drawingBufferWidth = Math.max(1, Math.floor(width * effectiveDpr));
  const drawingBufferHeight = Math.max(1, Math.floor(height * effectiveDpr));
  return {
    effectiveDpr,
    drawingBufferPixels: drawingBufferWidth * drawingBufferHeight,
    drawingBufferWidth,
    drawingBufferHeight,
  };
}
