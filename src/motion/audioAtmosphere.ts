import type { AudioEnergy } from "./audioSampler";

const ZERO_ENERGY: AudioEnergy = Object.freeze({
  low: 0,
  mid: 0,
  high: 0,
  overall: 0,
});

let currentEnergy: AudioEnergy = ZERO_ENERGY;

/**
 * #20 lightweight atmosphere channel. Playback writes smoothed energy here;
 * Three.js and SVG/CSS consumers read it from their own render loops without
 * scheduling React renders.
 */
export function writeAudioAtmosphereEnergy(energy: AudioEnergy) {
  currentEnergy = {
    low: clamp01(energy.low),
    mid: clamp01(energy.mid),
    high: clamp01(energy.high),
    overall: clamp01(energy.overall),
  };
}

export function readAudioAtmosphereEnergy(): AudioEnergy {
  return currentEnergy;
}

export function resetAudioAtmosphereEnergy() {
  currentEnergy = ZERO_ENERGY;
}

export function audioAtmosphereGains(energy: AudioEnergy) {
  const overall = clamp01(energy.overall);
  const low = clamp01(energy.low);
  const mid = clamp01(energy.mid);
  return {
    ambient: 1 + overall * 0.12,
    halo: 1 + low * 0.15,
    route: mid * 0.15,
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
