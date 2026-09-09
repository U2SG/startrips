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
  const maxPixels = finitePositive(qualityProfile.maxDrawingBufferPixels, width * height);
  const requestedDpr = Math.min(finitePositive(deviceDpr, 1), maxDpr);
  const areaDpr = Math.sqrt(maxPixels / (width * height));
  const effectiveDpr = Math.max(0.5, Math.min(requestedDpr, areaDpr));
  const drawingBufferWidth = Math.max(1, Math.round(width * effectiveDpr));
  const drawingBufferHeight = Math.max(1, Math.round(height * effectiveDpr));
  return {
    effectiveDpr,
    drawingBufferPixels: drawingBufferWidth * drawingBufferHeight,
    drawingBufferWidth,
    drawingBufferHeight,
  };
}
