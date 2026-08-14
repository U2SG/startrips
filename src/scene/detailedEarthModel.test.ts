import { describe, expect, it } from "vitest";
import {
  createDetailedEarthLabelExpression,
  DEFAULT_DETAILED_EARTH_STYLE_URL,
  getDetailedEarthStyleUrl,
  isDetailedEarthNameLabel,
} from "./detailedEarthModel";

describe("detailedEarthModel", () => {
  it("uses a provider-neutral vector style by default", () => {
    expect(getDetailedEarthStyleUrl()).toBe(DEFAULT_DETAILED_EARTH_STYLE_URL);
  });

  it("prefers simplified Chinese labels and offers an English second line", () => {
    expect(createDetailedEarthLabelExpression("zh")).toEqual(expect.arrayContaining([
      "coalesce",
      ["get", "name:zh-Hans"],
      ["get", "name:zh"],
    ]));
    expect(createDetailedEarthLabelExpression("bilingual")).toEqual(expect.arrayContaining([
      "format",
    ]));
  });

  it("only replaces map labels backed by name fields", () => {
    expect(isDetailedEarthNameLabel(["get", "name:nonlatin"])).toBe(true);
    expect(isDetailedEarthNameLabel(["to-string", ["get", "ref"]])).toBe(false);
  });
});
