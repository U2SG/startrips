// #596 — soundtrack ducking under an audible foreground video.
//
// One policy, shared by Journey Playback, Quick Recap, Full Playback, Story
// inline media and Story fullscreen. The parameters live here precisely so
// Story and Playback cannot grow their own magic numbers and drift apart.
//
// Two rules the shape of this module exists to enforce:
//
// 1. Ducking is relative to the member's own soundtrack volume, never absolute.
//    A baseline of 0.8 ducks to 0.24 and restores to exactly 0.8. The baseline
//    is re-read on every restore rather than snapshotted when the duck began,
//    so lowering the volume mid-duck restores to the volume actually in force.
// 2. Gain is a function of time, not of ticks. Both surfaces compute the same
//    value for the same elapsed time, so a late frame or a backgrounded tab
//    resumes on the curve instead of jumping.
//
// The real `<audio>` element stays the playback source. Ducking rides on that
// element's own `volume`; the Web Audio graph in `audioSampler` remains an
// analysis sidechain and is never routed through.

/** How much of the member's volume survives while a video is audible. */
export const SOUNDTRACK_DUCK_FACTOR = 0.3;

/** Issue asks for roughly 150-300ms into the duck. */
export const SOUNDTRACK_DUCK_ATTACK_MS = 220;

/** Issue asks for roughly 300-600ms back to the member's own level. */
export const SOUNDTRACK_DUCK_RELEASE_MS = 450;

/**
 * Whether a video currently owns the foreground audibly.
 *
 * "Is audible" is deliberately not "has an audio track". Proving that a file
 * carries sound costs a decode round trip and would block playback, which the
 * issue rules out; an unmuted, playing, in-volume foreground video is treated
 * as audible. A failed `play()` leaves `playing` false, so the failure path
 * cannot leave the soundtrack stuck low.
 */
export function shouldDuckSoundtrack(video: {
  foreground: boolean;
  playing: boolean;
  muted: boolean;
  ended: boolean;
  volume: number;
}) {
  return video.foreground
    && video.playing
    && !video.muted
    && !video.ended
    && video.volume > 0;
}

/** The volume the soundtrack should be heading toward. Never overrides the member's level. */
export function soundtrackTargetGain(baseline: number, ducking: boolean) {
  return ducking ? baseline * SOUNDTRACK_DUCK_FACTOR : baseline;
}

/** How long the current transition takes, chosen by direction. */
export function soundtrackRampMs(from: number, to: number) {
  if (to < from) return SOUNDTRACK_DUCK_ATTACK_MS;
  return SOUNDTRACK_DUCK_RELEASE_MS;
}

/**
 * The gain at a point on the transition curve.
 *
 * Pure and time-based so the same inputs always yield the same output, which is
 * what lets every surface share one implementation and lets the ramp be tested
 * without an animation frame.
 */
export function soundtrackRampGain(
  from: number,
  to: number,
  startedAt: number,
  durationMs: number,
  now: number,
) {
  if (durationMs <= 0) return to;
  const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
  return from + (to - from) * progress;
}

/**
 * A duck decision bound to the media generation that produced it.
 *
 * Rapid video A -> image -> video B means A's `pause`/`ended` events arrive
 * after B already owns the foreground. Carrying the generation lets a stale
 * event be dropped instead of restoring the soundtrack under the new video,
 * which is what would produce audible pumping.
 *
 * `soundtrackDuckingController` avoids the problem instead of filtering it: it
 * re-reads live state every frame, so a superseded event has nothing left to
 * corrupt. This helper is for a surface that chooses to push events rather than
 * be polled, and it deliberately compares two identifiers maintained together —
 * comparing a surface's generation against an independently incremented
 * controller counter would reject every frame, not only the stale ones.
 */
export type SoundtrackDuckDecision = {
  generation: number;
  ducking: boolean;
};

export function soundtrackDuckDecision(
  current: number,
  observedGeneration: number,
  ducking: boolean,
): SoundtrackDuckDecision | null {
  // A late event from a superseded transport must not move the gain.
  if (observedGeneration !== current) return null;
  return { generation: current, ducking };
}
