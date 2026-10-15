import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Output } from "mediabunny";
import { prepareJourneyFilmSoundtrack } from "./journeyFilmSoundtrack";
import { FILM_AUDIO_BITRATE } from "./journeyFilmBudget";

type MockSample = {
  timestamp: number;
  numberOfFrames: number;
  sampleRate: number;
  readonly duration: number;
  close: ReturnType<typeof vi.fn>;
  trim: (first: number, last: number) => MockSample;
  setTimestamp: (timestamp: number) => void;
};

const fake = vi.hoisted(() => {
  const state = {
    sampleRate: 48_000,
    sampleFrames: [4800, 4800],
    start: 0,
    end: 0.2,
    hasTrack: true,
    decodable: true,
    onNext: null as (() => void | Promise<void>) | null,
    onAdd: null as (() => void | Promise<void>) | null,
    decoded: [] as MockSample[],
    trimmed: [] as MockSample[],
    added: [] as Array<{ timestamp: number; duration: number; frames: number }>,
    returns: [] as Array<ReturnType<typeof vi.fn>>,
    inputConstructed: vi.fn(),
    inputDisposed: vi.fn(),
    sourceConfig: vi.fn(),
    sourceClosed: vi.fn(),
    sampleRequests: vi.fn(),
    canEncodeAudio: vi.fn(async () => true),
    registerAacEncoder: vi.fn(),
  };
  function sample(timestamp: number, numberOfFrames: number, trimmed = false): MockSample {
    const value: MockSample = {
      timestamp, numberOfFrames, sampleRate: state.sampleRate,
      get duration() { return this.numberOfFrames / this.sampleRate; },
      close: vi.fn(),
      setTimestamp: (next) => { value.timestamp = next; },
      trim: (first, last) => sample(timestamp + first / state.sampleRate, last - first, true),
    };
    (trimmed ? state.trimmed : state.decoded).push(value);
    return value;
  }
  return Object.assign(state, { sample });
});

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class { constructor(readonly blob: Blob) {} },
  Input: class {
    constructor() { fake.inputConstructed(); }
    async getPrimaryAudioTrack() {
      return fake.hasTrack ? { canDecode: async () => fake.decodable, getFirstTimestamp: async () => fake.start } : null;
    }
    async computeDuration() { return fake.end; }
    dispose() { fake.inputDisposed(); }
  },
  AudioSampleSource: class {
    constructor(config: unknown) { fake.sourceConfig(config); }
    async add(value: MockSample) {
      fake.added.push({ timestamp: value.timestamp, duration: value.duration, frames: value.numberOfFrames });
      await fake.onAdd?.();
    }
    close() { fake.sourceClosed(); }
  },
  AudioSampleSink: class {
    samples(start: number, end: number) {
      fake.sampleRequests(start, end);
      let index = 0, frames = 0;
      const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
      fake.returns.push(returned);
      return {
        async next() {
          if (index >= fake.sampleFrames.length) return { done: true as const, value: undefined };
          const count = fake.sampleFrames[index++];
          const value = fake.sample(fake.start + frames / fake.sampleRate, count);
          frames += count;
          await fake.onNext?.();
          return { done: false as const, value };
        },
        return: returned,
        [Symbol.asyncIterator]() { return this; },
      };
    }
  },
  canEncodeAudio: fake.canEncodeAudio,
}));
vi.mock("@mediabunny/aac-encoder", () => ({ registerAacEncoder: fake.registerAacEncoder }));

beforeEach(() => {
  fake.sampleRate = 48_000; fake.sampleFrames = [4800, 4800];
  fake.start = 0; fake.end = 0.2; fake.hasTrack = true; fake.decodable = true;
  fake.onNext = null; fake.onAdd = null;
  fake.decoded.length = 0; fake.trimmed.length = 0; fake.added.length = 0; fake.returns.length = 0;
  for (const spy of [fake.inputConstructed, fake.inputDisposed, fake.sourceConfig, fake.sourceClosed,
    fake.sampleRequests, fake.registerAacEncoder]) spy.mockClear();
  fake.canEncodeAudio.mockReset().mockResolvedValue(true);
});

function outputFixture() {
  return { addAudioTrack: vi.fn() } as unknown as Output;
}

