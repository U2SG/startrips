import { describe, expect, it } from "vitest";
import {
  buildPlaybackSteps,
  commitPresentedPlaybackPosition,
  committedPlaybackPosition,
  initialPlaybackState,
  isPlaybackTerminalState,
  isPlaybackTransitRoutePoint,
  playbackReducer,
  playbackFactualRouteText,
  playbackCameraTargetForStep,
  playbackTravelChoreography,
  playbackTravelAngularDistance,
  playbackCameraTargetKey,
  playbackIntroMedia,
  playbackMediaForPoint,
  playbackStoryMedia,
  storyMediaForScope,
  routePointAngularDistance,
  playbackMediaWaitPolicy,
  phaseForStep,
  routePointChapterDensity,
  storyEntryDensity,
  storySequenceForJourney,
  storySequenceMedia,
} from "./journeyPlayback";
import { deriveJourneyStaySummaries } from "./journeyModel";
import { buildPlaybackPlan } from "./journeyPlaybackPlan";
import type { HomeNarrativeContext } from "./homeBasePrelude";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

const point = (
  id: string,
  latitude: number,
  longitude: number,
  note: string | null = null,
  occurredAt: string | null = null,
): RoutePoint => ({
  id,
  journeyId: "journey-1",
  sortOrder: Number(id.slice(-1)),
  latitude,
  longitude,
  label: id,
  isStop: true,
  occurredAt,
  note,
  createdAt: "2026-08-11T00:00:00.000Z",
});

const media = (
  id: string,
  routePointId: string | null,
  mimeType: string,
  sortOrder = 0,
): JourneyMediaAsset => ({
  id,
  journeyId: "journey-1",
  routePointId,
  fileName: `${id}.bin`,
  mimeType,
  bytes: 128,
  sortOrder,
  createdAt: "2026-08-11T00:00:00.000Z",
});

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
  routePoints: [
    point("point-0", 0, 0, "第一次看到雪山"),
    point("point-1", 0, 60),
  ],
  media: [
    media("media-0", "point-0", "image/jpeg", 0),
    media("media-1", "point-1", "video/mp4", 0),
    media("track", null, "audio/mpeg", 0),
  ],
};


const homeNarrativeContext: HomeNarrativeContext = {
  prelude: {
    eligible: true,
    reason: "eligible",
    cameraTarget: {
      kind: "home",
      homeBaseId: "home-start",
      latitude: 22.5431,
      longitude: 114.0579,
      anchor: { x: 1, y: 2, z: 3 },
    },
  },
  epilogue: {
    eligible: true,
    reason: "eligible",
    cameraTarget: {
      kind: "home",
      homeBaseId: "home-end",
      latitude: 35.6762,
      longitude: 139.6503,
      anchor: { x: 4, y: 5, z: 6 },
    },
  },
};

describe("route provenance text boundary (#342)", () => {
  const route = (tier: "recorded-track" | "user-confirmed-route" | "user-shaped-route" | "suggested-route" | "sparse-relation") => ({
    points: [
      { lat: 0, lon: 0, isStop: true },
      { lat: 1, lon: 1, isStop: true },
    ],
    segmentProvenance: [tier],
  });

  it("allows actual-route text only for recorded or explicitly confirmed travel", () => {
    expect(playbackFactualRouteText(route("recorded-track"), 1, "actual street 2 km")).toBe("actual street 2 km");
    expect(playbackFactualRouteText(route("user-confirmed-route"), 1, "actual street 2 km")).toBe("actual street 2 km");
    expect(playbackFactualRouteText(route("user-shaped-route"), 1, "actual street 2 km")).toBeNull();
    expect(playbackFactualRouteText(route("suggested-route"), 1, "actual street 2 km")).toBeNull();
    expect(playbackFactualRouteText(route("sparse-relation"), 1, "actual street 2 km")).toBeNull();
  });

  it("checks every shaping segment of a chapter leg before claiming an actual route", () => {
    const shapedRoute = {
      points: [0, 1, 2, 3].map((index) => ({ lat: index, lon: index, isStop: index === 0 || index === 3 })),
      segmentProvenance: ["user-confirmed-route", "sparse-relation", "recorded-track"] as const,
    };
    expect(playbackFactualRouteText(shapedRoute, 3, "actual route", 0)).toBeNull();
    expect(playbackFactualRouteText({ ...shapedRoute, segmentProvenance: ["user-confirmed-route", "recorded-track", "recorded-track"] }, 3, "actual route", 0))
      .toBe("actual route");
  });
});

