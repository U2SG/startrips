import { describe, expect, it } from "vitest";
import { createMobileClassicPreference, MOBILE_CLASSIC_VIEWS, MOBILE_CLASSIC_VIEW_KEY, nextMobileClassicView, parseMobileClassicView } from "./mobileClassicView";

describe("mobile classic layout trials", () => {
  it("contains exactly four distinct layouts and cycles back to A", () => {
    expect(MOBILE_CLASSIC_VIEWS.map((view) => view.id)).toEqual(["light", "thumb", "photo", "earth"]);
    let current = "light";
    for (const expected of ["thumb", "photo", "earth", "light"]) {
      current = nextMobileClassicView(current); expect(current).toBe(expected);
    }
  });
  it("does not accept presentation styles, malformed storage, or prototype properties", () => {
    for (const value of [null, undefined, "", "book", "stream", "__proto__", {}, 3]) {
      expect(parseMobileClassicView(value)).toBe("light");
    }
  });
  it("remembers a valid choice without writing any Journey data", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    createMobileClassicPreference(storage).select("earth");
    expect([...values.keys()]).toEqual([MOBILE_CLASSIC_VIEW_KEY]);
    expect(createMobileClassicPreference(storage).read()).toBe("earth");
  });
  it("keeps switching when storage reads and writes throw", () => {
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const preference = createMobileClassicPreference(blocked);
    expect(preference.read()).toBe("light"); preference.select("photo");
    expect(preference.read()).toBe("photo");
    preference.select(nextMobileClassicView(preference.read())); expect(preference.read()).toBe("earth");
  });
  it("receives cross-tab changes without echoing another write", () => {
    const preference = createMobileClassicPreference({ getItem: () => "thumb", setItem: () => { throw new Error("must not write"); } });
    preference.receive("photo"); expect(preference.read()).toBe("photo");
    preference.receive(null); expect(preference.read()).toBe("light");
  });
});
