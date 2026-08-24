// #20 Audio-reactive atmosphere — a lightweight Web Audio energy sampler.
//
// One hidden <audio> element, one MediaElementAudioSourceNode (a media
// element can only be source'd once), an AnalyserNode, and a 30fps sampler
// that aggregates low/mid/high/overall energy with attack/release smoothing.
// The visual layers read energy values imperatively (CSS custom properties /
// refs) — never through per-frame React state.
//
// Degradation contract: if the analyser cannot be built (CORS, no AudioContext,
// the element already has a source), playback continues and the consumer
// falls back to the #7 CSS-only animation.

export type AudioEnergy = {
  low: number;
  mid: number;
  high: number;
  overall: number;
};

export type AudioSampler = {
  /** The smoothed energy of the last sample. */
  getEnergy(): AudioEnergy;
  /** Whether energy sampling is live (analyser built successfully). */
  isActive(): boolean;
  /** Start sampling; `element` must be the soundtrack <audio>. */
  start(element: HTMLAudioElement): void;
  /** Stop sampling and release the AudioContext; safe to call repeatedly. */
  stop(): void;
};

const SAMPLE_INTERVAL_MS = 33; // ~30fps
const FFT_SIZE = 1024;
const ATTACK_FACTOR = 0.4;
const RELEASE_FACTOR = 0.08;

function createSampler(): AudioSampler {
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let data: Uint8Array<ArrayBuffer> | null = null;
  let timer = 0;
  let active = false;
  // Current smoothed energy (0..1, clamped to a small visual range).
  let low = 0;
  let mid = 0;
  let high = 0;
  let overall = 0;

  const smooth = (raw: number, current: number) => {
    const factor = raw > current ? ATTACK_FACTOR : RELEASE_FACTOR;
    return current + (raw - current) * factor;
  };

  const sample = () => {
    if (!analyser || !data) return;
    analyser.getByteFrequencyData(data);
    const binCount = data.length;
    const lowEnd = Math.floor(binCount * 0.3);
    const midEnd = Math.floor(binCount * 0.65);
    const lowSum = average(data, 0, lowEnd);
    const midSum = average(data, lowEnd, midEnd);
    const highSum = average(data, midEnd, binCount);
    // Normalize to 0..1 (byte data is 0..255) then compress into a small
    // visual range so music never makes the whole page flash.
    const rawLow = normalize(lowSum);
    const rawMid = normalize(midSum);
    const rawHigh = normalize(highSum);
    low = smooth(rawLow, low);
    mid = smooth(rawMid, mid);
    high = smooth(rawHigh, high);
    overall = smooth((rawLow + rawMid + rawHigh) / 3, overall);
  };

  const tick = () => {
    if (!active) return;
    sample();
    timer = window.setTimeout(tick, SAMPLE_INTERVAL_MS);
  };

  return {
    getEnergy() {
      return { low, mid, high, overall };
    },
    isActive() {
      return active;
    },
    start(element) {
      if (active) return;
      try {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const newContext = new Ctor();
        const newAnalyser = newContext.createAnalyser();
        newAnalyser.fftSize = FFT_SIZE;
        const source = newContext.createMediaElementSource(element);
        source.connect(newAnalyser);
        newAnalyser.connect(newContext.destination);
        context = newContext;
        analyser = newAnalyser;
        data = new Uint8Array(newAnalyser.frequencyBinCount);
        active = true;
        tick();
      } catch {
        // CORS or unsupported: playback continues, sampling stays off and the
        // consumer falls back to the CSS-only playing animation.
        active = false;
      }
    },
    stop() {
      active = false;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      if (context) {
        void context.close().catch(() => undefined);
        context = null;
      }
      analyser = null;
      data = null;
      low = mid = high = overall = 0;
    },
  };
}

function average(data: Uint8Array<ArrayBuffer>, start: number, end: number) {
  const count = Math.max(1, end - start);
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += data[index];
  return sum / count;
}

function normalize(value: number) {
  return Math.min(1, Math.max(0, value / 255));
}

export function createAudioSampler(): AudioSampler {
  return createSampler();
}

/** Create one sampler per soundtrack element (shared across consumers). */
export function createSoundtrackSampler(): AudioSampler {
  return createSampler();
}
