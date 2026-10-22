import { describe, expect, it } from "vitest";
import {
  COVER_GOLD,
  COVER_GOLD_END,
  COVER_INK,
  COVER_NIGHT,
  COVER_PHOTO_ROUTE,
  COVER_SCRIM,
  COVER_STAR,
  COVER_STAR_COUNT,
  coverStarField,
} from "./journeyBookCover";

describe("cover colours", () => {
  it("uses the owner's starry palette", () => {
    expect(COVER_NIGHT).toBe("#0b1222");
    expect(COVER_STAR).toBe("#8fd3e8");
    expect(COVER_GOLD).toBe("#d9b97a");
    expect(COVER_GOLD_END).toBe("#f0d9a0");
    expect(COVER_INK).toBe("#ece6d6");
  });

  it("keeps the head scrim restrained, ending past the head and short of the Route band middle", () => {
    // Strong enough for the dates on a pale sky, short of hiding the photo.
    expect(COVER_SCRIM.alpha).toBeGreaterThanOrEqual(0.5);
    expect(COVER_SCRIM.alpha).toBeLessThanOrEqual(0.6);
    // The head ends near 26% of the cover; the Route band runs 30% to 73%.
    expect(COVER_SCRIM.height).toBeGreaterThan(0.26);
    expect(COVER_SCRIM.height).toBeLessThan(0.4);
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
