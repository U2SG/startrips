import { describe, expect, it } from "vitest";
import {
  SOUNDTRACK_DUCK_ATTACK_MS,
  SOUNDTRACK_DUCK_FACTOR,
  SOUNDTRACK_DUCK_RELEASE_MS,
  shouldDuckSoundtrack,
  soundtrackDuckDecision,
  soundtrackRampGain,
  soundtrackRampMs,
  soundtrackTargetGain,
} from "./soundtrackDucking";

const audible = {
  foreground: true,
  playing: true,
  muted: false,
  ended: false,
  volume: 1,
};

describe("soundtrack ducking policy", () => {
  it("docks only for an audible foreground video", () => {
    expect(shouldDuckSoundtrack(audible)).toBe(true);
  });

  it("restores for every reason the video stops being the audible foreground", () => {
    expect(shouldDuckSoundtrack({ ...audible, playing: false })).toBe(false);
    expect(shouldDuckSoundtrack({ ...audible, muted: true })).toBe(false);
    expect(shouldDuckSoundtrack({ ...audible, ended: true })).toBe(false);
    expect(shouldDuckSoundtrack({ ...audible, volume: 0 })).toBe(false);
    // A video that is merely nearby is not foreground ownership.
    expect(shouldDuckSoundtrack({ ...audible, foreground: false })).toBe(false);
  });

  // A rejected play() leaves `playing` false, so the soundtrack cannot end up
  // parked at the ducked level with nothing audible to justify it.
  it("does not duck a video that never actually started", () => {
    expect(shouldDuckSoundtrack({ ...audible, playing: false, volume: 1 })).toBe(false);
  });

  it("docks relative to the member's volume and restores to it exactly", () => {
    expect(soundtrackTargetGain(0.8, true)).toBeCloseTo(0.8 * SOUNDTRACK_DUCK_FACTOR, 10);
    expect(soundtrackTargetGain(0.8, false)).toBe(0.8);
    expect(soundtrackTargetGain(0, true)).toBe(0);
    expect(soundtrackTargetGain(1, true)).toBe(SOUNDTRACK_DUCK_FACTOR);
  });

  it("uses the issue's ramp budget, and a slower ramp to restore", () => {
    expect(SOUNDTRACK_DUCK_ATTACK_MS).toBeGreaterThanOrEqual(150);
    expect(SOUNDTRACK_DUCK_ATTACK_MS).toBeLessThanOrEqual(300);
    expect(SOUNDTRACK_DUCK_RELEASE_MS).toBeGreaterThanOrEqual(300);
    expect(SOUNDTRACK_DUCK_RELEASE_MS).toBeLessThanOrEqual(600);
    expect(soundtrackRampMs(0.8, 0.24)).toBe(SOUNDTRACK_DUCK_ATTACK_MS);
    expect(soundtrackRampMs(0.24, 0.8)).toBe(SOUNDTRACK_DUCK_RELEASE_MS);
  });

  it("ramps between the endpoints without stepping", () => {
    const start = 1000;
    const duration = SOUNDTRACK_DUCK_ATTACK_MS;
    expect(soundtrackRampGain(0.8, 0.24, start, duration, start)).toBeCloseTo(0.8, 10);
    expect(soundtrackRampGain(0.8, 0.24, start, duration, start + duration / 2))
      .toBeCloseTo((0.8 + 0.24) / 2, 10);
    expect(soundtrackRampGain(0.8, 0.24, start, duration, start + duration)).toBeCloseTo(0.24, 10);
    // Past the end, and before the start, it holds the endpoints.
    expect(soundtrackRampGain(0.8, 0.24, start, duration, start + duration * 5)).toBeCloseTo(0.24, 10);
    expect(soundtrackRampGain(0.8, 0.24, start, duration, start - 500)).toBeCloseTo(0.8, 10);
    expect(soundtrackRampGain(0.8, 0.24, start, 0, start)).toBe(0.24);
  });

  // Rapid video A -> image -> video B: A's late pause/ended must not restore
  // the soundtrack while B owns the foreground.
  it("drops a decision from a superseded transport generation", () => {
    expect(soundtrackDuckDecision(4, 4, true)).toEqual({ generation: 4, ducking: true });
    expect(soundtrackDuckDecision(4, 3, false)).toBeNull();
    expect(soundtrackDuckDecision(4, 5, false)).toBeNull();
  });
});
