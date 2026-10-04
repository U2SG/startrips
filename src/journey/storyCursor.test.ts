import { describe, expect, it } from "vitest";
import {
  storyActiveChapterRoutePointId,
  storyAutoplayAdvance,
  storyAutoplayVideoCandidate,
  storyCursorClampEntry,
  storyCursorEntryForPageId,
  storyCursorAssetIdForPage,
  storyCursorPageId,
  storyAutoplayVideoCandidateIndex,
  storyCursorEntryForMediaIndex,
  storyCursorForJourney,
  storyCursorMediaIndex,
  storyCursorNeighbourEntry,
  storyCursorOnJourneyCover,
  storyInitialCursorSelection,
  storyInitialMediaSelection,
  storyObservedTarget,
  storyStagePages,
  storyStepAvailability,
  storyUploadedEntryIndex,
} from "./storyMediaPolicy";
import { playbackStoryMedia } from "./journeyPlayback";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

// #555: Story's cursor is an index into presentation entries. With the Journey
// cover opening active the entries are [opening(b1), a1, b1, b2, c1]; the
// canonical media stays [a1, b1, b2, c1].
const createdAt = "2026-08-11T00:00:00.000Z";

function point(id: string, sortOrder: number, note: string | null = null): RoutePoint {
  return {
    id, journeyId: "journey-1", sortOrder, label: id, latitude: sortOrder, longitude: sortOrder,
    occurredAt: null, note, isStop: true, createdAt,
  };
}

function asset(id: string, routePointId: string | null, sortOrder: number, mimeType = "image/jpeg"): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-1",
    routePointId,
    storageDriver: "test",
    storageKey: `journey-1/${id}`,
    fileName: `${id}.bin`,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt,
  };
}

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
  createdAt,
  updatedAt: createdAt,
  coverMediaAssetId: "b1",
  routePoints: [point("A", 0, "A note"), point("B", 1, "B note"), point("C", 2)],
  media: [
    asset("a1", "A", 0),
    asset("b1", "B", 1),
    asset("b2", "B", 2),
    asset("c1", "C", 3),
    asset("track", null, 4, "audio/mpeg"),
  ],
};

const freshOpen = { routePointId: null, assetId: null, presentJourneyCoverOpening: true };

function initialCursor(
  target: Journey,
  request: { routePointId: string | null; assetId: string | null; presentJourneyCoverOpening: boolean },
) {
  const media = storyInitialMediaSelection(target, request.routePointId, request.assetId);
  return storyInitialCursorSelection(target, media, request);
}

describe("storyCursorForJourney (#555)", () => {
  it("puts the opening in front of the full canonical sequence and maps entries to canonical media", () => {
    const cursor = storyCursorForJourney(journey, true);
    expect(cursor.entries.map((entry) => `${entry.role}:${entry.asset?.id}`)).toEqual([
      "journey-cover:b1", "media:a1", "media:b1", "media:b2", "media:c1",
    ]);
    expect(cursor.entries[0]).toMatchObject({ routePointId: null, contextOwner: "journey" });
    expect(cursor.entries[2]).toMatchObject({ routePointId: "B", contextOwner: "route-point" });
    expect(cursor.firstCanonicalEntry).toBe(1);
    expect(cursor.mediaIndexByEntry).toEqual([1, 0, 1, 2, 3]);
    expect(cursor.entryIndexByMediaIndex).toEqual([1, 2, 3, 4]);
    expect(storyCursorEntryForMediaIndex(cursor, 0)).toBe(1);
    expect(storyCursorMediaIndex(cursor, 0)).toBe(1);
    expect(storyCursorOnJourneyCover(cursor, 0)).toBe(true);
    expect(storyCursorOnJourneyCover(cursor, 2)).toBe(false);
    // Canonical media is untouched: counts and "i of n" never see the opening.
    expect(playbackStoryMedia(journey).map((item) => item.id)).toEqual(["a1", "b1", "b2", "c1"]);
  });

  it("is the canonical sequence when the opening is not active for this open", () => {
    const cursor = storyCursorForJourney(journey, false);
    expect(cursor.entries.map((entry) => entry.asset?.id)).toEqual(["a1", "b1", "b2", "c1"]);
    expect(cursor.firstCanonicalEntry).toBe(0);
    expect(storyCursorEntryForMediaIndex(cursor, 2)).toBe(2);
  });
});

