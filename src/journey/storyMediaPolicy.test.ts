import { describe, expect, it } from "vitest";
import {
  storyLogicalObservation,
  storyMediaNeighborIndex,
  storyAssetIndexForId,
  indexStoryMedia,
  storyMediaInOptimisticOrder,
  storyAutoplayNextIndex,
  storyAutoplayVideoCandidate,
  storyNavigationTargetDisposition,
  storyAutoplayCanStart,
  storyImmersiveEntryKeepsPlaying,
  storyStageVideoOwner,
  storyAutoplayAdvance,
  storyMediaAvailability,
  storyAutoplayWaitsForVideoEnd,
  shouldHoldWholeJourneyTerminalFrame,
  storyUploadedAssetIndex,
  mediaForUploadRefreshScope,
  groupedPlacementRefreshSelection,
  storyInitialMediaSelection,
} from "./storyMediaPolicy";
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

describe("Story scoped media projection", () => {
  it("preserves optimistic order, drops deleted ids and appends new scoped assets", () => {
    const first = asset("first", "image/jpeg", 0);
    const second = asset("second", "video/mp4", 1);
    const uploaded = asset("uploaded", "image/jpeg", 2);
    const media = [first, second, uploaded];
    const localOrder = ["deleted", "second", "first", "outside-scope"];

    expect(storyMediaInOptimisticOrder(media, localOrder)).toEqual([second, first, uploaded]);
    expect(storyMediaInOptimisticOrder(media, null)).toBe(media);
    expect(storyMediaInOptimisticOrder(media, [])).toEqual(media);
    expect(media).toEqual([first, second, uploaded]);
    expect(localOrder).toEqual(["deleted", "second", "first", "outside-scope"]);
  });

  it("indexes only the current visual scope and replaces removed or moved identities", () => {
    const original: Journey = {
      ...journey,
      routePoints: [
        { id: "a", journeyId: journey.id, sortOrder: 0, label: "A", latitude: 1, longitude: 1, occurredAt: null, isStop: true, createdAt: journey.createdAt },
        { id: "b", journeyId: journey.id, sortOrder: 1, label: "B", latitude: 2, longitude: 2, occurredAt: null, isStop: true, createdAt: journey.createdAt },
      ],
      media: [
        { ...asset("late-a", "video/mp4", 5), routePointId: "a" },
        { ...asset("early-a", "image/jpeg", 1), routePointId: "a" },
        { ...asset("other-b", "image/jpeg", 0), routePointId: "b" },
        asset("intro", "image/jpeg", 8),
        asset("soundtrack", "audio/mpeg", 0),
      ],
    };
    const scopeA = mediaForUploadRefreshScope(original, "a");
    const first = indexStoryMedia(scopeA);
    expect([...first.indexById]).toEqual([["early-a", 0], ["late-a", 1]]);
    expect(first.byId.get("late-a")).toBe(original.media[0]);
    for (const unavailable of ["other-b", "intro", "soundtrack", "missing"]) {
      expect(first.byId.has(unavailable)).toBe(false);
      expect(storyAssetIndexForId(scopeA, unavailable, 9, first.indexById)).toBe(1);
    }

    const changed: Journey = { ...original, media: [
      { ...original.media[0], routePointId: "b" },
      original.media[2],
      { ...asset("uploaded-a", "image/jpeg", 0), routePointId: "a" },
    ] };
    const nextScopeA = mediaForUploadRefreshScope(changed, "a");
    const next = indexStoryMedia(nextScopeA);
    expect([...next.indexById]).toEqual([["uploaded-a", 0]]);
    expect(next.byId.has("early-a")).toBe(false);
    expect(next.byId.has("late-a")).toBe(false);
    expect(storyAssetIndexForId(nextScopeA, "late-a", 1, next.indexById)).toBe(0);
    expect(storyMediaInOptimisticOrder(nextScopeA, ["late-a", "early-a"]))
      .toEqual(nextScopeA);

    const scopeB = mediaForUploadRefreshScope(changed, "b");
    const other = indexStoryMedia(scopeB);
    expect([...other.indexById]).toEqual([["other-b", 0], ["late-a", 1]]);
    expect(other.byId.get("late-a")).toBe(changed.media[0]);
    expect(first.byId.get("late-a")?.routePointId).toBe("a");
    expect(storyAssetIndexForId(scopeB, "late-a", 0, other.indexById)).toBe(1);
  });

  it("preserves first-match lookup and fallback bounds for empty or repeated identities", () => {
    const original = asset("same", "image/jpeg", 0);
    const repeated = asset("same", "video/mp4", 1);
    const media = [original, repeated];
    const index = indexStoryMedia(media);
    expect(index.byId.get("same")).toBe(original);
    expect(storyAssetIndexForId(media, "same", 1, index.indexById)).toBe(0);
    expect(storyAssetIndexForId(media, null, -4, index.indexById)).toBe(0);
    expect(storyAssetIndexForId([], "same", 4, indexStoryMedia([]).indexById)).toBe(0);
    // Optimistic ordering still follows its existing last-value Map behavior;
    // indexing does not introduce deduplication or rewrite the media input.
    expect(storyMediaInOptimisticOrder(media, ["same", "same"]))
      .toEqual([repeated, repeated]);
  });
});
