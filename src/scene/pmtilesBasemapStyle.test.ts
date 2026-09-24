import { afterEach, describe, expect, it } from "vitest";
import {
  createDetailedEarthLabelExpression,
  DEFAULT_DETAILED_EARTH_STYLE_URL,
  getDetailedEarthLabelSchema,
  getDetailedEarthStyle,
  isPmtilesDetailedEarth,
  type DetailedEarthLabelSchema,
} from "./detailedEarthModel";
import {
  buildPmtilesBasemapStyle,
  DEFAULT_PMTILES_GLYPHS_PATH,
  PMTILES_SOURCE_ID,
  resolvePmtilesGlyphsUrl,
  resolvePmtilesSourceUrl,
} from "./pmtilesBasemapStyle";

// Evaluates the only operators the Chinese label expression uses, so the test
// states which property wins for a real feature of each tile schema.
function evaluateNameExpression(expression: unknown, properties: Record<string, string>): string {
  if (typeof expression === "string") return expression;
  const [operator, ...args] = expression as [string, ...unknown[]];
  if (operator === "get") return properties[args[0] as string] ?? "";
  if (operator === "coalesce") {
    for (const arg of args) {
      if (typeof arg === "string") return arg;
      const value = (arg as [string, string])[0] === "get" ? properties[(arg as [string, string])[1]] : undefined;
      if (value !== undefined) return value;
    }
    return "";
  }
  throw new Error(`unsupported operator ${operator}`);
}

function chineseLabel(schema: DetailedEarthLabelSchema, properties: Record<string, string>) {
  return evaluateNameExpression(createDetailedEarthLabelExpression("zh", schema), properties);
}

const env = import.meta.env as Record<string, string | undefined>;
const ENV_KEYS = ["VITE_ATLAS_MAP_STYLE_URL", "VITE_ATLAS_PMTILES_URL", "VITE_ATLAS_PMTILES_GLYPHS_URL"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) env[key] = originalEnv[key];
});

describe("detailed earth label expression per tile schema", () => {
  it("keeps the OpenMapTiles coalesce for the OpenFreeMap default", () => {
    expect(createDetailedEarthLabelExpression("zh")).toEqual(
      createDetailedEarthLabelExpression("zh", "openmaptiles"),
    );
    expect(chineseLabel("openmaptiles", { "name:zh": "北京", name: "北京市", "name:en": "Beijing" }))
      .toBe("北京");
    expect(chineseLabel("openmaptiles", { "name:nonlatin": "東京", "name:latin": "Tokyo" }))
      .toBe("東京");
  });

  it("reads Protomaps zh-Hans, then zh-Hant, then the local name", () => {
    expect(chineseLabel("protomaps", {
      "name:zh-Hans": "东京",
      "name:zh-Hant": "東京",
      name: "東京",
      "name:en": "Tokyo",
    })).toBe("东京");
    expect(chineseLabel("protomaps", { "name:zh-Hant": "臺北", name: "臺北市" })).toBe("臺北");
    expect(chineseLabel("protomaps", { name: "Reykjavík", "name:en": "Reykjavik" })).toBe("Reykjavík");
    expect(chineseLabel("protomaps", { "name:en": "Unnamed Bay" })).toBe("Unnamed Bay");
    expect(chineseLabel("protomaps", {})).toBe("");
  });

  it("never reads OpenMapTiles-only or pre-shaped glyph fields for Protomaps", () => {
    const serialized = JSON.stringify(createDetailedEarthLabelExpression("bilingual", "protomaps"));
    expect(serialized).not.toContain("name:nonlatin");
    expect(serialized).not.toContain("name_en");
    expect(serialized).not.toContain("pgf:");
    expect(serialized).toContain("\"name:en\"");
  });
});

describe("optional self-hosted PMTiles basemap", () => {
  it("stays on the proxied OpenFreeMap style when no PMTiles URL is set", () => {
    env.VITE_ATLAS_MAP_STYLE_URL = "";
    env.VITE_ATLAS_PMTILES_URL = "";
    expect(isPmtilesDetailedEarth()).toBe(false);
    expect(getDetailedEarthLabelSchema()).toBe("openmaptiles");
    expect(getDetailedEarthStyle()).toBe(DEFAULT_DETAILED_EARTH_STYLE_URL);
  });

  it("lets an explicit style URL keep precedence over a PMTiles URL", () => {
    env.VITE_ATLAS_MAP_STYLE_URL = "https://startrips.example/styles/contracted.json";
    env.VITE_ATLAS_PMTILES_URL = "/basemap/region.pmtiles";
    expect(isPmtilesDetailedEarth()).toBe(false);
    expect(getDetailedEarthStyle()).toBe("https://startrips.example/styles/contracted.json");
  });

  it("builds a Protomaps style with Chinese labels when only PMTiles is configured", () => {
    env.VITE_ATLAS_MAP_STYLE_URL = "";
    env.VITE_ATLAS_PMTILES_URL = "https://media.startrips.example/basemap/region.pmtiles";
    expect(isPmtilesDetailedEarth()).toBe(true);
    expect(getDetailedEarthLabelSchema()).toBe("protomaps");
    const style = getDetailedEarthStyle();
    expect(typeof style).toBe("object");
    const spec = style as Exclude<typeof style, string>;
    expect(spec.sources[PMTILES_SOURCE_ID]).toMatchObject({
      type: "vector",
      url: "pmtiles://https://media.startrips.example/basemap/region.pmtiles",
    });
    const places = spec.layers.find((layer) => layer.id === "places");
    expect(places?.type).toBe("symbol");
    expect(JSON.stringify(places)).toContain("name:zh-Hans");
  });

  it("resolves same-origin archive and glyph paths to absolute URLs", () => {
    const base = "https://startrips.example/atlas?view=planet";
    expect(resolvePmtilesSourceUrl("/basemap/region.pmtiles", base))
      .toBe("pmtiles://https://startrips.example/basemap/region.pmtiles");
    expect(resolvePmtilesSourceUrl("pmtiles://https://a.example/x.pmtiles", base))
      .toBe("pmtiles://https://a.example/x.pmtiles");
    expect(resolvePmtilesGlyphsUrl("", base))
      .toBe(`https://startrips.example${DEFAULT_PMTILES_GLYPHS_PATH}`);
    expect(resolvePmtilesGlyphsUrl("fonts/{fontstack}/{range}.pbf", base))
      .toBe("https://startrips.example/fonts/{fontstack}/{range}.pbf");
    expect(resolvePmtilesGlyphsUrl("https://media.startrips.example/fonts/{fontstack}/{range}.pbf", base))
      .toBe("https://media.startrips.example/fonts/{fontstack}/{range}.pbf");
  });

  it("uses no sprite and only deployment-owned URLs", () => {
    const style = buildPmtilesBasemapStyle({
      pmtilesUrl: "/basemap/region.pmtiles",
      glyphsUrl: "",
      baseUrl: "https://startrips.example/",
      labelTextField: createDetailedEarthLabelExpression("zh", "protomaps"),
    });
    expect(style.sprite).toBeUndefined();
    expect(style.glyphs?.startsWith("https://startrips.example/")).toBe(true);
    expect(JSON.stringify(style)).not.toMatch(/openfreemap|protomaps\.github|api\.protomaps/);
  });
});
