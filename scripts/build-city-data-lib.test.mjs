import { describe, expect, it } from "vitest";
import {
  applyChineseCandidates,
  chineseAlternateScore,
  collectChineseCandidates,
  parseCityRow,
} from "./build-city-data-lib.mjs";

describe("parseCityRow (#16)", () => {
  it("parses a valid cities15000 row", () => {
    const row = parseCityRow([
      "1799962",
      "Shenzhen",
      "Shenzhen",
      "宝安,深圳",
      "22.54554",
      "114.0683",
      "P",
      "PPLA2",
      "CN",
      "",
      "30",
      "",
      "",
      "",
      "17494398",
      "6",
      "17",
      "Asia/Shanghai",
      "2026-08-10",
    ]);
    expect(row?.geonameId).toBe("1799962");
    expect(row?.entry).toMatchObject({
      n: "Shenzhen",
      la: 22.54554,
      lo: 114.0683,
      p: 17494398,
      r: 2,
    });
  });

  it("skips invalid rows", () => {
    expect(parseCityRow(["", "", "", "", "91", "200", "", "", ""])).toBeNull();
    expect(parseCityRow(["1", "No Coords", "", "", "", "", "", "", ""])).toBeNull();
    expect(parseCityRow(["1", "No Pop", "", "", "10", "10", "", "", ""])).toBeNull();
  });
});

describe("chineseAlternateScore (#16)", () => {
  it("prefers simplified-Chinese tags over other Chinese tags and CJK fallbacks", () => {
    expect(chineseAlternateScore("zh-CN", "深圳")).toBe(0);
    expect(chineseAlternateScore("zh-Hans", "深圳")).toBe(0);
    // Bare zh is treated as simplified Chinese.
    expect(chineseAlternateScore("zh", "深圳")).toBe(0);
    expect(chineseAlternateScore("zh-TW", "深圳")).toBe(1);
    expect(chineseAlternateScore("zh-Hant", "深圳")).toBe(1);
    expect(chineseAlternateScore("en", "Shenzhen")).toBeNull();
    expect(chineseAlternateScore("en", "深圳")).toBe(2);
  });
});

describe("collectChineseCandidates + applyChineseCandidates (#16)", () => {
  it("joins tagged Chinese names by geonameId and applies them to cities", () => {
    const rows = [
      ["1", "1001", "zh-CN", "深圳"],
      ["2", "1001", "en", "Shenzhen"],
      ["3", "1002", "zh-TW", "北京"],
      ["4", "1002", "en", "Beijing"],
      ["5", "1003", "en", "A cidade sem chinês"],
      ["6", "1004", "en", "上海"], // untagged CJK fallback
      ["7", "1004", "en", "Shanghai"],
    ];
    const { preferred, fallback } = collectChineseCandidates(rows);

    // zh-CN wins over zh-TW for the same city.
    expect(preferred.get("1001")).toEqual({ name: "深圳", score: 0 });
    expect(preferred.get("1002")).toEqual({ name: "北京", score: 1 });
    expect(fallback.get("1004")).toBe("上海");

    const cities = [
      { n: "Shenzhen", p: 1 },
      { n: "Beijing", p: 1 },
      { n: "NoZh", p: 1 },
      { n: "Shanghai", p: 1 },
    ];
    const indexByGeonameId = new Map([
      ["1001", 0],
      ["1002", 1],
      ["1003", 2],
      ["1004", 3],
    ]);
    const joined = applyChineseCandidates(cities, indexByGeonameId, preferred, fallback);

    expect(joined).toBe(3);
    expect(cities[0].z).toBe("深圳");
    expect(cities[1].z).toBe("北京");
    expect(cities[2].z).toBeUndefined();
    expect(cities[3].z).toBe("上海");
  });

  it("does not overwrite a tagged candidate with a CJK fallback", () => {
    const rows = [
      ["1", "1001", "zh", "成都"],
      ["2", "1001", "en", "Chengdu"],
    ];
    const { preferred, fallback } = collectChineseCandidates(rows);
    const cities = [{ n: "Chengdu", p: 1 }];
    applyChineseCandidates(
      cities,
      new Map([["1001", 0]]),
      preferred,
      fallback,
    );
    expect(cities[0].z).toBe("成都");
  });
});
