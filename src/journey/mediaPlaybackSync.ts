export type PlaybackMediaElement = {
  pause: () => void;
  play: () => Promise<unknown> | void;
};

export type RestartablePlaybackMediaElement = Pick<PlaybackMediaElement, "pause"> & {
  currentTime: number;
};

/** Replay starts soundtrack ownership from the beginning, never from completion's pause point. */
export function rewindPlaybackMediaElement(element: RestartablePlaybackMediaElement | null) {
  if (!element) return;
  element.pause();
  element.currentTime = 0;
}

/** Keep chapter video transport subordinate to the Startrips playback state. */
export function syncPlaybackMediaElement(
  element: PlaybackMediaElement | null,
  playing: boolean,
  onPlayFailure?: () => void,
) {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  if (!element) return cancel;
  if (!playing) {
    element.pause();
    return cancel;
  }

  try {
    const result = element.play();
    if (result && typeof result.then === "function") {
      void result.catch(() => {
        if (!cancelled) onPlayFailure?.();
      });
    }
  } catch {
    if (!cancelled) onPlayFailure?.();
  }
  return cancel;
}
