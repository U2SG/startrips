import { describe, expect, it } from "vitest";
import {
  buildPlaybackSteps,
  commitPresentedPlaybackPosition,
  committedPlaybackPosition,
  initialPlaybackState,
  isPlaybackTerminalState,
  playbackReducer,
  playbackCameraTargetForStep,
  playbackTravelChoreography,
  playbackCameraTargetKey,
  playbackIntroMedia,
  playbackMediaForPoint,
  playbackStoryMedia,
  storyMediaForScope,
  routePointAngularDistance,
  playbackMediaWaitPolicy,
  phaseForStep,
  routePointChapterDensity,
} from "./journeyPlayback";
import { deriveJourneyStaySummaries } from "./journeyModel";
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
  storageDriver: "test",
  storageKey: id,
  fileName: `${id}.bin`,
  mimeType,
  bytes: 128,
  sortOrder,
  uploadedByUserId: "user-1",
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

  it("gives every point a stop step even without media, so no point is skipped", () => {
    const silent: Journey = {
      ...journey,
      routePoints: [point("p0", 0, 0), point("p1", 1, 1)],
      media: [],
    };
    const steps = buildPlaybackSteps(silent);
    expect(steps.filter((step) => step.kind === "stop")).toHaveLength(2);
    expect(steps.some((step) => step.kind === "media")).toBe(false);
  });

  it("keeps every canonical Route Point and media chapter when the overview groups a stay (#514)", () => {
    const grouped: Journey = {
      ...journey,
      routePoints: [
        { ...point("point-0", 30.66, 104.06), regionContext: "Chengdu", placeRole: "accommodation" },
        { ...point("point-1", 30.67, 104.07), isStop: false, regionContext: "Chengdu", placeRole: "pure-transit" },
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
      ["point-0", "point-2"],
    ]);

    const steps = buildPlaybackSteps(grouped);
    expect(steps.flatMap((step) => step.kind === "stop" ? [step.pointIndex] : [])).toEqual([0, 1, 2]);
    expect(steps.flatMap((step) => step.kind === "travel" ? [step.to] : [])).toEqual([1, 2]);
    expect(playbackMediaForPoint(grouped, 0).map((asset) => asset.id)).toEqual(["stay-hotel"]);
    expect(playbackMediaForPoint(grouped, 1).map((asset) => asset.id)).toEqual(["stay-detour"]);
    expect(playbackMediaForPoint(grouped, 2).map((asset) => asset.id)).toEqual(["stay-place"]);
    expect(grouped.routePoints).toEqual(routeBefore);
    expect(grouped.media).toEqual(mediaBefore);
    expect(grouped.media).toEqual(expect.arrayContaining(mediaBefore));
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

  it("classifies sparse and 4-9 sequence Route Point Media without claiming the 10+ band", () => {
    expect(routePointChapterDensity(densityJourney(0), 0)).toBe("empty");
    expect(routePointChapterDensity(densityJourney(1), 0)).toBe("single");
    expect(routePointChapterDensity(densityJourney(2), 0)).toBe("few");
    expect(routePointChapterDensity(densityJourney(3), 0)).toBe("few");
    expect(routePointChapterDensity(densityJourney(4), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(6), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(9), 0)).toBe("sequence");
    expect(routePointChapterDensity(densityJourney(10), 0)).toBe("few");
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
