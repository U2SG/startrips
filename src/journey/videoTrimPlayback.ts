/**
 * #195 Phase 2 — the trim-aware video playback contract.
 *
 * The Edit Plan may declare that a video item plays a sub-range of its source
 * (`item.trim`). Before this module existed no playback path honoured that: the
 * `<video>` autoplayed from zero and the step ended either on the real `ended`
 * event or on the director's timer, which spends exactly `outMs - inMs`. With a
 * zero in-point those two agree by accident; with a non-zero in-point the step
 * would claim a later segment and play the opening one, which is why
 * `validateAutoEditPlanV1` rejected a non-zero in-point outright.
 *
 * The rules live here as pure functions rather than inside the overlay's event
 * handlers so the contract is testable in the default node environment: this
 * repo runs every test there and does not add a jsdom environment for one file.
 * The overlay owns the `HTMLVideoElement`; this module owns what to do with it.
 */

export type VideoTrimWindow = { inMs: number; outMs: number };

/**
 * Why a declared trim is not being applied to the element.
 *
 * These are degradations, not failures: each one falls back to the pre-#195
 * behaviour (play the source from its beginning, let the `ended` event or the
 * director's timer end the step) rather than stalling on a segment the element
 * cannot reach. `source-shorter-than-in-point` is the shape production has
 * today — a video digest carries `QUICK_RECAP_PENDING_VIDEO_DURATION_MS`
 * because no real duration is persisted yet, so a plan can book an in-point
 * past the real media.
 */
export type VideoTrimDegradeReason =
  | "no-trim"
  | "unknown-source-duration"
  | "source-shorter-than-in-point";

export type ResolvedVideoTrim =
  | { kind: "trimmed"; startSeconds: number; endSeconds: number }
  | { kind: "untrimmed"; reason: VideoTrimDegradeReason };

/**
 * The tolerance that keeps a `timeupdate` from fighting the element.
 *
 * `timeupdate` fires roughly every 250 ms and a seek lands on the nearest
 * decodable frame, so an exact comparison would either re-seek forever or miss
 * the out-point entirely. 120 ms is under one `timeupdate` interval and well
 * over a frame at any sane rate.
 */
export const VIDEO_TRIM_TOLERANCE_SECONDS = 0.12;

function isPlayableDuration(seconds: number | undefined): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

/**
 * What the declared trim means for this element, at this moment.
 *
 * `sourceDurationSeconds` is the element's own `duration`, which is `NaN`
 * before metadata arrives and `Infinity` for an open-ended stream; both resolve
 * to `unknown-source-duration`. The out-point is clamped to the real duration
 * so a plan booked against a pending duration still ends on a reachable time
 * instead of a time the element will never report.
 */
export function resolveVideoTrim(
  trim: VideoTrimWindow | null | undefined,
  sourceDurationSeconds: number | undefined,
): ResolvedVideoTrim {
  if (!trim) return { kind: "untrimmed", reason: "no-trim" };
  if (
    !Number.isFinite(trim.inMs)
    || !Number.isFinite(trim.outMs)
    || trim.inMs < 0
    || trim.outMs <= trim.inMs
  ) {
    return { kind: "untrimmed", reason: "no-trim" };
  }
  if (!isPlayableDuration(sourceDurationSeconds)) {
    return { kind: "untrimmed", reason: "unknown-source-duration" };
  }
  const startSeconds = trim.inMs / 1_000;
  if (startSeconds >= sourceDurationSeconds) {
    return { kind: "untrimmed", reason: "source-shorter-than-in-point" };
  }
  const endSeconds = Math.min(trim.outMs / 1_000, sourceDurationSeconds);
  if (endSeconds - startSeconds <= VIDEO_TRIM_TOLERANCE_SECONDS) {
    return { kind: "untrimmed", reason: "source-shorter-than-in-point" };
  }
  return { kind: "trimmed", startSeconds, endSeconds };
}

/**
 * How much of a video beat has played, over the stretch of the beat the plan
 * paid for: the trimmed segment when one resolved, the whole source otherwise.
 *
 * A video beat is owned by the element, not by the director's wall-clock
 * budget — the director holds while the video runs — so the element's own
 * position is the only honest source for that beat's share of the progress bar.
 */
function videoTrimPlayedBounds(
  resolved: ResolvedVideoTrim,
  sourceDurationSeconds: number | undefined,
): { startSeconds: number; endSeconds: number } | null {
  const bounds = resolved.kind === "trimmed"
    ? { startSeconds: resolved.startSeconds, endSeconds: resolved.endSeconds }
    : isPlayableDuration(sourceDurationSeconds)
      ? { startSeconds: 0, endSeconds: sourceDurationSeconds }
      : null;
  if (!bounds || bounds.endSeconds - bounds.startSeconds <= 0) return null;
  return bounds;
}

/**
 * Whether the element's position can be read as a share of this beat at all.
 *
 * `videoTrimPlayedFraction` answers `0` both for "at the very start" and for
 * "there is no span to measure against" — an untrimmed source whose `duration`
 * is still `NaN`, or a live stream reporting `Infinity`. The caller that takes
 * over a beat's transport position has to tell those apart: claiming a beat it
 * can only ever answer `0` for would pin the bar at that beat's start and, by
 * claiming it, stop the wall-clock write that would otherwise have moved it.
 */
export function videoTrimPositionKnown(
  resolved: ResolvedVideoTrim,
  sourceDurationSeconds: number | undefined,
): boolean {
  return videoTrimPlayedBounds(resolved, sourceDurationSeconds) !== null;
}

