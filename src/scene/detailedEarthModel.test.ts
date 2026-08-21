import { describe, expect, it } from "vitest";
import {
  AMAP_RASTER_STYLE,
  createDetailedEarthLabelExpression,
  DEFAULT_DETAILED_EARTH_STYLE_URL,
  DETAILED_EARTH_DRAG_PAN_OPTIONS,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MAX_PITCH,
  DETAILED_EARTH_MAX_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  DETAILED_EARTH_RETURN_ZOOM,
  DETAILED_EARTH_TOUCH_ZOOM_RATE,
  DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD,
  getDetailedEarthStyle,
  isDetailedEarthNameLabel,
  isRasterDetailedEarth,
  shouldReturnToParticleEarth,
  useGlobeProjection,
} from "./detailedEarthModel";

describe("detailedEarthModel", () => {
  it("uses a provider-neutral vector style by default", () => {
    expect(getDetailedEarthStyle()).toBe(DEFAULT_DETAILED_EARTH_STYLE_URL);
    expect(isRasterDetailedEarth()).toBe(false);
    expect(useGlobeProjection()).toBe(true);
  });

  it("keeps globe projection only for the direct default provider", () => {
    const original = import.meta.env.VITE_ATLAS_MAP_STYLE_URL;
    try {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = AMAP_RASTER_STYLE;
      expect(useGlobeProjection()).toBe(false);
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL =
        "https://startrips.example/api/mapstyle?path=styles%2Ffiord";
      expect(useGlobeProjection()).toBe(false);
    } finally {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = original;
    }
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
    const chineseExpression = createDetailedEarthLabelExpression("zh") as unknown[];
    expect(chineseExpression).toEqual(expect.arrayContaining([
      "coalesce",
      ["get", "name:zh-Hans"],
      ["get", "name:zh"],
    ]));
    expect(chineseExpression[3]).toEqual(["get", "name:nonlatin"]);
    expect(createDetailedEarthLabelExpression("bilingual")).toEqual(expect.arrayContaining([
      "format",
    ]));
  });

  it("only replaces map labels backed by name fields", () => {
    expect(isDetailedEarthNameLabel(["get", "name:nonlatin"])).toBe(true);
    expect(isDetailedEarthNameLabel(["to-string", ["get", "ref"]])).toBe(false);
  });

  it("returns from the regional map before it expands into a world map", () => {
    expect(DETAILED_EARTH_MIN_ZOOM).toBeLessThan(DETAILED_EARTH_RETURN_ZOOM);
    expect(DETAILED_EARTH_INITIAL_ZOOM).toBeGreaterThan(DETAILED_EARTH_RETURN_ZOOM);
    expect(shouldReturnToParticleEarth(DETAILED_EARTH_RETURN_ZOOM + 0.01)).toBe(false);
    expect(shouldReturnToParticleEarth(DETAILED_EARTH_RETURN_ZOOM)).toBe(true);
  });

  it("keeps detailed-map interaction available but deliberately soft", () => {
    expect(DETAILED_EARTH_MAX_ZOOM).toBeGreaterThan(DETAILED_EARTH_INITIAL_ZOOM);
    expect(DETAILED_EARTH_MAX_PITCH).toBeGreaterThan(0);
    expect(DETAILED_EARTH_TOUCH_ZOOM_RATE).toBeLessThan(1);
    expect(DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD).toBeGreaterThan(0.1);
    expect(DETAILED_EARTH_DRAG_PAN_OPTIONS.linearity).toBeLessThan(0.3);
    expect(DETAILED_EARTH_DRAG_PAN_OPTIONS.maxSpeed).toBeLessThan(1_400);
  });
});
