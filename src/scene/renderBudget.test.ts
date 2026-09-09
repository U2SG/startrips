import { describe, expect, it } from "vitest";
import { resolveRenderBudget } from "./renderBudget";

describe("resolveRenderBudget", () => {
  it("caps dense DPR with the quality profile", () => {
    const budget = resolveRenderBudget({
      viewportWidth: 430, viewportHeight: 932, deviceDpr: 3,
      qualityProfile: { maxDpr: 2, maxDrawingBufferPixels: 4_000_000 },
    });
    expect(budget.effectiveDpr).toBe(2);
    expect(budget.drawingBufferPixels).toBe(860 * 1864);
  });

  it("reduces DPR when a large viewport would exceed the pixel budget", () => {
    const budget = resolveRenderBudget({
      viewportWidth: 2560, viewportHeight: 1440, deviceDpr: 3,
      qualityProfile: { maxDpr: 2, maxDrawingBufferPixels: 4_000_000 },
    });
    expect(budget.effectiveDpr).toBeLessThan(2);
    expect(budget.drawingBufferPixels).toBeLessThanOrEqual(4_005_000);
    expect(Number.isFinite(budget.effectiveDpr)).toBe(true);
  });

  it("honors the pixel cap even when a very large viewport needs DPR below 0.5", () => {
    const budget = resolveRenderBudget({
      viewportWidth: 3840, viewportHeight: 2160, deviceDpr: 3,
      qualityProfile: { maxDpr: 1, maxDrawingBufferPixels: 1_500_000 },
    });
    expect(budget.effectiveDpr).toBeLessThan(0.5);
    expect(budget.drawingBufferPixels).toBeLessThanOrEqual(1_500_000);
  });

  it("returns finite defaults for invalid browser measurements", () => {
    const budget = resolveRenderBudget({
      viewportWidth: Number.NaN, viewportHeight: 0, deviceDpr: Number.POSITIVE_INFINITY,
      qualityProfile: { maxDpr: 2, maxDrawingBufferPixels: 4_000_000 },
    });
    expect(budget.effectiveDpr).toBe(1);
    expect(budget.drawingBufferPixels).toBe(1);
  });
});
