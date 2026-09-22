import { describe, expect, it } from "vitest";
import {
  REVEAL_RENDER_BUDGET,
  RENDERER_MAX_PIXELS,
  rendererDrawingBufferPixels,
  resolveRevealBudget,
} from "./revealBudget";
import { QUALITY_PROFILE, resolveRenderBudget } from "../scene/renderBudget";

const VIEWPORTS = [
  { label: "phone", viewportWidth: 390, viewportHeight: 844, deviceDpr: 3 },
  { label: "tablet", viewportWidth: 834, viewportHeight: 1_112, deviceDpr: 2 },
  { label: "laptop", viewportWidth: 1_440, viewportHeight: 900, deviceDpr: 2 },
  { label: "large-desktop", viewportWidth: 2_560, viewportHeight: 1_440, deviceDpr: 3 },
  { label: "tiny", viewportWidth: 320, viewportHeight: 240, deviceDpr: 1 },
];

describe("resolveRevealBudget", () => {
  it("never exceeds the persistent Particle Earth budget on any globe quality profile", () => {
    for (const viewport of VIEWPORTS) {
      const reveal = resolveRevealBudget(viewport);
      for (const quality of ["low", "high"] as const) {
        const globe = resolveRenderBudget({
          viewportWidth: viewport.viewportWidth,
          viewportHeight: viewport.viewportHeight,
          deviceDpr: viewport.deviceDpr,
          qualityProfile: QUALITY_PROFILE[quality],
        });
        expect(
          reveal.effectiveDpr,
          `${viewport.label} dpr vs globe ${quality}`,
        ).toBeLessThanOrEqual(globe.effectiveDpr);
        expect(
          reveal.drawingBufferPixels,
          `${viewport.label} pixels vs globe ${quality}`,
        ).toBeLessThanOrEqual(globe.drawingBufferPixels);
      }
    }
  });

  it("declares caps that are at or below the cheapest globe profile", () => {
    expect(REVEAL_RENDER_BUDGET.maxDpr).toBeLessThanOrEqual(QUALITY_PROFILE.low.maxDpr);
    expect(REVEAL_RENDER_BUDGET.maxDrawingBufferPixels)
      .toBeLessThanOrEqual(QUALITY_PROFILE.low.maxDrawingBufferPixels);
  });

  it("bounds device pixel ratio, drawing-buffer pixels and texture size", () => {
    for (const viewport of VIEWPORTS) {
      const reveal = resolveRevealBudget(viewport);
      expect(reveal.effectiveDpr).toBeGreaterThan(0);
      expect(reveal.effectiveDpr).toBeLessThanOrEqual(REVEAL_RENDER_BUDGET.maxDpr);
      expect(reveal.effectiveDpr).toBeLessThanOrEqual(viewport.deviceDpr);
      expect(reveal.drawingBufferPixels)
        .toBeLessThanOrEqual(REVEAL_RENDER_BUDGET.maxDrawingBufferPixels);
      expect(reveal.drawingBufferPixels)
        .toBe(reveal.drawingBufferWidth * reveal.drawingBufferHeight);
      expect(reveal.maxTextureSize).toBe(REVEAL_RENDER_BUDGET.maxTextureSize);
    }
  });

  it("keeps the texture bound under the vendored renderer's own default", () => {
    // The vendored renderer defaults to 2048 and uploads two source images at
    // once; the reveal stage passes this smaller bound instead.
    expect(REVEAL_RENDER_BUDGET.maxTextureSize).toBeLessThanOrEqual(1_024);
  });

  it("keeps the renderer's own rounded drawing buffer inside the advertised cap", () => {
    // The renderer rounds where `resolveRenderBudget` floors, so the cap it is
    // handed has to leave room for that. 1440x900 is the case where rounding
    // the raw cap overshoots (1265x791 = 1,000,615 pixels).
    for (let width = 320; width <= 3_840; width += 37) {
      for (const height of [Math.round(width * 0.5625), Math.round(width * 1.8), 900]) {
        for (const deviceDpr of [1, 2, 3]) {
          const pixels = rendererDrawingBufferPixels(width, height, deviceDpr);
          expect(
            pixels,
            `${width}x${height} @${deviceDpr}`,
          ).toBeLessThanOrEqual(REVEAL_RENDER_BUDGET.maxDrawingBufferPixels);
        }
      }
    }
    expect(rendererDrawingBufferPixels(1_440, 900, 2))
      .toBeLessThanOrEqual(REVEAL_RENDER_BUDGET.maxDrawingBufferPixels);
    expect(RENDERER_MAX_PIXELS).toBeLessThan(REVEAL_RENDER_BUDGET.maxDrawingBufferPixels);
  });

  it("keeps the renderer's rounded buffer inside the globe's budget too", () => {
    for (const viewport of VIEWPORTS) {
      const pixels = rendererDrawingBufferPixels(
        viewport.viewportWidth,
        viewport.viewportHeight,
        viewport.deviceDpr,
      );
      for (const quality of ["low", "high"] as const) {
        const globe = resolveRenderBudget({
          viewportWidth: viewport.viewportWidth,
          viewportHeight: viewport.viewportHeight,
          deviceDpr: viewport.deviceDpr,
          qualityProfile: QUALITY_PROFILE[quality],
        });
        expect(pixels, `${viewport.label} vs globe ${quality}`)
          .toBeLessThanOrEqual(globe.drawingBufferPixels);
      }
    }
  });

  it("reuses the globe's resolver instead of a second DPR arithmetic", () => {
    const viewport = VIEWPORTS[3];
    expect(resolveRevealBudget(viewport)).toEqual({
      ...resolveRenderBudget({
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        deviceDpr: viewport.deviceDpr,
        qualityProfile: {
          maxDpr: REVEAL_RENDER_BUDGET.maxDpr,
          maxDrawingBufferPixels: REVEAL_RENDER_BUDGET.maxDrawingBufferPixels,
        },
      }),
      maxTextureSize: REVEAL_RENDER_BUDGET.maxTextureSize,
    });
  });
});
