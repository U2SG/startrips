import { describe, expect, it, vi } from "vitest";
import { LocationSearchUnavailableError } from "./location-search";
import { createPlaceNameAliasResolver } from "./place-name-aliases";

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

  it("drops a leading country qualifier but not a leading place name", async () => {
    await expect(resolve("美国檀香山")).resolves.toBe("Honolulu");
    await expect(resolve("巴西里约热内卢")).resolves.toBe("Rio de Janeiro");
    // A full country name strips as readily as a short one: the qualifier has
    // no length cap.
    await expect(resolve("印度尼西亚雅加达")).resolves.toBe("Jakarta");
    await expect(resolve("阿根廷布宜诺斯艾利斯")).resolves.toBe("Buenos Aires");
    // `深圳`, `上海` and `西安` are themselves place names, so these stay
    // local queries for the provider instead of being rewritten to another
    // place. `西安大雁塔` is the case that requires the scan to stop at a
    // leading place name rather than skip past it: `雁塔` is a district.
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
