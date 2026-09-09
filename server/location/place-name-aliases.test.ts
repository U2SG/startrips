import { describe, expect, it, vi } from "vitest";
import { LocationSearchUnavailableError } from "./location-search";
import { createPlaceNameAliasResolver, namesSamePlace } from "./place-name-aliases";

// Every Chinese-to-English mapping the search layer used to carry as a
// hand-maintained constant. Nothing here is written down in product code any
// more: each one has to come out of the shared place-name payload, so this
// matrix is the regression guard for dropping that table.
const HISTORICAL_EXONYMS: Readonly<Record<string, string>> = {
  "伦敦": "London",
  "英国伦敦": "London",
  "东京": "Tokyo",
  "日本东京": "Tokyo",
  "纽约": "New York City",
  "纽约市": "New York City",
  "巴黎": "Paris",
  "新加坡": "Singapore",
  "悉尼": "Sydney",
  "墨尔本": "Melbourne",
  "洛杉矶": "Los Angeles",
  "旧金山": "San Francisco",
  "芝加哥": "Chicago",
  "罗马": "Rome",
  "柏林": "Berlin",
  "莫斯科": "Moscow",
  "迪拜": "Dubai",
  "曼谷": "Bangkok",
  "首尔": "Seoul",
  "香港": "Hong Kong",
  "台北": "Taipei",
  "大阪": "Osaka",
};

describe("place-name aliases", () => {
  const resolve = createPlaceNameAliasResolver();

  it("keeps every exonym the removed alias table used to answer", async () => {
    const resolved = await Promise.all(
      Object.keys(HISTORICAL_EXONYMS).map(async (query) => [
        query,
        await resolve(query),
      ] as const),
    );
    expect(Object.fromEntries(resolved)).toEqual(HISTORICAL_EXONYMS);
  });

  it("answers exonyms that were never written into the search layer", async () => {
    await expect(resolve("檀香山")).resolves.toBe("Honolulu");
    await expect(resolve("里约热内卢")).resolves.toBe("Rio de Janeiro");
    await expect(resolve("慕尼黑")).resolves.toBe("Munich");
    await expect(resolve("佛罗伦萨")).resolves.toBe("Florence");
  });

  it("drops a qualifier that is a country or region name", async () => {
    await expect(resolve("美国檀香山")).resolves.toBe("Honolulu");
    await expect(resolve("巴西里约热内卢")).resolves.toBe("Rio de Janeiro");
    // A full country name strips as readily as a short one: the qualifier has
    // no length cap.
    await expect(resolve("印度尼西亚雅加达")).resolves.toBe("Jakarta");
    await expect(resolve("阿根廷布宜诺斯艾利斯")).resolves.toBe("Buenos Aires");
    await expect(resolve("阿拉伯联合酋长国阿布扎比")).resolves.toBe("Abu Dhabi");
    // Region-level qualifiers count too, not only sovereign states.
    await expect(resolve("台湾台北")).resolves.toBe("Taipei");
  });

  it("leaves a query whose head is not a country or region name untouched", async () => {
    // The rewrite needs positive evidence that the head is a country or
    // region. Absence from the place index is not that evidence: without the
    // check, any unverified head in front of an indexed exonym would silently
    // become that exonym's place, which is what issue #296 forbids.
    await expect(resolve("不存在巴黎")).resolves.toBe("不存在巴黎");
    await expect(resolve("随便什么檀香山")).resolves.toBe("随便什么檀香山");
    // A head that names a city rather than a country is not a qualifier
    // either, so these stay local queries for the provider: `西安大雁塔`
    // remains a search for the pagoda rather than one for `雁塔`.
    await expect(resolve("深圳南山区")).resolves.toBe("深圳南山区");
    await expect(resolve("上海外滩")).resolves.toBe("上海外滩");
    await expect(resolve("西安大雁塔")).resolves.toBe("西安大雁塔");
    await expect(resolve("北京朝阳区")).resolves.toBe("北京朝阳区");
  });

  it("prefers the most populous claimant of a shared name", async () => {
    // London, GB rather than London, CA; Sydney, AU rather than Sydney, CA.
    await expect(resolve("伦敦")).resolves.toBe("London");
    await expect(resolve("悉尼")).resolves.toBe("Sydney");
  });

  it("tells a place name apart from a longer name that contains it", () => {
    // An administrative suffix is the same place.
    expect(namesSamePlace("深圳市", "深圳")).toBe(true);
    expect(namesSamePlace("北京市", "北京")).toBe(true);
    expect(namesSamePlace("伦敦", "伦敦")).toBe(true);
    // A different place that merely contains the query is not.
    expect(namesSamePlace("伦敦街", "伦敦")).toBe(false);
    expect(namesSamePlace("新伦敦", "伦敦")).toBe(false);
    expect(namesSamePlace("檀香山路", "檀香山")).toBe(false);
    expect(namesSamePlace("", "檀香山")).toBe(false);
  });

  it("returns an unknown or non-Chinese query untouched", async () => {
    await expect(resolve("这个地方并不存在")).resolves.toBe("这个地方并不存在");
    await expect(resolve("Honolulu")).resolves.toBe("Honolulu");
    await expect(resolve("Kyoto, Japan")).resolves.toBe("Kyoto, Japan");
  });

  it("never reads the payload for a query that cannot carry an exonym", async () => {
    const loadPayload = vi.fn(async () => JSON.stringify({ cities: [] }));
    const asciiOnly = createPlaceNameAliasResolver({ loadPayload });

    await expect(asciiOnly("Honolulu")).resolves.toBe("Honolulu");
    expect(loadPayload).not.toHaveBeenCalled();
  });

  it("reads and parses the payload exactly once", async () => {
    const loadPayload = vi.fn(async () => JSON.stringify({
      cities: [{ n: "Honolulu", z: "檀香山" }],
    }));
    const cached = createPlaceNameAliasResolver({ loadPayload });

    await expect(cached("檀香山")).resolves.toBe("Honolulu");
    await expect(cached("檀香山")).resolves.toBe("Honolulu");
    expect(loadPayload).toHaveBeenCalledOnce();
  });

  it("surfaces an unreadable or malformed payload instead of guessing", async () => {
    const unreadable = createPlaceNameAliasResolver({
      loadPayload: async () => {
        throw new Error("ENOENT");
      },
    });
    const malformed = createPlaceNameAliasResolver({
      loadPayload: async () => JSON.stringify({ cities: null }),
    });

    await expect(unreadable("檀香山")).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
    await expect(malformed("檀香山")).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
  });

  it("retries after a transient read failure instead of staying broken", async () => {
    let attempts = 0;
    const flaky = createPlaceNameAliasResolver({
      loadPayload: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("EAGAIN");
        return JSON.stringify({ cities: [{ n: "Honolulu", z: "檀香山" }] });
      },
    });

    await expect(flaky("檀香山")).rejects.toBeInstanceOf(
      LocationSearchUnavailableError,
    );
    await expect(flaky("檀香山")).resolves.toBe("Honolulu");
    expect(attempts).toBe(2);
  });
});
