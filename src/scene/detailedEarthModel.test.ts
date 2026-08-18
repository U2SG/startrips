import { describe, expect, it } from "vitest";
import {
  AMAP_RASTER_STYLE,
  createDetailedEarthLabelExpression,
  DEFAULT_DETAILED_EARTH_STYLE_URL,
  getDetailedEarthStyle,
  isDetailedEarthNameLabel,
  isRasterDetailedEarth,
} from "./detailedEarthModel";

describe("detailedEarthModel", () => {
  it("uses a provider-neutral vector style by default", () => {
    expect(getDetailedEarthStyle()).toBe(DEFAULT_DETAILED_EARTH_STYLE_URL);
    expect(isRasterDetailedEarth()).toBe(false);
  });

  it("switches to the built-in AMap raster style through the sentinel", () => {
    const original = import.meta.env.VITE_ATLAS_MAP_STYLE_URL;
    try {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = AMAP_RASTER_STYLE;
      expect(isRasterDetailedEarth()).toBe(true);
      const style = getDetailedEarthStyle();
      expect(typeof style).toBe("object");
      const spec = style as { sources: Record<string, { type: string; maxzoom?: number }> };
      expect(spec.sources.amap.type).toBe("raster");
      expect(spec.sources.amap.maxzoom).toBe(18);
    } finally {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = original;
    }
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
