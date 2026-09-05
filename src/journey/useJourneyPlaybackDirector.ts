import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPlaybackSteps,
  initialPlaybackState,
  playbackReducer,
  playbackStepIdentity,
  type JourneyPlaybackPhase,
  type PlaybackControl,
  type PlaybackState,
  type PlaybackStep,
} from "./journeyPlayback";
import {
  buildPlaybackPlan,
  resolvePlaybackStepDurationMs,
  type PlaybackPlan,
  type PlaybackStepDurationResolver,
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

/** The elapsed-time budget the director keeps for the beat that is playing. */
export type PlaybackTimerBudget = { remainingMs: number; fullDurationMs: number };

/** The budget of the beat that stopped playing, tagged with the beat it belongs to. */
export type PlaybackTimerCarry = PlaybackTimerBudget & { key: string };

/**
 * Which budget the beat identified by `nextKey` should play with.
 *
 * Three cases, in order:
 *
 * - Same beat, new length (a tempo change re-resolves it): scale the remaining
 *   budget so the viewer keeps the fraction of the beat already watched.
 * - The beat we carried a budget for is the beat we are landing on, and the
 *   landing is a plan-rebuild remap: restore that carried fraction. A Quick
 *   Recap rebuild can add or drop beats before the one playing, so the same
 *   beat comes back under a different step index; without this the surviving
 *   beat would restart from the top every time the tempo control moved.
 * - Anything else — an ordinary advance, a user seek, a beat the rebuild
 *   deleted — starts fresh.
 *
 * `carryAllowed` is what separates a rebuild remap from a user seek: seeking
 * back to a beat is a request to watch it again, not to resume it.
 */
export function resolvePlaybackTimerBudget(input: {
  previousKey: string | null;
  nextKey: string;
  current: PlaybackTimerBudget | null;
  nextFullDurationMs: number;
  carry: PlaybackTimerCarry | null;
  carryAllowed: boolean;
}): { budget: PlaybackTimerBudget; carry: PlaybackTimerCarry | null } {
  const { previousKey, nextKey, current, nextFullDurationMs, carry, carryAllowed } = input;
  if (previousKey === nextKey && current) {
    if (current.fullDurationMs === nextFullDurationMs) return { budget: current, carry };
    return {
      budget: {
        remainingMs: replanPlaybackTimerBudget(
          current.remainingMs,
          current.fullDurationMs,
          nextFullDurationMs,
        ),
        fullDurationMs: nextFullDurationMs,
      },
      carry,
    };
  }
  if (carryAllowed && carry && carry.key === nextKey) {
    return {
      budget: {
        remainingMs: replanPlaybackTimerBudget(
          carry.remainingMs,
          carry.fullDurationMs,
          nextFullDurationMs,
        ),
        fullDurationMs: nextFullDurationMs,
      },
      carry: null,
    };
  }
  return {
    budget: { remainingMs: nextFullDurationMs, fullDurationMs: nextFullDurationMs },
    carry: previousKey && current ? { key: previousKey, ...current } : carry,
  };
}

/**
 * An override for one step's length.
 *
 * The director owns tempo state, so it passes its own tempo at the call site
 * rather than making the caller lift that state: a resolver built in the app
 * shell (Quick Recap) cannot take tempo as a dependency, but it can receive it
 * as an argument. The type itself lives beside the tempo profiles, because the
 * elapsed-time plan resolves durations through the very same call.
 */
export type { PlaybackStepDurationResolver };

/**
 * Where the transport is on the planned timeline: the beat's own start plus the
 * share of the beat already watched, over the whole plan.
 *
 * The consumed share is taken as a fraction of the live budget and then applied
 * to the *planned* segment length, so a transient disagreement between the two
 * — the frame between a tempo change and the plan rebuilt at that tempo — moves
 * the bar inside its own beat instead of running it into the next one.
 */
export function playbackProgressFraction(
  plan: PlaybackPlan | null,
  stepIndex: number,
  remainingMs: number,
  fullDurationMs: number,
): number {
  if (!plan || plan.totalDurationMs <= 0) return 0;
  const segment = plan.segments[stepIndex];
  if (!segment) return 0;
  const consumedFraction = fullDurationMs > 0
    ? Math.min(1, Math.max(0, (fullDurationMs - remainingMs) / fullDurationMs))
    : 1;
  const elapsedMs = segment.startMs + segment.durationMs * consumedFraction;
  return Math.min(1, Math.max(0, elapsedMs / plan.totalDurationMs));
}

/** The tempo every playback run starts at; callers that pre-build a plan for
 * the first beat must plan at the same tempo. */
export const PLAYBACK_INITIAL_TEMPO: PlaybackTempo = "standard";

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
  resolveStepDuration?: PlaybackStepDurationResolver,
) {
  const [state, setState] = useState<PlaybackState>(initialPlaybackState);
  const [tempo, setTempo] = useState<PlaybackTempo>(PLAYBACK_INITIAL_TEMPO);
  const timerRef = useRef<number>(0);
  const timerStepKeyRef = useRef<string | null>(null);
  const timerRemainingMsRef = useRef<number | null>(null);
  const timerFullDurationMsRef = useRef<number | null>(null);
  const timerStartedAtMsRef = useRef<number | null>(null);
  const timerCarryRef = useRef<PlaybackTimerCarry | null>(null);
  const pendingRemapSeekRef = useRef(false);
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
  // `carryProgress` marks a seek that only re-addresses the beat already
  // playing after a plan rebuild moved it, so the timer resumes it instead of
  // restarting it. A user seek leaves it unset and gets a fresh beat.
  const seek = useCallback((stepIndex: number, options?: { carryProgress?: boolean }) => {
    if (options?.carryProgress) pendingRemapSeekRef.current = true;
    transition({ type: "seek", stepIndex });
  }, [transition]);
  const exit = useCallback(() => transition({ type: "exit" }), [transition]);

  // The single place a step becomes a number of milliseconds: the injected
  // resolver when it answers, the tempo profile otherwise. The timer below and
  // #197's prefetch window both read durations through this, so the window is
  // always planned against the beats that actually play.
  const durationForStep = useCallback((target: PlaybackStep) => {
    const current = journeyRef.current;
    if (!current) return 0;
    return resolvePlaybackStepDurationMs(current, target, tempo, resolveStepDuration);
  }, [resolveStepDuration, tempo]);

  // The elapsed-time plan of the run that is playing, at this tempo and through
  // this resolver: the same two inputs the timer resolves each beat with, so
  // `plan.totalDurationMs` is the length the timers will actually add up to.
  const plan = useMemo(
    () => (journey ? buildPlaybackPlan(journey, tempo, resolveStepDuration) : null),
    [journey, resolveStepDuration, tempo],
  );

  // The live budget of the beat that is playing, read from the refs rather than
  // published as state: the timer effect below re-runs on every render (`step`
  // is derived fresh each time), so a `setState` here would not settle.
  const getTimerBudget = useCallback((): PlaybackTimerBudget | null => {
    const fullDurationMs = timerFullDurationMsRef.current;
    if (fullDurationMs === null) return null;
    const bookedMs = timerRemainingMsRef.current ?? fullDurationMs;
    const startedAtMs = timerStartedAtMsRef.current;
    return {
      remainingMs: startedAtMs === null
        ? bookedMs
        : consumePlaybackTimerBudget(bookedMs, startedAtMs, performance.now()),
      fullDurationMs,
    };
  }, []);

  // Keep one elapsed-time budget per expanded step. Pausing (or decode hold)
  // freezes that budget instead of discarding it, so resume continues from the
  // same point in the current beat rather than granting a fresh full timeout.
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    const carryAllowed = pendingRemapSeekRef.current;
    pendingRemapSeekRef.current = false;
    if (!journey || !step) {
      timerStepKeyRef.current = null;
      timerRemainingMsRef.current = null;
      timerFullDurationMsRef.current = null;
      timerStartedAtMsRef.current = null;
      timerCarryRef.current = null;
      return;
    }

    const fullDurationMs = durationForStep(step);
    // The key identifies *which* beat is playing, deliberately not how long it
    // is and deliberately not where it sits in the step list. Length is out
    // because a tempo change re-resolves the same beat to a new one, and that
    // must scale the remaining budget instead of resetting it. Step index is
    // out because a Quick Recap rebuild can add or drop beats ahead of the one
    // playing, which moves the surviving beat to another index; keyed by index
    // that remap looked like a different beat and restarted the image.
    //
    // The remap needs the carry slot as well as the identity key: the rebuild
    // and the remapping `seek` land in two separate commits, and in the one
    // between them the director still sees the old index — now pointing at some
    // other beat — so the running budget has to be parked under its own
    // identity until the seek arrives.
    const stepKey = `${journey.id}:${playbackStepIdentity(journey, step)}`;
    const resolved = resolvePlaybackTimerBudget({
      previousKey: timerStepKeyRef.current,
      nextKey: stepKey,
      current: timerFullDurationMsRef.current === null ? null : {
        remainingMs: timerRemainingMsRef.current ?? timerFullDurationMsRef.current,
        fullDurationMs: timerFullDurationMsRef.current,
      },
      nextFullDurationMs: fullDurationMs,
      carry: timerCarryRef.current,
      carryAllowed,
    });
    if (timerStepKeyRef.current !== stepKey) timerStartedAtMsRef.current = null;
    timerStepKeyRef.current = stepKey;
    timerRemainingMsRef.current = resolved.budget.remainingMs;
    timerFullDurationMsRef.current = resolved.budget.fullDurationMs;
    timerCarryRef.current = resolved.carry;

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
  }, [durationForStep, hold, journey, state.paused, step, transition]);

  // Reset when the journey changes.
  useEffect(() => {
    timerStepKeyRef.current = null;
    timerRemainingMsRef.current = null;
    timerFullDurationMsRef.current = null;
    timerStartedAtMsRef.current = null;
    timerCarryRef.current = null;
    pendingRemapSeekRef.current = false;
    setState(initialPlaybackState());
    setTempo(PLAYBACK_INITIAL_TEMPO);
  }, [journey?.id]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const phase: JourneyPlaybackPhase | undefined = state.phase;

  return {
    steps,
    stepIndex: state.stepIndex,
    step,
    plan,
    durationForStep,
    getTimerBudget,
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