describe("bounded journey soundtrack timeline", () => {
  it("loops a short source in order and trims its final sample to the complete film end", async () => {
    const output = outputFixture();
    const soundtrack = await prepareJourneyFilmSoundtrack(new Blob(["audio"]), output, 0.55, new AbortController().signal);
    try {
      expect(output.addAudioTrack).toHaveBeenCalledOnce();
      expect(fake.canEncodeAudio).toHaveBeenCalledWith("aac", { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 });
      expect(fake.sourceConfig).toHaveBeenCalledWith({ codec: "aac", bitrate: FILM_AUDIO_BITRATE,
        transform: { numberOfChannels: 2, sampleRate: 48_000 } });
      await soundtrack.addUntil(0.05);
      expect(fake.added).toHaveLength(1); // only one decoded sample is admitted for this video step
      await soundtrack.addUntil(0.35);
      await soundtrack.addUntil(10); // target cannot extend past the film's 0.55-second end
      expect(fake.sampleRequests).toHaveBeenCalledTimes(3);
      expect(fake.added).toHaveLength(6);
      fake.added.forEach((item, index) => expect(item.timestamp).toBeCloseTo(index / 10, 10));
      expect(fake.added.at(-1)?.frames).toBe(2400);
      expect(fake.added.reduce((sum, item) => sum + item.frames, 0)).toBe(26_400);
      const last = fake.added.at(-1)!;
      expect(last.timestamp + last.duration).toBeCloseTo(0.55, 10);
      for (const sample of [...fake.decoded, ...fake.trimmed]) expect(sample.close).toHaveBeenCalledOnce();
      soundtrack.close();
      expect(fake.sourceClosed).toHaveBeenCalledOnce();
    } finally { await soundtrack.dispose(); }
    await soundtrack.dispose();
    expect(fake.inputDisposed).toHaveBeenCalledOnce();
    expect(fake.returns.at(-1)).toHaveBeenCalledOnce();
  });

  it("finishes an 8 kHz source at a fractional 902/30-second film end without an empty-loop error", async () => {
    fake.sampleRate = 8000; fake.sampleFrames = [8000]; fake.end = 1;
    const duration = 902 / 30;
    const soundtrack = await prepareJourneyFilmSoundtrack(new Blob(["audio"]), outputFixture(), duration, new AbortController().signal);
    try {
      await soundtrack.addUntil(duration);
      expect(fake.added.reduce((sum, item) => sum + item.frames, 0)).toBe(Math.round(duration * fake.sampleRate));
      const last = fake.added.at(-1)!;
      expect(Math.abs(last.timestamp + last.duration - duration)).toBeLessThanOrEqual(0.5 / fake.sampleRate);
      expect(fake.sampleRequests.mock.calls.length).toBeLessThanOrEqual(32);
      const count = fake.added.length;
      await soundtrack.addUntil(duration + 1);
      expect(fake.added).toHaveLength(count);
      for (const sample of [...fake.decoded, ...fake.trimmed]) expect(sample.close).toHaveBeenCalledOnce();
    } finally { await soundtrack.dispose(); }
  });

  it.each(["next", "add"])("closes owned samples and rejects cancellation during the final awaited %s", async (stage) => {
    const controller = new AbortController();
    const soundtrack = await prepareJourneyFilmSoundtrack(new Blob(["audio"]), outputFixture(), 0.1, controller.signal);
    if (stage === "next") fake.onNext = () => controller.abort();
    else fake.onAdd = () => controller.abort();
    try {
      await expect(soundtrack.addUntil(0.1)).rejects.toMatchObject({ name: "AbortError" });
      expect(fake.decoded).toHaveLength(1);
      expect(fake.trimmed).toHaveLength(stage === "add" ? 1 : 0);
      for (const sample of [...fake.decoded, ...fake.trimmed]) expect(sample.close).toHaveBeenCalledOnce();
    } finally { await soundtrack.dispose(); }
    expect(fake.inputDisposed).toHaveBeenCalled();
    expect(fake.returns.at(-1)).toHaveBeenCalledOnce();
  });

  it("refuses an empty decoded source instead of silently emitting an audio track", async () => {
    fake.sampleFrames = [];
    const soundtrack = await prepareJourneyFilmSoundtrack(new Blob(["audio"]), outputFixture(), 1, new AbortController().signal);
    try {
      await expect(soundtrack.addUntil(1)).rejects.toThrow("journey_film_soundtrack_unsupported");
      expect(fake.added).toEqual([]);
      expect(fake.sampleRequests).toHaveBeenCalledOnce();
    } finally { await soundtrack.dispose(); }
    expect(fake.inputDisposed).toHaveBeenCalledOnce();
  });

  it.each(["missing track", "undecodable", "zero duration", "nonfinite duration"])("fails closed for %s", async (kind) => {
    if (kind === "missing track") fake.hasTrack = false;
    if (kind === "undecodable") fake.decodable = false;
    if (kind === "zero duration") fake.end = 0;
    if (kind === "nonfinite duration") fake.end = Number.NaN;
    const output = outputFixture();
    await expect(prepareJourneyFilmSoundtrack(new Blob(["audio"]), output, 1, new AbortController().signal))
      .rejects.toThrow("journey_film_soundtrack_unsupported");
    expect(output.addAudioTrack).not.toHaveBeenCalled();
    expect(fake.inputDisposed).toHaveBeenCalledOnce();
  });

  it("does not construct a decoder for an already-aborted export", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareJourneyFilmSoundtrack(new Blob(["audio"]), outputFixture(), 1, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fake.inputConstructed).not.toHaveBeenCalled();
  });

  it("registers the pinned AAC fallback only when native AAC is unavailable", async () => {
    fake.canEncodeAudio.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const soundtrack = await prepareJourneyFilmSoundtrack(new Blob(["audio"]), outputFixture(), 1, new AbortController().signal);
    try {
      expect(fake.registerAacEncoder).toHaveBeenCalledOnce();
      expect(fake.canEncodeAudio).toHaveBeenCalledTimes(2);
      expect(fake.sourceConfig).toHaveBeenCalledOnce();
    } finally { await soundtrack.dispose(); }
  });
});