describe("Stop/via cinematic chapters (#342)", () => {
  it("folds stay media into Stop A, keeps an ungrouped via chapter and empty Stop B, and retains all geometry", () => {
    const trip: Journey = {
      ...journey,
      routePoints: [
        { ...point("point-0", 0, 0), regionContext: "A" },
        { ...point("point-1", 2, 2), isStop: false },
        { ...point("point-2", 0.1, 0.1), isStop: false, regionContext: "A", stayAnchorRoutePointId: "point-0" },
        { ...point("point-3", 1, 1), isStop: false },
        { ...point("point-4", 2, 3), regionContext: "B" },
        { ...point("point-5", 3, 4), isStop: false },
      ],
      media: [media("child-photo", "point-2", "image/jpeg"), media("via-photo", "point-3", "image/jpeg", 1)],
    };
    const before = structuredClone(trip);
    const steps = buildPlaybackSteps(trip);
    expect(steps.map((step) => step.kind)).toEqual(["intro", "stop", "media", "travel", "media", "travel", "stop", "outro"]);
    expect(steps.filter((step) => step.kind === "stop").map((step) => step.pointIndex)).toEqual([0, 4]);
    expect(steps.filter((step) => step.kind === "travel")).toEqual([{ kind: "travel", from: 0, to: 3 }, { kind: "travel", to: 4 }]);
    expect(steps.filter((step) => step.kind === "media").map((step) => step.pointIndex)).toEqual([0, 3]);
    expect(playbackMediaForPoint(trip, 0)).toEqual([trip.media[0]]);
    expect(playbackMediaForPoint(trip, 2)).toEqual([]);
    expect(storyMediaForScope(trip, "point-2")).toEqual([trip.media[0]]);
    const foldedStep = steps.find((step) => step.kind === "media")!;
    expect(committedPlaybackPosition(trip, foldedStep)).toEqual({ journeyId: trip.id, routePointId: "point-2", assetId: "child-photo" });
    expect(buildPlaybackPlan(trip).segments.filter((segment) => segment.kind === "media")
      .map((segment) => [segment.routePointId, segment.assetId])).toEqual([["point-0", "child-photo"], ["point-3", "via-photo"]]);
    expect(phaseForStep(steps[3])).toEqual({ type: "travel", from: 0, to: 3 });
    expect(playbackTravelAngularDistance(trip, 3, 0)).toBeCloseTo(
      routePointAngularDistance(trip.routePoints[0], trip.routePoints[1])
      + routePointAngularDistance(trip.routePoints[1], trip.routePoints[2])
      + routePointAngularDistance(trip.routePoints[2], trip.routePoints[3]),
    );
    expect(trip).toEqual(before);
  });

  it.each(["previous", "next", "independent", "reordered", "deleted", "demoted"] as const)(
    "uses exact Stop ownership after %s without heuristic rebinding",
    (state) => {
      const child = { ...point("child", 0.1, 0.1), isStop: false, regionContext: "A",
        stayAnchorRoutePointId: state === "independent" ? null : state === "previous" ? "a" : "b" };
      const trip: Journey = { ...journey, routePoints: [
        { ...point("a", 0, 0), regionContext: "A" }, child,
        { ...point("b", 0.2, 0.2), regionContext: "A" },
      ], media: [media("child-photo", "child", "image/jpeg")] };
      if (state === "reordered") trip.routePoints = [trip.routePoints[2], trip.routePoints[0], child];
      if (state === "deleted") trip.routePoints = trip.routePoints.filter((candidate) => candidate.id !== "b");
      if (state === "demoted") trip.routePoints[2] = { ...trip.routePoints[2], isStop: false };
      const before = structuredClone(trip);
      const expectedOwner = ["independent", "deleted", "demoted"].includes(state)
        ? "child" : state === "previous" ? "a" : "b";
      const steps = buildPlaybackSteps(trip);
      const mediaSteps = steps.filter((step) => step.kind === "media");
      expect(mediaSteps.map((step) => trip.routePoints[step.pointIndex].id)).toEqual([expectedOwner]);
      expect(committedPlaybackPosition(trip, mediaSteps[0])).toEqual({
        journeyId: trip.id, routePointId: "child", assetId: "child-photo",
      });
      expect(steps.filter((step) => step.kind === "stop").map((step) => trip.routePoints[step.pointIndex].id))
        .toEqual(trip.routePoints.filter((candidate) => candidate.isStop).map((candidate) => candidate.id));
      expect(trip).toEqual(before);
    },
  );

  it("traverses leading shaping points without focusing them and respects the canonical Stop bit", () => {
    const trip = { ...journey, media: [], routePoints: [
      { ...point("point-0", 0, 0), isStop: false },
      { ...point("point-1", 0, 10), isStop: false },
      { ...point("point-2", 0, 20), placeRole: "pure-transit" as const },
    ] };
    expect(buildPlaybackSteps(trip).map((step) => step.kind)).toEqual(["intro", "travel", "stop", "outro"]);
    expect(buildPlaybackSteps(trip)[1]).toEqual({ kind: "travel", from: 0, to: 2 });
  });
});

describe("routePointAngularDistance (#19)", () => {
  it("measures the great-circle distance between two route points", () => {
    expect(routePointAngularDistance(point("a", 0, 0), point("b", 0, 60))).toBeCloseTo(
      Math.PI / 3,
      6,
    );
    const short = routePointAngularDistance(point("a", 0, 0), point("b", 0, 1));
    const long = routePointAngularDistance(point("a", 0, 0), point("b", 0, 90));
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(long);
  });
});

describe("Story whole-Journey media sequence (#76)", () => {
  it("shares intro and route-point ordering with Journey Playback", () => {
    const aggregate: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 0, 0),
        point("point-1", 0, 30),
        point("point-2", 0, 60),
      ],
      media: [
        media("intro-b", null, "image/jpeg", 1),
        media("point-1-video", "point-1", "video/mp4", 0),
        media("intro-a", null, "image/jpeg", 0),
        media("point-0-image", "point-0", "image/jpeg", 0),
        media("track", null, "audio/mpeg", 2),
      ],
    };

    expect(playbackStoryMedia(aggregate).map((asset) => asset.id)).toEqual([
      "intro-a",
      "intro-b",
      "point-0-image",
      "point-1-video",
    ]);
    expect(storyMediaForScope(aggregate, null).map((asset) => asset.id))
      .toEqual(playbackStoryMedia(aggregate).map((asset) => asset.id));
    expect(storyMediaForScope(aggregate, "point-1").map((asset) => asset.id))
      .toEqual(["point-1-video"]);
  });

  it("starts at the first populated route point when there is no intro and skips empty points", () => {
    const noIntro: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 0, 0),
        point("point-1", 0, 30),
        point("point-2", 0, 60),
      ],
      media: [
        media("point-1-image", "point-1", "image/jpeg", 0),
        media("point-2-video", "point-2", "video/mp4", 0),
      ],
    };

    expect(playbackStoryMedia(noIntro).map((asset) => asset.id)).toEqual([
      "point-1-image",
      "point-2-video",
    ]);
  });

  it("preserves ties and input objects while excluding audio and unknown route points", () => {
    const mixed: Journey = {
      ...journey,
      routePoints: [point("point-2", 0, 60), point("point-0", 0, 0), point("point-1", 0, 30)],
      media: [
        media("intro-tie-a", null, "image/jpeg", 2),
        media("point-1-late", "point-1", "video/mp4", 3),
        media("point-2-tie-a", "point-2", "image/jpeg", 1),
        media("orphan", "unknown-point", "image/jpeg", 0),
        media("intro-first", null, "video/mp4", 0),
        media("point-2-first", "point-2", "image/jpeg", 0),
        media("point-2-audio", "point-2", "audio/mpeg", -1),
        media("point-2-tie-b", "point-2", "video/mp4", 1),
        media("track", null, "audio/mpeg", 0),
        media("point-1-first", "point-1", "image/jpeg", 0),
        media("intro-tie-b", null, "image/jpeg", 2),
        media("point-0-audio", "point-0", "audio/wav", 0),
      ],
    };
    const original = structuredClone(mixed);
    for (const asset of mixed.media) Object.freeze(asset);
    for (const routePoint of mixed.routePoints) Object.freeze(routePoint);
    Object.freeze(mixed.media);
    Object.freeze(mixed.routePoints);
    Object.freeze(mixed);

    const story = playbackStoryMedia(mixed);
    const steps = buildPlaybackSteps(mixed, homeNarrativeContext);
    const stops = steps.filter((step) => step.kind === "stop");
    const introIds = ["intro-first", "intro-tie-a", "intro-tie-b"];
    const chapterIds = [
      ["point-2-first", "point-2-tie-a", "point-2-tie-b"],
      [],
      ["point-1-first", "point-1-late"],
    ];

    expect(story.map((asset) => asset.id)).toEqual([...introIds, ...chapterIds.flat()]);
    expect(playbackIntroMedia(mixed).map((asset) => asset.id)).toEqual(introIds);
    expect(storyMediaForScope(mixed, null)).toEqual(story);
    expect(storyMediaForScope(mixed, "unknown-point")).toEqual([]);
    expect(stops.map((step) => step.media.map((asset) => asset.id))).toEqual(chapterIds);
    for (const [pointIndex, routePoint] of mixed.routePoints.entries()) {
      expect(playbackMediaForPoint(mixed, pointIndex).map((asset) => asset.id))
        .toEqual(chapterIds[pointIndex]);
      expect(storyMediaForScope(mixed, routePoint.id)).toEqual(stops[pointIndex].media);
    }
    expect(steps.map((step) => step.kind)).toEqual([
      "home-prelude", "intro",
      "stop", "media", "media", "media",
      "travel", "stop",
      "travel", "stop", "media", "media",
      "home-epilogue", "outro",
    ]);
    for (const asset of [...story, ...stops.flatMap((step) => step.media)]) {
      expect(asset).toBe(mixed.media.find((originalAsset) => originalAsset.id === asset.id));
    }
    expect(mixed).toEqual(original);
  });

  it("does not sort media belonging to owners the projection never consumes", () => {
    const unreadOrder = (id: string, routePointId: string | null): JourneyMediaAsset => ({
      ...media(id, routePointId, "image/jpeg"),
      get sortOrder(): number {
        throw new Error(`Unconsumed media must not be sorted: ${id}`);
      },
    });
    const orphans = [unreadOrder("orphan-a", "missing"), unreadOrder("orphan-b", "missing")];
    const scattered: Journey = {
      ...journey,
      routePoints: [point("point-0", 0, 0)],
      media: [unreadOrder("intro-a", null), unreadOrder("intro-b", null), ...orphans],
    };

    expect(buildPlaybackSteps(scattered)).toEqual([
      { kind: "intro" },
      { kind: "stop", pointIndex: 0, media: [] },
      { kind: "outro" },
    ]);
    const story: Journey = {
      ...scattered,
      media: [media("intro-b", null, "image/jpeg", 1), ...orphans, media("intro-a", null, "image/jpeg", 0)],
    };
    expect(playbackStoryMedia(story).map((asset) => asset.id)).toEqual(["intro-a", "intro-b"]);
  });
});

