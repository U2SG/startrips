import { describe, expect, it } from "vitest";
import { nextMobileSurfaceHistoryWrite } from "./useMobileSurfaceHistory";

describe("mobile surface history replacement", () => {
  it("replaces the stale Story token instead of burying a ghost Story under Share", () => {
    const result = nextMobileSurfaceHistoryWrite(["journey-story:1"], new Set(), "journey-share:2");
    expect(result).toEqual({ mode: "replace", stack: ["journey-share:2"] });
  });

  it("preserves an active parent while replacing a contiguous stale child suffix", () => {
    const result = nextMobileSurfaceHistoryWrite(
      ["journey-sheet:1", "journey-story:2", "story-media-surface:3"],
      new Set(["journey-sheet:1"]),
      "journey-share:4",
    );
    expect(result).toEqual({
      mode: "replace",
      stack: ["journey-sheet:1", "journey-share:4"],
    });
  });

  it("pushes when the current top surface is still active", () => {
    const result = nextMobileSurfaceHistoryWrite(
      ["journey-story:1"],
      new Set(["journey-story:1"]),
      "story-media-surface:2",
    );
    expect(result).toEqual({
      mode: "push",
      stack: ["journey-story:1", "story-media-surface:2"],
    });
  });
});
