import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAuthoritativeChineseFallback,
  applyChineseCandidates,
  assertChineseRegionCoverage,
  chineseAlternateScore,
  chineseRegionCoverage,
  collectChineseCandidates,
  parseCityRow,
  normalizeZhCnLabel,
  isZhCnNormalizedLabel,
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
      c: "CN",
    });
  });

  it("uses a Han primary name only for the Chinese region", () => {
    const cn = Array(19).fill("");
    Object.assign(cn, { 0: "1", 1: "深圳", 4: "22.5", 5: "114", 7: "PPLA2", 8: "CN", 14: "100" });
    const jp = Array(19).fill("");
    Object.assign(jp, { 0: "2", 1: "東京", 4: "35.6", 5: "139.6", 7: "PPLC", 8: "JP", 14: "100" });
    expect(parseCityRow(cn)?.entry).toMatchObject({ c: "CN", z: "深圳" });
    expect(parseCityRow(jp)?.entry.z).toBeUndefined();
  });

  it("skips invalid rows", () => {
    expect(parseCityRow(["", "", "", "", "91", "200", "", "", ""])).toBeNull();
    expect(parseCityRow(["1", "No Coords", "", "", "", "", "", "", ""])).toBeNull();
    expect(parseCityRow(["1", "No Pop", "", "", "10", "10", "", "", ""])).toBeNull();
  });
});

describe("normalizeZhCnLabel (#16 zh-CN script truth)", () => {
  it("normalizes known Traditional-only variants using checked-in Unicode Unihan data", () => {
    expect(normalizeZhCnLabel("將軍澳新市鎮")).toBe("将军澳新市镇");
    expect(normalizeZhCnLabel("楊屋村 鶴園 粉嶺")).toBe("杨屋村 鹤园 粉岭");
    expect(isZhCnNormalizedLabel("将军澳新市镇")).toBe(true);
    expect(isZhCnNormalizedLabel("將軍澳新市鎮")).toBe(false);
  });
});

