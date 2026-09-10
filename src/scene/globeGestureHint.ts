// #253: the zoom/drag guidance is onboarding copy, not permanent chrome. It
// arms once when globe focus mode takes the viewport, and the first real
// gesture — or a short dwell — retires it for that visit.
//
// Everything here is pure so the whole lifecycle is unit-testable: the React
// side owns only a timer and two event listeners, and asks this module what
// the answer is. `session` is the ordering token. It increments on every
// focus-mode transition, so a timer or a gesture that belonged to an earlier
// visit can never dismiss — or re-show — the state of a newer one.

/**
 * Transient-help dwell. Half of the atlas notice's own 8000ms dwell
 * (`LivingAtlasApp`), because a gesture hint carries no result the user has to
 * read and is normally retired by the very interaction it describes. The
 * dismissal is a state change on a timer, never an animation or
 * `transitionend` event, so reduced motion reaches the same end state.
 */
export const GLOBE_GESTURE_HINT_DWELL_MS = 4000;

export type GlobeGestureHintPhase = "idle" | "visible" | "dismissed";

export type GlobeGestureHintState = {
  /** Monotonic visit token. Bumped on entering *and* leaving focus mode. */
  session: number;
  phase: GlobeGestureHintPhase;
};

export type GlobeGestureHintSignal =
  /** Globe focus mode was entered (`active: true`) or left (`active: false`). */
  | { kind: "focus-mode"; active: boolean }
  /** The first wheel or drag input of `session`. */
  | { kind: "gesture"; session: number }
  /** The dwell for `session` elapsed. */
  | { kind: "dwell"; session: number };

export const initialGlobeGestureHintState: GlobeGestureHintState = {
  session: 0,
  phase: "idle",
};

export function resolveGlobeGestureHint(
  state: GlobeGestureHintState,
  signal: GlobeGestureHintSignal,
): GlobeGestureHintState {
  if (signal.kind === "focus-mode") {
    if (!signal.active) {
      // Leaving ends the visit. Bumping the token here is what makes a timer
      // still in flight from this visit structurally unable to speak for the
      // next one.
      if (state.phase === "idle") return state;
      return { session: state.session + 1, phase: "idle" };
    }
    // One arming per visit: a re-render that repeats the entry signal must not
    // resurrect a hint the user already dismissed.
    if (state.phase !== "idle") return state;
    return { session: state.session + 1, phase: "visible" };
  }

  // A stale gesture or dwell belongs to a visit that is already over.
  if (signal.session !== state.session) return state;
  if (state.phase !== "visible") return state;
  return { session: state.session, phase: "dismissed" };
}

export function globeGestureHintVisible(state: GlobeGestureHintState): boolean {
  return state.phase === "visible";
}

/**
 * #308: the gesture note has its own discoverability rule now that permanent
 * renderer-mode chrome is gone. Focus mode keeps #253's transient onboarding;
 * ordinary desktop keeps one quiet zoom/drag line; compact mobile stays clear
 * because pinch is native to that surface. This decision deliberately does not
 * derive from whether the separate detail-control cluster is mounted.
 */
export function globeModeNoteVisible(
  state: GlobeGestureHintState,
  composition: { globeFocusMode: boolean; compactMobileLayout: boolean },
): boolean {
  if (composition.globeFocusMode) return globeGestureHintVisible(state);
  return !composition.compactMobileLayout;
}
