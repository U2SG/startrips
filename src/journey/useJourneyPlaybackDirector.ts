import { useCallback, useEffect, useRef, useState } from "react";
import {
  PLAYBACK_PACING,
  buildPlaybackSteps,
  initialPlaybackState,
  playbackReducer,
  stepDurationMs,
  type JourneyPlaybackPhase,
  type PlaybackControl,
  type PlaybackState,
  type PlaybackStep,
} from "./journeyPlayback";
import type { Journey } from "./types";

/**
 * #19 Journey Playback director.
 *
 * Drives the pure state machine with a timer per step, and exposes the
 * current phase plus semantic commands (pause / resume / next / back / exit)
 * for the overlay UI. The director never touches the Three scene or the audio
 * element directly — the overlay translates phases into focus/route/media
 * commands.
 */
export function useJourneyPlaybackDirector(
  journey: Journey | null,
  hold = false,
) {
  const [state, setState] = useState<PlaybackState>(initialPlaybackState);
  const timerRef = useRef<number>(0);
  const journeyRef = useRef(journey);
  journeyRef.current = journey;

  // The current expanded step, derived from the step index.
  const steps = journey ? buildPlaybackSteps(journey) : [];
  const step: PlaybackStep | undefined = steps[state.stepIndex];

  const transition = useCallback((control: PlaybackControl) => {
    setState((current) => {
      const target = journeyRef.current;
      if (!target) return current;
      return playbackReducer(target, current, control);
    });
  }, []);

  const pause = useCallback(() => transition({ type: "pause" }), [transition]);
  const resume = useCallback(() => transition({ type: "resume" }), [transition]);
  const next = useCallback(() => transition({ type: "advance" }), [transition]);
  const back = useCallback(() => transition({ type: "back" }), [transition]);
  const exit = useCallback(() => transition({ type: "exit" }), [transition]);

  // One timer per step: when it fires, advance. Rebuilt whenever the step
  // index changes, the director pauses, or the journey changes.
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (!journey || state.paused) return;
    if (!step) return;
    // Review P2: when `hold` is true the director waits — the overlay uses it
    // to keep a media chapter on screen until the image is actually decoded,
    // so a slow network never flashes an empty frame.
    if (hold) return;
    const duration = stepDurationMs(journey, step);
    timerRef.current = window.setTimeout(() => {
      transition({ type: "advance" });
    }, duration);
    return () => window.clearTimeout(timerRef.current);
  }, [hold, journey, state.stepIndex, state.paused, step, transition]);

  // Reset when the journey changes.
  useEffect(() => {
    setState(initialPlaybackState());
  }, [journey?.id]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const phase: JourneyPlaybackPhase | undefined = state.phase;

  return {
    steps,
    stepIndex: state.stepIndex,
    step,
    phase,
    paused: state.paused,
    isPlaying: !state.paused && step !== undefined,
    pause,
    resume,
    next,
    back,
    exit,
    introMs: PLAYBACK_PACING.introMs,
    outroMs: PLAYBACK_PACING.outroMs,
  };
}

export type JourneyPlaybackDirector = ReturnType<typeof useJourneyPlaybackDirector>;
