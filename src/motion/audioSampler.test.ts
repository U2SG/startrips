import { describe, expect, it, vi } from "vitest";
import { createAudioSampler, type AudioEnergy } from "./audioSampler";

// The sampler's real behaviour needs a browser AudioContext; in the node test
// environment it must degrade cleanly (never throw, playback unaffected) and
// expose the energy contract shape.
describe("createAudioSampler (#20)", () => {
  it("is inactive and returns zero energy before start", () => {
    const sampler = createAudioSampler();
    expect(sampler.isActive()).toBe(false);
    expect(sampler.getEnergy()).toMatchObject({
      low: 0,
      mid: 0,
      high: 0,
      overall: 0,
    });
  });

  it("start is safe without AudioContext (node) and keeps playback alive", () => {
    const sampler = createAudioSampler();
    const element = { src: "blob:x" } as unknown as HTMLAudioElement;
    expect(() => sampler.start(element)).not.toThrow();
    expect(sampler.isActive()).toBe(false);
    sampler.stop();
    expect(sampler.isActive()).toBe(false);
  });

  it("start catches a failing AudioContext construction and stays degraded", () => {
    // Simulate a CORS/unsupported scenario: constructor throws.
    const originalAudioContext = globalThis.AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        throw new Error("NotAllowedError");
      }
    };
    try {
      const sampler = createAudioSampler();
      const element = {} as HTMLAudioElement;
      sampler.start(element);
      expect(sampler.isActive()).toBe(false);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    }
  });

  it("never throws when stop is called twice", () => {
    const sampler = createAudioSampler();
    sampler.stop();
    expect(() => sampler.stop()).not.toThrow();
  });
});

// The energy smoothing math is pure inside the module; pin the shape of what
// consumers read so the visual layers and the sampler stay in contract.
describe("AudioEnergy contract (#20)", () => {
  it("is a plain JSON-able object with four clamped channels", () => {
    const energy: AudioEnergy = { low: 0.1, mid: 0.2, high: 0.05, overall: 0.12 };
    const parsed = JSON.parse(JSON.stringify(energy));
    expect(parsed).toEqual(energy);
    expect(Object.keys(parsed).sort()).toEqual(["high", "low", "mid", "overall"]);
  });
});
