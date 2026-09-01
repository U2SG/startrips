export type PlaybackControlsVisibilityContext = {
  paused: boolean;
  keyboardNavigation: boolean;
  focusWithinOverlay: boolean;
};

/**
 * Playback chrome may fade only during uninterrupted pointer/touch viewing.
 * Paused playback keeps controls visible, and keyboard users never lose the
 * controls while focus remains inside the playback dialog.
 */
export function playbackControlsMayAutoHide({
  paused,
  keyboardNavigation,
  focusWithinOverlay,
}: PlaybackControlsVisibilityContext) {
  if (paused) return false;
  return !(keyboardNavigation && focusWithinOverlay);
}
