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
  /**
   * The member's own soundtrack level. Optional: the controller reads it off the
   * element itself, because a level it did not write IS the member's level.
   * A surface only needs this when it keeps an independent source of truth,
   * such as a volume control.
   */
  getBaselineVolume?: () => number;
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
  /**
   * What the controller currently believes, for QA. A restore that silently
   * does not move is ambiguous from the outside: the element could be holding
   * the ducked level because the decision is still "duck", or because the
   * baseline itself drifted down to that level and "restore" now means 0.3.
   * These fields tell the two apart.
   */
  snapshot(): {
    frames: number;
    running: boolean;
    baseline: number;
    current: number;
    target: number;
    ducking: boolean;
    hasForeground: boolean;
    foregroundPaused: boolean | null;
    foregroundPlaying: boolean | null;
    lastWritten: number | null;
    elementVolume: number | null;
    drivesElement: boolean;
  };
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
  // How many times the loop has actually run. A frozen `frames` beside a
  // pending-but-unreached target is what distinguishes "the ramp restarted" from
  // "the loop stopped", which look identical from the gain alone.
  let frames = 0;
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
  // The soundtrack element the cached gain actually describes. A remount hands
  // back a new element sitting at the browser's default volume, and the cached
  // numbers say nothing about it: comparing the ramp's result against `current`
  // would conclude "already there" and leave the new element playing at full
  // volume underneath a video that is still audible.
  let seenSoundtrack: HTMLAudioElement | null = null;
  // The member's own soundtrack level, which the controller owns rather than
  // being told. The element's volume IS the member's level whenever this
  // controller is not the thing writing it, so the honest baseline is read off
  // the element instead of a constant a caller has to remember to keep in sync.
  let baseline = 1;
  // The last value this controller wrote, so a difference from it means somebody
  // else changed the level - a future volume control, a restored session - and
  // that new level is the baseline to restore to.
  let lastWritten: number | null = null;

  const retarget = (audio: HTMLAudioElement, ducking: boolean) => {
    const target = soundtrackTargetGain(
      host.getBaselineVolume?.() ?? baseline,
      ducking,
    );
    // Only a changed target restarts the ramp. Comparing the origin as well
    // would re-anchor on every single frame — `current` is always moving — and
    // the transition would restart forever and never arrive. `NaN` never
    // compares equal, which is how a newly adopted element forces a decision.
    if (target === to) return;
    from = current;
    to = target;
    startedAt = now();
  };

  const step = () => {
    if (!running) return;
    frames += 1;
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
    // A new soundtrack element is a new thing to control, not a continuation of
    // the old one: it starts at the browser default, and `current` describes an
    // element that no longer exists. Adopt its real volume and force a fresh
    // target, otherwise the ramp's result still equals the cached gain, the
    // write is skipped, and the replacement soundtrack is audible at full level
    // while the video is playing.
    if (audio !== seenSoundtrack) {
      seenSoundtrack = audio;
      if (audio) {
        current = audio.volume;
        from = current;
        // Whatever level this element arrived at is the member's level.
        baseline = current;
        lastWritten = null;
        // Force `retarget` to recompute even when the target value is unchanged.
        to = Number.NaN;
      }
    }
    // A level this controller did not write is the member's level. Adopting it is
    // what makes "the member changed the volume and the policy followed" true of
    // the product rather than only of the policy: no caller has to volunteer a
    // baseline, because the element is the record.
    //
    // `current` and `lastWritten` must move with it. Leaving `current` at the old
    // gain starts the ramp below where the element actually is, so the first
    // frame computes "no movement", never writes, and leaves `lastWritten`
    // stale - which re-detects the very same unchanged level on every following
    // frame and restarts the ramp forever. The element then sits wherever it was
    // left, for the rest of a video that is still playing.
    if (audio && lastWritten !== null && Math.abs(audio.volume - lastWritten) > 1e-3) {
      baseline = audio.volume;
      current = audio.volume;
      from = current;
      // Record it as observed, so the same level is not taken again next frame.
      lastWritten = audio.volume;
      to = Number.NaN;
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
        lastWritten = gain;
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
    /**
     * What the controller currently believes, for QA. A restore that silently
     * does not move is ambiguous from the outside: the element could be holding
     * the ducked level because the decision is still "duck", or because the
     * baseline itself drifted down to that level and "restore" now means 0.3.
     * These fields tell the two apart.
     */
    snapshot() {
      return {
        frames,
        running,
        baseline,
        current,
        target: to,
        ducking: to < baseline,
        hasForeground: seenVideo !== null,
        foregroundPaused: seenVideo ? seenVideo.paused : null,
        foregroundPlaying: seenVideo ? isActuallyPlaying(seenVideo) : null,
        lastWritten,
        // The element this controller actually drives, and its level. A QA lane
        // that reads `document.querySelector("audio")` can be looking at an
        // orphaned element after a soundtrack re-key, and then it would report
        // "the soundtrack did not restore" about a node nobody is driving.
        elementVolume: seenSoundtrack ? seenSoundtrack.volume : null,
        drivesElement: seenSoundtrack === host.getSoundtrack(),
      };
    },
  };
}
