import { describe, expect, it } from "vitest";
import {
  getLightEffectGradient,
  getLightEffectPalette,
} from "./lightEffects";

describe("light effects", () => {
  it("keeps legacy journeys on their single base color", () => {
    expect(getLightEffectPalette(null, "#f4ce73")).toEqual(["#f4ce73"]);
    expect(getLightEffectGradient(null, "#f4ce73")).toContain("#f4ce73");
  });

  it("derives the same effect mode from different base colors", () => {
    const warmRainbow = getLightEffectPalette("rainbow", "#f4ce73");
    const coolRainbow = getLightEffectPalette("rainbow", "#77c8c2");

    expect(warmRainbow).toHaveLength(7);
    expect(warmRainbow).not.toEqual(coolRainbow);
    expect(getLightEffectGradient("rainbow", "#f4ce73")).toContain("conic-gradient");
  });

  it("keeps each named mode multicolor while staying deterministic", () => {
    for (const effect of ["aurora", "sunset", "nebula"] as const) {
      const palette = getLightEffectPalette(effect, "#8ca8df");
      expect(new Set(palette).size).toBeGreaterThan(1);
      expect(getLightEffectPalette(effect, "#8ca8df")).toEqual(palette);
    }
  });
});
