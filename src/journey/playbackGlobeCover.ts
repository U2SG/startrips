import type { PlaybackStep } from "./journeyPlayback";

export type PlaybackGlobeCoverState = {
  opaqueMediaCover: boolean;
  coverTransitionActive: boolean;
};

export const EMPTY_PLAYBACK_GLOBE_COVER: PlaybackGlobeCoverState = {
  opaqueMediaCover: false,
  coverTransitionActive: false,
};

/**
 * #247: Playback is cinematic for its whole lifetime, but only the media beat
 * becomes a fully opaque Atlas cover. Presentation readiness is the existing
 * handoff owner: while that media slot is still settling, keep the globe alive.
 */
export function playbackGlobeCoverState(
  phase: PlaybackStep["kind"] | null,
  presentationPending: boolean,
): PlaybackGlobeCoverState {
  if (phase !== "media") return EMPTY_PLAYBACK_GLOBE_COVER;
  return {
    opaqueMediaCover: true,
    coverTransitionActive: presentationPending,
  };
}
