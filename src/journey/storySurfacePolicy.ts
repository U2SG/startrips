import type { Journey } from "./types";

export function mobileStoryExpandedForLayout(mobileLayout: boolean, expanded: boolean) {
  return mobileLayout ? expanded : false;
}

export type StoryFullscreenMorphIntent = {
  mediaId: string | undefined;
  nextFullscreen: boolean;
  /** `hidden` of the fullscreen overlay, or undefined when it is unmounted. */
  overlayHidden: boolean | undefined;
  stagePresent: boolean;
  currentPageId: string | undefined;
  /** An incoming page or a stage alert means the destination is still moving. */
  stageInterrupted: boolean;
};

/**
 * #459: the Story <-> fullscreen handoff is still the user's intent only while
 * the overlay has settled onto the requested side and the destination stage is
 * presenting exactly the media the morph started from. A swipe, close, rapid
 * re-open, Route Point change or Journey change commits a different current
 * page, which invalidates the pending morph. Kept pure so the compact-mobile
 * and video paths that no longer bypass the morph can be asserted directly.
 */
export function storyFullscreenTargetIsCurrent(intent: StoryFullscreenMorphIntent) {
  return Boolean(
    intent.mediaId
    && intent.stagePresent
    && intent.overlayHidden === !intent.nextFullscreen
    && intent.currentPageId === intent.mediaId
    && !intent.stageInterrupted,
  );
}

export type StoryGlobeCoverState = { opaqueMediaCover: boolean; coverTransitionActive: boolean };

export function storyGlobeCoverState({
  mobileLayout, mobileStoryExpanded, fullscreen, coverTransitionActive,
}: {
  mobileLayout: boolean; mobileStoryExpanded: boolean; fullscreen: boolean; coverTransitionActive: boolean;
}): StoryGlobeCoverState {
  return {
    opaqueMediaCover: fullscreen || mobileStoryExpandedForLayout(mobileLayout, mobileStoryExpanded),
    coverTransitionActive: !fullscreen && coverTransitionActive,
  };
}

export function mobileStoryHistoryLayers({
  mobileLayout,
  mobileManageMode,
  fullscreen,
  mediaMenuOpen,
  mediaDeleteOpen,
  journeyDeleteOpen,
}: {
  mobileLayout: boolean;
  mobileManageMode: boolean;
  fullscreen: boolean;
  mediaMenuOpen: boolean;
  mediaDeleteOpen: boolean;
  journeyDeleteOpen: boolean;
}) {
  const manage = mobileLayout && mobileManageMode;
  return {
    manage,
    // Fullscreen is valid in Viewer. Mutation-only media surfaces must wait
    // until Manage owns its parent history layer (important when a desktop
    // confirmation migrates into compact layout).
    mediaSurface: mobileLayout && (
      fullscreen || (mobileManageMode && (mediaMenuOpen || mediaDeleteOpen))
    ),
    journeyDelete: manage && journeyDeleteOpen,
  };
}

// #199: Story media sequence playback is a viewing action, so mobile Viewer
// keeps one quiet play/pause control in its action cluster instead of hiding
// it behind Manage mode. Manage owns mutation surfaces, the overview grid has
// no single stage to play, and a scope with one asset has no sequence at all —
// the same gate the fullscreen navigation already uses.
export function showMobileStoryPlayControl({
  mobileLayout,
  overview,
  mobileManageMode,
  scopedMediaCount,
}: {
  mobileLayout: boolean;
  overview: boolean;
  mobileManageMode: boolean;
  scopedMediaCount: number;
}) {
  return mobileLayout && !overview && !mobileManageMode && scopedMediaCount > 1;
}

// #199 follow-up: immersive viewing is a viewing action too, so Viewer owns the
// fullscreen entry instead of the management sheet. Unlike sequence playback it
// is meaningful for a single asset — one photo still deserves the full stage —
// so this gate asks for a current asset rather than a sequence.
export function showMobileStoryFullscreenControl({
  mobileLayout,
  overview,
  mobileManageMode,
  hasAsset,
}: {
  mobileLayout: boolean;
  overview: boolean;
  mobileManageMode: boolean;
  hasAsset: boolean;
}) {
  return mobileLayout && !overview && !mobileManageMode && hasAsset;
}

export function journeyDeleteDescription(journey: Journey) {
  return `先从图谱隐藏；7 天内可撤销，之后才会清理路线和 ${journey.media.length} 个私有媒体。`;
}
