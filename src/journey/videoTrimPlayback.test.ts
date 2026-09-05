import { describe, expect, it } from "vitest";
import {
  resolveVideoTrim,
  videoTrimBuffersOnStall,
  videoTrimStatusAfterPauseChange,
  videoTrimEntryAction,
  videoTrimHoldsStep,
  videoTrimPlayedFraction,
  videoTrimPositionKnown,
  videoTrimProgressAction,
  videoTrimSeekApplies,
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

  it("treats a not-progressing signal as a stall only while the beat is meant to play", () => {
    // `waiting` and `stalled` also fire around a pause and around the refill
    // that follows a resume. A paused beat's budget is already frozen, so
    // calling that a stall would arm the escape watchdog against a beat that is
    // playing correctly.
    expect(videoTrimBuffersOnStall("playing", false)).toBe(true);
    expect(videoTrimBuffersOnStall("playing", true)).toBe(false);
    expect(videoTrimBuffersOnStall("positioning", false)).toBe(false);
    expect(videoTrimBuffersOnStall("buffering", false)).toBe(false);
    expect(videoTrimBuffersOnStall("unavailable", false)).toBe(false);
    expect(videoTrimBuffersOnStall(null, false)).toBe(false);
  });

  it("never carries a buffering beat across a pause or a resume", () => {
    // Resuming starts from `playing`; a stall that is still real re-reports
    // itself at once, and the watchdog window then measures the resume rather
    // than the length of the pause.
    expect(videoTrimStatusAfterPauseChange("buffering")).toBe("playing");
    expect(videoTrimStatusAfterPauseChange("playing")).toBe("playing");
    expect(videoTrimStatusAfterPauseChange("positioning")).toBe("positioning");
    expect(videoTrimStatusAfterPauseChange("unavailable")).toBe("unavailable");
    expect(videoTrimStatusAfterPauseChange(null)).toBeNull();
  });

  it("keeps a paused and resumed beat inside its segment", () => {
    // Pause freezes the element where it stands, so resume re-enters from the
    // same position and the entry rule leaves it alone: no seek, no restart,
    // and the remaining budget is what is left of the segment.
    const resolved = resolveVideoTrim({ inMs: 1_200, outMs: 4_700 }, 12);
    expect(videoTrimEntryAction(resolved, 2.5)).toEqual({ kind: "none" });
    expect(videoTrimProgressAction(resolved, 2.5)).toEqual({ kind: "none" });
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

  it("lets the newer beat win when two consecutive beats trim the same source", () => {
    // Highlight planning under #195 Phase 2 emits several windows over one
    // video, so `assetId` alone stops identifying a beat. A settle computed for
    // step 3 must not land on the beat that is now at step 4, or a late
    // `seeked` from the previous window would release a budget the current one
    // is still holding.
    const beat = { assetId: "asset-a", stepIndex: 3 };
    expect(videoTrimSeekApplies(beat, "asset-a", 3)).toBe(true);
    expect(videoTrimSeekApplies(beat, "asset-a", 4)).toBe(false);
    expect(videoTrimSeekApplies(beat, "asset-b", 3)).toBe(false);
    expect(videoTrimSeekApplies(null, "asset-a", 3)).toBe(false);
    expect(videoTrimSeekApplies(undefined, "asset-a", 3)).toBe(false);
  });

  it("keeps `unavailable` terminal for every event that could re-seek the beat", () => {
    // `loadedmetadata` and `seeked` both re-run the entry rule, so both are
    // bounded by the holding states: once the watchdog has given up, the beat
    // is on `ended` ownership and a native scrub must not quietly take it back.
    expect(videoTrimHoldsStep("positioning")).toBe(true);
    expect(videoTrimHoldsStep("buffering")).toBe(true);
    expect(videoTrimHoldsStep("playing")).toBe(false);
    expect(videoTrimHoldsStep("unavailable")).toBe(false);
    expect(videoTrimHoldsStep(null)).toBe(false);
  });
});

describe("videoTrimPlayedFraction (#126)", () => {
  it("measures an untrimmed beat against the whole source", () => {
    const untrimmed = resolveVideoTrim(null, 12);
    expect(videoTrimPlayedFraction(untrimmed, 0, 12)).toBe(0);
    expect(videoTrimPlayedFraction(untrimmed, 3, 12)).toBe(0.25);
    expect(videoTrimPlayedFraction(untrimmed, 12, 12)).toBe(1);
  });

  it("measures a trimmed beat against the segment the plan paid for", () => {
    const trimmed = resolveVideoTrim({ inMs: 4_000, outMs: 8_000 }, 12);
    expect(trimmed.kind).toBe("trimmed");
    expect(videoTrimPlayedFraction(trimmed, 4, 12)).toBe(0);
    expect(videoTrimPlayedFraction(trimmed, 6, 12)).toBe(0.5);
    expect(videoTrimPlayedFraction(trimmed, 8, 12)).toBe(1);
    // Outside the segment the beat still owns only its own stretch of the bar.
    expect(videoTrimPlayedFraction(trimmed, 1, 12)).toBe(0);
    expect(videoTrimPlayedFraction(trimmed, 11.5, 12)).toBe(1);
  });

  it("stays at the beat's start when the source duration is not known yet", () => {
    const pending = resolveVideoTrim(null, Number.NaN);
    expect(videoTrimPlayedFraction(pending, 3, Number.NaN)).toBe(0);
    expect(videoTrimPlayedFraction(pending, 3, Number.POSITIVE_INFINITY)).toBe(0);
    expect(videoTrimPlayedFraction(pending, Number.NaN, 12)).toBe(0);
  });

  it("separates a measurable beat from one whose zero is only ignorance", () => {
    // The two cases above both answer `0`, and the transport has to tell them
    // apart: it takes over a beat's bar position only when the element's
    // position can actually move it, and leaves the wall-clock write in charge
    // otherwise.
    expect(videoTrimPositionKnown(resolveVideoTrim(null, 12), 12)).toBe(true);
    expect(videoTrimPositionKnown(resolveVideoTrim({ inMs: 4_000, outMs: 8_000 }, 12), 12)).toBe(true);
    expect(videoTrimPositionKnown(resolveVideoTrim(null, Number.NaN), Number.NaN)).toBe(false);
    expect(videoTrimPositionKnown(
      resolveVideoTrim(null, Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    )).toBe(false);
    expect(videoTrimPositionKnown(resolveVideoTrim(null, 0), 0)).toBe(false);
  });
});