describe("storyInitialCursorSelection (#555)", () => {
  it("opens a genuine whole-Journey entry on the opening", () => {
    expect(initialCursor(journey, freshOpen)).toEqual({
      withJourneyCoverOpening: true, entryIndex: 0, assetId: "b1", pageId: "journey-cover:journey-1:b1",
    });
  });

  it("never presents the opening for a deep link or a Playback return", () => {
    // A Route Point deep link starts on that Route Point's canonical media.
    expect(initialCursor(journey, { ...freshOpen, routePointId: "C" })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 3, assetId: "c1", pageId: "c1",
    });
    // An asset deep link starts on that asset's canonical entry.
    expect(initialCursor(journey, { ...freshOpen, routePointId: "B", assetId: "b2" })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 2, assetId: "b2", pageId: "b2",
    });
    // A Playback return can resolve to null/null; without the explicit signal it
    // lands on the canonical cover entry, exactly as before.
    expect(initialCursor(journey, { ...freshOpen, presentJourneyCoverOpening: false })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 1, assetId: "b1", pageId: "b1",
    });
  });

  it("presents no opening when the Journey has no visual media", () => {
    const silent: Journey = { ...journey, coverMediaAssetId: null, media: [asset("track", null, 0, "audio/mpeg")] };
    expect(initialCursor(silent, freshOpen)).toEqual({
      withJourneyCoverOpening: false, entryIndex: 0, assetId: null, pageId: null,
    });
    expect(storyCursorForJourney(silent, true).entries).toEqual([]);
  });
});

describe("Story cursor stepping with the one-way opening (#555)", () => {
  const cursor = storyCursorForJourney(journey, true);
  const last = cursor.entries.length - 1;

  it("goes nowhere back from the opening and enters canonical entry 0 forward", () => {
    expect(storyCursorNeighbourEntry(cursor, 0, -1, true)).toBeNull();
    expect(storyCursorNeighbourEntry(cursor, 0, -1, false)).toBeNull();
    expect(storyCursorNeighbourEntry(cursor, 0, 1, true)).toBe(1);
    expect(storyStepAvailability(0, cursor.entries.length, cursor.firstCanonicalEntry))
      .toEqual({ previous: false, next: true });
  });

  it("wraps the Journey boundary onto canonical entry 0, never back onto the opening", () => {
    expect(storyCursorNeighbourEntry(cursor, last, 1, true)).toBe(1);
    expect(storyCursorNeighbourEntry(cursor, last, 1, false)).toBeNull();
    expect(storyAutoplayAdvance(last, cursor.entries.length, cursor.firstCanonicalEntry))
      .toEqual({ kind: "advance", nextIndex: 1 });
    expect(storyAutoplayAdvance(0, cursor.entries.length, cursor.firstCanonicalEntry))
      .toEqual({ kind: "advance", nextIndex: 1 });
    expect(storyStepAvailability(last, cursor.entries.length, cursor.firstCanonicalEntry))
      .toEqual({ previous: true, next: false });
  });

  it("still wraps Previous from canonical entry 0 to the end of the Journey", () => {
    expect(storyCursorNeighbourEntry(cursor, 1, -1, true)).toBe(last);
    expect(storyCursorNeighbourEntry(cursor, 1, -1, false)).toBeNull();
    expect(storyStepAvailability(1, cursor.entries.length, cursor.firstCanonicalEntry))
      .toEqual({ previous: false, next: true });
  });

  it("leaves the opening of a single-media Journey and then stops", () => {
    const single: Journey = { ...journey, media: [asset("b1", "B", 0)] };
    const one = storyCursorForJourney(single, true);
    expect(one.entries.map((entry) => entry.role)).toEqual(["journey-cover", "media"]);
    expect(storyCursorNeighbourEntry(one, 0, 1, true)).toBe(1);
    expect(storyCursorNeighbourEntry(one, 1, 1, true)).toBeNull();
    expect(storyCursorNeighbourEntry(one, 1, -1, true)).toBeNull();
    expect(storyAutoplayAdvance(1, 2, 1)).toEqual({ kind: "stop" });
  });

  it("keeps the plain Journey-wide rules when there is no opening", () => {
    const plain = storyCursorForJourney(journey, false);
    expect(storyCursorNeighbourEntry(plain, 0, -1, true)).toBe(3);
    expect(storyCursorNeighbourEntry(plain, 3, 1, true)).toBe(0);
    expect(storyStepAvailability(0, 4)).toEqual({ previous: false, next: true });
  });

  it("looks ahead for a video the way the cursor wraps", () => {
    const video = asset("video", null, 0, "video/mp4");
    const imageA = asset("image-a", null, 1);
    const imageB = asset("image-b", null, 2);
    // Index 0 stands for the opening: the lookahead from the end wraps to
    // canonical entry 1 and never reconsiders the opening.
    expect(storyAutoplayVideoCandidate([video, imageA, imageB], 2, 1)).toBeNull();
    expect(storyAutoplayVideoCandidate([video, imageA, imageB], 0, 1)?.id).toBe("video");
    expect(storyAutoplayVideoCandidate([video, imageA, imageB], 2)?.id).toBe("video");
  });
});

