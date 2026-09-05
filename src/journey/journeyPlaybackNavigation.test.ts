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
  it("skips travel bookkeeping in both manual directions", () => {
    const steps = buildPlaybackSteps(journey);
    expect(steps.map((step) => step.kind)).toEqual([
      "intro", "stop", "media", "travel", "stop", "media", "outro",
    ]);
    const meaningful = meaningfulPlaybackStepIndexes(steps);
    expect(meaningfulPlaybackStepIndex(meaningful, 2, 1)).toBe(4);
    expect(meaningfulPlaybackStepIndex(meaningful, 3, 1)).toBe(4);
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
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "next" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 0 });
    state = playbackReducer(journey, state, { type: "next" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
    state = playbackReducer(journey, state, { type: "next" });
    expect(state.phase).toEqual({ type: "stop", pointIndex: 1 });
    state = playbackReducer(journey, state, { type: "previous" });
    expect(state.phase).toEqual({ type: "media", pointIndex: 0, mediaIndex: 0 });
  });


  it("keeps Back usable while paused and preserves pause ownership", () => {
    let state = initialPlaybackState();
    state = playbackReducer(journey, state, { type: "next" });
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
