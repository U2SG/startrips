import { describe, expect, it } from "vitest";
import { wrapLines, wrapUnits } from "./journeyBook3dPainter";

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
