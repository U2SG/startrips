import { describe, expect, it } from "vitest";
import {
  journeyBookBlockWidth,
  journeyBookFlipMinWidth,
  journeyBookLayout,
  journeyBookLayoutCompatible,
} from "./journeyBookLayout";

describe("journeyBookLayout", () => {
  it("opens one readable page on a portrait phone", () => {
    expect(journeyBookLayout(390, 600)).toEqual({ orientation: "portrait", pageWidth: 389, pageHeight: 487 });
  });

  it("opens a spread on a short landscape phone and never exceeds its height", () => {
    const layout = journeyBookLayout(780, 280)!;
    expect(layout.orientation).toBe("landscape");
    expect(layout.pageHeight).toBeLessThanOrEqual(280);
    expect(journeyBookBlockWidth(layout)).toBeLessThanOrEqual(780);
  });

  it("opens a spread on a desktop window", () => {
    expect(journeyBookLayout(1400, 700)).toEqual({ orientation: "landscape", pageWidth: 560, pageHeight: 700 });
  });

  it("prefers one large page over a small spread on a square stage", () => {
    expect(journeyBookLayout(600, 600)?.orientation).toBe("portrait");
  });

  it("always fits the stage in both directions", () => {
    for (const [width, height] of [[320, 480], [568, 260], [834, 1112], [1112, 760], [2560, 1300]]) {
      const layout = journeyBookLayout(width, height)!;
      expect(layout.pageHeight).toBeLessThanOrEqual(height);
      expect(journeyBookBlockWidth(layout)).toBeLessThanOrEqual(width);
    }
  });

  it("has no layout before the stage has a size", () => {
    expect(journeyBookLayout(0, 600)).toBeNull();
  });
});

describe("journeyBookLayoutCompatible", () => {
  it("keeps the book through a small resize and rebuilds on a turn of the device", () => {
    const built = journeyBookLayout(1400, 700)!;
    expect(journeyBookLayoutCompatible(built, journeyBookLayout(1300, 650)!)).toBe(true);
    expect(journeyBookLayoutCompatible(built, journeyBookLayout(390, 600)!)).toBe(false);
  });

  it("reproduces PageFlip's own portrait rule with the chosen minWidth", () => {
    const portrait = journeyBookLayout(390, 600)!;
    expect(journeyBookBlockWidth(portrait)).toBeLessThan(journeyBookFlipMinWidth(portrait) * 2);
    const landscape = journeyBookLayout(1400, 700)!;
    expect(journeyBookBlockWidth(landscape)).toBeGreaterThanOrEqual(journeyBookFlipMinWidth(landscape) * 2);
  });

  it("rebuilds when a spread shrinks past the band PageFlip was given", () => {
    const built = journeyBookLayout(1400, 700)!;
    expect(journeyBookLayoutCompatible(built, journeyBookLayout(700, 340)!)).toBe(false);
  });
});
