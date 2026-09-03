export type PlaybackMediaElement = {
  pause: () => void;
  play: () => Promise<unknown> | void;
};

/** Keep chapter video transport subordinate to the Startrips playback state. */
export function syncPlaybackMediaElement(
  element: PlaybackMediaElement | null,
  playing: boolean,
  onPlayFailure?: () => void,
  onPlaySuccess?: () => void,
) {
  if (!element) return;
  if (!playing) {
    element.pause();
    return;
  }

  try {
    const result = element.play();
    if (result && typeof result.then === "function") {
      void result.then(() => onPlaySuccess?.(), () => onPlayFailure?.());
    } else {
      onPlaySuccess?.();
    }
  } catch {
    onPlayFailure?.();
  }
}
