import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  storyAutoplayVideoCandidate,
  storyAutoplayCanStart,
  storyStageVideoOwner,
  shouldRefreshStoryMediaRead,
  createStoryAutoplayFallbackController,
  JourneyStory,
  finalizeMediaDragCommit,
  scheduleCancelableMediaDragSettle,
  scheduleCancelableDeferredFullscreenEntry,
  cancelPendingStoryMediaOwners,
  groupedPlacementRefreshSelection,
  journeyDeleteDescription,
  mobileStoryExpandedForLayout,
  mobileStoryHistoryLayers,
  storyGlobeCoverState,
  mediaForRoutePoint,
  mediaForUploadRefreshScope,
  mediaMoveUndoForSelection,
  mediaMoveUndoNeedsServerReconcile,
  reorderInvalidatesMediaMoveUndo,
  retainMediaMoveUndoAfterError,
  replaceJourneySoundtrack,
  showMobileStoryFullscreenControl,
  storyImmersiveEntryKeepsPlaying,
  showMobileStoryPlayControl,
  storyAssetIndexForId,
  storyAutoplayAdvance,
  storyAutoplayNextIndex,
  storyAutoplayWaitsForVideoEnd,
  storyMediaAvailability,
  storyNavigationTargetDisposition,
  storyChapterMedia,
  shouldHoldWholeJourneyTerminalFrame,
  storyInitialMediaSelection,
  storyLogicalObservation,
  storyMediaNeighborIndex,
  storySelectionContainsRoutePointMedia,
  storyUploadedAssetIndex,
} from "./JourneyStory";
import { JourneyApiError } from "./journeyApi";
import { createPlacementAnalysisAuthority, placementAnalysisScope } from "./placementAnalysisAuthority";
import type { Journey, JourneyMediaAsset } from "./types";

const journey: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "A quiet route home.",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [],
  media: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finalizeMediaDragCommit (#65)", () => {
  it("commits the new semantic owner before removing the visible drag layers", () => {
    const events: string[] = [];
    finalizeMediaDragCommit(
      () => events.push("commit"),
      () => events.push("cleanup"),
      (callback) => {
        events.push("flush-start");
        callback();
        events.push("flush-end");
      },
    );

    expect(events).toEqual(["flush-start", "commit", "flush-end", "cleanup"]);
  });
});