// #76 acceptance: Story and Cinematic Journey Playback must agree on one
// chapter/media order. `sortOrder` is a Journey-global upload counter, so a
// folded child's media can carry a LOWER sortOrder than the Stop that owns the
// chapter. Ordering the merged chapter by `sortOrder` alone therefore made the
// two projections disagree on real journeys. These cases pin the agreement in
// both anchor directions.
describe("Story and Playback share one grouped-chapter order (#76)", () => {
  const playbackChapterOrder = (target: Journey) => buildPlaybackSteps(target)
    .filter((step) => step.kind === "stop")
    .flatMap((step) => (step.kind === "stop" ? step.media : []))
    .map((asset) => asset.id);

  const asVia = (target: RoutePoint, stayAnchorRoutePointId: string): RoutePoint => ({
    ...target,
    isStop: false,
    placeRole: "pure-transit",
    stayAnchorRoutePointId,
  });

  it("keeps a backward-anchored child's media after its Stop even when uploaded first", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        asVia(point("point-1", 30.67, 104.07), "point-0"),
        point("point-2", 30.68, 104.08),
      ],
      media: [
        media("via-first", "point-1", "image/jpeg", 0),
        media("stop-first", "point-0", "image/jpeg", 1),
        media("stop-second", "point-0", "image/jpeg", 2),
      ],
    };

    expect(playbackChapterOrder(grouped)).toEqual(["stop-first", "stop-second", "via-first"]);
    expect(playbackStoryMedia(grouped).map((asset) => asset.id))
      .toEqual(playbackChapterOrder(grouped));
  });

  it("keeps a forward-anchored child's media before its Stop", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        asVia(point("point-1", 30.67, 104.07), "point-2"),
        point("point-2", 30.68, 104.08),
      ],
      media: [
        media("via-late", "point-1", "image/jpeg", 9),
        media("stop-first", "point-2", "image/jpeg", 0),
        media("stop-second", "point-2", "image/jpeg", 1),
      ],
    };

    expect(playbackChapterOrder(grouped)).toEqual(["via-late", "stop-first", "stop-second"]);
    expect(playbackStoryMedia(grouped).map((asset) => asset.id))
      .toEqual(playbackChapterOrder(grouped));
  });

  it("orders several grouped children by route position inside one chapter", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        asVia(point("point-1", 30.67, 104.07), "point-0"),
        asVia(point("point-2", 30.67, 104.08), "point-0"),
      ],
      media: [
        media("child-b", "point-2", "image/jpeg", 0),
        media("stop-media", "point-0", "image/jpeg", 1),
        media("child-a", "point-1", "image/jpeg", 2),
      ],
    };

    expect(playbackChapterOrder(grouped)).toEqual(["stop-media", "child-a", "child-b"]);
    expect(playbackStoryMedia(grouped).map((asset) => asset.id))
      .toEqual(playbackChapterOrder(grouped));
  });

  it("still orders intro media ahead of every chapter", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        asVia(point("point-1", 30.67, 104.07), "point-0"),
      ],
      media: [
        media("intro", null, "image/jpeg", 5),
        media("via-first", "point-1", "image/jpeg", 0),
        media("stop-media", "point-0", "image/jpeg", 1),
      ],
    };

    expect(playbackStoryMedia(grouped).map((asset) => asset.id))
      .toEqual(["intro", "stop-media", "via-first"]);
  });

  it("leaves the all-Stop projection byte-identical to per-owner ordering", () => {
    const stopsOnly: Journey = {
      ...journey,
      routePoints: [point("point-0", 0, 0), point("point-1", 1, 1), point("point-2", 2, 2)],
      media: [
        media("point-2-b", "point-2", "image/jpeg", 7),
        media("point-0-b", "point-0", "image/jpeg", 8),
        media("point-1-a", "point-1", "image/jpeg", 9),
        media("point-2-a", "point-2", "image/jpeg", 10),
      ],
    };

    expect(playbackChapterOrder(stopsOnly)).toEqual([
      "point-0-b", "point-1-a", "point-2-b", "point-2-a",
    ]);
    expect(playbackStoryMedia(stopsOnly).map((asset) => asset.id))
      .toEqual(playbackChapterOrder(stopsOnly));
  });
});