describe("chineseAlternateScore (#16)", () => {
  it("uses Chinese tags and country-scoped Han fallbacks without misclassifying Japanese/Korean", () => {
    expect(chineseAlternateScore("zh-CN", "深圳", "CN")).toBe(0);
    expect(chineseAlternateScore("zh-Hans", "深圳", "CN")).toBe(0);
    expect(chineseAlternateScore("zh", "深圳", "CN")).toBe(1);
    expect(chineseAlternateScore("zh-TW", "深圳", "CN")).toBe(1);
    expect(chineseAlternateScore("yue", "香港", "HK")).toBe(1);
    expect(chineseAlternateScore("en", "Shenzhen", "CN")).toBeNull();
    expect(chineseAlternateScore("", "深圳", "CN")).toBe(2);
    expect(chineseAlternateScore("", "東京", "JP")).toBeNull();
    expect(chineseAlternateScore("ja", "東京", "JP")).toBeNull();
    expect(chineseAlternateScore("ko", "漢城", "KR")).toBeNull();
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
      ["6", "1004", "", "上海"], // untagged CJK fallback
      ["7", "1004", "en", "Shanghai"],
      ["8", "1005", "ja", "東京"], // tagged Kanji must not become zh-CN
    ];
    const { preferred, fallback } = collectChineseCandidates(rows, new Map([
      ["1001", "CN"], ["1002", "CN"], ["1003", "PT"], ["1004", "CN"], ["1005", "JP"],
    ]));

    // zh-CN wins over zh-TW for the same city.
    expect(preferred.get("1001")).toEqual({ name: "深圳", score: 0 });
    expect(preferred.get("1002")).toEqual({ name: "北京", score: 1 });
    expect(fallback.get("1004")).toBe("上海");

    const cities = [
      { n: "Shenzhen", p: 1 },
      { n: "Beijing", p: 1 },
      { n: "NoZh", p: 1 },
      { n: "Shanghai", p: 1 },
      { n: "Tokyo", p: 1 },
    ];
    const indexByGeonameId = new Map([
      ["1001", 0],
      ["1002", 1],
      ["1003", 2],
      ["1004", 3],
      ["1005", 4],
    ]);
    const joined = applyChineseCandidates(cities, indexByGeonameId, preferred, fallback);

    expect(joined).toBe(3);
    expect(cities[0].z).toBe("深圳");
    expect(cities[1].z).toBe("北京");
    expect(cities[2].z).toBeUndefined();
    expect(cities[3].z).toBe("上海");
    expect(cities[4].z).toBeUndefined();
  });

  it("does not overwrite a tagged candidate with a CJK fallback", () => {
    const rows = [
      ["1", "1001", "zh", "成都"],
      ["2", "1001", "en", "Chengdu"],
    ];
    const { preferred, fallback } = collectChineseCandidates(rows, new Map([["1001", "CN"]]));
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


describe("authoritative Chinese-region fallback and production coverage (#16 reopened)", () => {
  it("applies only a matching Chinese-region Han label and never overwrites GeoNames localization", () => {
    const cities = [
      { n: "Bao'an", c: "CN", la: 22.55, lo: 113.88, p: 1, r: 3 },
      { n: "Existing", c: "CN", z: "已有", la: 1, lo: 1, p: 1, r: 3 },
      { n: "Tokyo", c: undefined, la: 35, lo: 139, p: 1, r: 3 },
    ];
    const joined = applyAuthoritativeChineseFallback(cities, new Map([["1", 0], ["2", 1], ["3", 2]]), [
      { geonameId: "1", country: "CN", label: "宝安区" },
      { geonameId: "2", country: "CN", label: "替换" },
      { geonameId: "3", country: "JP", label: "東京" },
    ]);
    expect(joined).toBe(1);
    expect(cities[0].z).toBe("宝安区");
    expect(cities[1].z).toBe("已有");
    expect(cities[2].z).toBeUndefined();
  });

  it("guards actual generated city data by rank, dense-region coverage and key PRD labels", () => {
    const url = new URL("../public/earth/cities.json", import.meta.url);
    const payload = JSON.parse(readFileSync(url, "utf8"));
    const cities = payload.cities;
    const coverage = assertChineseRegionCoverage(cities, [
      "Shenzhen", "Guangzhou", "Hong Kong", "Bao'an", "Luohu District", "Tseung Kwan O", "Fanling",
    ]);
    expect(coverage.ranks[0].localized).toBe(coverage.ranks[0].total);
    expect(coverage.ranks[1].localized).toBe(coverage.ranks[1].total);
    expect(coverage.ranks[2].localized).toBe(coverage.ranks[2].total);
    expect(coverage.prdRank3.ratio).toBeGreaterThanOrEqual(0.65);
    expect(statSync(url).size).toBeLessThanOrEqual(2_500_000);
    const expected = new Map([
      ["Shenzhen", "深圳"],
      ["Guangzhou", "广州"],
      ["Hong Kong", "香港"],
      ["Bao'an", "宝安区"],
      ["Luohu District", "罗湖区"],
      ["Tseung Kwan O", "将军澳新市镇"],
      ["Fanling", "粉岭"],
      ["Chéngguān Qū", "城关区"],
      ["Nyingchi", "林芝市"],
    ]);
    for (const [name, label] of expected) {
      expect(cities.find((city) => city.n === name)?.z).toBe(label);
    }
    expect(cities.filter((city) => city.z).every((city) => isZhCnNormalizedLabel(city.z))).toBe(true);
  });

  it("fails when a major Chinese-region rank or the PRD local coverage budget regresses", () => {
    const healthy = [
      { n: "Capital", c: "CN", z: "首都", la: 30, lo: 110, r: 0 },
      { n: "Province", c: "CN", z: "省会", la: 30, lo: 110, r: 1 },
      { n: "Prefecture", c: "CN", z: "地级", la: 30, lo: 110, r: 2 },
      ...Array.from({ length: 20 }, (_, index) => ({
        n: `Local ${index}`, c: "CN", z: index < 13 ? `本地${index}` : undefined, la: 22.5, lo: 114, r: 3,
      })),
    ];
    expect(chineseRegionCoverage(healthy).prdRank3.ratio).toBe(0.65);
    expect(() => assertChineseRegionCoverage(healthy)).not.toThrow();
    expect(() => assertChineseRegionCoverage(healthy.map((city) => city.n === "Prefecture" ? { ...city, z: undefined } : city)))
      .toThrow(/rank 2/);
    expect(() => assertChineseRegionCoverage(healthy.map((city) => city.n === "Local 12" ? { ...city, z: undefined } : city)))
      .toThrow(/PRD rank-3/);
    expect(() => assertChineseRegionCoverage([
      { n: "Traditional witness", c: "HK", z: "將軍澳新市鎮", la: 22.3, lo: 114.2, r: 3 },
    ])).toThrow(/not simplified/);
  });
});
