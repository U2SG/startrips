import { describe, expect, it } from "vitest";
import {
  consumePlaybackTimerBudget,
  replanPlaybackTimerBudget,
  resolvePlaybackTimerBudget,
} from "./useJourneyPlaybackDirector";

describe("consumePlaybackTimerBudget (#126)", () => {
  it("subtracts only elapsed active time from the current step budget", () => {
    expect(consumePlaybackTimerBudget(4500, 1_000, 2_250)).toBe(3250);
  });

  it("never returns a negative remaining duration", () => {
    expect(consumePlaybackTimerBudget(900, 1_000, 2_500)).toBe(0);
  });

  it("ignores a backwards clock sample", () => {
    expect(consumePlaybackTimerBudget(1200, 2_000, 1_500)).toBe(1200);
  });
});


describe("replanPlaybackTimerBudget (#126)", () => {
  it("preserves elapsed progress when tempo changes during an active beat", () => {
    expect(replanPlaybackTimerBudget(1400, 2800, 1700)).toBe(850);
    expect(replanPlaybackTimerBudget(1400, 2800, 4500)).toBe(2250);
  });

  it("keeps completed beats completed and clamps invalid remaining input", () => {
    expect(replanPlaybackTimerBudget(0, 2800, 1700)).toBe(0);
    expect(replanPlaybackTimerBudget(4000, 2800, 1700)).toBe(1700);
  });

  it("falls back to the new duration when the previous budget is invalid", () => {
    expect(replanPlaybackTimerBudget(0, 0, 1700)).toBe(1700);
  });
});

describe("resolvePlaybackTimerBudget (#210)", () => {
  const beat = "j1:media:asset-a";
  const other = "j1:media:asset-b";

  it("scales the remaining budget when the same beat is re-resolved to a new length", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: beat,
      nextKey: beat,
      current: { remainingMs: 1400, fullDurationMs: 2800 },
      nextFullDurationMs: 1700,
      carry: null,
      carryAllowed: false,
    });
    expect(result.budget).toEqual({ remainingMs: 850, fullDurationMs: 1700 });
  });

  it("keeps the elapsed fraction when a rebuild moves the playing beat to another index", () => {
    // Frame 1: the rebuilt plan arrives before the remapping seek, so the old
    // index now addresses a different beat and parks the live budget.
    const parked = resolvePlaybackTimerBudget({
      previousKey: beat,
      nextKey: other,
      current: { remainingMs: 1400, fullDurationMs: 2800 },
      nextFullDurationMs: 3000,
      carry: null,
      carryAllowed: false,
    });
    expect(parked.budget).toEqual({ remainingMs: 3000, fullDurationMs: 3000 });
    expect(parked.carry).toEqual({ key: beat, remainingMs: 1400, fullDurationMs: 2800 });

    // Frame 2: the remap seek lands back on the same beat at its new index and
    // resumes it half-watched instead of restarting the image.
    const remapped = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: beat,
      current: parked.budget,
      nextFullDurationMs: 1700,
      carry: parked.carry,
      carryAllowed: true,
    });
    expect(remapped.budget).toEqual({ remainingMs: 850, fullDurationMs: 1700 });
    expect(remapped.carry).toBeNull();
  });

  it("starts fresh when the rebuild deleted the beat and playback lands on a neighbour", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: "j1:stop:point-2",
      current: { remainingMs: 3000, fullDurationMs: 3000 },
      nextFullDurationMs: 1700,
      carry: { key: beat, remainingMs: 1400, fullDurationMs: 2800 },
      carryAllowed: true,
    });
    expect(result.budget).toEqual({ remainingMs: 1700, fullDurationMs: 1700 });
  });

  it("restarts a beat the viewer seeks back to instead of resuming it", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: beat,
      current: { remainingMs: 3000, fullDurationMs: 3000 },
      nextFullDurationMs: 2800,
      carry: { key: beat, remainingMs: 1400, fullDurationMs: 2800 },
      carryAllowed: false,
    });
    expect(result.budget).toEqual({ remainingMs: 2800, fullDurationMs: 2800 });
  });

  it("starts the first beat of a run at its full duration", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: null,
      nextKey: beat,
      current: null,
      nextFullDurationMs: 2800,
      carry: null,
      carryAllowed: true,
    });
    expect(result.budget).toEqual({ remainingMs: 2800, fullDurationMs: 2800 });
    expect(result.carry).toBeNull();
  });
});