describe("Story stage page identity (#555)", () => {
  const OPENING = "journey-cover:journey-1:b1";
  const cursor = storyCursorForJourney(journey, true);

  it("gives the opening and the canonical cover two pages of one asset", () => {
    expect(cursor.pageIds).toEqual([OPENING, "a1", "b1", "b2", "c1"]);
    expect(storyCursorPageId(cursor.entries[0])).toBe(OPENING);
    expect(storyCursorPageId(cursor.entries[2])).toBe("b1");
    expect([...cursor.pageAssetIds]).toEqual([[OPENING, "b1"]]);
    expect(storyCursorAssetIdForPage(cursor, OPENING)).toBe("b1");
    expect(storyCursorAssetIdForPage(cursor, "b1")).toBe("b1");
    // A canonical-only cursor needs no mapping: every page id is its asset id.
    expect(storyCursorForJourney(journey, false).pageAssetIds.size).toBe(0);
  });

  it("turns a page id back into exactly its own entry", () => {
    expect(storyCursorEntryForPageId(cursor, OPENING, 3)).toBe(0);
    expect(storyCursorEntryForPageId(cursor, "b1", 0)).toBe(2);
    expect(storyCursorEntryForPageId(cursor, "c1", 0)).toBe(4);
  });

  it("keeps an unknown page on the current position without moving anyone onto the opening", () => {
    expect(storyCursorEntryForPageId(cursor, "missing", 0)).toBe(0);
    expect(storyCursorEntryForPageId(cursor, null, 3)).toBe(3);
    expect(storyCursorEntryForPageId(cursor, "missing", 9)).toBe(4);
    expect(storyCursorClampEntry(cursor, -1)).toBe(1);
  });

  it("lands an upload refresh on a canonical entry, never on the opening", () => {
    const refreshed = storyCursorForJourney({
      ...journey,
      media: [...journey.media, asset("b3", "B", 5)],
    }, true);
    expect(storyUploadedEntryIndex(refreshed, ["b3"])).toBe(4);
    // Re-uploading onto the cover's own Route Point still names the cover's
    // canonical entry, not the opening that shares its asset.
    expect(storyUploadedEntryIndex(refreshed, ["b1"])).toBe(2);
    expect(storyUploadedEntryIndex(refreshed, ["missing", "c1"])).toBe(5);
    expect(storyUploadedEntryIndex(refreshed, ["missing"])).toBeNull();
  });

  it("names the page of the autoplay video candidate, not just its asset", () => {
    const withVideo = storyCursorForJourney({
      ...journey, media: [...journey.media, asset("v1", "C", 6, "video/mp4")],
    }, true);
    const index = storyAutoplayVideoCandidateIndex(withVideo.assets, 0, withVideo.firstCanonicalEntry);
    expect(index).toBe(5);
    expect(withVideo.pageIds[index!]).toBe("v1");
  });
});

