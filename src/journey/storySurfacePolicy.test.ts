import { describe, expect, it } from "vitest";
import {
  storyFullscreenTargetIsCurrent,
  showMobileStoryPlayControl,
  showMobileStoryFullscreenControl,
} from "./storySurfacePolicy";

describe("Story fullscreen morph ownership (#459)", () => {
  const entering = {
    mediaId: "asset-1",
    nextFullscreen: true,
    overlayHidden: false,
    stagePresent: true,
    currentPageId: "asset-1",
    stageInterrupted: false,
  };
  const leaving = { ...entering, nextFullscreen: false, overlayHidden: true };

  it("keeps compact-mobile entry and return bound to the same media identity", () => {
    expect(storyFullscreenTargetIsCurrent(entering)).toBe(true);
    expect(storyFullscreenTargetIsCurrent(leaving)).toBe(true);
  });

  it("lets a newer swipe, rapid close, or scope replacement cancel a stale handoff", () => {
    expect(storyFullscreenTargetIsCurrent({ ...entering, currentPageId: "asset-2" })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...entering, overlayHidden: true })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...leaving, stagePresent: false, currentPageId: undefined })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...entering, stageInterrupted: true })).toBe(false);
  });

  it("does not claim a video that never settled a shared media identity", () => {
    expect(storyFullscreenTargetIsCurrent({ ...entering, mediaId: undefined, currentPageId: undefined })).toBe(false);
  });
});

describe("showMobileStoryPlayControl (#199)", () => {
  const viewer = {
    mobileLayout: true,
    overview: false,
    mobileManageMode: false,
    scopedMediaCount: 3,
  };

  it("exposes playback in mobile Viewer for a multi-asset scope", () => {
    expect(showMobileStoryPlayControl(viewer)).toBe(true);
    expect(showMobileStoryPlayControl({ ...viewer, scopedMediaCount: 2 })).toBe(true);
  });

  it("stays out of desktop, the overview grid, Manage mode and single-asset scopes", () => {
    expect(showMobileStoryPlayControl({ ...viewer, mobileLayout: false })).toBe(false);
    expect(showMobileStoryPlayControl({ ...viewer, overview: true })).toBe(false);
    expect(showMobileStoryPlayControl({ ...viewer, mobileManageMode: true })).toBe(false);
    expect(showMobileStoryPlayControl({ ...viewer, scopedMediaCount: 1 })).toBe(false);
    expect(showMobileStoryPlayControl({ ...viewer, scopedMediaCount: 0 })).toBe(false);
  });

  it("matches the gate the fullscreen navigation already uses", () => {
    for (const scopedMediaCount of [0, 1, 2, 5]) {
      expect(showMobileStoryPlayControl({ ...viewer, scopedMediaCount }))
        .toBe(scopedMediaCount > 1);
    }
  });
});

describe("showMobileStoryFullscreenControl (#199 follow-up)", () => {
  const viewer = {
    mobileLayout: true,
    overview: false,
    mobileManageMode: false,
    hasAsset: true,
  };

  it("gives mobile Viewer its own immersive entry whenever a media asset is on stage", () => {
    expect(showMobileStoryFullscreenControl(viewer)).toBe(true);
  });

  it("stays out of desktop, the overview grid, Manage mode and an empty stage", () => {
    expect(showMobileStoryFullscreenControl({ ...viewer, mobileLayout: false })).toBe(false);
    expect(showMobileStoryFullscreenControl({ ...viewer, overview: true })).toBe(false);
    expect(showMobileStoryFullscreenControl({ ...viewer, mobileManageMode: true })).toBe(false);
    expect(showMobileStoryFullscreenControl({ ...viewer, hasAsset: false })).toBe(false);
  });

  it("does not inherit the sequence gate: one asset is still worth the full stage", () => {
    expect(showMobileStoryFullscreenControl(viewer)).toBe(true);
    expect(showMobileStoryPlayControl({
      mobileLayout: true,
      overview: false,
      mobileManageMode: false,
      scopedMediaCount: 1,
    })).toBe(false);
  });
});

describe("Story fullscreen intent supersession (#459)", () => {
  it("cancels the Story fullscreen morph when newer media or overlay intent wins (#459)", () => {
    const current = {
      mediaId: "asset-a",
      nextFullscreen: true,
      overlayHidden: false,
      stagePresent: true,
      currentPageId: "asset-a",
      stageInterrupted: false,
    };
    expect(storyFullscreenTargetIsCurrent(current)).toBe(true);
    expect(storyFullscreenTargetIsCurrent({ ...current, currentPageId: "asset-b" })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, overlayHidden: true })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, stageInterrupted: true })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, stagePresent: false })).toBe(false);
  });
});
