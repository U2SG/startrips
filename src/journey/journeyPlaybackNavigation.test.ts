import { describe, expect, it } from "vitest";
import {
  buildPlaybackSteps,
  initialPlaybackState,
  meaningfulPlaybackStepIndex,
  meaningfulPlaybackStepIndexes,
  playbackReducer,
} from "./journeyPlayback";
import { buildPlaybackPlan, nextMeaningfulStepIndex } from "./journeyPlaybackPlan";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

const point = (id: string, sortOrder: number): RoutePoint => ({
  id,
  journeyId: "journey-nav",
  sortOrder,
  latitude: 22 + sortOrder,
  longitude: 114 + sortOrder,
  label: id,
  isStop: true,
  occurredAt: null,
  note: "",
  createdAt: "2026-09-01T00:00:00.000Z",
});

const media = (id: string, routePointId: string, sortOrder = 0): JourneyMediaAsset => ({
  id,
  journeyId: "journey-nav",
  routePointId,
  storageDriver: "test",
  storageKey: id,
  fileName: `${id}.jpg`,
  mimeType: "image/jpeg",
  bytes: 128,
  sortOrder,
  uploadedByUserId: "user-1",
  createdAt: "2026-09-01T00:00:00.000Z",
});

const journey: Journey = {
  id: "journey-nav",
  atlasId: "atlas-1",
  title: "Navigation fixture",
  startedOn: "2026-09-01",
  endedOn: null,
  note: "",
  lightColor: "#ffffff",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  routePoints: [point("point-0", 0), point("point-1", 1)],
  media: [media("media-0", "point-0"), media("media-1", "point-1")],
};