// #595: the canonical Story sequence is the presentation authority. `note`
// entries are what a Route Point with no media of its own presents as, so
// "empty is a valid chapter" survives into the sequence instead of the point
// being stepped past.
describe("Story presentation sequence (#595)", () => {
  // The order Journey Playback hands the director, straight from the media
  // each `stop` step carries.
  const playbackChapterOrder = (target: Journey) => buildPlaybackSteps(target)
    .filter((step) => step.kind === "stop")
    .flatMap((step) => (step.kind === "stop" ? step.media : []))
    .map((asset) => asset.id);
  const asVia = (target: RoutePoint, stayAnchorRoutePointId: string): RoutePoint => ({
    ...target,
    isStop: false,
    placeRole: "pure-transit",
    stayAnchorRoutePointId,
  });
  const withNote = (target: RoutePoint, note: string): RoutePoint => ({ ...target, note });
  const roles = (entries: ReturnType<typeof storySequenceForJourney>) =>
    entries.map((entry) => entry.presentationId);

  it("keeps a note-only Route Point as a real beat between its media neighbours", () => {
    const mixed: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 0, 0),
        withNote(point("point-1", 0, 30), "只写了一句话"),
        point("point-2", 0, 60),
      ],
      media: [
        media("first", "point-0", "image/jpeg", 0),
        media("last", "point-2", "image/jpeg", 1),
      ],
    };

    expect(roles(storySequenceForJourney(mixed))).toEqual([
      "media:first", "note:point-1", "media:last",
    ]);
    const [noteEntry] = storySequenceForJourney(mixed).filter((entry) => entry.role === "note");
    expect(noteEntry).toMatchObject({
      asset: null,
      routePointId: "point-1",
      contextOwner: "route-point",
      note: "只写了一句话",
    });
  });

  it("does not turn a Route Point's own note into a step beside its media", () => {
    const noted: Journey = {
      ...journey,
      routePoints: [
        withNote(point("point-0", 0, 0), "住在这里"),
        withNote(point("point-1", 0, 30), "路过"),
      ],
      media: [
        media("stay-a", "point-0", "image/jpeg", 0),
        media("stay-b", "point-0", "image/jpeg", 1),
        media("passed", "point-1", "image/jpeg", 2),
      ],
    };

    // Each note rides with its own Route Point's media; neither becomes a
    // second beat that makes the member swipe past a page of text.
    expect(roles(storySequenceForJourney(noted)))
      .toEqual(["media:stay-a", "media:stay-b", "media:passed"]);
  });

  it("keeps a parent Stop note and its children's notes in canonical route order", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        withNote(point("point-0", 0, 0), "Stop 的感想"),
        withNote(asVia(point("point-1", 0, 10), "point-0"), "子点 A"),
        withNote(asVia(point("point-2", 0, 20), "point-0"), "子点 B"),
      ],
      media: [media("child-a-media", "point-1", "image/jpeg", 0)],
    };

    expect(roles(storySequenceForJourney(grouped))).toEqual([
      "note:point-0", "media:child-a-media", "note:point-2",
    ]);
  });

  it("keeps grouped children inside their anchor Stop's chapter position", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 0, 0),
        asVia(point("point-1", 0, 10), "point-0"),
        point("point-2", 0, 30),
      ],
      media: [
        media("intro", null, "image/jpeg", 0),
        media("child", "point-1", "image/jpeg", 1),
        media("stop-media", "point-0", "image/jpeg", 2),
        media("last", "point-2", "image/jpeg", 3),
      ],
    };

    expect(roles(storySequenceForJourney(grouped))).toEqual([
      "media:intro", "media:stop-media", "media:child", "media:last",
    ]);
  });

  it("treats a Journey-level media entry as Journey context, not a Route Point's", () => {
    const withIntro: Journey = {
      ...journey,
      routePoints: [point("point-0", 0, 0)],
      media: [
        media("intro", null, "image/jpeg", 0),
        media("stop-media", "point-0", "image/jpeg", 1),
      ],
    };

    expect(storySequenceForJourney(withIntro).map((entry) => entry.contextOwner))
      .toEqual(["journey", "route-point"]);
  });

  it("projects back to exactly the media order the whole Journey already showed", () => {
    // The sequence is a widening, not a reordering: nothing that consumed
    // `playbackStoryMedia` before may observe a different list.
    const grouped: Journey = {
      ...journey,
      routePoints: [
        withNote(point("point-0", 0, 0), "Stop"),
        withNote(asVia(point("point-1", 0, 10), "point-0"), "child note"),
        withNote(point("point-2", 0, 30), "second stop"),
        asVia(point("point-3", 0, 40), "point-2"),
      ],
      media: [
        media("intro", null, "image/jpeg", 0),
        media("child-media", "point-1", "video/mp4", 1),
        media("stop-media", "point-0", "image/jpeg", 2),
        media("second", "point-2", "image/jpeg", 3),
      ],
    };

    const expected = ["intro", "stop-media", "child-media", "second"];
    expect(storySequenceMedia(storySequenceForJourney(grouped)).map((asset) => asset.id))
      .toEqual(expected);
    expect(playbackStoryMedia(grouped).map((asset) => asset.id)).toEqual(expected);
    expect(storyMediaForScope(grouped, null).map((asset) => asset.id)).toEqual(expected);
    // And the point-owned part still equals what Journey Playback hands the
    // director. Its `intro` media rides on its own step, not on a `stop` step,
    // so it is compared separately.
    expect(playbackIntroMedia(grouped).map((asset) => asset.id)).toEqual(["intro"]);
    expect(playbackChapterOrder(grouped)).toEqual(expected.slice(1));
  });

  it("never reuses an asset id as a presentation identity", () => {
    const sequence = storySequenceForJourney({
      ...journey,
      routePoints: [withNote(point("point-0", 0, 0), "note"), point("point-1", 0, 30)],
      media: [media("only", "point-1", "image/jpeg", 0)],
    });

    expect(sequence.map((entry) => entry.presentationId)).toContain("note:point-0");
    for (const entry of sequence) {
      if (entry.asset) expect(entry.presentationId).not.toBe(entry.asset.id);
    }
    expect(new Set(sequence.map((entry) => entry.presentationId)).size).toBe(sequence.length);
  });

  it("counts density in media, so a note entry never promotes an empty chapter", () => {
    const entries = storySequenceForJourney({
      ...journey,
      routePoints: [withNote(point("point-0", 0, 0), "只有一句话")],
      media: [],
    });

    expect(entries).toHaveLength(1);
    expect(storyEntryDensity(entries)).toBe("empty");
    expect(routePointChapterDensity({
      ...journey,
      routePoints: [point("point-0", 0, 0)],
      media: [],
    }, 0)).toBe("empty");
  });

  it("ignores blank and whitespace-only notes rather than presenting an empty beat", () => {
    const blank: Journey = {
      ...journey,
      routePoints: [
        { ...point("point-0", 0, 0), note: "   \n  " },
        { ...point("point-1", 0, 30), note: null },
      ],
      media: [],
    };

    expect(storySequenceForJourney(blank)).toEqual([]);
  });
});

