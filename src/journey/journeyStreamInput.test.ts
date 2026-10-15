import { describe, expect, it } from "vitest";
import { canStartStreamPointer, streamPointerHasLostCapture, streamSwipeDirection, STREAM_NATIVE_INPUT } from "./journeyStreamInput";

describe("Stream input ownership", () => {
  const valid = { isPrimary: true, button: 0, blocked: false, activePointerId: null };
  it("accepts only an unowned primary pointer", () => {
    expect(canStartStreamPointer(valid)).toBe(true);
    expect(canStartStreamPointer({ ...valid, activePointerId: 0 })).toBe(false);
    expect(canStartStreamPointer({ ...valid, activePointerId: 7 })).toBe(false);
    expect(canStartStreamPointer({ ...valid, isPrimary: false })).toBe(false);
    expect(canStartStreamPointer({ ...valid, button: 2 })).toBe(false);
    expect(canStartStreamPointer({ ...valid, blocked: true })).toBe(false);
  });
  it("ends claimed drags as soon as native capture is gone, but permits an unclaimed press", () => {
    expect(streamPointerHasLostCapture(false, false)).toBe(false);
    expect(streamPointerHasLostCapture(false, true)).toBe(false);
    expect(streamPointerHasLostCapture(true, true)).toBe(false);
    expect(streamPointerHasLostCapture(true, false)).toBe(true);
  });
  it("always leaves native media and editable controls to their own handlers", () => {
    expect(STREAM_NATIVE_INPUT.split(", ")).toEqual(expect.arrayContaining(["video", "audio", "input", "textarea", "select"]));
    expect(STREAM_NATIVE_INPUT).toContain("button:not([data-stream-shot])");
  });
  it("rejects taps, diagonal/vertical drags and every cancelled release", () => {
    expect(streamSwipeDirection(-100, 2, true, false)).toBe(1);
    expect(streamSwipeDirection(100, 2, true, false)).toBe(-1);
    for (const [dx, dy] of [[70, 0], [71, 70], [10, 200], [NaN, 0], [Infinity, 0]]) {
      expect(streamSwipeDirection(dx, dy, true, false)).toBeNull();
    }
    expect(streamSwipeDirection(-200, 0, false, false)).toBeNull();
    expect(streamSwipeDirection(-200, 0, true, true)).toBeNull();
    expect(streamSwipeDirection(200, 0, true, true)).toBeNull();
  });
});
