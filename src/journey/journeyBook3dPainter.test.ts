import { describe, expect, it } from "vitest";
import { COVER_GROOVE, COVER_MATERIAL, coverMaterialColor, wrapLines, wrapUnits } from "./journeyBook3dPainter";

// Every character one unit wide.
const measure = (value: string) => Array.from(value).length;

describe("wrapUnits", () => {
  it("keeps Latin words whole and splits CJK by character", () => {
    expect(wrapUnits("在Death Valley看日出")).toEqual(["在", "Death", " ", "Valley", "看", "日", "出"]);
  });
});

describe("wrapLines", () => {
  it("wraps CJK text by character", () => {
    expect(wrapLines("一二三四五六七", 3, measure)).toEqual(["一二三", "四五六", "七"]);
  });

  it("never starts a line with closing punctuation", () => {
    expect(wrapLines("一二三，四五", 3, measure)).toEqual(["一二三，", "四五"]);
  });

  it("moves a whole Latin word and drops the space at the break", () => {
    expect(wrapLines("see the sea", 7, measure)).toEqual(["see the", "sea"]);
  });

  it("keeps paragraph breaks", () => {
    expect(wrapLines("一二\n三", 5, measure)).toEqual(["一二", "三"]);
  });
});

describe("cover material map", () => {
  it("packs height, roughness and metalness into R, G and B", () => {
    expect(COVER_MATERIAL.cloth).toEqual([128, 230, 0]);
    // Foil is the only metal; the Route, mark and start square are pressed in, the plate raised.
    expect(COVER_MATERIAL.foil[1]).toBe(128);
    expect(COVER_MATERIAL.foil[2]).toBe(217);
    for (const [name, channels] of Object.entries(COVER_MATERIAL)) {
      if (name !== "foil") expect(channels[2]).toBe(0);
    }
    expect(COVER_MATERIAL.deboss[0]).toBeLessThan(COVER_MATERIAL.mark[0]);
    expect(COVER_MATERIAL.mark[0]).toBeLessThan(COVER_MATERIAL.cloth[0]);
    expect(COVER_MATERIAL.plate[0]).toBeGreaterThan(COVER_MATERIAL.cloth[0]);
  });

  it("deepens the Route groove toward its centre", () => {
    for (let index = 1; index < COVER_GROOVE.length; index += 1) {
      expect(COVER_GROOVE[index].width).toBeLessThan(COVER_GROOVE[index - 1].width);
      expect(COVER_GROOVE[index].depth).toBeGreaterThan(COVER_GROOVE[index - 1].depth);
    }
    expect(COVER_GROOVE[COVER_GROOVE.length - 1].depth).toBe(1);
    // A fine impression: no wider than the painted deboss line, and shallow.
    expect(COVER_GROOVE[0].width).toBeLessThanOrEqual(1.1);
    expect(COVER_MATERIAL.cloth[0] - COVER_MATERIAL.deboss[0]).toBeLessThanOrEqual(32);
  });

  it("interpolates a material colour from the cloth", () => {
    expect(coverMaterialColor(COVER_MATERIAL.deboss)).toBe("rgb(96 217 0)");
    expect(coverMaterialColor(COVER_MATERIAL.deboss, 0.5)).toBe("rgb(112 224 0)");
    expect(coverMaterialColor(COVER_MATERIAL.deboss, 0)).toBe("rgb(128 230 0)");
  });
});
