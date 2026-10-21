import { describe, expect, it } from "vitest";
import { coverRouteGeometry, COVER_ROUTE_STROKE } from "./coverRouteGeometry";
import { COVER_GOLD, COVER_GOLD_END, COVER_PHOTO_ROUTE } from "./journeyBookCover";
import type { JourneyBookPage } from "./journeyBookPages";
import {
  COVER_GROOVE,
  COVER_MATERIAL,
  coverMaterialColor,
  coverRouteLayers,
  paintCoverMaterial,
  wrapLines,
  wrapUnits,
} from "./journeyBook3dPainter";
import type { JourneyMediaAsset } from "./types";

// Every character one unit wide.
const measure = (value: string) => Array.from(value).length;

describe("wrapUnits", () => {
  it("keeps Latin words whole and splits CJK by character", () => {
    expect(wrapUnits("在Death Valley看日出")).toEqual(["在", "Death", " ", "Valley", "看", "日", "出"]);
  });
});

describe("wrapLines", () => {
  it("wraps CJK text by character", () => {
    expect(wrapLines("一二三四五六七", 3, measure)).toEqual(["一二三", "四五六", "七"]);
  });

  it("never starts a line with closing punctuation", () => {
    expect(wrapLines("一二三，四五", 3, measure)).toEqual(["一二三，", "四五"]);
  });

  it("moves a whole Latin word and drops the space at the break", () => {
    expect(wrapLines("see the sea", 7, measure)).toEqual(["see the", "sea"]);
  });

  it("keeps paragraph breaks", () => {
    expect(wrapLines("一二\n三", 5, measure)).toEqual(["一二", "三"]);
  });
});

describe("cover material map", () => {
  it("packs height, roughness and metalness into R, G and B", () => {
    expect(COVER_MATERIAL.surface).toEqual([128, 230, 0]);
    // Foil is the only metal; the Route, mark and start square are pressed in.
    expect(COVER_MATERIAL.foil[1]).toBe(128);
    expect(COVER_MATERIAL.foil[2]).toBe(217);
    for (const [name, channels] of Object.entries(COVER_MATERIAL)) {
      if (name !== "foil") expect(channels[2]).toBe(0);
    }
    expect(COVER_MATERIAL.deboss[0]).toBeLessThan(COVER_MATERIAL.mark[0]);
    expect(COVER_MATERIAL.mark[0]).toBeLessThan(COVER_MATERIAL.surface[0]);
  });

  it("deepens the Route groove toward its centre", () => {
    for (let index = 1; index < COVER_GROOVE.length; index += 1) {
      expect(COVER_GROOVE[index].width).toBeLessThan(COVER_GROOVE[index - 1].width);
      expect(COVER_GROOVE[index].depth).toBeGreaterThan(COVER_GROOVE[index - 1].depth);
    }
    expect(COVER_GROOVE[COVER_GROOVE.length - 1].depth).toBe(1);
    // A fine impression: no wider than the groove stroke, and shallow.
    expect(COVER_GROOVE[0].width).toBeLessThanOrEqual(1.1);
    expect(COVER_MATERIAL.surface[0] - COVER_MATERIAL.deboss[0]).toBeLessThanOrEqual(32);
  });

  it("interpolates a material colour from the surface", () => {
    expect(coverMaterialColor(COVER_MATERIAL.deboss)).toBe("rgb(96 217 0)");
    expect(coverMaterialColor(COVER_MATERIAL.deboss, 0.5)).toBe("rgb(112 224 0)");
    expect(coverMaterialColor(COVER_MATERIAL.deboss, 0)).toBe("rgb(128 230 0)");
  });
});

/** A 2D context that records every colour it fills or strokes with. */
function recordingCanvas() {
  const colours = new Set<string>();
  let fills = 0;
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    bezierCurveTo() {},
    arc() {},
    drawImage() {},
    fillRect() {
      fills += 1;
      colours.add(context.fillStyle);
    },
    fill() {
      colours.add(context.fillStyle);
    },
    stroke() {
      colours.add(context.strokeStyle);
    },
  };
  const canvas = { width: 504, height: 630, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, colours, fills: () => fills };
}

const route = coverRouteGeometry([
  { latitude: 1.29, longitude: 103.85 },
  { latitude: 1.3, longitude: 103.91 },
  { latitude: 1.36, longitude: 103.99 },
]);
const photo = { id: "cover", mimeType: "image/jpeg" } as JourneyMediaAsset;

describe("paintCoverMaterial", () => {
  it("leaves a photo cover flat: the plain surface, no groove, mark or foil", () => {
    const { canvas, colours, fills } = recordingCanvas();
    const page: JourneyBookPage = { kind: "cover", key: "cover", asset: photo };
    paintCoverMaterial(canvas, { page, route });
    expect([...colours]).toEqual([coverMaterialColor(COVER_MATERIAL.surface)]);
    expect(fills()).toBe(1);
  });

  it("gives the starry cover's Route a groove and its end foil", () => {
    const { canvas, colours } = recordingCanvas();
    const page: JourneyBookPage = { kind: "cover", key: "cover", asset: null };
    paintCoverMaterial(canvas, { page, route });
    expect(colours.has(coverMaterialColor(COVER_MATERIAL.deboss))).toBe(true);
    expect(colours.has(coverMaterialColor(COVER_MATERIAL.foil))).toBe(true);
  });
});

describe("coverRouteLayers", () => {
  it("draws the starry Route in gold with a paler end", () => {
    const [gold, ...rest] = coverRouteLayers("starry");
    expect(rest).toEqual([]);
    expect(gold.color).toBe(COVER_GOLD);
    expect(gold.endColor).toBe(COVER_GOLD_END);
    expect(gold.end).toBe(COVER_ROUTE_STROKE.end);
  });

  it("draws a photo Route as a light core over a wider dark halo", () => {
    const [halo, core] = coverRouteLayers("photo");
    expect(halo.color).toBe(COVER_PHOTO_ROUTE.halo);
    expect(core.color).toBe(COVER_PHOTO_ROUTE.core);
    for (const size of ["line", "dot", "start", "end"] as const) {
      expect(halo[size]).toBeGreaterThan(core[size]);
    }
    // The outer markers keep the sizes the band's padding is fitted to.
    expect(halo.start).toBe(COVER_ROUTE_STROKE.start);
    expect(halo.end).toBe(COVER_ROUTE_STROKE.end);
  });
});