export function videoTrimPlayedFraction(
  resolved: ResolvedVideoTrim,
  currentTimeSeconds: number,
  sourceDurationSeconds: number | undefined,
): number {
  const bounds = videoTrimPlayedBounds(resolved, sourceDurationSeconds);
  if (!bounds || !Number.isFinite(currentTimeSeconds)) return 0;
  const spanSeconds = bounds.endSeconds - bounds.startSeconds;
  return Math.min(1, Math.max(0, (currentTimeSeconds - bounds.startSeconds) / spanSeconds));
}

export type VideoTrimAction =
  | { kind: "none" }
  | { kind: "seek"; toSeconds: number }
  | { kind: "complete" };

/**
 * How to position the element when the segment is entered.
 *
 * Entry happens on `loadedmetadata` and again whenever the viewer re-enters the
 * same video beat with the step scrubber: the range input seeks the *director*,
 * which hands the beat a fresh full budget, but the `<video>` keeps its React
 * key and therefore its `currentTime`. Without repositioning, a re-entered beat
 * would resume near — or past — its out-point while the timer paid for the
 * whole segment again.
 */
export function videoTrimEntryAction(
  resolved: ResolvedVideoTrim,
  currentTimeSeconds: number,
): VideoTrimAction {
  if (resolved.kind !== "trimmed") return { kind: "none" };
  const inSegment = currentTimeSeconds >= resolved.startSeconds - VIDEO_TRIM_TOLERANCE_SECONDS
    && currentTimeSeconds < resolved.endSeconds - VIDEO_TRIM_TOLERANCE_SECONDS;
  return inSegment ? { kind: "none" } : { kind: "seek", toSeconds: resolved.startSeconds };
}

/**
 * How to react to the element advancing inside the segment.
 *
 * Reaching the out-point ends the *step*, which is the half of acceptance 1
 * that replaces waiting for `ended`. Drifting before the in-point — a native
 * seek, a browser that rewound after a stall — clamps back into the segment
 * rather than letting playback escape it.
 */
export function videoTrimProgressAction(
  resolved: ResolvedVideoTrim,
  currentTimeSeconds: number,
): VideoTrimAction {
  if (resolved.kind !== "trimmed") return { kind: "none" };
  if (currentTimeSeconds >= resolved.endSeconds - VIDEO_TRIM_TOLERANCE_SECONDS) {
    return { kind: "complete" };
  }
  if (currentTimeSeconds < resolved.startSeconds - VIDEO_TRIM_TOLERANCE_SECONDS) {
    return { kind: "seek", toSeconds: resolved.startSeconds };
  }
  return { kind: "none" };
}

/** How long the trimmed segment actually plays for, in milliseconds. */
export function videoTrimSegmentDurationMs(resolved: ResolvedVideoTrim): number | null {
  if (resolved.kind !== "trimmed") return null;
  return Math.round((resolved.endSeconds - resolved.startSeconds) * 1_000);
}

/**
 * Whether the director's beat budget must not run right now.
 *
 * The budget is `outMs - inMs` of *played* segment, but the director spends it
 * on the wall clock, so it may only run while the element is actually moving
 * through the segment. It must not start before the element sits at the
 * in-point — a seek costs real time, and starting the timer at step entry would
 * spend part of the budget on the seek and truncate the tail — and it must stop
 * again whenever playback stops progressing, or a buffering video would be
 * skipped by a timer that kept counting against a stationary `currentTime`.
 * Both states are released on a bounded watchdog, so a source that never seeks
 * and a source that never resumes degrade instead of stalling.
 */
export type VideoTrimSeekStatus = "positioning" | "buffering" | "playing" | "unavailable";

export function videoTrimHoldsStep(status: VideoTrimSeekStatus | null): boolean {
  return status === "positioning" || status === "buffering";
}

/**
 * Whether a not-progressing signal means the segment stopped.
 *
 * `waiting` and `stalled` also fire around an ordinary pause and around the
 * refill that follows a resume, and a paused beat is not a stalled one — its
 * budget is already frozen by the pause. Only a beat that is supposed to be
 * moving can start buffering.
 */
export function videoTrimBuffersOnStall(
  status: VideoTrimSeekStatus | null,
  paused: boolean,
): boolean {
  return status === "playing" && !paused;
}

/**
 * The status a beat carries across a pause or a resume.
 *
 * A pause freezes the budget on its own, so carrying `buffering` through one
 * would hand the resumed beat an already-aged watchdog window for a stall that
 * may no longer exist. Resuming starts from `playing`; if the element really is
 * still refilling it says so again immediately, and the window then measures
 * the resume rather than the pause.
 */
export function videoTrimStatusAfterPauseChange(
  status: VideoTrimSeekStatus | null,
): VideoTrimSeekStatus | null {
  return status === "buffering" ? "playing" : status;
}

/**
 * Which beat a trim state belongs to.
 *
 * The state used to be keyed by `assetId` alone, which is enough only while no
 * two consecutive beats trim the same source. Highlight planning under #195
 * Phase 2 produces exactly that shape — several windows over one video — and
 * then a late `seeked`, `waiting` or watchdog settle from the previous beat
 * carries the same asset id as the new one and would settle it, releasing a
 * budget the new beat is still holding. The step index is what makes the newer
 * intent win.
 */
export function videoTrimSeekApplies(
  state: { assetId: string; stepIndex: number } | null | undefined,
  assetId: string,
  stepIndex: number,
): boolean {
  return !!state && state.assetId === assetId && state.stepIndex === stepIndex;
}