// #555: the Journey-level cover opening. Presentation identity is not asset
// identity: the same canonical cover row is presented once as the whole
// Journey's opening and again later inside its own Route Point.
describe("Journey cover presentation entry (#555)", () => {
  const withCover = (coverOwner: string): Journey => ({
    ...journey,
    coverMediaAssetId: "point-cover",
    routePoints: [point("point-0", 0, 0), point("point-1", 0, 30)],
    media: [
      media("a1", "point-0", "image/jpeg", 0),
      media("point-cover", coverOwner, "image/jpeg", 1),
      media("b1", "point-1", "image/jpeg", 2),
    ],
  });

  it("prepends one Journey-context entry without collapsing the canonical one", () => {
    const target = withCover("point-1");
    const canonical = storySequenceForJourney(target);
    const presentation = storySequenceForJourney(target, { withJourneyCoverOpening: true });

    expect(presentation[0]).toEqual({
      presentationId: `journey-cover:${target.id}:point-cover`,
      role: "journey-cover",
      asset: target.media[1],
      // Journey-level context: it must not inherit the cover's own Route Point.
      routePointId: null,
      // #595: nor its chapter.
      chapterRoutePointId: null,
      contextOwner: "journey",
    });
    // Canonical media follow in full, so nothing before the cover is skipped.
    expect(presentation.slice(1)).toEqual(canonical);
    expect(presentation.map((entry) => entry.presentationId)).toEqual([
      "journey-cover:journey-1:point-cover",
      "media:a1",
      "media:point-cover",
      "media:b1",
    ]);
  });

  it("keeps the two cover appearances as distinct roles on the same asset row", () => {
    const target = withCover("point-1");
    const presentation = storySequenceForJourney(target, { withJourneyCoverOpening: true });
    const coverEntries = presentation.filter((entry) => entry.asset?.id === "point-cover");

    expect(coverEntries).toHaveLength(2);
    expect(coverEntries[0].role).toBe("journey-cover");
    expect(coverEntries[0].contextOwner).toBe("journey");
    // Later, the same media behaves as ordinary media inside its own chapter.
    expect(coverEntries[1].role).toBe("media");
    expect(coverEntries[1].contextOwner).toBe("route-point");
    // Same canonical row in both places: no duplicated media object.
    expect(coverEntries[0].asset).toBe(coverEntries[1].asset);
  });

  it("leaves the canonical media list untouched so keepsake cannot duplicate it", () => {
    const target = withCover("point-1");
    // `playbackStoryMedia` is what keepsake reads. It stays the canonical list,
    // because it always builds the sequence WITHOUT the opening.
    expect(playbackStoryMedia(target).map((asset) => asset.id)).toEqual(["a1", "point-cover", "b1"]);
    // Projecting the PRESENTATION sequence does carry the cover twice, which is
    // the whole point of the entry: one Journey opening, one Route Point media.
    const projected = storySequenceMedia(storySequenceForJourney(target, { withJourneyCoverOpening: true }));
    expect(projected.map((asset) => asset.id)).toEqual(["point-cover", "a1", "point-cover", "b1"]);
  });

  it("adds no opening when the Journey has no visual media to open with", () => {
    const noMedia: Journey = { ...journey, routePoints: [point("point-0", 0, 0)], media: [] };
    expect(storySequenceForJourney(noMedia, { withJourneyCoverOpening: true }))
      .toEqual(storySequenceForJourney(noMedia));
  });

  it("opens with the resolved cover even when none was chosen explicitly", () => {
    const implicit = { ...journey, routePoints: [point("point-0", 0, 0)], media: [media("a1", "point-0", "image/jpeg", 0)] };
    const presentation = storySequenceForJourney(implicit, { withJourneyCoverOpening: true });
    expect(presentation[0]).toMatchObject({ role: "journey-cover", contextOwner: "journey" });
    expect(presentation[0].asset?.id).toBe("a1");
  });
});

