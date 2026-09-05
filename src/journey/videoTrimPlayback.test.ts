import { describe, expect, it } from "vitest";
import {
  resolveVideoTrim,
  videoTrimEntryAction,
  videoTrimHoldsStep,
  videoTrimProgressAction,
  videoTrimSegmentDurationMs,
  VIDEO_TRIM_TOLERANCE_SECONDS,
} from "./videoTrimPlayback";

describe("trim-aware video playback contract (#195 Phase 2)", () => {
  it("resolves a source-bounded trim into the segment the element must play", () => {
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(resolved).toEqual({ kind: "trimmed", startSeconds: 1.2, endSeconds: 4.7 });
  });

  it("makes step accounting and real elapsed playback agree for a non-zero in-point", () => {
    const trim = { inMs: 1_200, outMs: 4_700 };
    const resolved = resolveVideoTrim(trim, 12);
    // The director's budget for the beat is `outMs - inMs`. The segment the
    // element actually plays must be the same number of milliseconds, or the
    // beat either truncates its tail or waits on a frame it already passed.
    expect(videoTrimSegmentDurationMs(resolved)).toBe(trim.outMs - trim.inMs);
  });

  it("holds the beat's budget whenever the segment is not progressing", () => {
    // The director spends the budget on the wall clock, so it may run only
    // while the element is really moving through the segment: not while it is
    // being seeked onto the in-point, and not while it is buffering — a timer
    // that kept counting against a stationary currentTime would skip most of a
    // 3.5 s beat before any fallback fired.
    expect(videoTrimHoldsStep("positioning")).toBe(true);
    expect(videoTrimHoldsStep("buffering")).toBe(true);
    expect(videoTrimHoldsStep("playing")).toBe(false);
    expect(videoTrimHoldsStep("unavailable")).toBe(false);
    expect(videoTrimHoldsStep(null)).toBe(false);
  });

  it("seeks to the in-point on entry and does nothing once inside the segment", () => {
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(videoTrimEntryAction(resolved, 0)).toEqual({ kind: "seek", toSeconds: 1.2 });
    expect(videoTrimEntryAction(resolved, 2.5)).toEqual({ kind: "none" });
  });

  it("repositions a re-entered beat whose element is already past the out-point", () => {
    // The step scrubber hands the director a fresh full budget while the
    // <video> keeps its React key and therefore its currentTime.
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(videoTrimEntryAction(resolved, 4.7)).toEqual({ kind: "seek", toSeconds: 1.2 });
    expect(videoTrimEntryAction(resolved, 9)).toEqual({ kind: "seek", toSeconds: 1.2 });
  });

  it("ends the step at the out-point instead of waiting for the source to end", () => {
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(videoTrimProgressAction(resolved, 3)).toEqual({ kind: "none" });
    expect(videoTrimProgressAction(resolved, 4.7)).toEqual({ kind: "complete" });
    expect(videoTrimProgressAction(resolved, 11.9)).toEqual({ kind: "complete" });
  });

  it("clamps playback that drifts before the in-point back into the segment", () => {
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(videoTrimProgressAction(resolved, 0.2)).toEqual({ kind: "seek", toSeconds: 1.2 });
    // Inside one tolerance of the in-point is inside the segment: a seek lands
    // on the nearest decodable frame, and re-seeking that would never settle.
    expect(videoTrimProgressAction(resolved, 1.2 - VIDEO_TRIM_TOLERANCE_SECONDS / 2))
      .toEqual({ kind: "none" });
  });

  it("clamps an out-point booked past the real source onto a reachable time", () => {
    // A video digest carries an analysis-pending duration today, so a plan can
    // book an out-point the element will never report.
    const resolved = resolveVideoTrim({ inMs: 500, outMs: 6_000 }, 3);
    expect(resolved).toEqual({ kind: "trimmed", startSeconds: 0.5, endSeconds: 3 });
    expect(videoTrimProgressAction(resolved, 3)).toEqual({ kind: "complete" });
  });

  it("degrades rather than stalls when the trim cannot be applied", () => {
    expect(resolveVideoTrim(null, 12)).toEqual({ kind: "untrimmed", reason: "no-trim" });
    expect(resolveVideoTrim({ inMs: 4_000, outMs: 1_000 }, 12))
      .toEqual({ kind: "untrimmed", reason: "no-trim" });
    // `duration` is NaN before metadata arrives and Infinity for a stream.
    expect(resolveVideoTrim({ inMs: 1_000, outMs: 4_000 }, Number.NaN))
      .toEqual({ kind: "untrimmed", reason: "unknown-source-duration" });
    expect(resolveVideoTrim({ inMs: 1_000, outMs: 4_000 }, Number.POSITIVE_INFINITY))
      .toEqual({ kind: "untrimmed", reason: "unknown-source-duration" });
    expect(resolveVideoTrim({ inMs: 1_000, outMs: 4_000 }, undefined))
      .toEqual({ kind: "untrimmed", reason: "unknown-source-duration" });
    // The in-point is past the end of the real media, so there is no segment to
    // reach; the beat plays the source and ends on `ended` as it did before.
    expect(resolveVideoTrim({ inMs: 9_000, outMs: 10_000 }, 3))
      .toEqual({ kind: "untrimmed", reason: "source-shorter-than-in-point" });
    // What is left of the segment is under one tolerance, so it is not a
    // segment the element can be positioned inside.
    expect(resolveVideoTrim({ inMs: 2_950, outMs: 10_000 }, 3))
      .toEqual({ kind: "untrimmed", reason: "source-shorter-than-in-point" });
  });

  it("takes no transport action at all for an untrimmed beat", () => {
    for (const sourceDuration of [12, Number.NaN]) {
      const resolved = resolveVideoTrim(null, sourceDuration);
      expect(videoTrimEntryAction(resolved, 0)).toEqual({ kind: "none" });
      expect(videoTrimProgressAction(resolved, 11.99)).toEqual({ kind: "none" });
      expect(videoTrimSegmentDurationMs(resolved)).toBeNull();
    }
  });
});
