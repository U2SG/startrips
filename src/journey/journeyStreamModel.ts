import { isVisualMediaAsset } from "./journeyModel";
import type { Journey, JourneyMediaAsset, MediaPreviewRead, RoutePoint } from "./types";

/**
 * #393 Journey Stream (after Undertow): a Journey read as one thread of its
 * own light colour. The thread runs through its pictures and videos in Route
 * order; each Route Point's note is written in the margin beside the first
 * picture of that point, as a journal is. A point with a note and no media is
 * a bead on the thread with its note beside it — space carrying the story when
 * there are no pictures. Points with neither carry no story and are skipped.
 */
export type JourneyStreamEntry =
  | { kind: "intro"; key: string; note: string | null }
  | {
    kind: "media";
    key: string;
    asset: JourneyMediaAsset;
    routePoint: RoutePoint | null;
    /** Place and date open a point's first entry only. */
    place: string | null;
    date: string | null;
    note: string | null;
  }
  | { kind: "note"; key: string; routePoint: RoutePoint; place: string | null; date: string | null; note: string };

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** The calendar part of an occurrence time, as written. */
export function streamDate(occurredAt: string | null | undefined): string | null {
  const value = trimmed(occurredAt);
  return value ? value.slice(0, 10) : null;
}

function ownerMedia(journey: Journey, routePointId: string | null): JourneyMediaAsset[] {
  return journey.media
    .filter((asset) => asset.routePointId === routePointId && isVisualMediaAsset(asset))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/** Entries oldest first, in canonical Route order. */
export function journeyStreamEntries(journey: Journey): JourneyStreamEntry[] {
  const entries: JourneyStreamEntry[] = [{ kind: "intro", key: "intro", note: trimmed(journey.note) }];
  for (const asset of ownerMedia(journey, null)) {
    entries.push({ kind: "media", key: `media:${asset.id}`, asset, routePoint: null, place: null, date: null, note: null });
  }
  for (const point of journey.routePoints) {
    const media = ownerMedia(journey, point.id);
    const note = trimmed(point.note);
    const place = trimmed(point.label);
    const date = streamDate(point.occurredAt);
    if (media.length === 0) {
      if (note) entries.push({ kind: "note", key: `note:${point.id}`, routePoint: point, place, date, note });
      continue;
    }
    media.forEach((asset, index) => {
      entries.push({
        kind: "media",
        key: `media:${asset.id}`,
        asset,
        routePoint: point,
        place: index === 0 ? place : null,
        date: index === 0 ? date : null,
        note: index === 0 ? note : null,
      });
    });
  }
  return entries;
}

/** Width / height of a picture, from the best size known so far. */
export function streamAspect(
  asset: Pick<JourneyMediaAsset, "displayWidth" | "displayHeight">,
  preview?: Pick<MediaPreviewRead, "width" | "height"> | null,
  natural?: { width: number; height: number } | null,
): number {
  for (const size of [natural, { width: asset.displayWidth, height: asset.displayHeight }, preview]) {
    if (size?.width && size.height && size.width > 0 && size.height > 0) return size.width / size.height;
  }
  return 4 / 3;
}

export type JourneyStreamLayout = {
  /** Wide screens write the note beside the picture; narrow ones below it. */
  beside: boolean;
  /** Width of a landscape picture; portrait pictures are narrower. */
  pictureWidth: number;
  gap: number;
  noteWidth: number;
  gutter: number;
  /** Tallest a picture may be, so one always fits on screen. */
  maxPictureHeight: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function journeyStreamLayout(width: number, height: number): JourneyStreamLayout {
  const gap = Math.round(clamp(height * 0.075, 36, 80));
  const noteWidth = Math.round(clamp(width * 0.2, 220, 300));
  const gutter = Math.round(clamp(width * 0.04, 28, 60));
  let pictureWidth = Math.min(clamp(height * 0.44, 220, 380), width * 0.64);
  const beside = width >= pictureWidth + 2 * (gutter + noteWidth + 40);
  if (!beside) pictureWidth = Math.min(width * 0.84, 440);
  return {
    beside,
    pictureWidth: Math.round(pictureWidth),
    gap,
    noteWidth,
    gutter,
    maxPictureHeight: Math.round(height * 0.62),
  };
}

export function streamPictureSize(aspect: number, layout: JourneyStreamLayout): { width: number; height: number } {
  let width = aspect < 1 ? layout.pictureWidth * 0.72 : layout.pictureWidth;
  let height = width / aspect;
  if (height > layout.maxPictureHeight) {
    height = layout.maxPictureHeight;
    width = height * aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Offset that puts an entry's centre at the middle of a viewport of `height`. */
export function streamOffsetFor(entryCenter: number, height: number): number {
  return height / 2 - entryCenter;
}
