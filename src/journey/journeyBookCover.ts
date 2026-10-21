/**
 * Journey Book front cover (owner decision 2026-10-21): a Journey with a
 * cover photo shows that photo across the whole front cover; a Journey
 * without one gets a starry night sky. The 2D book and the 3D book's canvas
 * painter draw both from these values, so the two stay identical. Pure; no DOM.
 */

/** Night base of the starry cover, the spine side and the back cover. */
export const COVER_NIGHT = "#0b1222";
/** Small stars, in the globe's cyan family. */
export const COVER_STAR = "#8fd3e8";
/** The few brighter stars, near white with a trace of the same cyan. */
export const COVER_STAR_BRIGHT = "#eaf6f9";
/** The Route on the starry cover, and its end marker. */
export const COVER_GOLD = "#d9b97a";
export const COVER_GOLD_END = "#f0d9a0";
/** Title, dates and back-cover title on both covers. */
export const COVER_INK = "#ece6d6";

/**
 * The faint radial lift on the starry cover: a little of the star colour at
 * the middle of the Route band, gone by `radius` (an ellipse, as a fraction
 * of the cover width and of its height). Barely visible on purpose; it keeps
 * the night from reading flat.
 */
export const COVER_LIFT = { x: 0.5, y: 0.45, radius: 0.7, color: "rgb(143 211 232 / 0.07)" } as const;

/**
 * The head scrim on a photo cover: the night base at `alpha` at the top edge,
 * fading to nothing by `height` (a fraction of the cover height). The head
 * (top 8.7%, two title lines and the dates) ends near 26%; the fade runs a
 * little past it so the dates never sit on its edge. 0.38 is the least that
 * separates the light ink from a pale sky together with the text's own soft
 * shadow (`COVER_TEXT_SHADOW`), while a light photo still reads light at the
 * top: white silk under the peak stays near 230 × 0.62 ≈ 143 before shading.
 */
export const COVER_SCRIM = { height: 0.34, alpha: 0.38, color: "11 18 34" } as const;

/** A soft dark shadow under the head's text on a photo, as a fraction of the cover width. */
export const COVER_TEXT_SHADOW = { blur: 3 / 504, color: "rgb(6 9 16 / 0.45)" } as const;

/**
 * The Route on a photo: a light core over a dark halo, so it reads on any
 * photo. Sizes are fractions of the cover width (reference: a 504 px cover);
 * each halo is the core plus 1.5 px a side. The outer start/end sizes match
 * `COVER_ROUTE_STROKE`, so the markers still fit the band's padding.
 */
export const COVER_PHOTO_ROUTE = {
  core: "#f6f1e4",
  /** Opaque, so where the halo's line, dots and squares overlap it does not darken. */
  halo: "#080b12",
  line: { core: 2 / 504, halo: 5 / 504 },
  dot: { core: 6 / 504, halo: 9 / 504 },
  start: { core: 8 / 504, halo: 11 / 504 },
  end: { core: 9 / 504, halo: 12 / 504 },
} as const;

/** The gold Route's line width on the starry cover, a fraction of the cover width. */
export const COVER_GOLD_LINE = 2.5 / 504;

/**
 * The v12 mark on the starry cover: gold, a little under full strength. A
 * photo cover has no mark: its cutouts are painted solid, in the night
 * colour, and would show as dark patches on a picture.
 */
export const COVER_MARK_OPACITY = 0.6;

export type CoverStar = {
  /** Centre, as fractions of the cover width and height. */
  x: number;
  y: number;
  /** Radius, as a fraction of the cover width. */
  radius: number;
  alpha: number;
  bright: boolean;
};

export const COVER_STAR_COUNT = 64;
export const COVER_STAR_SEED = 0x5747a9;

/** mulberry32: a small seeded generator, so the sky is the same on every render. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A sparse, deterministic star field: mostly tiny faint stars, about one in
 * eight brighter and near white. The same seed always gives the same sky.
 */
export function coverStarField(count: number = COVER_STAR_COUNT, seed: number = COVER_STAR_SEED): CoverStar[] {
  const next = seeded(seed);
  return Array.from({ length: count }, () => {
    const x = 0.02 + next() * 0.96;
    const y = 0.02 + next() * 0.96;
    const size = next();
    const bright = next() < 0.125;
    return {
      x,
      y,
      // Cubed, so most stars are pinpricks (about 0.6 px on a 504 px cover) and few reach 2 px.
      radius: (bright ? 1.4 : 0.6) / 504 + size ** 3 * (1 / 504),
      alpha: bright ? 0.85 + size * 0.15 : 0.3 + size * 0.45,
      bright,
    };
  });
}
