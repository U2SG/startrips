import { describe, expect, it } from "vitest";
import { resolvePlaceMediaObservationRect } from "./placeMediaHandoff";

describe("resolvePlaceMediaObservationRect", () => {
  it("places the frame beside a visible geographic marker while preserving media aspect", () => {
    const rect = resolvePlaceMediaObservationRect(
      { left: 300, top: 200, width: 14, height: 14 },
      { left: 0, top: 0, width: 76, height: 58 },
      { width: 1200, height: 800 },
      false,
    );
    expect(rect).not.toBeNull();
    expect(rect?.left).toBeCloseTo(323);
    expect(rect?.top).toBeCloseTo(167.85);
    expect(rect?.width).toBeCloseTo(102.6);
    expect(rect?.height).toBeCloseTo(78.3);
  });

  it("flips left and clamps inside the viewport near the right edge", () => {
    const rect = resolvePlaceMediaObservationRect(
      { left: 1180, top: 20, width: 14, height: 14 },
      { left: 0, top: 0, width: 200, height: 100 },
      { width: 1200, height: 800 },
      false,
    );
    expect(rect).toEqual({ left: 1059, top: 12, width: 112, height: 56 });
  });

  it("refuses an offscreen or invalid geographic anchor", () => {
    expect(resolvePlaceMediaObservationRect(
      { left: -40, top: 100, width: 10, height: 10 },
      { left: 0, top: 0, width: 76, height: 58 },
      { width: 390, height: 844 },
      true,
    )).toBeNull();
    expect(resolvePlaceMediaObservationRect(
      { left: 100, top: 100, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 58 },
      { width: 390, height: 844 },
      true,
    )).toBeNull();
  });
});