describe("scheduleCancelableMediaDragSettle (#140)", () => {
  it("cancels stale settle work before it can commit into a new Story scope", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableMediaDragSettle(
      () => events.push("commit"),
      () => events.push("cleanup"),
      220,
      (callback) => {
        scheduled.current = callback;
        return 7;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    cancel();
    scheduled.current?.();
    cancel();

    expect(events).toEqual(["clear:7", "cleanup"]);
  });

  it("runs the settle once and makes later cancellation a no-op", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableMediaDragSettle(
      () => events.push("commit"),
      () => events.push("cleanup"),
      220,
      (callback) => {
        scheduled.current = callback;
        return 11;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    scheduled.current?.();
    cancel();

    expect(events).toEqual(["commit"]);
  });
});

describe("scheduleCancelableDeferredFullscreenEntry (#239)", () => {
  it("cancels deferred fullscreen work before the deadline", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableDeferredFullscreenEntry(
      () => events.push("fullscreen"),
      4,
      () => 4,
      220,
      (callback, delay) => {
        events.push(`schedule:${delay}`);
        scheduled.current = callback;
        return 17;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    cancel();
    scheduled.current?.();

    expect(events).toEqual(["schedule:220", "clear:17"]);
  });

  it("drops a stale captured Story scope revision even if the timer fires", () => {
    const run = vi.fn();
    const scheduled: { current: (() => void) | null } = { current: null };
    let revision = 8;
    scheduleCancelableDeferredFullscreenEntry(
      run,
      revision,
      () => revision,
      220,
      (callback) => {
        scheduled.current = callback;
        return 19;
      },
      () => undefined,
    );

    revision += 1;
    scheduled.current?.();

    expect(run).not.toHaveBeenCalled();
  });

  it("keeps reduced-motion delay zero deferred and cancellable", () => {
    const run = vi.fn();
    const scheduled: { current: (() => void) | null } = { current: null };
    const delays: number[] = [];
    const cancel = scheduleCancelableDeferredFullscreenEntry(
      run,
      1,
      () => 1,
      0,
      (callback, delay) => {
        delays.push(delay);
        scheduled.current = callback;
        return 23;
      },
      () => undefined,
    );

    expect(run).not.toHaveBeenCalled();
    expect(delays).toEqual([0]);
    cancel();
    scheduled.current?.();
    expect(run).not.toHaveBeenCalled();
  });

  it("one Story cancellation clears drag settle and deferred fullscreen owners", () => {
    const events: string[] = [];
    cancelPendingStoryMediaOwners(
      () => events.push("drag-settle"),
      () => events.push("deferred-fullscreen"),
    );
    expect(events).toEqual(["drag-settle", "deferred-fullscreen"]);
  });
});


function asset(
  id: string,
  mimeType: string,
  sortOrder: number,
  fileName = `${id}.bin`,
): JourneyMediaAsset {
  return {
    id,
    journeyId: journey.id,
    routePointId: null,
    storageDriver: "test",
    storageKey: `journey-1/${id}`,
    fileName,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: journey.createdAt,
  };
}


describe("groupedPlacementRefreshSelection (#112 review)", () => {
  it("selects the newly uploaded asset inside the accepted route-point scope", () => {
    const refreshed: Journey = {
      ...journey,
      routePoints: [{
        id: "point-1", journeyId: journey.id, sortOrder: 0, label: "Point 1",
        latitude: 1, longitude: 1, occurredAt: null, note: null, isStop: true, createdAt: journey.createdAt,
      }],
      media: [
        { ...asset("existing", "image/jpeg", 0), routePointId: "point-1" },
        { ...asset("uploaded", "image/jpeg", 1), routePointId: "point-1" },
      ],
    };
    expect(groupedPlacementRefreshSelection(refreshed, "point-1", ["uploaded"]))
      .toMatchObject({ assetIndex: 1, assetId: "uploaded" });
  });

  it("treats a null refresh or a stale refresh missing the uploaded asset as failure", () => {
    expect(groupedPlacementRefreshSelection(null, "point-1", ["uploaded"])).toBeNull();
    expect(groupedPlacementRefreshSelection(journey, null, ["missing"])).toBeNull();
  });
});

describe("mediaForUploadRefreshScope (#111 review)", () => {
  it("filters refreshed media by the accepted upload destination instead of stale UI scope", () => {
    const refreshed: Journey = {
      ...journey,
      routePoints: [
        { id: "old-point", journeyId: journey.id, sortOrder: 0, label: "Old", latitude: 1, longitude: 1, occurredAt: null, note: null, isStop: true, createdAt: journey.createdAt },
        { id: "new-point", journeyId: journey.id, sortOrder: 1, label: "New", latitude: 2, longitude: 2, occurredAt: null, note: null, isStop: true, createdAt: journey.createdAt },
      ],
      media: [
        { ...asset("old-media", "image/jpeg", 0), routePointId: "old-point" },
        { ...asset("uploaded-media", "image/jpeg", 1), routePointId: "new-point" },
      ],
    };
    expect(mediaForUploadRefreshScope(refreshed, "new-point").map((item) => item.id))
      .toEqual(["uploaded-media"]);
  });
});

describe("media move Undo review regressions", () => {
  it("reconciles server state when a retained Undo retry reports stale", () => {
    expect(mediaMoveUndoNeedsServerReconcile(
      new JourneyApiError(409, "MEDIA_MOVE_UNDO_STALE", "stale"),
    )).toBe(true);
    expect(mediaMoveUndoNeedsServerReconcile(
      new JourneyApiError(400, "INVALID_MEDIA_MOVE_UNDO", "invalid"),
    )).toBe(false);
  });

  it("does not invalidate Undo for rejected cross-chapter drag reorder", () => {
    const pointA = { ...asset("point-a-media", "image/jpeg", 0), routePointId: "point-a" };
    const pointB = { ...asset("point-b-media", "image/jpeg", 1), routePointId: "point-b" };
    const pointASecond = { ...asset("point-a-second", "image/jpeg", 2), routePointId: "point-a" };

    expect(reorderInvalidatesMediaMoveUndo([pointA, pointB], pointA.id, pointB.id)).toBe(false);
    expect(reorderInvalidatesMediaMoveUndo([pointA, pointASecond], pointA.id, pointASecond.id)).toBe(true);
  });
});

describe("retainMediaMoveUndoAfterError", () => {
  it("keeps the descriptor for network and retryable HTTP failures", () => {
    expect(retainMediaMoveUndoAfterError(new TypeError("network failed"))).toBe(true);
    expect(retainMediaMoveUndoAfterError(new JourneyApiError(503, "REQUEST_FAILED", "retry"))).toBe(true);
    expect(retainMediaMoveUndoAfterError(new JourneyApiError(429, "RATE_LIMITED", "retry"))).toBe(true);
  });

  it("drops the descriptor for confirmed stale or other non-retryable failures", () => {
    expect(retainMediaMoveUndoAfterError(
      new JourneyApiError(409, "MEDIA_MOVE_UNDO_STALE", "stale"),
    )).toBe(false);
    expect(retainMediaMoveUndoAfterError(
      new JourneyApiError(400, "INVALID_MEDIA_MOVE_UNDO", "invalid"),
    )).toBe(false);
  });
});

describe("storyInitialMediaSelection (#18 follow-up)", () => {
  it("opens a Journey card on its explicit cover instead of visualMedia[0]", () => {
    const first = asset("first", "image/jpeg", 0, "first.jpg");
    const cover = asset("cover", "image/jpeg", 1, "cover.jpg");
    const withExplicitCover: Journey = {
      ...journey,
      coverMediaAssetId: cover.id,
      media: [first, cover],
    };

    expect(storyInitialMediaSelection(withExplicitCover, null)).toEqual({
      routePointId: null,
      assetIndex: 1,
      assetId: cover.id,
    });
  });


  it("restores an explicit logical asset within the requested Story scope", () => {
    const first = { ...asset("first", "image/jpeg", 0, "first.jpg"), routePointId: "point-1" };
    const returned = { ...asset("returned", "image/jpeg", 1, "returned.jpg"), routePointId: "point-1" };
    const withReturnedAsset: Journey = {
      ...journey,
      routePoints: [{
        id: "point-1", journeyId: journey.id, sortOrder: 0, latitude: 1, longitude: 2,
        label: "Point", isStop: true, occurredAt: null, createdAt: journey.createdAt,
      }],
      media: [first, returned],
    };
    expect(storyInitialMediaSelection(withReturnedAsset, "point-1", returned.id)).toEqual({
      routePointId: "point-1",
      assetIndex: 1,
      assetId: returned.id,
    });
  });

  it("publishes logical observation identity without viewport pixels or media internals", () => {
    const observedAsset = {
      ...asset("asset-d", "image/jpeg", 0, "asset-d.jpg"),
      routePointId: "point-d",
    };
    const observedJourney = { ...journey, media: [observedAsset] };
    expect(storyLogicalObservation(observedJourney, null, "asset-d", true, false)).toEqual({
      journeyId: journey.id,
      routePointId: "point-d",
      assetId: "asset-d",
      storySnapState: "in-context",
    });
    expect(storyLogicalObservation(observedJourney, null, "asset-d", true, true).storySnapState)
      .toBe("expanded");
    expect(storyLogicalObservation(observedJourney, "point-a", "deleted-asset", true, false))
      .toMatchObject({ routePointId: "point-a", assetId: null });
  });
  it("keeps whole-Journey mode when the explicit cover belongs to a route point", () => {
    const journeyLevel = asset("journey-level", "image/jpeg", 0, "journey.jpg");
    const pointFirst = {
      ...asset("point-first", "image/jpeg", 1, "point-first.jpg"),
      routePointId: "point-1",
    };
    const pointCover = {
      ...asset("point-cover", "image/jpeg", 2, "point-cover.jpg"),
      routePointId: "point-1",
    };
    const withPointCover: Journey = {
      ...journey,
      coverMediaAssetId: pointCover.id,
      routePoints: [{
        id: "point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳",
        isStop: true,
        occurredAt: null,
        note: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      }],
      media: [journeyLevel, pointFirst, pointCover],
    };

    expect(storyInitialMediaSelection(withPointCover, null)).toEqual({
      routePointId: null,
      assetIndex: 2,
      assetId: pointCover.id,
    });
    expect(storyInitialMediaSelection(withPointCover, "point-1")).toEqual({
      routePointId: "point-1",
      assetIndex: 0,
      assetId: pointFirst.id,
    });
  });
});



describe("storyMediaNeighborIndex (#76)", () => {
  it("does not wrap the whole-Journey narrative at either end", () => {
    expect(storyMediaNeighborIndex(0, 4, -1, false)).toBeNull();
    expect(storyMediaNeighborIndex(3, 4, 1, false)).toBeNull();
    expect(storyMediaNeighborIndex(1, 4, 1, false)).toBe(2);
  });

  it("preserves the existing wrap behavior for a route-point browse scope", () => {
    expect(storyMediaNeighborIndex(0, 4, -1, true)).toBe(3);
    expect(storyMediaNeighborIndex(3, 4, 1, true)).toBe(0);
  });
});

describe("storyAutoplayNextIndex (#76)", () => {
  it("stops at the end of the whole-Journey narrative", () => {
    expect(storyAutoplayNextIndex(0, 3, true)).toBe(1);
    expect(storyAutoplayNextIndex(2, 3, true)).toBeNull();
    expect(storyAutoplayNextIndex(0, 1, true)).toBeNull();
  });

  it("preserves route-point autoplay looping", () => {
    expect(storyAutoplayNextIndex(0, 3, false)).toBe(1);
    expect(storyAutoplayNextIndex(2, 3, false)).toBe(0);
    expect(storyAutoplayNextIndex(0, 1, false)).toBeNull();
  });
});

describe("shouldHoldWholeJourneyTerminalFrame (#76 review)", () => {
  it("keeps the final whole-Journey frame playing for its terminal interval", () => {
    expect(shouldHoldWholeJourneyTerminalFrame(2, 3, true)).toBe(true);
    expect(shouldHoldWholeJourneyTerminalFrame(0, 1, true)).toBe(true);
  });

  it("does not turn route-point or non-terminal frames into delayed stops", () => {
    expect(shouldHoldWholeJourneyTerminalFrame(1, 3, true)).toBe(false);
    expect(shouldHoldWholeJourneyTerminalFrame(2, 3, false)).toBe(false);
    expect(shouldHoldWholeJourneyTerminalFrame(0, 0, true)).toBe(false);
  });
});

describe("storyAutoplayVideoCandidate (#204 final review)", () => {
  const imageA = asset("image-a", "image/jpeg", 0, "a.jpg");
  const imageB = asset("image-b", "image/jpeg", 1, "b.jpg");
  const video = asset("video-1", "video/mp4", 2, "clip.mp4");

  it("prepares the first future video while autoplay is still on an image", () => {
    expect(storyAutoplayVideoCandidate([imageA, imageB, video], 0, true)?.id).toBe("video-1");
  });

  it("keeps the current video as the stable authorized element", () => {
    expect(storyAutoplayVideoCandidate([imageA, video], 1, true)?.id).toBe("video-1");
  });

  it("only wraps for a route-point autoplay loop", () => {
    expect(storyAutoplayVideoCandidate([video, imageA, imageB], 2, true)).toBeNull();
    expect(storyAutoplayVideoCandidate([video, imageA, imageB], 2, false)?.id).toBe("video-1");
  });
});

describe("storyAutoplayCanStart (#204 CFAA)", () => {
  const video = asset("video-ready", "video/mp4", 0, "clip.mp4");

  it("waits only while the candidate URL is unresolved", () => {
    expect(storyAutoplayCanStart(video, "waiting")).toBe(false);
    expect(storyAutoplayCanStart(video, "ready")).toBe(true);
  });

  it("does not deadlock autoplay after a failed candidate prefetch", () => {
    expect(storyAutoplayCanStart(video, "error")).toBe(true);
  });

  it("does not block an image-only sequence", () => {
    expect(storyAutoplayCanStart(null, "waiting")).toBe(true);
  });
});

describe("storyStageVideoOwner (#204 CFAA)", () => {
  const videoA = asset("video-a", "video/mp4", 0, "a.mp4");
  const videoB = asset("video-b", "video/mp4", 1, "b.mp4");
  const image = asset("image", "image/jpeg", 2, "image.jpg");

  it("prefers an incoming video over the previously settled video", () => {
    expect(storyStageVideoOwner(videoA, videoB, videoA)?.id).toBe("video-b");
  });

  it("keeps the settled video when the incoming asset is an image", () => {
    expect(storyStageVideoOwner(videoA, image, videoB)?.id).toBe("video-a");
  });

  it("uses the future autoplay candidate while an image is settled", () => {
    expect(storyStageVideoOwner(image, null, videoB)?.id).toBe("video-b");
  });
});

describe("storyAutoplayAdvance (#199 review)", () => {
  it("names what ends each step: next asset, terminal hold, or stop", () => {
    expect(storyAutoplayAdvance(0, 3, true)).toEqual({ kind: "advance", nextIndex: 1 });
    expect(storyAutoplayAdvance(2, 3, true)).toEqual({ kind: "hold-terminal" });
    expect(storyAutoplayAdvance(2, 3, false)).toEqual({ kind: "advance", nextIndex: 0 });
    expect(storyAutoplayAdvance(0, 1, false)).toEqual({ kind: "stop" });
    expect(storyAutoplayAdvance(0, 0, true)).toEqual({ kind: "stop" });
  });

  it("keeps the single whole-Journey asset on its terminal hold", () => {
    expect(storyAutoplayAdvance(0, 1, true)).toEqual({ kind: "hold-terminal" });
  });
});

describe("shouldRefreshStoryMediaRead (#204 final review)", () => {
  const now = 1_000_000;

  it("defers signed URL replacement for the video currently owned by Story autoplay", () => {
    expect(shouldRefreshStoryMediaRead(
      "video-1",
      { status: "ready", expiresAt: now + 30_000 },
      now,
      "video-1",
    )).toBe(false);
  });

  it("continues refreshing other expiring reads while autoplay owns a video", () => {
    expect(shouldRefreshStoryMediaRead(
      "image-2",
      { status: "ready", expiresAt: now + 30_000 },
      now,
      "video-1",
    )).toBe(true);
  });

  it("refreshes the video again after autoplay releases ownership", () => {
    expect(shouldRefreshStoryMediaRead(
      "video-1",
      { status: "ready", expiresAt: now + 30_000 },
      now,
      null,
    )).toBe(true);
  });

  it("does not refresh non-ready or non-expiring reads", () => {
    expect(shouldRefreshStoryMediaRead("video-1", { status: "loading" }, now, null)).toBe(false);
    expect(shouldRefreshStoryMediaRead(
      "video-1",
      { status: "ready", expiresAt: now + 120_000 },
      now,
      null,
    )).toBe(false);
  });
});

describe("storyNavigationTargetDisposition (#204 final review)", () => {
  const video = asset("video-nav", "video/mp4", 0, "clip.mp4");
  const image = asset("image-nav", "image/jpeg", 1, "frame.jpg");

  it("promotes terminal read failures so autoplay can advance past unavailable media", () => {
    expect(storyNavigationTargetDisposition(video, "error", false)).toBe("failed");
    expect(storyNavigationTargetDisposition(image, "error", false)).toBe("failed");
  });

  it("waits only for unresolved reads or undecoded images", () => {
    expect(storyNavigationTargetDisposition(video, "waiting", false)).toBe("waiting");
    expect(storyNavigationTargetDisposition(video, "ready", false)).toBe("ready");
    expect(storyNavigationTargetDisposition(image, "ready", false)).toBe("waiting");
    expect(storyNavigationTargetDisposition(image, "ready", true)).toBe("ready");
  });
});

describe("storyMediaAvailability (#199 review)", () => {
  it("maps signed-read status onto the shared playback vocabulary", () => {
    expect(storyMediaAvailability("ready")).toBe("ready");
    expect(storyMediaAvailability("error")).toBe("error");
    expect(storyMediaAvailability("loading")).toBe("waiting");
    expect(storyMediaAvailability(undefined)).toBe("waiting");
  });
});

describe("createStoryAutoplayFallbackController (#204 review)", () => {
  it("ignores a delayed play rejection after the owning effect is disposed", () => {
    const scheduled: string[] = [];
    const cleared: number[] = [];
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push("armed"); return 41; },
      (timer) => cleared.push(timer),
    );

    controller.dispose();
    controller.arm();

    expect(scheduled).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("cancels a transient watchdog and allows a later stall to re-arm it", () => {
    const scheduled: number[] = [];
    const cleared: number[] = [];
    let nextTimer = 42;
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push(nextTimer); return nextTimer++; },
      (timer) => cleared.push(timer),
    );

    controller.arm();
    controller.cancel();
    controller.arm();

    expect(scheduled).toEqual([42, 43]);
    expect(cleared).toEqual([42]);
  });

  it("clears an already-armed fallback and cannot re-arm after disposal", () => {
    const scheduled: string[] = [];
    const cleared: number[] = [];
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push("armed"); return 42; },
      (timer) => cleared.push(timer),
    );

    controller.arm();
    controller.dispose();
    controller.arm();

    expect(scheduled).toEqual(["armed"]);
    expect(cleared).toEqual([42]);
  });
});

