import { describe, expect, it } from "vitest";
import {
  consumePlaybackTimerBudget,
  replanPlaybackTimerBudget,
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