describe("buildPlaybackSteps (#19)", () => {
  it("expands intro, per-point travel/stop/media, and outro in order", () => {
    const steps = buildPlaybackSteps(journey);
    expect(steps.map((step) => step.kind)).toEqual([
      "intro",
      "stop", // point 0 (no travel for the first point)
      "media",
      "travel",
      "stop", // point 1
      "media",
      "outro",
    ]);
    expect(steps[1]).toMatchObject({ kind: "stop", pointIndex: 0 });
    expect(steps[4]).toMatchObject({ kind: "stop", pointIndex: 1 });
  });

  it("keeps the soundtrack out of the chapter stream", () => {
    expect(playbackMediaForPoint(journey, 0).map((asset) => asset.id))
      .toEqual(["media-0"]);
    expect(playbackMediaForPoint(journey, 1).map((asset) => asset.id))
      .toEqual(["media-1"]);
  });

  it("gives every real Stop a chapter even without media", () => {
    const silent: Journey = {
      ...journey,
      routePoints: [point("p0", 0, 0), point("p1", 1, 1)],
      media: [],
    };
    const steps = buildPlaybackSteps(silent);
    expect(steps.filter((step) => step.kind === "stop")).toHaveLength(2);
    expect(steps.some((step) => step.kind === "media")).toBe(false);
  });

  it("keeps route shape and historical media without promoting pure transit to a stop (#514)", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        { ...point("point-0", 30.66, 104.06), regionContext: "Chengdu", placeRole: "accommodation" },
        { ...point("point-1", 30.67, 104.07), isStop: false, regionContext: "Chengdu", placeRole: "pure-transit", stayAnchorRoutePointId: "point-2" },
        { ...point("point-2", 30.68, 104.08), regionContext: "Chengdu", placeRole: "attraction" },
      ],
      media: [
        media("stay-hotel", "point-0", "image/jpeg", 0),
        media("stay-detour", "point-1", "image/jpeg", 1),
        media("stay-place", "point-2", "video/mp4", 2),
      ],
    };
    const routeBefore = structuredClone(grouped.routePoints);
    const mediaBefore = [...grouped.media];

    expect(deriveJourneyStaySummaries(grouped).map((summary) => summary.routePointIds)).toEqual([
      ["point-0", "point-1", "point-2"],
    ]);

    const steps = buildPlaybackSteps(grouped);
    expect(steps.flatMap((step) => step.kind === "stop" ? [step.pointIndex] : [])).toEqual([0, 2]);
    expect(steps.flatMap((step) => step.kind === "travel" ? [step.to] : [])).toEqual([2]);
    expect(steps.flatMap((step) => step.kind === "media" ? [step.pointIndex] : [])).toEqual([0, 2, 2]);
    expect(playbackMediaForPoint(grouped, 0).map((asset) => asset.id)).toEqual(["stay-hotel"]);
    expect(playbackMediaForPoint(grouped, 1)).toEqual([]);
    expect(storyMediaForScope(grouped, "point-1").map((asset) => asset.id)).toEqual(["stay-detour"]);
    expect(playbackMediaForPoint(grouped, 2).map((asset) => asset.id)).toEqual(["stay-detour", "stay-place"]);
    expect(grouped.routePoints).toEqual(routeBefore);
    expect(grouped.media).toEqual(mediaBefore);
    expect(grouped.media).toEqual(expect.arrayContaining(mediaBefore));
  });

  it("folds explicitly-owned child media into the selected Stop without changing canonical media ownership (#514)", () => {
    const child = {
      ...point("point-1", 30.67, 104.07),
      isStop: false,
      placeRole: "pure-transit" as const,
      stayAnchorRoutePointId: "point-0",
    };
    const promotedStop = {
      ...point("point-2", 30.68, 104.08),
      placeRole: "pure-transit" as const,
    };
    const owned: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        child,
        promotedStop,
      ],
      media: [media("child-memory", "point-1", "image/jpeg", 0)],
    };

    expect(isPlaybackTransitRoutePoint(promotedStop)).toBe(false);
    expect(playbackMediaForPoint(owned, 0).map((asset) => asset.id)).toEqual(["child-memory"]);
    expect(playbackMediaForPoint(owned, 1)).toEqual([]);
    expect(storyMediaForScope(owned, "point-1").map((asset) => asset.id)).toEqual(["child-memory"]);

    const steps = buildPlaybackSteps(owned);
    expect(steps.filter((step) => step.kind === "stop").map((step) => step.pointIndex)).toEqual([0, 2]);
    expect(steps.filter((step) => step.kind === "media").map((step) => step.pointIndex)).toEqual([0]);
    const foldedMedia = steps.find((step) => step.kind === "media");
    expect(committedPlaybackPosition(owned, foldedMedia)).toEqual({
      journeyId: owned.id,
      routePointId: "point-1",
      assetId: "child-memory",
    });
  });

  it("keeps legacy isStop=false route points as transit without requiring placeRole metadata (#514)", () => {
    const legacyTransit = { ...point("point-1", 30.67, 104.07), isStop: false };
    const legacy: Journey = {
      ...journey,
      routePoints: [
        point("point-0", 30.66, 104.06),
        legacyTransit,
        point("point-2", 30.68, 104.08),
      ],
      media: [media("legacy-transit-media", "point-1", "image/jpeg", 0)],
    };

    expect(legacyTransit.placeRole).toBeUndefined();
    expect(isPlaybackTransitRoutePoint(legacyTransit)).toBe(true);
    const steps = buildPlaybackSteps(legacy);
    expect(steps.flatMap((step) => step.kind === "stop" ? [step.pointIndex] : [])).toEqual([0, 2]);
    expect(steps.flatMap((step) => step.kind === "media" ? [step.pointIndex] : [])).toEqual([1]);
    expect(playbackMediaForPoint(legacy, 1).map((asset) => asset.id)).toEqual(["legacy-transit-media"]);
  });
});



describe("playback camera ownership", () => {
  it("keeps intro and outro on the whole Journey route", () => {
    expect(playbackCameraTargetForStep({ kind: "intro" })).toEqual({ kind: "route" });
    expect(playbackCameraTargetForStep({ kind: "outro" })).toEqual({ kind: "route" });
  });

  it("gives travel, stop, and media to the relevant route point", () => {
    expect(playbackCameraTargetForStep({ kind: "travel", to: 1 }))
      .toEqual({ kind: "point", pointIndex: 1 });
    expect(playbackCameraTargetForStep({ kind: "stop", pointIndex: 1, media: [] }))
      .toEqual({ kind: "point", pointIndex: 1 });
    expect(playbackCameraTargetForStep({ kind: "media", pointIndex: 1, mediaIndex: 0 }))
      .toEqual({ kind: "point", pointIndex: 1 });
  });

  it("uses one stable camera key across stop-to-media chapters at the same point", () => {
    const stopTarget = playbackCameraTargetForStep({ kind: "stop", pointIndex: 0, media: [] });
    const mediaTarget = playbackCameraTargetForStep({ kind: "media", pointIndex: 0, mediaIndex: 0 });
    expect(stopTarget).not.toBeNull();
    expect(mediaTarget).not.toBeNull();
    expect(playbackCameraTargetKey(stopTarget!)).toBe("point:0");
    expect(playbackCameraTargetKey(mediaTarget!)).toBe("point:0");
  });

  it("keeps Home as its own camera-only target", () => {
    const home = homeNarrativeContext.prelude.eligible ? homeNarrativeContext.prelude.cameraTarget : null;
    expect(home).not.toBeNull();
    expect(playbackCameraTargetForStep({ kind: "home-prelude", cameraTarget: home! })).toEqual(home);
    expect(playbackCameraTargetKey(home!)).toBe("home:home-start");
  });

  it("returns no camera command when playback has no current step", () => {
    expect(playbackCameraTargetForStep(undefined)).toBeNull();
  });
});

describe("Home epilogue camera continuity (#235)", () => {
  it("keeps Home camera ownership through outro and preserves route outro without Home", () => {
    const steps = buildPlaybackSteps(journey, homeNarrativeContext);
    const epilogue = steps.at(-2);
    const outro = steps.at(-1);
    expect(epilogue).toMatchObject({ kind: "home-epilogue" });
    expect(outro).toMatchObject({ kind: "outro" });
    const epilogueTarget = playbackCameraTargetForStep(epilogue, journey);
    const outroTarget = playbackCameraTargetForStep(outro, journey);
    expect(epilogueTarget).toMatchObject({ kind: "home", homeBaseId: "home-end" });
    expect(outroTarget).toEqual(epilogueTarget);
    expect(playbackCameraTargetKey(outroTarget!)).toBe("home:home-end");

    const withoutHome = buildPlaybackSteps(journey);
    expect(playbackCameraTargetForStep(withoutHome.at(-1), journey)).toEqual({ kind: "route" });
  });
});