describe("storyAutoplayWaitsForVideoEnd (#199 review)", () => {
  const video = asset("video-1", "video/mp4", 0, "clip.mp4");
  const image = asset("image-1", "image/jpeg", 1, "frame.jpg");

  it("lets a mounted, readable video own its own completion", () => {
    expect(storyAutoplayWaitsForVideoEnd(video, "ready", true)).toBe(true);
  });

  it("keeps the slide timer for anything that cannot report `ended`", () => {
    // An image step is always timed.
    expect(storyAutoplayWaitsForVideoEnd(image, "ready", true)).toBe(false);
    // No settled element for this asset yet, so nothing can fire `ended`.
    expect(storyAutoplayWaitsForVideoEnd(video, "ready", false)).toBe(false);
    // A failed read never produces a playable element.
    expect(storyAutoplayWaitsForVideoEnd(video, "error", true)).toBe(false);
    expect(storyAutoplayWaitsForVideoEnd(null, "ready", true)).toBe(false);
  });

  it("still waits on a video whose read is in flight once its element is attached", () => {
    expect(storyAutoplayWaitsForVideoEnd(video, "waiting", true)).toBe(true);
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

describe("storyImmersiveEntryKeepsPlaying (#199 follow-up review)", () => {
  const video = asset("video-1", "video/mp4", 0, "clip.mp4");

  it("carries a running sequence into fullscreen when the gesture can authorize the candidate", () => {
    expect(storyImmersiveEntryKeepsPlaying(true, video, "ready")).toBe(true);
    expect(storyImmersiveEntryKeepsPlaying(true, null, "ready")).toBe(true);
    // A failed read is terminal for this step; the existing playback policy
    // already degrades it through the timer, so the handoff is still honest.
    expect(storyImmersiveEntryKeepsPlaying(true, video, "error")).toBe(true);
  });

  it("stops the sequence rather than claiming a handoff it cannot authorize", () => {
    expect(storyImmersiveEntryKeepsPlaying(true, video, "waiting")).toBe(false);
  });

  it("never starts playback that the viewer did not ask for", () => {
    for (const availability of ["ready", "waiting", "error"] as const) {
      expect(storyImmersiveEntryKeepsPlaying(false, video, availability)).toBe(false);
      expect(storyImmersiveEntryKeepsPlaying(false, null, availability)).toBe(false);
    }
  });
});

describe("storyUploadedAssetIndex (#76 review)", () => {
  it("selects a deduplicated intro asset instead of the first route-point boundary", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const pointMedia = {
      ...asset("point", "image/jpeg", 1, "point.jpg"),
      routePointId: "point-1",
    };
    expect(storyUploadedAssetIndex([intro, pointMedia], [intro.id])).toBe(0);
  });

  it("selects the first successful newly uploaded asset by id", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const added = asset("added", "image/jpeg", 1, "added.jpg");
    const pointMedia = {
      ...asset("point", "image/jpeg", 2, "point.jpg"),
      routePointId: "point-1",
    };
    expect(storyUploadedAssetIndex([intro, added, pointMedia], [added.id])).toBe(1);
  });

  it("returns null when refresh cannot find any successful uploaded asset", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    expect(storyUploadedAssetIndex([intro], ["missing"])).toBeNull();
  });
});

describe("aggregate organizer ownership (#76 review)", () => {
  it("keeps organizer reorder neighbors within the active ownership chapter", () => {
    const pointA1 = { ...asset("a1", "image/jpeg", 0), routePointId: "point-a" };
    const pointB = { ...asset("b", "image/jpeg", 1), routePointId: "point-b" };
    const pointA2 = { ...asset("a2", "image/jpeg", 2), routePointId: "point-a" };
    expect(storyChapterMedia([pointA1, pointA2, pointB], pointA1).map((item) => item.id))
      .toEqual(["a1", "a2"]);
  });

  it("offers the journey-level destination when aggregate selection includes chapter media", () => {
    const intro = asset("intro", "image/jpeg", 0);
    const point = { ...asset("point", "image/jpeg", 1), routePointId: "point-a" };
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([point.id])))
      .toBe(true);
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([intro.id])))
      .toBe(false);
  });

  it("captures mixed previous ownership and full order for server-backed move undo", () => {
    const intro = asset("intro", "image/jpeg", 0);
    const pointA = { ...asset("point-a-media", "image/jpeg", 1), routePointId: "point-a" };
    const pointB = { ...asset("point-b-media", "video/mp4", 2), routePointId: "point-b" };
    const track = asset("track", "audio/mpeg", 3);
    const source: Journey = { ...journey, media: [intro, pointA, pointB, track] };

    expect(mediaMoveUndoForSelection(
      source,
      [pointB.id, intro.id],
      "point-a",
    )).toEqual({
      journeyId: source.id,
      expectedRoutePointId: "point-a",
      assignments: [
        { assetId: intro.id, routePointId: null },
        { assetId: pointB.id, routePointId: "point-b" },
      ],
      assetOrder: [intro.id, pointA.id, pointB.id, track.id],
    });
    expect(mediaMoveUndoForSelection(source, ["missing"], "point-a")).toBeNull();
  });
});

