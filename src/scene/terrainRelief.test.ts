import { describe, expect, it } from "vitest";
import {
  terrainReliefBumpScale,
  terrainReliefOpacity,
  terrainReliefStrength,
} from "./terrainRelief";

describe("terrain relief zoom narrative (#82)", () => {
  it("is nearly imperceptible globally and increases continuously toward local zoom", () => {
    const global = terrainReliefStrength(1);
    const regional = terrainReliefStrength(2);
    const local = terrainReliefStrength(2.8);
    expect(global).toBeLessThan(0.05);
    expect(regional).toBeGreaterThan(global);
    expect(local).toBeGreaterThan(regional);
    expect(local).toBeLessThanOrEqual(1);
  });

  it("caps relief cost/intensity on the low-quality profile", () => {
    expect(terrainReliefStrength(2.8, "low"))
      .toBeCloseTo(terrainReliefStrength(2.8, "high") * 0.5, 8);
    expect(terrainReliefOpacity(2.8, "low"))
      .toBeLessThan(terrainReliefOpacity(2.8, "high"));
    expect(terrainReliefBumpScale(2.8, "low"))
      .toBeLessThan(terrainReliefBumpScale(2.8, "high"));
  });

  it("clamps extreme zoom values to stable endpoints", () => {
    expect(terrainReliefStrength(-10)).toBe(terrainReliefStrength(0.72));
    expect(terrainReliefStrength(99)).toBe(terrainReliefStrength(3));
  });
});
