// #596 — the driver that actually moves the soundtrack's volume.
//
// One controller per soundtrack element, shared by every surface that has one.
// The policy constants and the gain curve live in `soundtrackDucking`; this
// file only owns the state machine: what the current gain is, where it is
// heading, and when a new transport makes the pending target irrelevant.
//
// Deliberately frame-polled rather than event-driven. Every "the video
// paused / ended / muted" event has to be attributed to the transport that
// raised it, and video A's late event arriving after video B already owns the
// foreground is exactly how a soundtrack ends up pumping. Reading live state
// from the element on each frame removes that whole class instead of trying to
// filter it afterwards.
//
// The real `<audio>` element stays the playback source and is never routed
// through Web Audio; ducking is only ever `element.volume`. The analysis
// sidechain in `audioSampler` is untouched by this.

import {
  shouldDuckSoundtrack,
  soundtrackRampGain,
  soundtrackRampMs,
  soundtrackTargetGain,
} from "./soundtrackDucking";

/** `readyState` value meaning "has current frame data", i.e. really playing. */
const HAVE_CURRENT_DATA = 2;

export type SoundtrackDuckingHost = {
  /** The one live soundtrack element, or null before it mounts. */
  getSoundtrack: () => HTMLAudioElement | null;
  /**
   * The video that currently owns the foreground, or null. This is ownership,
   * not proximity: a video merely present in the DOM must not duck.
   */
  getForegroundVideo: () => HTMLVideoElement | null;
  /**
   * The surface's own media/transport generation, when it has one. A frame
   * whose generation disagrees with the one this controller last accepted is
   * dropped rather than acted on.
   */
  getMediaGeneration?: () => number;
  /** The member's own soundtrack level. Re-read every frame, never snapshotted. */
  getBaselineVolume: () => number;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

export type SoundtrackDuckingController = {
  start(): void;
  stop(): void;
  /** Current gain, for tests and for surfaces that surface it. */
  currentGain(): number;
  /** True while a transition is in flight. */
  isRamping(): boolean;
};

/** Is this element genuinely playing, rather than merely un-paused? */
function isActuallyPlaying(video: HTMLVideoElement) {
  return !video.paused
    && !video.ended
    && video.readyState >= HAVE_CURRENT_DATA;
}

export function createSoundtrackDuckingController(
  host: SoundtrackDuckingHost,
): SoundtrackDuckingController {
  const now = host.now ?? (() => Date.now());
  const requestFrame = host.requestFrame
    ?? ((callback: () => void) => (
      typeof window === "undefined" ? 0 : window.requestAnimationFrame(() => callback())
    ));
  const cancelFrame = host.cancelFrame
    ?? ((handle: number) => {
      if (typeof window !== "undefined" && handle) window.cancelAnimationFrame(handle);
    });

  let handle: number | null = null;
  let running = false;
  // What the element's volume is right now, and where it is heading.
  let current = 1;
  let from = 1;
  let to = 1;
  let startedAt = 0;
  // The video element this controller last acted on, and the surface's own
  // media generation at that moment. A change in either is a new transport.
  let seenVideo: HTMLVideoElement | null = null;
  let lastHostGeneration: number | null | undefined;
  let transport = 0;

  const retarget = (audio: HTMLAudioElement, ducking: boolean) => {
    // The baseline is read here, every time, so lowering the soundtrack while
    // ducked restores to the level actually in force rather than the one that
    // happened to be in force when the duck started.
    const target = soundtrackTargetGain(host.getBaselineVolume(), ducking);
    // Only a changed target restarts the ramp. Comparing the origin as well
    // would re-anchor on every single frame — `current` is always moving — and
    // the transition would restart forever and never arrive.
    if (target === to) return;
    from = current;
    to = target;
    startedAt = now();
  };

  const step = () => {
    if (!running) return;
    const audio = host.getSoundtrack();
    const video = host.getForegroundVideo();
    const hostGeneration = host.getMediaGeneration?.() ?? null;
    // A transport change is either a different element or the surface advancing
    // its own media generation. Both mean the previous target described
    // something that no longer exists, so re-anchor on the live gain and decide
    // again from scratch rather than finishing a transition nobody asked for.
    if (video !== seenVideo || hostGeneration !== lastHostGeneration) {
      seenVideo = video;
      lastHostGeneration = hostGeneration;
      transport += 1;
      from = current;
    }
    const ducking = video
      ? shouldDuckSoundtrack({
        foreground: true,
        playing: isActuallyPlaying(video),
        muted: video.muted,
        ended: video.ended,
        volume: video.volume,
      })
      : false;
    if (audio) {
      retarget(audio, ducking);
      const gain = soundtrackRampGain(
        from,
        to,
        startedAt,
        soundtrackRampMs(from, to),
        now(),
      );
      // Assigning the same value every frame would make the element report a
      // spurious volume change, so only write on real movement.
      if (Math.abs(gain - current) > 1e-4) {
        current = gain;
        audio.volume = gain;
      }
    }
    handle = requestFrame(step);
  };

  return {
    start() {
      if (running) return;
      running = true;
      const audio = host.getSoundtrack();
      if (audio) current = audio.volume;
      handle = requestFrame(step);
    },
    stop() {
      running = false;
      if (handle !== null) cancelFrame(handle);
      handle = null;
    },
    currentGain() {
      return current;
    },
    isRamping() {
      // Whether the gain is still moving, not whether the transition it began
      // with had different endpoints. `from` is deliberately left at the origin
      // of the last retarget so a new transport can re-anchor from it, which
      // would otherwise report "ramping" forever after the gain had settled.
      return Math.abs(to - current) > 1e-4;
    },
  };
}