describe("storyAssetIndexForId (#76)", () => {
  it("keeps the settled asset selected when a reassignment changes sequence order", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const moved = asset("moved", "image/jpeg", 1, "moved.jpg");
    const other = asset("other", "image/jpeg", 2, "other.jpg");
    expect(storyAssetIndexForId([intro, other, moved], moved.id, 1)).toBe(2);
  });

  it("clamps the numeric fallback when the settled asset disappeared", () => {
    const only = asset("only", "image/jpeg", 0, "only.jpg");
    expect(storyAssetIndexForId([only], "gone", 4)).toBe(0);
  });
});

describe("replaceJourneySoundtrack", () => {
  const file = { name: "night.mp3", size: 64, type: "audio/mpeg" } as File;

  it("uploads and confirms the new track before removing the old one", async () => {
    const calls: string[] = [];
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const upload = vi.fn(async () => {
      calls.push("upload");
      return { uploadedCount: 1, mediaErrors: [], assets: [] };
    });
    const refresh = vi.fn(async () => {
      calls.push("refresh");
      return journey;
    });
    const remove = vi.fn(async () => {
      calls.push("remove");
    });

    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: upload as never,
      refresh,
      remove,
    });

    expect(calls).toEqual(["upload", "refresh", "remove", "refresh"]);
    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({
      uploaded: true,
      refreshFailed: false,
      cleanupFailed: false,
    });
  });

  it("keeps the track when replacing it with the exact same file", async () => {
    // Soundtracks are always small enough to be content hashed, so the server
    // deduplicates this upload to the asset that is already active.
    const previous = asset("old-track", "audio/mpeg", 0, "night.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: previous.id,
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey-1/old-track",
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: true,
      unchanged: true,
      cleanupFailed: false,
    });
  });

  it("still replaces when the upload resolves to a different asset", async () => {
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: "new-track",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey-1/new-track",
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({ uploaded: true, unchanged: false });
  });

  it("keeps the previous track when the new upload fails", async () => {
    const remove = vi.fn();
    const refresh = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({
        uploadedCount: 0,
        mediaErrors: [{ fileIndex: 0, fileName: "night.mp3", message: "storage unavailable" }],
        assets: [],
      })) as never,
      refresh,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: false,
      uploadError: "storage unavailable",
    });
  });

  it("reports a failed cleanup without discarding the new track", async () => {
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => journey,
      remove: async () => {
        throw new Error("delete failed");
      },
    });

    expect(result).toMatchObject({ uploaded: true, cleanupFailed: true });
  });

  it("skips removal for a journey that had no soundtrack", async () => {
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: null,
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => null,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    // A refresh that returns nothing is reported, not silently swallowed.
    expect(result).toMatchObject({ uploaded: true, refreshFailed: true });
  });
});

