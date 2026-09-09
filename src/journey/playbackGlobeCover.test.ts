import { describe, expect, it } from "vitest";
import { playbackGlobeCoverState } from "./playbackGlobeCover";

describe("playbackGlobeCoverState", () => {
  it("keeps every globe-visible cinematic phase rendering", () => {
    for (const phase of ["intro", "travel", "stop", "outro"] as const) {
      expect(playbackGlobeCoverState(phase, false)).toEqual({
        opaqueMediaCover: false,
        coverTransitionActive: false,
      });
    }
  });

  it("treats media as a cover only after its existing presentation handoff settles", () => {
    expect(playbackGlobeCoverState("media", true)).toEqual({
      opaqueMediaCover: true,
      coverTransitionActive: true,
    });
    expect(playbackGlobeCoverState("media", false)).toEqual({
      opaqueMediaCover: true,
      coverTransitionActive: false,
    });
  });
});
