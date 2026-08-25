import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioSampler, type AudioEnergy } from "./audioSampler";
import {
  audioAtmosphereGains,
  readAudioAtmosphereEnergy,
  resetAudioAtmosphereEnergy,
  writeAudioAtmosphereEnergy,
} from "./audioAtmosphere";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAudioAtmosphereEnergy();
});

function installFakeAudioBrowser({
  hidden = false,
  throwContext = false,
}: {
  hidden?: boolean;
  throwContext?: boolean;
} = {}) {
  const analysisElement = {
    crossOrigin: null,
    preload: "",
    loop: false,
    src: "",
    currentTime: 0,
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLAudioElement;
  const sourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as MediaElementAudioSourceNode;
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 12,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getByteFrequencyData: vi.fn((data: Uint8Array<ArrayBuffer>) => data.fill(96)),
  } as unknown as AnalyserNode;
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as GainNode;
  const context = {
    destination: {},
    createAnalyser: vi.fn(() => analyser),
    createGain: vi.fn(() => gainNode),
    createMediaElementSource: vi.fn(() => sourceNode),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } as unknown as AudioContext;
  const AudioContextCtor = throwContext
    ? class {
      constructor() {
        throw new Error("NotAllowedError");
      }
    }
    : vi.fn(function FakeAudioContext() {
      return context;
    });
  vi.stubGlobal("window", {
    AudioContext: AudioContextCtor,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", {
    hidden,
    createElement: vi.fn(() => analysisElement),
  });
  return { analysisElement, analyser, context };
}

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
    installFakeAudioBrowser({ throwContext: true });
    const sampler = createAudioSampler();
    const element = {
      currentSrc: "https://media.example/soundtrack.mp3",
      src: "https://media.example/soundtrack.mp3",
      loop: true,
      currentTime: 0,
    } as HTMLAudioElement;
    expect(() => sampler.start(element)).not.toThrow();
    expect(sampler.isActive()).toBe(false);
  });

  it("reuses one CORS analysis source across pause/resume and decays energy", () => {
    vi.useFakeTimers();
    const { analysisElement, context } = installFakeAudioBrowser();
    const primary = {
      currentSrc: "https://media.example/soundtrack.mp3",
      src: "https://media.example/soundtrack.mp3",
      loop: true,
      currentTime: 12,
    } as HTMLAudioElement;
    const sampler = createAudioSampler();

    sampler.start(primary);
    sampler.start(primary);
    expect(sampler.isActive()).toBe(true);
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(analysisElement.crossOrigin).toBe("anonymous");
    expect(analysisElement.src).toBe(primary.currentSrc);

    sampler.setPlaying(true);
    vi.advanceTimersByTime(40);
    const playingEnergy = sampler.getEnergy().overall;
    expect(playingEnergy).toBeGreaterThan(0);

    sampler.setPlaying(false);
    expect(analysisElement.pause).toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(sampler.getEnergy().overall).toBeLessThan(playingEnergy);

    sampler.setPlaying(true);
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    sampler.stop();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does no analyser reads while the page is hidden", () => {
    vi.useFakeTimers();
    const { analyser } = installFakeAudioBrowser({ hidden: true });
    const primary = {
      currentSrc: "https://media.example/soundtrack.mp3",
      src: "https://media.example/soundtrack.mp3",
      loop: true,
      currentTime: 0,
    } as HTMLAudioElement;
    const sampler = createAudioSampler();
    sampler.start(primary);
    sampler.setPlaying(true);
    vi.advanceTimersByTime(400);
    expect(analyser.getByteFrequencyData).not.toHaveBeenCalled();
    sampler.stop();
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

  it("clamps the shared channel and caps visual gains at the restrained budget", () => {
    writeAudioAtmosphereEnergy({ low: 2, mid: 4, high: -3, overall: Number.NaN });
    expect(readAudioAtmosphereEnergy()).toEqual({
      low: 1,
      mid: 1,
      high: 0,
      overall: 0,
    });
    expect(audioAtmosphereGains({ low: 1, mid: 1, high: 1, overall: 1 })).toEqual({
      ambient: 1.12,
      halo: 1.15,
      route: 0.15,
    });
  });
});
