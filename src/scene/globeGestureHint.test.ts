import { describe, expect, it } from "vitest";
import {
  GLOBE_GESTURE_HINT_DWELL_MS,
  globeGestureHintVisible,
  globeModeNoteVisible,
  initialGlobeGestureHintState,
  resolveGlobeGestureHint,
  type GlobeGestureHintSignal,
  type GlobeGestureHintState,
} from "./globeGestureHint";

function play(...signals: GlobeGestureHintSignal[]): GlobeGestureHintState {
  return signals.reduce(resolveGlobeGestureHint, initialGlobeGestureHintState);
}

const enter: GlobeGestureHintSignal = { kind: "focus-mode", active: true };
const leave: GlobeGestureHintSignal = { kind: "focus-mode", active: false };

describe("globe gesture hint lifecycle (#253)", () => {
  it("is absent until globe focus mode takes the viewport", () => {
    expect(globeGestureHintVisible(initialGlobeGestureHintState)).toBe(false);
  });

  it("arms on entering globe focus mode", () => {
    const state = play(enter);
    expect(globeGestureHintVisible(state)).toBe(true);
    expect(state.session).toBe(1);
  });

  it("dismisses on the first wheel or drag input", () => {
    const armed = play(enter);
    const dismissed = resolveGlobeGestureHint(armed, { kind: "gesture", session: armed.session });
    expect(globeGestureHintVisible(dismissed)).toBe(false);
    expect(dismissed.phase).toBe("dismissed");
  });

  it("dismisses on the declared dwell, with no animation event in the path", () => {
    const armed = play(enter);
    const dismissed = resolveGlobeGestureHint(armed, { kind: "dwell", session: armed.session });
    expect(globeGestureHintVisible(dismissed)).toBe(false);
    expect(GLOBE_GESTURE_HINT_DWELL_MS).toBeGreaterThan(0);
  });

  it("does not re-arm within the same session", () => {
    const dismissed = play(enter, { kind: "gesture", session: 1 });
    // A re-render republishing the entry signal must not resurrect the hint.
    const rerendered = resolveGlobeGestureHint(dismissed, enter);
    expect(rerendered).toBe(dismissed);
    expect(globeGestureHintVisible(rerendered)).toBe(false);
  });

  it("cannot be re-shown by a second gesture or dwell in the same session", () => {
    const dismissed = play(enter, { kind: "gesture", session: 1 });
    expect(resolveGlobeGestureHint(dismissed, { kind: "dwell", session: 1 })).toBe(dismissed);
    expect(resolveGlobeGestureHint(dismissed, { kind: "gesture", session: 1 })).toBe(dismissed);
  });

  it("arms again for the next visit, on a newer session token", () => {
    const second = play(enter, { kind: "gesture", session: 1 }, leave, enter);
    expect(globeGestureHintVisible(second)).toBe(true);
    expect(second.session).toBe(3);
  });

  it("ignores a dwell whose session token is older than the current visit", () => {
    const second = play(enter, leave, enter);
    const stale = resolveGlobeGestureHint(second, { kind: "dwell", session: 1 });
    expect(stale).toBe(second);
    expect(globeGestureHintVisible(stale)).toBe(true);
  });

  it("ignores a stale gesture, so a newer visit keeps its own state", () => {
    const second = play(enter, leave, enter);
    const stale = resolveGlobeGestureHint(second, { kind: "gesture", session: 1 });
    expect(globeGestureHintVisible(stale)).toBe(true);
  });

  it("cannot re-show a hint the newer visit already dismissed", () => {
    const dismissed = play(enter, leave, enter, { kind: "gesture", session: 3 });
    expect(resolveGlobeGestureHint(dismissed, { kind: "dwell", session: 1 })).toBe(dismissed);
    expect(globeGestureHintVisible(dismissed)).toBe(false);
  });

  it("keeps the ordinary Atlas guidance permanent, hint state notwithstanding", () => {
    // Owner review on PR 257: #253 owns the focus-mode composition only. The
    // ordinary surface must keep the line it has always shown next to its mode
    // chrome, whatever the transient resolver says.
    const ordinary = { globeFocusMode: false, showControls: true };
    expect(globeModeNoteVisible(initialGlobeGestureHintState, ordinary)).toBe(true);
    expect(globeModeNoteVisible(play(enter, { kind: "gesture", session: 1 }, leave), ordinary)).toBe(true);
    // Compact mobile has never rendered the mode chrome, and the note belongs
    // to it, so it stays absent there.
    expect(globeModeNoteVisible(initialGlobeGestureHintState, {
      globeFocusMode: false,
      showControls: false,
    })).toBe(false);
  });

  it("makes the focus-mode note follow the transient resolver alone", () => {
    // `showControls` is false in focus mode by the #253 contract, and the note
    // must still appear: the two levers are independent.
    const focus = { globeFocusMode: true, showControls: false };
    expect(globeModeNoteVisible(play(enter), focus)).toBe(true);
    expect(globeModeNoteVisible(play(enter, { kind: "dwell", session: 1 }), focus)).toBe(false);
    expect(globeModeNoteVisible(initialGlobeGestureHintState, focus)).toBe(false);
  });

  it("leaving focus mode retires the hint without arming anything", () => {
    const left = play(enter, leave);
    expect(globeGestureHintVisible(left)).toBe(false);
    expect(left.phase).toBe("idle");
    // Repeated exits are a no-op, so an effect republishing them cannot drift
    // the ordering token away from the timers still holding it.
    expect(resolveGlobeGestureHint(left, leave)).toBe(left);
  });
});
