// #20 Audio-reactive atmosphere — a lightweight Web Audio energy sampler.
//
// The real hidden <audio> remains untouched and is always the playback source.
// Analysis uses one silent CORS-enabled clone plus one MediaElementAudioSource
// per sampler lifetime, so a bucket CORS failure can only disable atmosphere —
// it can never break the soundtrack itself. Sampling runs at ~30fps with
// attack/release smoothing and no per-frame React state.

export type AudioEnergy = {
  low: number;
  mid: number;
  high: number;
  overall: number;
};

export type AudioSampler = {
  getEnergy(): AudioEnergy;
  isActive(): boolean;
  /** Build/reuse the analyser graph for this exact soundtrack element. */
  start(element: HTMLAudioElement): void;
  /** Toggle real sampling; false decays the current energy smoothly to zero. */
  setPlaying(playing: boolean): void;
  /** Final teardown for this element/context. */
  stop(): void;
};

const SAMPLE_INTERVAL_MS = 33;
const HIDDEN_INTERVAL_MS = 500;
const FFT_SIZE = 1024;
const ATTACK_FACTOR = 0.4;
const RELEASE_FACTOR = 0.08;

function createSampler(): AudioSampler {
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceNode: MediaElementAudioSourceNode | null = null;
  let gainNode: GainNode | null = null;
  // `sourceElement` is the real player and is used only for identity/time sync.
  // `analysisElement` is the CORS-enabled silent clone connected to Web Audio.
  let sourceElement: HTMLAudioElement | null = null;
  let analysisElement: HTMLAudioElement | null = null;
  let data: Uint8Array<ArrayBuffer> | null = null;
  let timer = 0;
  let active = false;
  let playing = false;
  let low = 0;
  let mid = 0;
  let high = 0;
  let overall = 0;

  const smooth = (raw: number, current: number) => {
    const factor = raw > current ? ATTACK_FACTOR : RELEASE_FACTOR;
    return current + (raw - current) * factor;
  };

  const decay = () => {
    low = smooth(0, low);
    mid = smooth(0, mid);
    high = smooth(0, high);
    overall = smooth(0, overall);
  };

  const sample = () => {
    if (!analyser || !data) return;
    analyser.getByteFrequencyData(data);
    const binCount = data.length;
    const lowEnd = Math.floor(binCount * 0.3);
    const midEnd = Math.floor(binCount * 0.65);
    const rawLow = normalize(average(data, 0, lowEnd));
    const rawMid = normalize(average(data, lowEnd, midEnd));
    const rawHigh = normalize(average(data, midEnd, binCount));
    low = smooth(rawLow, low);
    mid = smooth(rawMid, mid);
    high = smooth(rawHigh, high);
    overall = smooth((rawLow + rawMid + rawHigh) / 3, overall);
  };

  const tick = () => {
    if (!active) return;
    // Background tabs keep audio playback untouched but do no analyser reads.
    // The slow timer only checks whether the page became visible again.
    if (typeof document !== "undefined" && document.hidden) {
      timer = window.setTimeout(tick, HIDDEN_INTERVAL_MS);
      return;
    }
    if (playing) sample();
    else decay();
    timer = window.setTimeout(tick, SAMPLE_INTERVAL_MS);
  };

  const teardown = () => {
    active = false;
    playing = false;
    if (timer && typeof window !== "undefined") window.clearTimeout(timer);
    timer = 0;
    analysisElement?.pause();
    if (analysisElement) {
      analysisElement.removeAttribute("src");
      try {
        analysisElement.load();
      } catch {
        // Detached media elements may reject load() during teardown.
      }
    }
    try {
      sourceNode?.disconnect();
      analyser?.disconnect();
      gainNode?.disconnect();
    } catch {
      // A partially-created graph may already be disconnected.
    }
    sourceNode = null;
    analyser = null;
    gainNode = null;
    analysisElement = null;
    data = null;
    sourceElement = null;
    if (context) {
      void context.close().catch(() => undefined);
      context = null;
    }
    low = mid = high = overall = 0;
  };

  return {
    getEnergy() {
      return { low, mid, high, overall };
    },
    isActive() {
      return active;
    },
    start(element) {
      if (typeof window === "undefined" || typeof document === "undefined") return;
      const mediaUrl = element.currentSrc || element.src;
      if (!mediaUrl) return;
      if (active && sourceElement === element && analysisElement?.src === mediaUrl) return;
      if (active) teardown();
      try {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const newContext = new Ctor();
        context = newContext;
        const newAnalyser = newContext.createAnalyser();
        analyser = newAnalyser;
        newAnalyser.fftSize = FFT_SIZE;
        const newGain = newContext.createGain();
        gainNode = newGain;
        newGain.gain.value = 0;

        // Analyze a silent clone instead of routing the real playback element
        // through Web Audio. `anonymous` lets configured COS/S3 CORS expose the
        // signal; when CORS is missing only this clone fails, so soundtrack
        // playback on `element` remains completely untouched.
        const analysis = document.createElement("audio");
        analysisElement = analysis;
        sourceElement = element;
        analysis.crossOrigin = "anonymous";
        analysis.preload = "auto";
        analysis.loop = element.loop;
        analysis.src = mediaUrl;
        const newSource = newContext.createMediaElementSource(analysis);
        sourceNode = newSource;
        newSource.connect(newAnalyser);
        newAnalyser.connect(newGain);
        newGain.connect(newContext.destination);

        data = new Uint8Array(newAnalyser.frequencyBinCount);
        active = true;
        tick();
      } catch {
        // Unsupported/CORS/source creation failure: leave playback untouched.
        teardown();
      }
    },
    setPlaying(nextPlaying) {
      playing = active && nextPlaying;
      if (!active || !analysisElement || !context) return;
      if (!nextPlaying) {
        analysisElement.pause();
        return;
      }
      // Resync on every resume so pauses/background time never accumulate
      // drift. Seeking before metadata can throw, hence the guarded assignment.
      if (sourceElement && Number.isFinite(sourceElement.currentTime)) {
        try {
          if (Math.abs(analysisElement.currentTime - sourceElement.currentTime) > 0.12) {
            analysisElement.currentTime = sourceElement.currentTime;
          }
        } catch {
          // The clone will start at zero and catch up on the next resume.
        }
      }
      void context.resume().catch(() => undefined);
      void analysisElement.play().catch(() => {
        // CORS/autoplay failure affects only analysis; keep energy decaying to
        // zero while the real soundtrack continues normally.
        playing = false;
      });
    },
    stop() {
      teardown();
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

export function createSoundtrackSampler(): AudioSampler {
  return createSampler();
}
