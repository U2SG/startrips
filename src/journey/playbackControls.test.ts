import { describe, expect, it } from "vitest";
import { playbackControlsMayAutoHide } from "./playbackControls";

describe("playbackControlsMayAutoHide (#126)", () => {
  it("keeps controls visible while playback is paused", () => {
    expect(playbackControlsMayAutoHide({
      paused: true,
      keyboardNavigation: false,
      focusWithinOverlay: false,
    })).toBe(false);
  });

  it("keeps focused playback controls visible for keyboard navigation", () => {
    expect(playbackControlsMayAutoHide({
      paused: false,
      keyboardNavigation: true,
      focusWithinOverlay: true,
    })).toBe(false);
  });

  it("allows idle fade after pointer/touch activity even if programmatic focus remains", () => {
    expect(playbackControlsMayAutoHide({
      paused: false,
      keyboardNavigation: false,
      focusWithinOverlay: true,
    })).toBe(true);
  });

  it("allows idle fade once keyboard focus leaves the overlay", () => {
    expect(playbackControlsMayAutoHide({
      paused: false,
      keyboardNavigation: true,
      focusWithinOverlay: false,
    })).toBe(true);
  });
});
