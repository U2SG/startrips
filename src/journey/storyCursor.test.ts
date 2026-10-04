import { describe, expect, it } from "vitest";
import {
  storyActiveChapterRoutePointId,
  storyAutoplayAdvance,
  storyAutoplayVideoCandidate,
  storyCursorClampEntry,
  storyCursorEntryForAssetId,
  storyCursorEntryForMediaIndex,
  storyCursorForJourney,
  storyCursorMediaIndex,
  storyCursorNeighbourEntry,
  storyCursorOnJourneyCover,
  storyInitialCursorSelection,
  storyInitialMediaSelection,
  storyObservedAssetId,
  storyStageMedia,
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
    expect(cursor.entries.map((entry) => `${entry.role}:${entry.asset.id}`)).toEqual([
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
    expect(cursor.entries.map((entry) => entry.asset.id)).toEqual(["a1", "b1", "b2", "c1"]);
    expect(cursor.firstCanonicalEntry).toBe(0);
    expect(storyCursorEntryForMediaIndex(cursor, 2)).toBe(2);
  });
});

describe("storyInitialCursorSelection (#555)", () => {
  it("opens a genuine whole-Journey entry on the opening", () => {
    expect(initialCursor(journey, freshOpen)).toEqual({
      withJourneyCoverOpening: true, entryIndex: 0, assetId: "b1",
    });
  });

  it("never presents the opening for a deep link or a Playback return", () => {
    // A Route Point deep link starts on that Route Point's canonical media.
    expect(initialCursor(journey, { ...freshOpen, routePointId: "C" })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 3, assetId: "c1",
    });
    // An asset deep link starts on that asset's canonical entry.
    expect(initialCursor(journey, { ...freshOpen, routePointId: "B", assetId: "b2" })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 2, assetId: "b2",
    });
    // A Playback return can resolve to null/null; without the explicit signal it
    // lands on the canonical cover entry, exactly as before.
    expect(initialCursor(journey, { ...freshOpen, presentJourneyCoverOpening: false })).toEqual({
      withJourneyCoverOpening: false, entryIndex: 1, assetId: "b1",
    });
  });

  it("presents no opening when the Journey has no visual media", () => {
    const silent: Journey = { ...journey, coverMediaAssetId: null, media: [asset("track", null, 0, "audio/mpeg")] };
    expect(initialCursor(silent, freshOpen)).toEqual({
      withJourneyCoverOpening: false, entryIndex: 0, assetId: null,
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

describe("asset id -> cursor position (#555)", () => {
  const cursor = storyCursorForJourney(journey, true);

  it("prefers the current entry when it paints the asset, otherwise the canonical entry", () => {
    expect(storyCursorEntryForAssetId(cursor, "b1", 0)).toBe(0);
    expect(storyCursorEntryForAssetId(cursor, "b1", 2)).toBe(2);
    expect(storyCursorEntryForAssetId(cursor, "b1", 4)).toBe(2);
    expect(storyCursorEntryForAssetId(cursor, "c1", 0)).toBe(4);
  });

  it("keeps an unknown id on the current position without moving anyone onto the opening", () => {
    expect(storyCursorEntryForAssetId(cursor, "missing", 0)).toBe(0);
    expect(storyCursorEntryForAssetId(cursor, null, 3)).toBe(3);
    expect(storyCursorEntryForAssetId(cursor, "missing", 9)).toBe(4);
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
});

describe("Journey context on the opening (#555)", () => {
  const cover = { ...asset("b1", "B", 1) };

  it("names no chapter on the opening, and the cover's Route Point on its own entry", () => {
    expect(storyActiveChapterRoutePointId(null, cover, true, null, true)).toBeNull();
    expect(storyActiveChapterRoutePointId(null, cover, true, null, false)).toBe("B");
  });

  it("publishes no asset for the opening, so closing Story does not move the map to the cover's Route Point", () => {
    expect(storyObservedAssetId("b1", null, "b1")).toBeNull();
    // Mid-handoff the foreground can already be the next page; that one speaks.
    expect(storyObservedAssetId("a1", null, "b1")).toBe("a1");
    expect(storyObservedAssetId("b1", null, null)).toBe("b1");
    expect(storyObservedAssetId("b1", "A", null)).toBeNull();
  });
});

describe("storyStageMedia (#555)", () => {
  it("paints the opening with no previous page and canonical entry 0 next", () => {
    const cursor = storyCursorForJourney(journey, true);
    const canonical = playbackStoryMedia(journey);
    expect(storyStageMedia(cursor, 0, canonical).map((item) => item.id)).toEqual(["b1", "a1", "b2", "c1"]);
    expect(storyStageMedia(cursor, 1, canonical)).toBe(canonical);
  });

  it("keeps asset ids unique when the cover is canonical entry 0", () => {
    const leading: Journey = { ...journey, coverMediaAssetId: "a1" };
    const cursor = storyCursorForJourney(leading, true);
    const canonical = playbackStoryMedia(leading);
    expect(storyStageMedia(cursor, 0, canonical).map((item) => item.id)).toEqual(["a1", "b1", "b2", "c1"]);
    // Next from the opening is canonical entry 0: the same picture, its own context.
    expect(storyCursorNeighbourEntry(cursor, 0, 1, true)).toBe(1);
    expect(cursor.entries[1]).toMatchObject({ role: "media", routePointId: "A" });
  });
});