describe("JourneyStory", () => {
  it("opens desktop Story in reading mode with an explicit edit entry", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="退出旅程故事"');
    expect(markup).toContain('class="journey-story__close"');
    expect(markup).toContain('data-story-layout="desktop"');
    expect(markup).not.toContain('data-story-editing="true"');
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).not.toContain(">退出<");
    expect(markup).not.toContain("添加照片或视频");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).not.toContain("ROUTE POINTS");
    expect(markup).not.toContain("story-media-rail");
    expect(markup).not.toContain("确认删除");
    expect(journeyDeleteDescription(journey)).toBe(
      "先从图谱隐藏；7 天内可撤销，之后才会清理路线和 0 个私有媒体。",
    );
  });

  it("opens a selected route point and scopes its media", () => {
    const pointJourney: Journey = {
      ...journey,
      routePoints: [{
        id: "point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳",
        isStop: true,
        occurredAt: null,
        createdAt: journey.createdAt,
      }],
      media: [{
        id: "media-1",
        journeyId: journey.id,
        routePointId: "point-1",
        storageDriver: "test",
        storageKey: "point-1/photo.jpg",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: 0,
        uploadedByUserId: "user-1",
        createdAt: journey.createdAt,
      }],
    };

    expect(mediaForRoutePoint(pointJourney, "point-1")).toHaveLength(1);
    expect(mediaForRoutePoint(pointJourney, null)).toHaveLength(0);
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [pointJourney],
      journeyId: pointJourney.id,
      routePointId: "point-1",
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).toContain('data-route-point-id="point-1"');
    expect(markup).toContain("深圳");
    expect(markup).toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("1 个媒体片段");
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
  });

  it("hides the media removal control when the scoped media is empty", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
  });

  it("keeps desktop picture navigation separate from fullscreen and playback controls", () => {
    const multiMediaJourney: Journey = {
      ...journey,
      media: [
        {
          id: "media-1",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey/first.jpg",
          fileName: "first.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 0,
          uploadedByUserId: "user-1",
          createdAt: journey.createdAt,
        },
        {
          id: "media-2",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey/second.jpg",
          fileName: "second.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 1,
          uploadedByUserId: "user-1",
          createdAt: journey.createdAt,
        },
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [multiMediaJourney],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain('aria-label="上一个媒体"');
    expect(markup).not.toContain('aria-label="下一个媒体"');
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).toContain('aria-label="自动播放媒体"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="全屏查看媒体"');
    expect(markup).toContain('aria-label="first.jpg。左侧上一张，右侧下一张，方向键切换"');
    expect(markup).toContain('aria-keyshortcuts="ArrowLeft ArrowRight"');
    const mediaNavigation = markup.match(/<nav class="journey-story__media-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(mediaNavigation).toBeDefined();
    expect(mediaNavigation?.match(/<button\b/g)).toHaveLength(2);
    expect(mediaNavigation).not.toContain("1 / 2");
  });

  it("reports only expanded/fullscreen Story as opaque globe cover while transitions stay live", () => {
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: false, fullscreen: false, coverTransitionActive: false }))
      .toEqual({ opaqueMediaCover: false, coverTransitionActive: false });
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: true, fullscreen: false, coverTransitionActive: true }))
      .toEqual({ opaqueMediaCover: true, coverTransitionActive: true });
    expect(storyGlobeCoverState({ mobileLayout: false, mobileStoryExpanded: true, fullscreen: false, coverTransitionActive: false }))
      .toEqual({ opaqueMediaCover: false, coverTransitionActive: false });
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: false, fullscreen: true, coverTransitionActive: true }))
      .toEqual({ opaqueMediaCover: true, coverTransitionActive: false });
  });

  it("clears expanded Story state across a compact breakpoint round trip", () => {
    const expandedOnMobile = mobileStoryExpandedForLayout(true, true);
    const afterDesktop = mobileStoryExpandedForLayout(false, expandedOnMobile);
    const backOnMobile = mobileStoryExpandedForLayout(true, afterDesktop);

    expect(expandedOnMobile).toBe(true);
    expect(afterDesktop).toBe(false);
    expect(backOnMobile).toBe(false);
  });

  it("orders migrated mobile mutation history under Manage while keeping Viewer fullscreen independent", () => {
    const migratedJourneyDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: true,
    });
    expect(migratedJourneyDelete).toEqual({
      manage: false,
      mediaSurface: false,
      journeyDelete: false,
    });

    const settledJourneyDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: true,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: true,
    });
    expect(settledJourneyDelete).toEqual({
      manage: true,
      mediaSurface: false,
      journeyDelete: true,
    });

    const migratedMediaDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: true,
      journeyDeleteOpen: false,
    });
    expect(migratedMediaDelete.mediaSurface).toBe(false);
    expect(mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: true,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: true,
      journeyDeleteOpen: false,
    }).mediaSurface).toBe(true);

    expect(mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: true,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: false,
    }).mediaSurface).toBe(true);
  });

  it("keeps the mobile media stage gesture-first instead of rendering the desktop toolbar", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const mobileJourney: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0, "first.jpg"),
        asset("media-2", "image/jpeg", 1, "second.jpg"),
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [mobileJourney],
      journeyId: mobileJourney.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-layout="true"');
    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('data-mobile-presentation="in-context"');
    expect(markup).toContain('aria-label="展开旅程故事"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).not.toContain('aria-label="管理当前媒体"');
    expect(markup).not.toContain("添加照片或视频");
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain("journey-story__media-nav");
    // #204 CFAA: fullscreen keeps a persistent, hidden stage so its video node
    // can be authorized during the entry gesture; its nav may exist in SSR but
    // must remain inside the hidden overlay until fullscreen is entered.
    expect(markup).toContain('<div hidden="" style="display:none" class="journey-story-fullscreen');
    expect(markup).toContain('class="journey-story-fullscreen__nav"');
    expect(markup).not.toContain("全部照片");
    // #199: playback is the one Viewer control that survives the toolbar cut.
    expect(markup).toContain("journey-story__mobile-media-play");
    expect(markup).toContain('aria-label="自动播放媒体"');
    expect(markup).not.toContain("journey-story__mobile-media-sheet");
  });

  it("keeps mobile Story playback in the Viewer cluster only for multi-media scopes (#199)", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const single = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [asset("media-1", "image/jpeg", 0)] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    // One asset is not a sequence, so the control would promise nothing.
    expect(single).not.toContain("journey-story__mobile-media-play");
    expect(single).toContain('aria-label="管理旅程"');

    const sequence = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{
        ...journey,
        media: [
          asset("media-1", "image/jpeg", 0),
          asset("media-2", "video/mp4", 1),
        ],
      }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    // Mixed image/video still reads as one playable sequence, and the control
    // sits in the Viewer action cluster rather than the management sheet.
    expect(sequence).toContain('class="icon-action-button journey-story__mobile-media-play"');
    expect(sequence).toContain('aria-label="自动播放媒体"');
    expect(sequence).toContain('aria-pressed="false"');
    expect(sequence).not.toContain("journey-story__mobile-media-sheet");
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeGreaterThan(sequence.indexOf('class="journey-story__mobile-media-actions"'));
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-menu-trigger"));
  });

  it("gives mobile Viewer the immersive entry the manage sheet used to own (#199)", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const render = (media: JourneyMediaAsset[]) => renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    const sequence = render([
      asset("media-1", "image/jpeg", 0),
      asset("media-2", "video/mp4", 1),
    ]);
    expect(sequence).toContain('class="icon-action-button journey-story__mobile-media-fullscreen"');
    expect(sequence).toContain('aria-label="沉浸查看媒体"');
    // Immersive viewing is a viewing action: it sits in the Viewer cluster and
    // the management sheet is not even mounted here.
    expect(sequence).not.toContain("journey-story__mobile-media-sheet");
    // Focus order follows the rendered row: immersive, playback, management.
    expect(
      sequence.indexOf("journey-story__mobile-media-fullscreen"),
    ).toBeGreaterThan(sequence.indexOf('class="journey-story__mobile-media-actions"'));
    expect(
      sequence.indexOf("journey-story__mobile-media-fullscreen"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-play"));
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-menu-trigger"));

    // A single asset has no sequence to play, so the immersive entry takes the
    // playback slot rather than leaving a hole in the row.
    const single = render([asset("media-1", "image/jpeg", 0)]);
    expect(single).toContain("journey-story__mobile-media-fullscreen is-compact");
    expect(single).not.toContain("journey-story__mobile-media-play");
    expect(single).toContain('aria-label="沉浸查看媒体"');

    // The words that used to name the management-sheet action are gone from the
    // product entirely; the Viewer entry is media-aware and count-independent.
    for (const markup of [sequence, single]) {
      expect(markup).not.toContain("沉浸播放</");
      expect(markup).not.toContain("沉浸查看</");
      expect(markup).not.toContain("自动播放照片");
    }
  });

  it("keeps mobile management reachable when the selected media scope is empty", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).toContain('data-story-layout="mobile"');
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).not.toContain("添加照片或视频");
    vi.unstubAllGlobals();
  });

  it("keeps singleton and multi-media reading views free of the editing overview", () => {
    const single = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [asset("media-1", "image/jpeg", 0)] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(single).not.toContain("全部照片");
    expect(single).toContain('aria-label="编辑故事"');
    expect(single).toContain('aria-label="旅程媒体"');
    expect(single).toContain('aria-pressed="false"');

    const many: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("media-3", "video/mp4", 2),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [many],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).not.toContain("全部照片");
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).toContain('aria-pressed="false"');
    // The editable grid only appears after entering Story editing.
    expect(markup).not.toContain("journey-story__media-grid");
    expect(markup).not.toContain("story-media-organizer");
    expect(markup).not.toContain("story-media-rail");
    expect(markup).not.toContain("3 个媒体片段");
  });

  it("keeps a soundtrack out of the photo counts and shows it as audio", () => {
    const scored: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("track", "audio/mpeg", 2, "night-route.mp3"),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [scored],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("JOURNEY SOUNDTRACK");
    // #7: the presentation strips the file extension — the UI shows the
    // friendly name, never `night-route.mp3`.
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).not.toContain("替换配乐");
    expect(markup).not.toContain("移除配乐");
    // Audio never becomes a third item in the visual reading sequence.
    expect(markup).toContain('data-media-page-id="media-1"');
    expect(markup).toContain('data-media-page-id="media-2"');
    expect(markup).not.toContain('data-media-page-id="track"');
    // The light strip replaces the native control bar. (The <audio> playback
    // engine only mounts once the signed read resolves at runtime.)
    expect(markup).toContain("journey-story__soundtrack-light");
  });

  it("keeps a soundtrack-only journey silent and free of a broken cover", () => {
    const soundtrackOnly: Journey = {
      ...journey,
      media: [asset("track", "audio/mpeg", 0, "night-route.mp3")],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [soundtrackOnly],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("整段旅程还没有媒体");
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).not.toContain("全部照片");
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
  });

  it("omits empty soundtrack controls from the reading view", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("还没有配乐，幻灯片会安静播放");
    expect(markup).not.toContain("上传配乐");
    expect(markup).not.toContain("journey-story__soundtrack");
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("移除配乐");
  });

  it("keeps Story editing reachable without a journey deletion callback", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
  });
});


