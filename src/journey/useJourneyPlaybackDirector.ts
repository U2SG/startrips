import { useCallback, useEffect, useRef, useState } from "react";
import {
  PLAYBACK_PACING,
  buildPlaybackSteps,
  initialPlaybackState,
  playbackReducer,
  type JourneyPlaybackPhase,
  type PlaybackControl,
  type PlaybackState,
  type PlaybackStep,
} from "./journeyPlayback";
import {
  PLAYBACK_TEMPO_PROFILES,
  playbackStepDurationForTempo,
  type PlaybackTempo,
} from "./journeyPlaybackPlan";
import type { Journey } from "./types";

export function consumePlaybackTimerBudget(remainingMs: number, startedAtMs: number, nowMs: number) {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  return Math.max(0, remainingMs - elapsedMs);
}

export function replanPlaybackTimerBudget(
  remainingMs: number,
  previousDurationMs: number,
  nextDurationMs: number,
) {
  if (previousDurationMs <= 0) return Math.max(0, nextDurationMs);
  const remainingFraction = Math.min(1, Math.max(0, remainingMs / previousDurationMs));
  return Math.max(0, nextDurationMs * remainingFraction);
}

/**
 * #19 Journey Playback director.
 *
 * Drives the pure state machine with a timer per step, and exposes the
 * current phase plus semantic commands (pause / resume / next / back / exit)
 * for the overlay UI. The director never touches the Three scene or the audio
 * element directly — the overlay translates phases into focus/route/media
 * commands.
 */
export type PlaybackStepDurationResolver = (journey: Journey, step: PlaybackStep) => number | undefined;

export function useJourneyPlaybackDirector(
  journey: Journey | null,
  hold = false,
  resolveStepDuration?: PlaybackStepDurationResolver,
) {
  const [state, setState] = useState<PlaybackState>(initialPlaybackState);
  const [tempo, setTempo] = useState<PlaybackTempo>("standard");
  const timerRef = useRef<number>(0);
  const timerStepKeyRef = useRef<string | null>(null);
  const timerRemainingMsRef = useRef<number | null>(null);
  const timerFullDurationMsRef = useRef<number | null>(null);
  const timerStartedAtMsRef = useRef<number | null>(null);
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
  const next = useCallback(() => transition({ type: "next" }), [transition]);
  const complete = useCallback(() => transition({ type: "advance" }), [transition]);
  const back = useCallback(() => transition({ type: "previous" }), [transition]);
  const seek = useCallback((stepIndex: number) => transition({ type: "seek", stepIndex }), [transition]);
  const exit = useCallback(() => transition({ type: "exit" }), [transition]);

  // Keep one elapsed-time budget per expanded step. Pausing (or decode hold)
  // freezes that budget instead of discarding it, so resume continues from the
  // same point in the current beat rather than granting a fresh full timeout.
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (!journey || !step) {
      timerStepKeyRef.current = null;
      timerRemainingMsRef.current = null;
      timerFullDurationMsRef.current = null;
      timerStartedAtMsRef.current = null;
      return;
    }

    const overrideDurationMs = resolveStepDuration?.(journey, step);
    const profile = PLAYBACK_TEMPO_PROFILES[tempo];
    const fullDurationMs = overrideDurationMs !== undefined
      && Number.isFinite(overrideDurationMs)
      && overrideDurationMs >= 0
      ? overrideDurationMs
      : playbackStepDurationForTempo(journey, step, profile);
    const stepKey = `${journey.id}:${state.stepIndex}:${step.kind}:${fullDurationMs}`;
    if (timerStepKeyRef.current !== stepKey) {
      timerStepKeyRef.current = stepKey;
      timerRemainingMsRef.current = fullDurationMs;
      timerFullDurationMsRef.current = fullDurationMs;
      timerStartedAtMsRef.current = null;
    } else if (timerFullDurationMsRef.current !== fullDurationMs) {
      timerRemainingMsRef.current = replanPlaybackTimerBudget(
        timerRemainingMsRef.current ?? timerFullDurationMsRef.current ?? fullDurationMs,
        timerFullDurationMsRef.current ?? fullDurationMs,
        fullDurationMs,
      );
      timerFullDurationMsRef.current = fullDurationMs;
    }

    if (state.paused || hold) return;

    const remainingMs = timerRemainingMsRef.current ?? fullDurationMs;
    const startedAtMs = performance.now();
    timerStartedAtMsRef.current = startedAtMs;
    timerRef.current = window.setTimeout(() => {
      timerRemainingMsRef.current = 0;
      timerStartedAtMsRef.current = null;
      transition({ type: "advance" });
    }, remainingMs);

    return () => {
      window.clearTimeout(timerRef.current);
      if (
        timerStepKeyRef.current === stepKey
        && timerStartedAtMsRef.current === startedAtMs
      ) {
        timerRemainingMsRef.current = consumePlaybackTimerBudget(
          remainingMs,
          startedAtMs,
          performance.now(),
        );
        timerStartedAtMsRef.current = null;
      }
    };
  }, [hold, journey, resolveStepDuration, state.stepIndex, state.paused, step, tempo, transition]);

  // Reset when the journey changes.
  useEffect(() => {
    timerStepKeyRef.current = null;
    timerRemainingMsRef.current = null;
    timerFullDurationMsRef.current = null;
    timerStartedAtMsRef.current = null;
    setState(initialPlaybackState());
    setTempo("standard");
  }, [journey?.id]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const phase: JourneyPlaybackPhase | undefined = state.phase;

  return {
    steps,
    stepIndex: state.stepIndex,
    step,
    phase,
    paused: state.paused,
    tempo,
    setTempo,
    isPlaying: !state.paused && step !== undefined,
    pause,
    resume,
    next,
    complete,
    back,
    seek,
    exit,
    introMs: PLAYBACK_PACING.introMs,
    outroMs: PLAYBACK_PACING.outroMs,
  };
}

export type JourneyPlaybackDirector = ReturnType<typeof useJourneyPlaybackDirector>;