describe("Journey context on the opening (#555)", () => {
  const cover = { ...asset("b1", "B", 1) };
  const cursor = storyCursorForJourney(journey, true);

  it("names no chapter on the opening, and the cover's Route Point on its own entry", () => {
    expect(storyActiveChapterRoutePointId({ routePointId: cover.routePointId }, true, null, true)).toBeNull();
    expect(storyActiveChapterRoutePointId({ routePointId: cover.routePointId }, true, null, false)).toBe("B");
  });

  it("publishes no asset for the opening page, so closing Story does not move the map to the cover's Route Point", () => {
    expect(storyObservedTarget(cursor, "journey-cover:journey-1:b1")).toEqual({ assetId: null, noteRoutePointId: null });
    // The canonical cover page is the same asset and does speak for its Route Point.
    expect(storyObservedTarget(cursor, "b1").assetId).toBe("b1");
    // Mid-handoff the foreground can already be the next page; that one speaks.
    expect(storyObservedTarget(cursor, "a1").assetId).toBe("a1");
    expect(storyObservedTarget(cursor, null)).toEqual({ assetId: null, noteRoutePointId: null });
  });

  it("publishes a note page as its own Route Point with no asset (#595)", () => {
    const withNoteOnly: Journey = {
      ...journey,
      routePoints: [...journey.routePoints, point("D", 3, "D only has words")],
    };
    const noteCursor = storyCursorForJourney(withNoteOnly, false);
    expect(noteCursor.pageIds.at(-1)).toBe("note:D");
    // A note page never borrows a neighbouring media's owner for the return.
    expect(storyObservedTarget(noteCursor, "note:D")).toEqual({ assetId: null, noteRoutePointId: "D" });
    expect(storyCursorAssetIdForPage(noteCursor, "note:D")).toBeNull();
  });
});

describe("storyStagePages (#555)", () => {
  it("paints the opening with no previous page and canonical entry 0 next", () => {
    const cursor = storyCursorForJourney(journey, true);
    const onOpening = storyStagePages(cursor, 0);
    expect(onOpening.map((item) => item.id)).toEqual(["journey-cover:journey-1:b1", "a1", "b1", "b2", "c1"]);
    // The opening page keeps everything about its asset except its identity.
    expect(onOpening[0]).toMatchObject({ mimeType: "image/jpeg", routePointId: "B", fileName: "b1.bin" });
    // Off the opening the stage cannot reach back to it.
    expect(storyStagePages(cursor, 1).map((item) => item.id)).toEqual(["a1", "b1", "b2", "c1"]);
  });

  it("returns the canonical media itself when there is no opening", () => {
    const cursor = storyCursorForJourney(journey, false);
    expect(storyStagePages(cursor, 0)).toBe(cursor.assets);
  });

  it("holds the cover twice when it is canonical entry 0, so the step off the opening is a real page", () => {
    const leading: Journey = { ...journey, coverMediaAssetId: "a1" };
    const cursor = storyCursorForJourney(leading, true);
    const pages = storyStagePages(cursor, 0);
    expect(pages.map((item) => item.id)).toEqual(["journey-cover:journey-1:a1", "a1", "b1", "b2", "c1"]);
    expect(storyCursorAssetIdForPage(cursor, pages[0].id)).toBe(storyCursorAssetIdForPage(cursor, pages[1].id));
    expect(storyCursorNeighbourEntry(cursor, 0, 1, true)).toBe(1);
    expect(cursor.pageIds[1]).not.toBe(cursor.pageIds[0]);
    expect(cursor.entries[1]).toMatchObject({ role: "media", routePointId: "A" });
  });
});
