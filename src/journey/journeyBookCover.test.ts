import { describe, expect, it } from "vitest";
import {
  COVER_GOLD,
  COVER_GOLD_END,
  COVER_INK,
  COVER_NIGHT,
  COVER_PHOTO_ROUTE,
  COVER_STAR,
  COVER_STAR_COUNT,
  COVER_TITLE_BAND,
  coverStarField,
} from "./journeyBookCover";
import { COVER_ROUTE_BAND } from "./coverRouteGeometry";

describe("cover colours", () => {
  it("uses the owner's starry palette", () => {
    expect(COVER_NIGHT).toBe("#0b1222");
    expect(COVER_STAR).toBe("#8fd3e8");
    expect(COVER_GOLD).toBe("#d9b97a");
    expect(COVER_GOLD_END).toBe("#f0d9a0");
    expect(COVER_INK).toBe("#ece6d6");
  });

  it("sets the photo cover's title band solid behind the head, clear of the top edge and the Route band", () => {
    // Strong enough for the title on a bright photo, short of an opaque block.
    expect(COVER_TITLE_BAND.alpha).toBeGreaterThanOrEqual(0.75);
    expect(COVER_TITLE_BAND.alpha).toBeLessThanOrEqual(0.85);
    expect(COVER_TITLE_BAND.color).toBe("11 18 34");
    // A strip of photo stays above it for the 3D QA's top-edge cover probes.
    expect(COVER_TITLE_BAND.top).toBeGreaterThanOrEqual(0.04);
    // Below the title top (8.7%) and past the dates (near 27%).
    expect(COVER_TITLE_BAND.top).toBeLessThan(0.087);
    expect(COVER_TITLE_BAND.bottom).toBeGreaterThan(0.27);
    // Short of the Route band, which starts at 30%.
    expect(COVER_TITLE_BAND.bottom).toBeLessThanOrEqual(0.29);
    expect(COVER_TITLE_BAND.bottom).toBeLessThan(COVER_ROUTE_BAND.top);
  });

  it("draws the photo Route light on dark", () => {
    expect(COVER_PHOTO_ROUTE.halo).not.toBe(COVER_PHOTO_ROUTE.core);
    for (const size of ["line", "dot", "start", "end"] as const) {
      expect(COVER_PHOTO_ROUTE[size].halo).toBeGreaterThan(COVER_PHOTO_ROUTE[size].core);
    }
  });
});

describe("coverStarField", () => {
  it("is the same sky on every call", () => {
    expect(coverStarField()).toEqual(coverStarField());
    expect(coverStarField()).toHaveLength(COVER_STAR_COUNT);
  });

  it("differs with the seed", () => {
    expect(coverStarField(16, 1)).not.toEqual(coverStarField(16, 2));
  });

  it("is sparse and small, with a few bright stars", () => {
    const stars = coverStarField();
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0.02);
      expect(star.x).toBeLessThanOrEqual(0.98);
      expect(star.y).toBeGreaterThanOrEqual(0.02);
      expect(star.y).toBeLessThanOrEqual(0.98);
      // At most about 2.4 px across on a 504 px cover.
      expect(star.radius).toBeLessThanOrEqual(2.4 / 504);
      expect(star.alpha).toBeGreaterThan(0);
      expect(star.alpha).toBeLessThanOrEqual(1);
    }
    const bright = stars.filter((star) => star.bright).length;
    expect(bright).toBeGreaterThan(0);
    expect(bright).toBeLessThan(stars.length / 4);
  });
});
