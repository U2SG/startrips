export type PlaybackMediaElement = {
  pause: () => void;
  play: () => Promise<unknown> | void;
};

/** Keep chapter video transport subordinate to the Startrips playback state. */
export function syncPlaybackMediaElement(
  element: PlaybackMediaElement | null,
  playing: boolean,
) {
  if (!element) return;
  if (!playing) {
    element.pause();
    return;
  }

  try {
    const result = element.play();
    if (result && typeof result.catch === "function") {
      void result.catch(() => undefined);
    }
  } catch {
    // Browser autoplay/user-activation failures are non-fatal; the shared
    // transport remains the only visible source of playback state.
  }
}
