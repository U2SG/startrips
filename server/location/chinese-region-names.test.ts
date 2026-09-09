import { describe, expect, it } from "vitest";
import {
  chineseRegionNames,
  isChineseRegionName,
} from "./chinese-region-names";

describe("Chinese region names", () => {
  it("carries the platform's region vocabulary", () => {
    const names = chineseRegionNames();

    // A runtime without Chinese region data would leave this empty and every
    // country-qualified query unstripped, so assert it here rather than let a
    // resolver expectation fail with an unexplained place name.
    expect(names.size).toBeGreaterThan(200);
    for (const name of ["美国", "英国", "日本", "印度尼西亚", "阿拉伯联合酋长国"]) {
      expect(isChineseRegionName(name)).toBe(true);
    }
  });

  it("claims no name that is not a country or region", () => {
    // Cities, districts and arbitrary strings must not read as qualifiers.
    for (const name of ["深圳", "檀香山", "巴黎", "南山区", "不存在"]) {
      expect(isChineseRegionName(name)).toBe(false);
    }
    expect(isChineseRegionName("US")).toBe(false);
    expect(isChineseRegionName("")).toBe(false);
  });

  it("builds the vocabulary once per process", () => {
    expect(chineseRegionNames()).toBe(chineseRegionNames());
  });
});
