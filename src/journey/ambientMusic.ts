// A tiny ambient pad synthesized with the Web Audio API, so the Ken Burns
// slideshow can have background music without shipping audio files or
// depending on third-party content.

let activeContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

const PAD_VOLUME = 0.05;
const FADE_IN_SECONDS = 2.5;
const FADE_OUT_SECONDS = 0.8;

export function startAmbientMusic(): void {
  if (activeContext) return;
  try {
    const context = new AudioContext();
    const master = context.createGain();
    master.gain.value = 0;

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 0.4;

    const chord: Array<{ frequency: number; type: OscillatorType; gain: number }> = [
      { frequency: 110, type: "sine", gain: 0.5 },
      { frequency: 130.81, type: "sine", gain: 0.42 },
      { frequency: 164.81, type: "sine", gain: 0.34 },
      { frequency: 220, type: "triangle", gain: 0.1 },
    ];
    for (const voice of chord) {
      const oscillator = context.createOscillator();
      oscillator.type = voice.type;
      oscillator.frequency.value = voice.frequency;
      const gain = context.createGain();
      gain.gain.value = voice.gain;
      oscillator.connect(gain);
      gain.connect(filter);
      oscillator.start();
    }

    // A very slow filter sweep keeps the pad from feeling static.
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = context.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    filter.connect(master);
    master.connect(context.destination);

    master.gain.linearRampToValueAtTime(
      PAD_VOLUME,
      context.currentTime + FADE_IN_SECONDS,
    );

    activeContext = context;
    masterGain = master;
  } catch {
    // No audio output available; the slideshow still plays silently.
  }
}

export function stopAmbientMusic(): void {
  const context = activeContext;
  const master = masterGain;
  if (!context || !master) return;
  activeContext = null;
  masterGain = null;
  if (stopTimer) clearTimeout(stopTimer);
  try {
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.linearRampToValueAtTime(
      0,
      context.currentTime + FADE_OUT_SECONDS,
    );
    stopTimer = setTimeout(() => {
      void context.close().catch(() => undefined);
    }, FADE_OUT_SECONDS * 1000 + 200);
  } catch {
    void context.close().catch(() => undefined);
  }
}
