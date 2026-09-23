/**
 * #512: reading a long screenshot without asking a model to guess at it.
 *
 * A phone screenshot of a multi-day plan is tall and narrow, and two things go
 * wrong if it is submitted whole. It does not fit — one image has to stay
 * inside the app's 512 KB request envelope, which every other route is held to
 * as well — and even where it fits, scaling a 12,000-pixel column down to
 * something a request can carry is how printed names turn into a model's
 * guesses. So a tall image is cut into bands at its natural reading width, at
 * full resolution, with a controlled overlap so a row that lands on a cut is
 * whole in at least one band.
 *
 * Two rules keep the assembly honest.
 *
 * A band is a *view* of one plan, never a plan of its own: every reading
 * carries the page it came from and the region of that page, and the bands are
 * reassembled into a single draft before anybody reviews anything.
 *
 * And the overlap that makes a cut row readable also makes it readable twice,
 * so the duplicate has to go — but only that duplicate. The dedup is by
 * segment adjacency and printed position, never by name: #512 is explicit that
 * a same-city multi-day stay, a one-day multi-city sequence and an A to B back
 * to A revisit each keep every visit. Two bands of the same page may only
 * cancel an entry that agrees on day, position within the day and printed
 * name — which is the one thing the overlap can actually produce.
 */

import type {
  ItineraryRecognition,
  ItineraryRecognitionDay,
  ItineraryRecognitionEntry,
} from "./itineraryImport";

/** One band of one submitted image. */
export type ItineraryImageSegmentPlan = {
  /** Which submitted image, in the order the member arranged them. */
  pageIndex: number;
  /** The band's order inside that image. */
  segmentIndex: number;
  top: number;
  height: number;
  /** How much of this band repeats the end of the one before it. */
  overlapWithPrevious: number;
};

/**
 * Roughly what one band may carry before its encoding stops fitting the
 * request envelope the server enforces per segment. Deliberately a pixel
 * budget rather than a byte one: the encoder's output is not knowable here,
 * and a budget that is too generous fails loudly on the server rather than
 * silently degrading a reading.
 */
export const MAX_SEGMENT_PIXELS = 700_000;

/** Enough to carry a full row of a plan across a cut. */
export const SEGMENT_OVERLAP = 96;

export function planItineraryImageSegments(
  image: { pageIndex: number; width: number; height: number },
  options: { maxSegmentPixels?: number; overlap?: number } = {},
): ItineraryImageSegmentPlan[] {
  const width = Math.max(1, Math.floor(image.width));
  const height = Math.max(1, Math.floor(image.height));
  const budget = options.maxSegmentPixels ?? MAX_SEGMENT_PIXELS;
  const overlap = Math.max(0, Math.floor(options.overlap ?? SEGMENT_OVERLAP));
  const band = Math.max(1, Math.floor(budget / width));

  if (height <= band) {
    return [{
      pageIndex: image.pageIndex,
      segmentIndex: 0,
      top: 0,
      height,
      overlapWithPrevious: 0,
    }];
  }

  // A band has to advance by at least half of itself, or an overlap wider than
  // the band would cut a tall image into thousands of near-identical requests.
  const step = band - Math.min(overlap, Math.floor(band / 2));
  const segments: ItineraryImageSegmentPlan[] = [];
  let top = 0;
  while (top < height) {
    const previous = segments[segments.length - 1];
    segments.push({
      pageIndex: image.pageIndex,
      segmentIndex: segments.length,
      top,
      // The last band is whatever is left; it still carries the overlap, so a
      // row sitting on the cut above it is whole here.
      height: Math.min(band, height - top),
      overlapWithPrevious: previous
        ? Math.max(0, previous.top + previous.height - top)
        : 0,
    });
    if (top + band >= height) break;
    top += step;
  }
  return segments;
}

/** One band's reading, kept beside the band it came from. */
export type ItinerarySegmentReading = {
  segment: ItineraryImageSegmentPlan;
  recognition: ItineraryRecognition;
};

function sameEntry(
  left: ItineraryRecognitionEntry,
  right: ItineraryRecognitionEntry,
): boolean {
  return left.dayNumber === right.dayNumber
    && left.orderInDay === right.orderInDay
    && left.name === right.name;
}

function mergeDay(
  into: ItineraryRecognitionDay,
  next: ItineraryRecognitionDay,
): ItineraryRecognitionDay {
  return {
    dayNumber: into.dayNumber,
    // A band that saw the heading wins over a band that only saw rows; neither
    // one is allowed to replace something already read.
    sourceDayTitle: into.sourceDayTitle ?? next.sourceDayTitle,
    calendarDate: into.calendarDate ?? next.calendarDate,
    partialDate: into.partialDate ?? next.partialDate,
    regionContext: into.regionContext ?? next.regionContext ?? null,
  };
}

/**
 * Assemble the bands of one or more images into the single reading a member
 * reviews.
 *
 * Readings are consumed in the order the bands were cut, which is the order
 * the plan is printed in, so day order and position within a day survive
 * untouched. Only a band and the band immediately before it on the same page
 * can cancel an entry, and only when day, position and printed name all agree.
 */
export function mergeItinerarySegmentReadings(
  readings: readonly ItinerarySegmentReading[],
): ItineraryRecognition {
  if (readings.length === 0) {
    throw new Error("an itinerary reading needs at least one segment");
  }
  const ordered = [...readings].sort((left, right) =>
    left.segment.pageIndex - right.segment.pageIndex
    || left.segment.segmentIndex - right.segment.segmentIndex
  );

  const days = new Map<number, ItineraryRecognitionDay>();
  const entries: ItineraryRecognitionEntry[] = [];
  let previous: ItinerarySegmentReading | null = null;
  let previousEntries: ItineraryRecognitionEntry[] = [];

  for (const reading of ordered) {
    for (const day of reading.recognition.days) {
      const existing = days.get(day.dayNumber);
      days.set(day.dayNumber, existing ? mergeDay(existing, day) : { ...day });
    }

    const adjacent = previous !== null
      && previous.segment.pageIndex === reading.segment.pageIndex
      && previous.segment.segmentIndex + 1 === reading.segment.segmentIndex
      && reading.segment.overlapWithPrevious > 0;
    for (const entry of reading.recognition.entries) {
      if (adjacent && previousEntries.some((earlier) => sameEntry(earlier, entry))) {
        // The overlap band repeated a row the previous band already read.
        continue;
      }
      entries.push(entry);
    }
    previous = reading;
    // Everything the previous band saw, including rows it read and this one
    // will repeat — a row dropped here was still visible there.
    previousEntries = reading.recognition.entries;
  }

  const versions = [...new Set(ordered.map((reading) => reading.recognition.recognizerVersion))];
  const first = ordered[0].recognition;
  const claimed = <T>(pick: (reading: ItineraryRecognition) => T | null): T | null => {
    for (const reading of ordered) {
      const value = pick(reading.recognition);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };

  return {
    contractVersion: 1,
    sourceKind: first.sourceKind,
    recognizerVersion: versions.join("+"),
    sourceTitle: claimed((reading) => reading.sourceTitle),
    // What any band saw the page claim, kept for comparison. Never summed:
    // every band is looking at the same plan's own header.
    sourceReportedDayCount: claimed((reading) => reading.sourceReportedDayCount),
    sourceReportedPlaceCount: claimed((reading) => reading.sourceReportedPlaceCount),
    days: [...days.values()].sort((left, right) => left.dayNumber - right.dayNumber),
    entries,
  };
}
