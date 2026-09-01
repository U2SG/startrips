import { describe, expect, it } from "vitest";
import { consumePlaybackTimerBudget } from "./useJourneyPlaybackDirector";

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
