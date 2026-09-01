import { describe, expect, it } from "vitest";
import {
  PLAYBACK_PACING,
  buildPlaybackSteps,
  initialPlaybackState,
  playbackReducer,
  playbackCameraTargetForStep,
  playbackTravelChoreography,
  playbackCameraTargetKey,
  playbackMediaForPoint,
  playbackStoryMedia,
  storyMediaForScope,
  routePointAngularDistance,
  stepDurationMs,
  travelDurationMs,
} from "./journeyPlayback";
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

describe("routePointAngularDistance / travelDurationMs (#19)", () => {
  it("maps angular distance to a clamped travel duration", () => {
    expect(routePointAngularDistance(point("a", 0, 0), point("b", 0, 60))).toBeCloseTo(
      Math.PI / 3,
      6,
    );
    const short = travelDurationMs(point("a", 0, 0), point("b", 0, 1));
    const long = travelDurationMs(point("a", 0, 0), point("b", 0, 90));
    expect(short).toBeGreaterThan(PLAYBACK_PACING.travelBaseMs);
    expect(long).toBeLessThanOrEqual(PLAYBACK_PACING.travelMaxMs);
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

  it("returns no camera command when playback has no current step", () => {
    expect(playbackCameraTargetForStep(undefined)).toBeNull();
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
    // Outro is the last step and advance clamps there.
    for (let index = 0; index < steps.length; index += 1) {
      state = playbackReducer(journey, state, { type: "advance" });
    }
    expect(state.phase).toEqual({ type: "outro" });
    const clamped = playbackReducer(journey, state, { type: "advance" });
    expect(clamped.phase).toEqual({ type: "outro" });
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

  it("pause freezes advancement and resume restores the previous phase", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "advance" });
    state = playbackReducer(journey, state, { type: "pause" });
    expect(state.paused).toBe(true);
    expect(state.phase).toEqual({
      type: "paused",
      previous: { type: "stop", pointIndex: 0 },
    });
    const advanced = playbackReducer(journey, state, { type: "advance" });
    expect(advanced.stepIndex).toBe(state.stepIndex); // paused: no advance
    const resumed = playbackReducer(journey, state, { type: "resume" });
    expect(resumed.paused).toBe(false);
    expect(resumed.phase).toEqual({ type: "stop", pointIndex: 0 });
  });
});

describe("stepDurationMs (#19)", () => {
  it("returns the deterministic pacing for each step kind", () => {
    const steps = buildPlaybackSteps(journey);
    expect(stepDurationMs(journey, steps[0])).toBe(PLAYBACK_PACING.introMs);
    expect(stepDurationMs(journey, steps[1])).toBeGreaterThanOrEqual(
      PLAYBACK_PACING.stopMinMs,
    );
    expect(stepDurationMs(journey, steps[3])).toBeLessThanOrEqual(
      PLAYBACK_PACING.travelMaxMs,
    );
    expect(stepDurationMs(journey, steps[5])).toBe(PLAYBACK_PACING.videoMs);
    expect(stepDurationMs(journey, steps.at(-1)!)).toBe(PLAYBACK_PACING.outroMs);
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
