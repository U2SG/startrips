export type PlaybackMode = "full" | "quick-recap";

/**
 * The tempo control is hidden in Quick Recap.
 *
 * Quick Recap plays a frozen plan: `quickRecapStepDurationMs()` returns the
 * plan's own camera, arrival and dwell milliseconds, and the director only
 * falls back to the tempo profile for intro and outro. Changing tempo there
 * therefore moves two beats out of a whole recap, which reads as a control that
 * does nothing — a live product lie. Hiding it is decision D4-A of the shared
 * narrative timing plan; PR 4 threads tempo through the Quick Recap plan and
 * shows the control again once it means something.
 */
export function playbackTempoControlVisible(playbackMode: PlaybackMode) {
  return playbackMode !== "quick-recap";
}

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
