import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildJourneyTimeline,
  cursorForJourney,
  getJourneyTemporalProgress,
  getTemporalProgress,
  resolveJourneyTimelineSelection,
  timelineCursorStops,
  type JourneyTimelineEntry,
} from "./globeTimeline";
import type { Journey } from "./types";

export type TemporalReveal = {
  /** Per-journey route reveal progress (0..1) at the current cursor. */
  journeyProgress: Map<string, number>;
  /** Per-point reveal progress, keyed by `${journeyId}:${pointIndex}`. */
  pointProgress: Map<string, number>;
  /** Undated journeys are always visible at the final state. */
  showUndated: boolean;
};

/**
 * #21 useGlobeTimeCursor — one cursor in [0, 1] over the whole journey
 * timeline, with play/scrub controls. The globe consumes normalized reveal
 * maps, never dates.
 */
export function useGlobeTimeCursor(journeys: readonly Journey[]) {
  const timeline = useMemo(() => buildJourneyTimeline(journeys), [journeys]);
  // Review P2: default to "now" (1) so entering Globe Focus Mode shows the
  // full planet — only an explicit Play/scrub rewinds through time.
  const [cursor, setCursor] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [scrub, setScrubState] = useState<number | null>(null);
  // Explicit chip/picker/point selection is part of the canonical playback
  // controller. Keep journey-level selection distinct from point-level
  // selection so a journey click can frame the whole route while timeline
  // playback/scrubbing can still resolve to the latest reached point.
  const [selectionOwner, setSelectionOwner] = useState<{
    journeyId: string;
    pointIndex: number | null;
  } | null>(null);
  // Explicit re-selection must still retrigger camera framing even when the
  // journey/point coordinates are unchanged (for example after manual globe
  // rotation). Keep a monotonic revision separate from timeline position.
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [timelineRevision, setTimelineRevision] = useState(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const stops = useMemo(
    () => timelineCursorStops(timeline.entries),
    [timeline],
  );

  // Auto-play: step through the change moments at a fixed pace.
  useEffect(() => {
    if (!playing) return;
    if (stops.length === 0) {
      setPlaying(false);
      return;
    }
    let stopIndex = stops.findIndex((stop) => stop >= cursor);
    if (stopIndex < 0) stopIndex = stops.length - 1;
    const timer = window.setTimeout(() => {
      const nextStop = stops[stopIndex + 1];
      if (nextStop === undefined) {
        setPlaying(false);
        setTimelineRevision((revision) => revision + 1);
        setCursor(1);
        return;
      }
      setTimelineRevision((revision) => revision + 1);
      setCursor(nextStop);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, stops]);

  const play = useCallback(() => {
    setSelectionOwner(null);
    setScrubState(null);
    setTimelineRevision((revision) => revision + 1);
    setCursor((current) => (current >= 1 ? 0 : current));
    setPlaying(true);
  }, []);
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((value: number) => {
    setSelectionOwner(null);
    setTimelineRevision((revision) => revision + 1);
    setCursor(Math.min(1, Math.max(0, value)));
    setScrubState(null);
    setPlaying(false);
  }, []);
  const previewScrub = useCallback((value: number | null) => {
    setSelectionOwner(null);
    setTimelineRevision((revision) => revision + 1);
    setScrubState(value === null ? null : Math.min(1, Math.max(0, value)));
  }, []);

  // Scrubbing is a first-class preview position. Every derived surface uses
  // the effective cursor, so the globe, chip and route reveal cannot drift.
  const effectiveCursor = scrub ?? cursor;
  const selection = useMemo(
    () => selectionOwner
      ? {
          journeyId: selectionOwner.journeyId,
          pointIndex: selectionOwner.pointIndex,
          cursor: effectiveCursor,
        }
      : resolveJourneyTimelineSelection(timeline.entries, effectiveCursor),
    [effectiveCursor, selectionOwner, timeline.entries],
  );

  useEffect(() => {
    if (
      selectionOwner
      && !timeline.entries.some((entry) => entry.journeyId === selectionOwner.journeyId)
    ) {
      setSelectionOwner(null);
    }
  }, [selectionOwner, timeline.entries]);

  const selectJourney = useCallback((journeyId: string) => {
    const target = cursorForJourney(timeline.entries, journeyId);
    if (target === null) return;
    setSelectionOwner({ journeyId, pointIndex: null });
    setSelectionRevision((revision) => revision + 1);
    setCursor(target);
    setScrubState(null);
    setPlaying(false);
  }, [timeline.entries]);

  const selectPoint = useCallback((journeyId: string, pointIndex: number) => {
    const entry = timeline.entries.find((candidate) => candidate.journeyId === journeyId);
    const point = entry?.points.find((candidate) => candidate.pointIndex === pointIndex);
    if (!point) return;
    setSelectionOwner({ journeyId, pointIndex });
    setSelectionRevision((revision) => revision + 1);
    setCursor(Math.min(1, Math.max(0, point.at)));
    setScrubState(null);
    setPlaying(false);
  }, [timeline.entries]);

  const reveal: TemporalReveal = useMemo(() => {
    const journeyProgress = new Map<string, number>();
    const pointProgress = new Map<string, number>();
    for (const entry of timeline.entries) {
      journeyProgress.set(
        entry.journeyId,
        getJourneyTemporalProgress(entry, effectiveCursor),
      );
      for (const point of entry.points) {
        pointProgress.set(
          `${entry.journeyId}:${point.pointIndex}`,
          getTemporalProgress(point.at, effectiveCursor),
        );
      }
    }
    return {
      journeyProgress,
      pointProgress,
      showUndated: effectiveCursor >= 1,
    };
  }, [timeline, effectiveCursor]);

  return {
    cursor: effectiveCursor,
    playing,
    stops,
    timeDomain: timeline.entries.length > 0
      ? { minTime: timeline.minTime, maxTime: timeline.maxTime }
      : null,
    play,
    pause,
    seek,
    selectJourney,
    selectPoint,
    selection,
    selectionRevision,
    timelineRevision,
    scrub,
    setScrub: previewScrub,
    reveal,
    entryOf: (journeyId: string): JourneyTimelineEntry | undefined =>
      timeline.entries.find((entry) => entry.journeyId === journeyId),
  };
}

export type GlobeTimeCursor = ReturnType<typeof useGlobeTimeCursor>;