describe("Home narrative playback topology (#235)", () => {
  it("keeps Home beats in the same reducer index space as the expanded steps", () => {
    const steps = buildPlaybackSteps(journey, homeNarrativeContext);
    expect(steps[0]).toMatchObject({ kind: "home-prelude" });
    expect(steps.at(-2)).toMatchObject({ kind: "home-epilogue" });

    let state = initialPlaybackState(homeNarrativeContext);
    expect(state.phase).toEqual({ type: "home-prelude", homeBaseId: "home-start" });
    state = playbackReducer(journey, state, { type: "advance" }, homeNarrativeContext);
    expect(state.phase).toEqual({ type: "intro" });

    state = playbackReducer(
      journey,
      state,
      { type: "seek", stepIndex: steps.length - 2 },
      homeNarrativeContext,
    );
    expect(state.phase).toEqual({ type: "home-epilogue", homeBaseId: "home-end" });
    expect(state.stepIndex).toBe(steps.length - 2);
  });
});

describe("playbackReducer (#19)", () => {
  it("advances and steps back through the chapter list", () => {
    const steps = buildPlaybackSteps(journey);
    let state = initialPlaybackState();
    expect(state.phase).toEqual({ type: "intro" });
    state = playbackReducer(journey, state, { type: "advance" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 0 });
    state = playbackReducer(journey, state, { type: "advance" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
    state = playbackReducer(journey, state, { type: "back" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 0 });
    // Consuming outro enters a distinct terminal transport state. Further
    // automatic advancement is the exact same state object.
    for (let index = 0; index < steps.length; index += 1) {
      state = playbackReducer(journey, state, { type: "advance" });
    }
    expect(state.phase).toEqual({ type: "completed" });
    const clamped = playbackReducer(journey, state, { type: "advance" });
    expect(clamped).toBe(state);
    expect(isPlaybackTerminalState(state)).toBe(true);
    expect(isPlaybackTerminalState(initialPlaybackState())).toBe(false);
  });

  it("seeks atomically to a requested playback step and clamps boundaries", () => {
    const steps = buildPlaybackSteps(journey);
    let state = playbackReducer(journey, initialPlaybackState(), { type: "seek", stepIndex: 5 });
    expect(state).toEqual({
      stepIndex: 5,
      phase: { type: "media", pointIndex: 1, mediaIndex: 0 },
      paused: false,
    });

    state = playbackReducer(journey, state, { type: "seek", stepIndex: 999 });
    expect(state.stepIndex).toBe(steps.length - 1);
    expect(state.phase).toEqual({ type: "outro" });

    state = playbackReducer(journey, state, { type: "seek", stepIndex: -20 });
    expect(state.stepIndex).toBe(0);
    expect(state.phase).toEqual({ type: "intro" });
  });

  it("preserves pause ownership when seeking so resume starts from the target", () => {
    let state = playbackReducer(journey, initialPlaybackState(), { type: "pause" });
    state = playbackReducer(journey, state, { type: "seek", stepIndex: 4 });
    expect(state).toEqual({
      stepIndex: 4,
      phase: { type: "paused", previous: { type: "stop", pointIndex: 1 } },
      paused: true,
    });
    state = playbackReducer(journey, state, { type: "resume" });
    expect(state).toEqual({
      stepIndex: 4,
      phase: { type: "stop", pointIndex: 1 },
      paused: false,
    });
  });

  it("pause keeps ownership while raw advance moves to the requested next beat", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "advance" });
    state = playbackReducer(journey, state, { type: "pause" });
    expect(state.paused).toBe(true);
    expect(state.phase).toEqual({
      type: "paused",
      previous: { type: "stop", pointIndex: 0 },
    });
    const advanced = playbackReducer(journey, state, { type: "advance" });
    expect(advanced.stepIndex).toBe(state.stepIndex + 1);
    expect(advanced.paused).toBe(true);
    expect(advanced.phase).toEqual({
      type: "paused",
      previous: { type: "media", pointIndex: 0, mediaIndex: 0 },
    });
    const resumed = playbackReducer(journey, advanced, { type: "resume" });
    expect(resumed.paused).toBe(false);
    expect(resumed.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
  });
});

describe("video completion ownership (#126)", () => {
  it("lets a healthy Full Journey video own advancement until its real ended event", () => {
    const video = media("video", "point-0", "video/mp4");
    expect(playbackMediaWaitPolicy(video, "waiting")).toBe("video-ended");
    expect(playbackMediaWaitPolicy(video, "ready")).toBe("video-ended");
    expect(playbackMediaWaitPolicy(video, "error")).toBe("none");
  });

  it("keeps image decode waiting separate from video completion", () => {
    const image = media("image", "point-0", "image/jpeg");
    expect(playbackMediaWaitPolicy(image, "waiting")).toBe("decode");
    expect(playbackMediaWaitPolicy(image, "ready")).toBe("none");
    expect(playbackMediaWaitPolicy(image, "error")).toBe("none");
  });

  it("keeps automatic video completion on raw sequence advancement", () => {
    const steps = buildPlaybackSteps(journey);
    const mediaIndex = steps.findIndex((step) => step.kind === "media");
    const state = { stepIndex: mediaIndex, phase: phaseForStep(steps[mediaIndex]), paused: false };
    const automatic = playbackReducer(journey, state, { type: "advance" });
    const manual = playbackReducer(journey, state, { type: "next" });
    expect(automatic.stepIndex).toBe(mediaIndex + 1);
    expect(steps[automatic.stepIndex]?.kind).toBe("travel");
    expect(steps[manual.stepIndex]?.kind).not.toBe("travel");
  });
});