describe("placement analysis supersession (#113)", () => {
  const point = (id: string, owner = "journey-1") => ({
    id, journeyId: owner, sortOrder: 0, label: id, latitude: 1, longitude: 1, occurredAt: null, note: null, isStop: true, createdAt: journey.createdAt,
  });
  const withPoints = (base: Journey, ids: string[]): Journey => ({ ...base, routePoints: ids.map((id) => point(id, base.id)) });

  it("drops Journey A analysis after Journey B becomes the scope, so late A cannot review or upload", () => {
    const authority = createPlacementAnalysisAuthority();
    const journeyA = withPoints(journey, ["a1"]);
    const journeyB = withPoints({ ...journey, id: "journey-2", title: "B" }, ["b1"]);
    const a = placementAnalysisScope([journeyA, journeyB], journeyA.id, "a1");
    authority.syncScope(a);
    const intentA = authority.start(a);
    const b = placementAnalysisScope([journeyA, journeyB], journeyB.id, "b1");
    authority.syncScope(b);
    const review = vi.fn();
    const upload = vi.fn();
    if (authority.isCurrent(intentA, b)) { review(); upload(); }
    expect(review).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps analysis B active when stale A reaches finally", () => {
    const authority = createPlacementAnalysisAuthority();
    const scope = placementAnalysisScope([withPoints(journey, ["p1"])], journey.id, "p1");
    authority.syncScope(scope);
    const intentA = authority.start(scope);
    const intentB = authority.start(scope);
    expect(authority.isCurrent(intentA, scope)).toBe(false);
    expect(authority.isCurrent(intentB, scope)).toBe(true);
  });

  it("invalidates an analysis when the same Journey switches Route Point", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1", "p2"]);
    const p1 = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(p1);
    const intent = authority.start(p1);
    const p2 = placementAnalysisScope([current], current.id, "p2");
    authority.syncScope(p2);
    expect(authority.isCurrent(intent, p2)).toBe(false);
  });

  it("invalidates analysis when its Journey or captured Route Point leaves current membership", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    const deleted = placementAnalysisScope([], current.id, "p1");
    authority.syncScope(deleted);
    expect(deleted.valid).toBe(false);
    expect(authority.isCurrent(intent, deleted)).toBe(false);
  });

  it("rejects every late commit after Story unmount", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    authority.dispose();
    expect(authority.isCurrent(intent, scope)).toBe(false);
  });

  it("keeps the unchanged #86 current-scope happy path authoritative", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    expect(authority.isCurrent(intent, scope)).toBe(true);
  });
});
