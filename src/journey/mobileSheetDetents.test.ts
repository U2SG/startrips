import { describe, expect, it } from "vitest";
import { resolveMobileSheetSwipe, stepDownMobileSheet } from "./mobileSheetDetents";

describe("Journey sheet detents", () => {
  it("expands medium to large on an upward swipe and ignores small moves", () => {
    expect(resolveMobileSheetSwipe("medium", -80, true)).toBe("large");
    expect(resolveMobileSheetSwipe("medium", -20, true)).toBeNull();
    expect(resolveMobileSheetSwipe("medium", 30, true)).toBeNull();
  });

  it("steps down large → medium → close", () => {
    expect(resolveMobileSheetSwipe("large", 100, true)).toBe("medium");
    expect(resolveMobileSheetSwipe("medium", 100, true)).toBe("close");
    expect(stepDownMobileSheet("large")).toBe("medium");
    expect(stepDownMobileSheet("medium")).toBe("close");
  });

  it("treats swipes inside scrolled large content as scrolling", () => {
    expect(resolveMobileSheetSwipe("large", 120, false)).toBeNull();
    expect(resolveMobileSheetSwipe("large", -120, false)).toBeNull();
    expect(resolveMobileSheetSwipe("large", -120, true)).toBeNull();
  });
});
