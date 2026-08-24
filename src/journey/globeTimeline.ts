// #21 Rewind — normalize journey/point timestamps into a temporal cursor.
//
// All time math is pure and unit-tested; the globe receives normalized
// progress values (0 = future/invisible, 0..1 = being revealed, 1 = visited)
// and never parses dates itself.

import type { Journey, RoutePoint } from "./types";

export type JourneyTimelineEntry = {
  journeyId: string;
  /** Normalized timestamp in [0, 1] over the full timeline. */
  started: number;
  /** Normalized timestamp in [0, 1]. */
  ended: number;
  /** Points with their own normalized reveal time. */
  points: Array<{
    pointIndex: number;
    /** Point's own timestamp in [0, 1]. */
    at: number;
    /** True when the point carried an explicit occurredAt. */
    explicit: boolean;
  }>;
};

/**
 * Build the global journey timeline. The cursor domain is [0, 1]: 0 is
 * before every dated journey, 1 is "now" (the latest dated moment).
 *
 * Point timestamps resolve to the finest available data:
 * - occurredAt when present;
 * - otherwise evenly interpolated across the journey's date range by index;
 * - a single-date journey reveals all its points at that date.
 */
export function buildJourneyTimeline(journeys: readonly Journey[]): {
  entries: JourneyTimelineEntry[];
  /** Earliest absolute ms across all dated journeys. */
  minTime: number;
  /** Latest absolute ms across all dated journeys. */
  maxTime: number;
  /** Journeys with no usable date (shown only at the final state). */
  undated: Journey[];
} {
  const dated = journeys.filter((journey) => journey.startedOn);
  const undated = journeys.filter((journey) => !journey.startedOn);

  const times = dated.map((journey) => Date.parse(journey.startedOn))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) {
    return { entries: [], minTime: 0, maxTime: 1, undated };
  }
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(1, maxTime - minTime);

  const normalize = (timeMs: number) => (timeMs - minTime) / span;

  const entries: JourneyTimelineEntry[] = dated.map((journey) => {
    const started = normalize(Date.parse(journey.startedOn));
    const ended = journey.endedOn
      ? normalize(Date.parse(journey.endedOn))
      : started;
    const points = resolveRoutePointTimes(journey).map((point) => ({
      pointIndex: point.index,
      at: normalize(point.timeMs),
      explicit: point.explicit,
    }));
    return { journeyId: journey.id, started, ended, points };
  });

  entries.sort((left, right) => left.started - right.started);
  return { entries, minTime, maxTime, undated };
}

type ResolvedPointTime = {
  index: number;
  timeMs: number;
  explicit: boolean;
};

export function resolveRoutePointTimes(journey: Journey): ResolvedPointTime[] {
  const points = journey.routePoints;
  if (points.length === 0) return [];

  // Explicit occurredAt wins for each point.
  const explicit = points.map((point, index) => {
    const timeMs = point.occurredAt ? Date.parse(point.occurredAt) : Number.NaN;
    return {
      index,
      timeMs: Number.isFinite(timeMs) ? timeMs : Number.NaN,
      explicit: Number.isFinite(timeMs),
    };
  });

  const explicitCount = explicit.filter((point) => point.explicit).length;
  if (explicitCount === points.length) return explicit;

  // Interpolate points without explicit times across the journey range.
  const startedMs = Date.parse(journey.startedOn);
  const endedMs = journey.endedOn
    ? Date.parse(journey.endedOn)
    : startedMs;
  const rangeMs = Math.max(0, Number.isFinite(endedMs) ? endedMs - startedMs : 0);

  return explicit.map((point) => {
    if (point.explicit) return point;
    const fraction = points.length > 1 ? point.index / (points.length - 1) : 1;
    return {
      index: point.index,
      timeMs: Number.isFinite(startedMs)
        ? startedMs + rangeMs * fraction
        : Number.NaN,
      explicit: false,
    };
  });
}

/**
 * Temporal progress of one point at the given cursor (0..1):
 * 0 = future (invisible), 0..1 = currently being revealed, 1 = visited.
 */
export function getTemporalProgress(
  pointAt: number,
  cursor: number,
  revealWindow = 0.015,
): number {
  if (cursor >= pointAt) return 1;
  if (cursor + revealWindow <= pointAt) return 0;
  return (cursor + revealWindow - pointAt) / revealWindow;
}

/**
 * Temporal progress of one journey (its route reveals from started to ended).
 */
export function getJourneyTemporalProgress(
  entry: Pick<JourneyTimelineEntry, "started" | "ended">,
  cursor: number,
): number {
  if (cursor >= entry.ended) return 1;
  if (cursor <= entry.started) return 0;
  const span = Math.max(Number.EPSILON, entry.ended - entry.started);
  return Math.min(1, (cursor - entry.started) / span);
}

/**
 * Auto-play cursor positions: the sequence of moments at which anything
 * changes (each journey start/end and each explicit point time), plus the
 * final "now". Used to scrub the cursor deterministically.
 */
export function timelineCursorStops(
  entries: readonly JourneyTimelineEntry[],
  maxStops = 512,
): number[] {
  const stops = new Set<number>();
  for (const entry of entries) {
    stops.add(entry.started);
    stops.add(entry.ended);
    for (const point of entry.points) stops.add(point.at);
  }
  const sorted = [...stops].filter((value) => value >= 0 && value <= 1).sort(
    (left, right) => left - right,
  );
  if (sorted.length <= maxStops) return sorted;
  // Thin densely-clustered stops to the budget, keeping the endpoints.
  const stride = Math.ceil(sorted.length / maxStops);
  const thinned = sorted.filter((_, index) => index % stride === 0);
  if (thinned[0] !== sorted[0]) thinned.unshift(sorted[0]);
  if (thinned.at(-1) !== sorted.at(-1)) thinned.push(sorted.at(-1)!);
  return thinned;
}
