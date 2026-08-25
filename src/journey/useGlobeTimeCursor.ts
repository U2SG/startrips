import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildJourneyTimeline,
  getJourneyTemporalProgress,
  getTemporalProgress,
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
  const [scrub, setScrub] = useState<number | null>(null);
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
        setCursor(1);
        return;
      }
      setCursor(nextStop);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, stops]);

  const play = useCallback(() => {
    setCursor((current) => (current >= 1 ? 0 : current));
    setPlaying(true);
  }, []);
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((value: number) => {
    setCursor(Math.min(1, Math.max(0, value)));
    setPlaying(false);
  }, []);

  const reveal: TemporalReveal = useMemo(() => {
    const journeyProgress = new Map<string, number>();
    const pointProgress = new Map<string, number>();
    for (const entry of timeline.entries) {
      journeyProgress.set(
        entry.journeyId,
        getJourneyTemporalProgress(entry, cursor),
      );
      for (const point of entry.points) {
        pointProgress.set(
          `${entry.journeyId}:${point.pointIndex}`,
          getTemporalProgress(point.at, cursor),
        );
      }
    }
    return {
      journeyProgress,
      pointProgress,
      showUndated: cursor >= 1,
    };
  }, [timeline, cursor]);

  // The scrub value lets the timeline UI drive the cursor continuously.
  const effectiveCursor = scrub ?? cursor;

  return {
    cursor: effectiveCursor,
    playing,
    stops,
    play,
    pause,
    seek,
    scrub,
    setScrub,
    reveal,
    entryOf: (journeyId: string): JourneyTimelineEntry | undefined =>
      timeline.entries.find((entry) => entry.journeyId === journeyId),
  };
}

export type GlobeTimeCursor = ReturnType<typeof useGlobeTimeCursor>;
