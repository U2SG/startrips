import { describe, expect, it } from "vitest";
import { isMediaSwipeIntent, nextMediaSwipeVelocity, shouldCommitMediaSwipe } from "./mediaSwipeDecision";

describe("mobile media swipe decision", () => {
  it("commits a deliberate distance drag", () => {
    expect(shouldCommitMediaSwipe(-48, -0.1, true)).toBe(true);
    expect(shouldCommitMediaSwipe(72, 0.05, true)).toBe(true);
  });

  it("commits a short fast flick in the same direction", () => {
    expect(shouldCommitMediaSwipe(-40, -0.8, true)).toBe(true);
    expect(shouldCommitMediaSwipe(38, 0.7, true)).toBe(true);
  });

  it("does not treat slow jitter or contradictory velocity as a swipe", () => {
    expect(isMediaSwipeIntent(30, 1.2)).toBe(false);
    expect(isMediaSwipeIntent(40, 0.2)).toBe(false);
    expect(isMediaSwipeIntent(40, -0.8)).toBe(false);
  });

  it("expires stale flick velocity before blending a delayed sample", () => {
    const velocity = nextMediaSwipeVelocity(2, 1, 100);
    expect(velocity).toBeCloseTo(0.01);
    expect(shouldCommitMediaSwipe(41, velocity, true)).toBe(false);
  });

  it("keeps edge flicks as swipe intent without committing a missing neighbor", () => {
    expect(isMediaSwipeIntent(-40, -0.8)).toBe(true);
    expect(shouldCommitMediaSwipe(-40, -0.8, false)).toBe(false);
  });
});
