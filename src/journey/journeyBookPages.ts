import { isVisualMediaAsset } from "./journeyModel";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

/**
 * #393 Journey Book: the page sequence of one Journey read as a book.
 *
 * Unlike `playbackStoryMedia`, which yields media only, the book also gives a
 * page to a Route Point that has a note but no media: a note-only point is a
 * chapter of the Journey, not an empty state. Points with neither note nor
 * media (route corrections, pass-through positions) carry no story and get no
 * page. Order follows the canonical Route order; media keeps its owner order.
 */
export type JourneyBookPage =
  | { kind: "cover"; key: string; asset: JourneyMediaAsset | null; note: string | null }
  | { kind: "media"; key: string; asset: JourneyMediaAsset; routePoint: RoutePoint | null; note: string | null }
  | { kind: "note"; key: string; routePoint: RoutePoint | null; note: string }
  | { kind: "blank"; key: string }
  | { kind: "end"; key: string };

/**
 * A note longer than this gets its own text page before the point's media
 * instead of being laid over a picture, so the picture stays readable and the
 * full note stays reachable. A note whose point opens with a video gets its
 * own page too: the live video is laid over the page and would cover it.
 */
export const BOOK_OVERLAY_NOTE_LIMIT = 90;

function trimmedNote(note: string | null | undefined): string | null {
  const value = note?.trim();
  return value ? value : null;
}

function ownerMedia(journey: Journey, routePointId: string | null): JourneyMediaAsset[] {
  return journey.media
    .filter((asset) => asset.routePointId === routePointId && isVisualMediaAsset(asset))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function coverAsset(journey: Journey): JourneyMediaAsset | null {
  const explicit = journey.coverMediaAssetId
    ? journey.media.find((asset) => asset.id === journey.coverMediaAssetId && isVisualMediaAsset(asset))
    : null;
  if (explicit) return explicit;
  return [...journey.media].filter(isVisualMediaAsset).sort((left, right) => left.sortOrder - right.sortOrder)[0] ?? null;
}

function ownerPages(
  media: readonly JourneyMediaAsset[],
  routePoint: RoutePoint | null,
  note: string | null,
): JourneyBookPage[] {
  const pages: JourneyBookPage[] = [];
  const ownerKey = routePoint?.id ?? "journey";
  const noteGetsPage = note !== null && (
    media.length === 0
    || note.length > BOOK_OVERLAY_NOTE_LIMIT
    || media[0].mimeType.startsWith("video/")
  );
  if (noteGetsPage) pages.push({ kind: "note", key: `note:${ownerKey}`, routePoint, note });
  media.forEach((asset, index) => {
    pages.push({
      kind: "media",
      key: `media:${asset.id}`,
      asset,
      routePoint,
      // The note is said once per point, over its first picture; the rest of
      // the point's pictures do not repeat it.
      note: !noteGetsPage && index === 0 ? note : null,
    });
  });
  return pages;
}

export function journeyBookPages(journey: Journey): JourneyBookPage[] {
  const journeyNote = trimmedNote(journey.note);
  const pages: JourneyBookPage[] = [{ kind: "cover", key: "cover", asset: coverAsset(journey), note: journeyNote }];
  // The cover presents the Journey note; Journey-level media follows without
  // repeating it. The cover asset is a presentation copy (#555): it still
  // appears at its own position with its own point's note.
  pages.push(...ownerPages(ownerMedia(journey, null), null, null));
  for (const point of journey.routePoints) {
    pages.push(...ownerPages(ownerMedia(journey, point.id), point, trimmedNote(point.note)));
  }
  // With a hard front and back cover, an open book shows pages in pairs; an
  // odd interior would leave the back cover sharing a spread.
  if (pages.length % 2 === 0) pages.push({ kind: "blank", key: "blank" });
  pages.push({ kind: "end", key: "end" });
  return pages;
}

/**
 * The page a reader opening at a Route Point or asset should land on. An
 * asset wins over its point; an unknown target opens at the cover.
 */
export function journeyBookStartPage(
  pages: readonly JourneyBookPage[],
  target: { routePointId?: string | null; assetId?: string | null },
): number {
  if (target.assetId) {
    const index = pages.findIndex((page) => page.kind === "media" && page.asset.id === target.assetId);
    if (index >= 0) return index;
  }
  if (target.routePointId) {
    const index = pages.findIndex((page) => (page.kind === "media" || page.kind === "note")
      && page.routePoint?.id === target.routePointId);
    if (index >= 0) return index;
  }
  return 0;
}

/** The Route Point a page belongs to, for returning to the globe on close. */
export function journeyBookPageRoutePointId(page: JourneyBookPage | undefined): string | null {
  return page && (page.kind === "media" || page.kind === "note") ? page.routePoint?.id ?? null : null;
}