describe("playbackTravelChoreography (#126)", () => {
  const withPoints = (coords: Array<[number, number]>): Journey => ({
    ...journey,
    routePoints: coords.map(([latitude, longitude], index) => point(`p-${index}`, latitude, longitude)),
  });

  it("uses a restrained nearby flight for same-city legs", () => {
    const target = withPoints([[22.28, 114.17], [22.31, 114.21]]);
    expect(playbackTravelChoreography(target, 1)).toBe("nearby");
    expect(playbackCameraTargetForStep({ kind: "travel", to: 1 }, target)).toEqual({
      kind: "point", pointIndex: 1, choreography: "nearby",
    });
  });

  it("uses regional choreography for medium-distance legs", () => {
    const target = withPoints([[22.28, 114.17], [31.23, 121.47]]);
    expect(playbackTravelChoreography(target, 1)).toBe("regional");
  });

  it("uses pullback choreography for intercontinental legs", () => {
    const target = withPoints([[22.28, 114.17], [51.51, -0.13]]);
    expect(playbackTravelChoreography(target, 1)).toBe("long-haul");
    expect(playbackCameraTargetForStep({ kind: "travel", to: 1 }, target)).toMatchObject({
      choreography: "long-haul",
    });
  });
});


describe("committedPlaybackPosition (#245)", () => {
  it("derives logical identity from the committed media step", () => {
    const steps = buildPlaybackSteps(journey);
    const mediaStep = steps.find((step) => step.kind === "media" && step.pointIndex === 1);
    expect(committedPlaybackPosition(journey, mediaStep)).toEqual({
      journeyId: journey.id,
      routePointId: "point-1",
      assetId: "media-1",
    });
  });

  it("uses the committed step rather than an unrelated pending seek target", () => {
    const steps = buildPlaybackSteps(journey);
    const committed = steps.find((step) => step.kind === "media" && step.pointIndex === 0);
    const pendingSeekTarget = steps.find((step) => step.kind === "media" && step.pointIndex === 1);
    expect(pendingSeekTarget).not.toEqual(committed);
    expect(committedPlaybackPosition(journey, committed)).toEqual({
      journeyId: journey.id,
      routePointId: "point-0",
      assetId: "media-0",
    });
  });


  it("keeps the last presented position when the requested media fails before presentation", () => {
    const steps = buildPlaybackSteps(journey);
    const presented = steps.find((step) => step.kind === "media" && step.pointIndex === 0);
    const failedRequested = steps.find((step) => step.kind === "media" && step.pointIndex === 1);
    const lastCommitted = committedPlaybackPosition(journey, presented);

    expect(commitPresentedPlaybackPosition(
      lastCommitted,
      journey,
      failedRequested,
      lastCommitted.assetId!,
    )).toEqual(lastCommitted);
    expect(commitPresentedPlaybackPosition(
      lastCommitted,
      journey,
      failedRequested,
      "media-1",
    )).toEqual({
      journeyId: journey.id,
      routePointId: "point-1",
      assetId: "media-1",
    });
  });

  it("keeps intro/outro at Journey-level context", () => {
    expect(committedPlaybackPosition(journey, { kind: "intro" })).toEqual({
      journeyId: journey.id,
      routePointId: null,
      assetId: null,
    });
    expect(committedPlaybackPosition(journey, { kind: "outro" })).toEqual({
      journeyId: journey.id,
      routePointId: null,
      assetId: null,
    });
  });
});

describe("routePointChapterDensity (#456)", () => {
  const densityJourney = (mediaCount: number): Journey => ({
    ...journey,
    routePoints: [point("point-0", 0, 0, "一个安静的下午")],
    media: [
      ...Array.from({ length: mediaCount }, (_unused, index) => (
        media(`density-${index}`, "point-0", "image/jpeg", index)
      )),
      // The soundtrack is never part of a chapter, at any density.
      media("track", null, "audio/mpeg", 0),
    ],
  });

  it("classifies sparse, sequence and dense Route Point media without changing the lower bands", () => {
    expect(routePointChapterDensity(densityJourney(0), 0)).toBe("empty");
    expect(routePointChapterDensity(densityJourney(1), 0)).toBe("single");
    expect(routePointChapterDensity(densityJourney(2), 0)).toBe("few");
    expect(routePointChapterDensity(densityJourney(3), 0)).toBe("few");
    expect(routePointChapterDensity(densityJourney(4), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(6), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(9), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(10), 0)).toBe("dense");
    expect(routePointChapterDensity(densityJourney(30), 0)).toBe("dense");
  });

  it("derives density only from playbackMediaForPoint", () => {
    // A soundtrack and another point's media are both outside this chapter, so
    // neither may move its density; that is the single media-order authority.
    const shared: Journey = {
      ...journey,
      routePoints: [point("point-0", 0, 0), point("point-1", 0, 60)],
      media: [
        media("a", "point-1", "image/jpeg", 0),
        media("b", "point-1", "image/jpeg", 1),
        media("track", null, "audio/mpeg", 0),
      ],
    };
    expect(playbackMediaForPoint(shared, 0)).toEqual([]);
    expect(routePointChapterDensity(shared, 0)).toBe("empty");
    expect(routePointChapterDensity(shared, 1)).toBe("few");
  });

  it("treats a missing route point as an empty chapter", () => {
    expect(routePointChapterDensity(journey, 99)).toBe("empty");
  });
});

describe("Journey Playback chapter order is motion-independent (#456)", () => {
  // Reduced Motion is a presentation preference the overlay resolves; it is
  // deliberately NOT an input to the chapter machine. This pins that: the step
  // kinds and order for empty / single / few chapters are produced by
  // `buildPlaybackSteps(journey, homeContext)` alone, so threading a motion
  // preference into the director later would break here rather than silently
  // give Reduced Motion viewers a different chapter order.
  const sparseJourney: Journey = {
    ...journey,
    routePoints: [
      point("point-0", 0, 0, "没有照片的地方"),
      point("point-1", 0, 20),
      point("point-2", 0, 40),
    ],
    media: [
      media("single-0", "point-1", "image/jpeg", 0),
      media("few-0", "point-2", "image/jpeg", 0),
      media("few-1", "point-2", "image/jpeg", 1),
      media("few-2", "point-2", "video/mp4", 2),
      media("track", null, "audio/mpeg", 0),
    ],
  };

  const buildUnder = (reduceMotion: boolean) => {
    void reduceMotion;
    return buildPlaybackSteps(sparseJourney);
  };

  it("builds the same steps for empty, single and few chapters either way", () => {
    const reduced = buildUnder(true);
    const full = buildUnder(false);
    expect(reduced).toEqual(full);
    expect(full.map((step) => step.kind)).toEqual([
      "intro",
      "stop",
      "travel", "stop", "media",
      "travel", "stop", "media", "media", "media",
      "outro",
    ]);
    expect(routePointChapterDensity(sparseJourney, 0)).toBe("empty");
    expect(routePointChapterDensity(sparseJourney, 1)).toBe("single");
    expect(routePointChapterDensity(sparseJourney, 2)).toBe("few");
  });
});