describe("meaningful Journey Playback navigation (#126)", () => {
  it("skips travel and populated-arrival bookkeeping in both manual directions", () => {
    const steps = buildPlaybackSteps(journey);
    expect(steps.map((step) => step.kind)).toEqual([
      "intro", "stop", "media", "travel", "stop", "media", "outro",
    ]);
    // #456: both points are `single` density, so neither arrival is its own
    // manual destination — the chapter's memory is.
    const meaningful = meaningfulPlaybackStepIndexes(steps);
    expect(meaningful).toEqual([0, 2, 5, 6]);
    expect(meaningfulPlaybackStepIndex(meaningful, 2, 1)).toBe(5);
    expect(meaningfulPlaybackStepIndex(meaningful, 3, 1)).toBe(5);
    expect(meaningfulPlaybackStepIndex(meaningful, 4, 1)).toBe(5);
    expect(meaningfulPlaybackStepIndex(meaningful, 5, -1)).toBe(2);
    expect(meaningfulPlaybackStepIndex(meaningful, 4, -1)).toBe(2);
    expect(meaningfulPlaybackStepIndex(meaningful, 3, -1)).toBe(2);
  });

  it("gives the plan and the reducer the same meaningful moments", () => {
    const steps = buildPlaybackSteps(journey);
    const plan = buildPlaybackPlan(journey, "standard");
    const meaningful = meaningfulPlaybackStepIndexes(steps);
    expect(plan.meaningfulStepIndexes).toEqual(meaningful);
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const forward = playbackReducer(
        journey,
        { stepIndex, phase: { type: "intro" }, paused: false },
        { type: "next" },
      );
      const backward = playbackReducer(
        journey,
        { stepIndex, phase: { type: "intro" }, paused: false },
        { type: "previous" },
      );
      expect(nextMeaningfulStepIndex(plan, stepIndex, 1)).toBe(forward.stepIndex);
      expect(nextMeaningfulStepIndex(plan, stepIndex, -1)).toBe(backward.stepIndex);
    }
  });

  it("keeps automatic advance on the full cinematic stream", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "advance" });
    state = playbackReducer(journey, state, { type: "advance" });
    state = playbackReducer(journey, state, { type: "advance" });
    expect(state.phase).toEqual({ type: "travel", from: 0, to: 1 });
  });

  it("maps manual next and previous to user-visible beats", () => {
    // #456: one click per memory. The arrival of a populated chapter is no
    // longer the extra click between the place and the photo it is about.
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "next" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
    state = playbackReducer(journey, state, { type: "next" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 1, mediaIndex: 0 });
    state = playbackReducer(journey, state, { type: "previous" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
  });

  it("never lands manual navigation on a populated arrival, in either direction", () => {
    const steps = buildPlaybackSteps(journey);
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      for (const control of [{ type: "next" } as const, { type: "previous" } as const]) {
        const landed = playbackReducer(
          journey,
          { stepIndex, phase: { type: "intro" }, paused: false },
          control,
        );
        const landedStep = steps[landed.stepIndex];
        expect(landedStep.kind === "stop" && landedStep.media.length > 0).toBe(false);
      }
    }
  });

  it("keeps an empty chapter's arrival as its sole manual destination", () => {
    // 0 media: the place IS the memory, so the arrival must stay reachable —
    // dropping it would make that Route Point unreachable by Next/Previous.
    const emptyJourney: Journey = {
      ...journey,
      routePoints: [point("point-0", 0), point("empty-point", 1), point("point-1", 2)],
      media: [media("media-0", "point-0"), media("media-1", "point-1")],
    };
    const steps = buildPlaybackSteps(emptyJourney);
    expect(steps.map((step) => step.kind)).toEqual([
      "intro", "stop", "media", "travel", "stop", "travel", "stop", "media", "outro",
    ]);
    const meaningful = meaningfulPlaybackStepIndexes(steps);
    expect(meaningful).toEqual([0, 2, 4, 7, 8]);

    let state = initialPlaybackState();
    state = playbackReducer(emptyJourney, state, { type: "next" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
    state = playbackReducer(emptyJourney, state, { type: "next" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 1 });
    state = playbackReducer(emptyJourney, state, { type: "next" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 2, mediaIndex: 0 });
    state = playbackReducer(emptyJourney, state, { type: "previous" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 1 });
  });

  it("keeps every media of a few-density chapter reachable in one continuous run", () => {
    const fewJourney: Journey = {
      ...journey,
      routePoints: [point("point-0", 0)],
      media: [
        media("few-0", "point-0", 0),
        media("few-1", "point-0", 1),
        media("few-2", "point-0", 2),
      ],
    };
    const steps = buildPlaybackSteps(fewJourney);
    expect(steps.map((step) => step.kind)).toEqual([
      "intro", "stop", "media", "media", "media", "outro",
    ]);
    expect(meaningfulPlaybackStepIndexes(steps)).toEqual([0, 2, 3, 4, 5]);

    let state = initialPlaybackState();
    const visited = [];
    for (let click = 0; click < 4; click += 1) {
      state = playbackReducer(fewJourney, state, { type: "next" });
      visited.push(state.phase);
    }
    expect(visited).toEqual([
      { type: "media", pointIndex: 0, mediaIndex: 0 },
      { type: "media", pointIndex: 0, mediaIndex: 1 },
      { type: "media", pointIndex: 0, mediaIndex: 2 },
      { type: "outro" },
    ]);
  });


  it("keeps Back usable while paused and preserves pause ownership", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "next" });
    state = playbackReducer(journey, state, { type: "next" });
    state = playbackReducer(journey, state, { type: "pause" });
    state = playbackReducer(journey, state, { type: "previous" });
    expect(state.stepIndex).toBe(2);
    expect(state.paused).toBe(true);
    expect(state.phase).toEqual({
      type: "paused",
      previous: { type: "media", pointIndex: 0, mediaIndex: 0 },
    });
  });

  it("keeps next, back and raw advance meaningful while paused without resuming", () => {
    let pausedMedia = initialPlaybackState();
    pausedMedia = playbackReducer(journey, pausedMedia, { type: "seek", stepIndex: 2 });
    pausedMedia = playbackReducer(journey, pausedMedia, { type: "pause" });

    const next = playbackReducer(journey, pausedMedia, { type: "next" });
    expect(next).toEqual({
      stepIndex: 5,
      phase: { type: "paused", previous: { type: "media", pointIndex: 1, mediaIndex: 0 } },
      paused: true,
    });

    const advanced = playbackReducer(journey, pausedMedia, { type: "advance" });
    expect(advanced).toEqual(next);

    const back = playbackReducer(journey, next, { type: "back" });
    expect(back).toEqual({
      stepIndex: 2,
      phase: { type: "paused", previous: { type: "media", pointIndex: 0, mediaIndex: 0 } },
      paused: true,
    });
  });

  it("replay leaves completion at exactly the initial transport state", () => {
    const steps = buildPlaybackSteps(journey);
    let state = playbackReducer(journey, initialPlaybackState(), {
      type: "seek",
      stepIndex: steps.length - 1,
    });
    state = playbackReducer(journey, state, { type: "advance" });
    expect(state.phase).toEqual({ type: "completed" });
    expect(playbackReducer(journey, state, { type: "replay" })).toEqual(initialPlaybackState());
  });

  it("clamps manual navigation at intro and outro", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "previous" });
    expect(state.phase).toEqual({ type: "intro" });
    for (let index = 0; index < 8; index += 1) {
      state = playbackReducer(journey, state, { type: "next" });
    }
    expect(state.phase).toEqual({ type: "outro" });
  });
});
