import { describe, expect, it } from "vitest";
import { filmTextBands } from "./journeyFilmCanvas";

describe("memory-film caption and footer separation", () => {
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    for (const lines of [0, 1, 3, 4]) {
      it(`${width}x${height}: ${lines} wrapped lines never obscure dates or the map`, () => {
        const margin = Math.min(width, height) * 0.075;
        const fontSize = Math.min(width, height) * 0.034;
        const bottom = margin + fontSize * 2 + fontSize * 1.65 * 1.25;
        const bands = filmTextBands(width, height, margin, fontSize, lines, bottom);
        expect(bands.mapTop).toBeGreaterThanOrEqual(bottom + margin);
        expect(bands.mapTop + bands.mapSize).toBeLessThan(bands.routeLabelTop);
        expect(bands.routeLabelTop + fontSize).toBeLessThan(bands.dateTop);
        expect(bands.dateTop + fontSize).toBeLessThan(bands.captionTop);
        expect(bands.captionTop + bands.captionHeight).toBe(height);
      });
    }
  }
  it("refuses impossible text rather than overlapping or dropping it", () => {
    expect(() => filmTextBands(1920, 1080, 80, 42, 24, 300)).toThrow("text_layout_limit");
  });
});
