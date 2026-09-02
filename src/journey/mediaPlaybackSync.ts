export type PlaybackMediaElement = {
  pause: () => void;
  play: () => Promise<unknown> | void;
};

/** Keep chapter video transport subordinate to the Startrips playback state. */
export function syncPlaybackMediaElement(
  element: PlaybackMediaElement | null,
  playing: boolean,
  onPlayFailure?: () => void,
) {
  if (!element) return;
  if (!playing) {
    element.pause();
    return;
  }

  try {
    const result = element.play();
    if (result && typeof result.catch === "function") {
      void result.catch(() => onPlayFailure?.());
    }
  } catch {
    onPlayFailure?.();
  }
}
