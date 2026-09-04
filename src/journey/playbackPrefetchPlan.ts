// #197 tempo-aware Journey Playback prefetch planner.
//
// Playback Tempo changed how fast the player consumes media without changing
// how far ahead the overlay prepared it, so `fast` reached undecoded assets
// sooner than `standard`. The answer is a lookahead expressed in seconds of
// prepared playback rather than a fixed asset count.
//
// This module is pure: it never resolves a duration itself. The caller passes
// the durations the Playback director already resolves for the active plan and
// tempo, so Full Playback and Quick Recap plan their prefetch against the beats
// they actually play — there is no second timing model here.

import { PLAYBACK_TEMPO_PROFILES, type PlaybackTempo } from "./journeyPlaybackPlan";

/**
 * Hard ceiling on assets in one window, independent of the time budget.
 *
 * The budget alone cannot bound the walk: a run of zero-duration steps would
 * accumulate nothing and reach the end of the Journey. This keeps the window a
 * provable constant — and therefore the concurrent signed-read count too.
 */
export const MAX_PREFETCH_ASSETS = 8;

/**
 * Seconds of prepared playback the window aims to hold ahead of the current
 * step, per tempo.
 *
 * Derived from the tempo profiles rather than a table of its own: one beat of
 * the slowest tempo is the decode headroom every tempo needs, widened by
 * exactly how much faster this tempo consumes an image beat. That makes `fast`
 * prepare farther ahead in time *and* cover more assets, while `immersive`
 * stays at roughly today's current + next.
 */
export function readyMsAheadForTempo(tempo: PlaybackTempo): number {
  const slowestImageMs = PLAYBACK_TEMPO_PROFILES.immersive.imageMs;
  const imageMs = PLAYBACK_TEMPO_PROFILES[tempo].imageMs;
  return Math.max(imageMs, 2 * slowestImageMs - imageMs);
}

export type PlaybackPrefetchWindow = {
  /** Ordered, de-duplicated media asset ids to read and decode ahead. */
  assetIds: string[];
  /**
   * Playback time covered by the steps after the current one.
   *
   * This never exceeds `budgetMs`, except when reaching the next step that
   * displays an asset at all costs more than the budget — that step is always
   * covered, because it is the next thing the viewer sees and the director
   * holds on it.
   */
  coveredDurationMs: number;
  /** Last step index the window covers; equals `stepIndex` for an empty walk. */
  lastStepIndex: number;
};

/**
 * Walk forward from `stepIndex`, admitting steps while their accumulated
 * duration fits inside `budgetMs`, and return the media assets those steps
 * display.
 *
 * The window is derived only from `stepIndex`, so a seek, next or back yields a
 * window for the new position with no cancellation bookkeeping: the old window
 * simply stops being produced.
 */
export function planPrefetchWindow(input: {
  stepCount: number;
  stepIndex: number;
  budgetMs: number;
  durationForStep: (stepIndex: number) => number;
  assetIdsForStep: (stepIndex: number) => readonly string[];
  maxAssets?: number;
}): PlaybackPrefetchWindow {
  const { stepCount, stepIndex, budgetMs, durationForStep, assetIdsForStep } = input;
  const maxAssets = Math.max(1, input.maxAssets ?? MAX_PREFETCH_ASSETS);
  const empty: PlaybackPrefetchWindow = {
    assetIds: [],
    coveredDurationMs: 0,
    lastStepIndex: stepIndex,
  };
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= stepCount) return empty;

  const assetIds: string[] = [];
  const seen = new Set<string>();
  const collect = (ids: readonly string[]) => {
    for (const id of ids) {
      if (assetIds.length >= maxAssets) return;
      if (seen.has(id)) continue;
      seen.add(id);
      assetIds.push(id);
    }
  };

  // The current step's asset is the display target, not lookahead: it is
  // prepared whatever the budget says.
  collect(assetIdsForStep(stepIndex));

  let coveredDurationMs = 0;
  let lastStepIndex = stepIndex;
  let reachedAssetAhead = false;
  for (let index = stepIndex + 1; index < stepCount; index += 1) {
    if (assetIds.length >= maxAssets) break;
    const stepAssetIds = assetIdsForStep(index);
    const stepMs = Math.max(0, durationForStep(index));
    const fitsBudget = coveredDurationMs + stepMs <= budgetMs;
    // The next step that shows an asset is always reached, even when the beats
    // in between are longer than the whole budget: the director holds on that
    // asset, so leaving it unread would stall playback rather than pace it.
    const reachesNextAsset = !reachedAssetAhead && stepAssetIds.length > 0;
    if (!fitsBudget && !reachesNextAsset) break;
    coveredDurationMs += stepMs;
    lastStepIndex = index;
    if (stepAssetIds.length > 0) {
      reachedAssetAhead = true;
      collect(stepAssetIds);
    }
  }

  return { assetIds, coveredDurationMs, lastStepIndex };
}
