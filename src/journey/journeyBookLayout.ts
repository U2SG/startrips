/**
 * #393 Journey Book: how the book fits the space it is given.
 *
 * PageFlip decides portrait or landscape from width alone, so on a short
 * landscape phone it opens two pages that are taller than the screen. The
 * Book decides instead, from both dimensions: it opens a spread when two
 * pages side by side are nearly as large as one page alone, and always sizes
 * the page so the whole book fits.
 */
export type JourneyBookOrientation = "portrait" | "landscape";

export type JourneyBookLayout = {
  orientation: JourneyBookOrientation;
  pageWidth: number;
  pageHeight: number;
};

/** Page width / height of the reference book (512 × 640). */
export const BOOK_PAGE_RATIO = 0.8;
/** A spread must keep at least this share of the single page's height. */
const SPREAD_MIN_SCALE = 0.85;

export function journeyBookLayout(
  width: number,
  height: number,
  ratio: number = BOOK_PAGE_RATIO,
): JourneyBookLayout | null {
  if (!(width > 0) || !(height > 0)) return null;
  const portraitHeight = Math.min(height, width / ratio);
  const landscapeHeight = Math.min(height, width / (2 * ratio));
  const orientation: JourneyBookOrientation = landscapeHeight >= portraitHeight * SPREAD_MIN_SCALE
    ? "landscape"
    : "portrait";
  const pageHeight = Math.floor(orientation === "landscape" ? landscapeHeight : portraitHeight);
  return { orientation, pageWidth: Math.floor(pageHeight * ratio), pageHeight };
}

/** Width of the element PageFlip lays the book out in. */
export function journeyBookBlockWidth(layout: JourneyBookLayout): number {
  return layout.orientation === "landscape" ? layout.pageWidth * 2 : layout.pageWidth;
}

/**
 * PageFlip turns portrait when its block is narrower than twice `minWidth`.
 * With the block exactly one or two pages wide, any value in
 * (pageWidth / 2, pageWidth] reproduces the Book's own decision; the middle
 * of that band leaves room for small resizes without rebuilding the book.
 */
export function journeyBookFlipMinWidth(layout: JourneyBookLayout): number {
  return Math.round(layout.pageWidth * 0.75);
}

/**
 * Whether PageFlip, created for `built`, still makes the same decision for
 * `next`. When it does, the Book only resizes; otherwise it rebuilds.
 */
export function journeyBookLayoutCompatible(built: JourneyBookLayout, next: JourneyBookLayout): boolean {
  if (built.orientation !== next.orientation) return false;
  const minWidth = journeyBookFlipMinWidth(built);
  const blockWidth = journeyBookBlockWidth(next);
  return next.orientation === "landscape" ? blockWidth >= minWidth * 2 : blockWidth < minWidth * 2;
}
