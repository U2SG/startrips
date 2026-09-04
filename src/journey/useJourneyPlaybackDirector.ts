import { useCallback, useEffect, useRef, useState } from "react";
import {
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
/**
 * An override for one step's length.
 *
 * The director owns tempo state, so it passes its own tempo at the call site
 * rather than making the caller lift that state: a resolver built in the app
 * shell (Quick Recap) cannot take tempo as a dependency, but it can receive it
 * as an argument.
 */
export type PlaybackStepDurationResolver = (
  journey: Journey,
  step: PlaybackStep,
  tempo: PlaybackTempo,
) => number | undefined;

/** The tempo every playback run starts at; callers that pre-build a plan for
 * the first beat must plan at the same tempo. */
export const PLAYBACK_INITIAL_TEMPO: PlaybackTempo = "standard";

export function useJourneyPlaybackDirector(
  journey: Journey | null,
  hold = false,
  resolveStepDuration?: PlaybackStepDurationResolver,
) {
  const [state, setState] = useState<PlaybackState>(initialPlaybackState);
  const [tempo, setTempo] = useState<PlaybackTempo>(PLAYBACK_INITIAL_TEMPO);
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

  // The single place a step becomes a number of milliseconds: the injected
  // resolver when it answers, the tempo profile otherwise. The timer below and
  // #197's prefetch window both read durations through this, so the window is
  // always planned against the beats that actually play.
  const durationForStep = useCallback((target: PlaybackStep) => {
    const current = journeyRef.current;
    if (!current) return 0;
    const overrideDurationMs = resolveStepDuration?.(current, target, tempo);
    return overrideDurationMs !== undefined
      && Number.isFinite(overrideDurationMs)
      && overrideDurationMs >= 0
      ? overrideDurationMs
      : playbackStepDurationForTempo(current, target, PLAYBACK_TEMPO_PROFILES[tempo]);
  }, [resolveStepDuration, tempo]);

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

    const fullDurationMs = durationForStep(step);
    // The key identifies *which* beat is playing, deliberately not how long it
    // is: a tempo change re-resolves the same beat to a new length, and that
    // must scale the remaining budget through `replanPlaybackTimerBudget`
    // instead of resetting it. With the duration inside the key every change
    // took the reset branch, so the replan branch was unreachable and a tempo
    // change restarted the current beat.
    const stepKey = `${journey.id}:${state.stepIndex}:${step.kind}`;
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
  }, [durationForStep, hold, journey, state.stepIndex, state.paused, step, transition]);

  // Reset when the journey changes.
  useEffect(() => {
    timerStepKeyRef.current = null;
    timerRemainingMsRef.current = null;
    timerFullDurationMsRef.current = null;
    timerStartedAtMsRef.current = null;
    setState(initialPlaybackState());
    setTempo(PLAYBACK_INITIAL_TEMPO);
  }, [journey?.id]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const phase: JourneyPlaybackPhase | undefined = state.phase;

  return {
    steps,
    stepIndex: state.stepIndex,
    step,
    durationForStep,
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
  };
}

export type JourneyPlaybackDirector = ReturnType<typeof useJourneyPlaybackDirector>;
