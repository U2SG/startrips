import { describe, expect, it } from "vitest";
import {
  PLAYBACK_TEMPO_PROFILES,
  buildPlaybackPlan,
  nextMeaningfulStepIndex,
  resolvePlaybackStepDurationMs,
  type PlaybackStepDurationResolver,
  playbackElapsedForFraction,
  playbackSegmentAtElapsed,
  playbackStepDurationForTempo,
} from "./journeyPlaybackPlan";
import { buildPlaybackSteps, playbackStepIdentity } from "./journeyPlayback";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

function point(id: string, sortOrder: number, longitude: number, note: string | null = null): RoutePoint {
  return {
    id,
    journeyId: "journey-1",
    sortOrder,
    latitude: 22.3,
    longitude,
    label: id,
    isStop: true,
    occurredAt: null,
    note,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function media(id: string, routePointId: string | null, mimeType = "image/jpeg", sortOrder = 0): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-1",
    routePointId,
    storageDriver: "test",
    storageKey: id,
    fileName: id,
    mimeType,
    bytes: 1,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function fixture(mediaPerPoint = 2): Journey {
  const routePoints = [point("p0", 0, 114.1, "arrival note"), point("p1", 1, 114.2)];
  return {
    id: "journey-1",
    atlasId: "atlas-1",
    title: "Playback V2",
    startedOn: "2026-09-01",
    endedOn: null,
    note: "",
    lightColor: "#fff",
    revision: 1,
    createdByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    routePoints,
    media: routePoints.flatMap((routePoint, pointIndex) => Array.from(
      { length: mediaPerPoint },
      (_, mediaIndex) => media(
        `${routePoint.id}-m${mediaIndex}`,
        routePoint.id,
        pointIndex === 1 && mediaIndex === 0 ? "video/mp4" : "image/jpeg",
        mediaIndex,
      ),
    )),
  };
}

describe("Playback V2 timeline planner (#126)", () => {
  it("keeps every visual asset in canonical order for full playback", () => {
    const journey = fixture(3);
    const plan = buildPlaybackPlan(journey, "standard");
    expect(plan.segments.filter((segment) => segment.kind === "media").map((segment) => segment.assetId))
      .toEqual(["p0-m0", "p0-m1", "p0-m2", "p1-m0", "p1-m1", "p1-m2"]);
  });

  // The discriminating fixture for the index space: journey-scoped media
  // (routePointId null) is NOT a beat of `buildPlaybackSteps`, so a plan that
  // gave it a segment of its own would address every later beat one index too
  // late — the seek target and the timer would disagree from the intro on.
  it("addresses the same beat as buildPlaybackSteps at every index", () => {
    const journey = fixture(2);
    journey.media.unshift(
      media("journey-image", null, "image/jpeg", 0),
      media("journey-video", null, "video/mp4", 1),
    );
    const steps = buildPlaybackSteps(journey);
    const plan = buildPlaybackPlan(journey, "standard");
    expect(plan.segments).toHaveLength(steps.length);
    plan.segments.forEach((segment, index) => {
      expect(segment.stepIndex).toBe(index);
      expect(segment.id).toBe(
        playbackStepIdentity(journey, steps[index]).replace(/^stop:/, "arrival:"),
      );
    });
    expect(plan.segments.map((segment) => segment.assetId).filter(Boolean))
      .toEqual(["p0-m0", "p0-m1", "p1-m0", "p1-m1"]);
    expect(playbackSegmentAtElapsed(plan, plan.segments[3].startMs)?.stepIndex).toBe(3);
  });

  it("totals exactly what the director's durationForStep will spend, at every tempo", () => {
    const journey = fixture(2);
    const steps = buildPlaybackSteps(journey);
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const plan = buildPlaybackPlan(journey, tempo);
      const directorTotalMs = steps.reduce(
        (total, step) => total + resolvePlaybackStepDurationMs(journey, step, tempo),
        0,
      );
      expect(plan.totalDurationMs).toBe(directorTotalMs);
    }
  });

  it("plans the beats a Quick Recap-style resolver overrides at their overridden length", () => {
    const journey = fixture(2);
    const steps = buildPlaybackSteps(journey);
    // Overrides one beat only, the way quickRecapStepDurationMs answers for the
    // beats its Edit Plan owns and leaves the rest to the tempo profile.
    const resolver: PlaybackStepDurationResolver = (target, step) => (
      playbackStepIdentity(target, step) === "media:p0-m1" ? 640 : undefined
    );
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const plan = buildPlaybackPlan(journey, tempo, resolver);
      const directorTotalMs = steps.reduce(
        (total, step) => total + resolvePlaybackStepDurationMs(journey, step, tempo, resolver),
        0,
      );
      expect(plan.totalDurationMs).toBe(directorTotalMs);
      expect(plan.segments.find((segment) => segment.assetId === "p0-m1")?.durationMs).toBe(640);
      expect(plan.totalDurationMs).not.toBe(buildPlaybackPlan(journey, tempo).totalDurationMs);
    }
  });

  it("exposes the same phase-specific duration policy to the live director", () => {
    const journey = fixture(1);
    const mediaStep = buildPlaybackSteps(journey).find((step) => step.kind === "media")!;
    expect(playbackStepDurationForTempo(
      journey,
      mediaStep,
      PLAYBACK_TEMPO_PROFILES.fast,
    )).toBe(PLAYBACK_TEMPO_PROFILES.fast.imageMs);
    expect(playbackStepDurationForTempo(
      journey,
      mediaStep,
      PLAYBACK_TEMPO_PROFILES.immersive,
    )).toBe(PLAYBACK_TEMPO_PROFILES.immersive.imageMs);
  });

  it("maps tempo independently by phase instead of applying one global multiplier", () => {
    const journey = fixture(1);
    const fast = buildPlaybackPlan(journey, "fast");
    const standard = buildPlaybackPlan(journey, "standard");
    const immersive = buildPlaybackPlan(journey, "immersive");
    expect(fast.totalDurationMs).toBeLessThan(standard.totalDurationMs);
    expect(standard.totalDurationMs).toBeLessThan(immersive.totalDurationMs);
    expect(PLAYBACK_TEMPO_PROFILES.fast.imageMs / PLAYBACK_TEMPO_PROFILES.standard.imageMs)
      .not.toBeCloseTo(
        PLAYBACK_TEMPO_PROFILES.fast.travelBaseMs / PLAYBACK_TEMPO_PROFILES.standard.travelBaseMs,
        3,
      );
  });

  it("builds a contiguous elapsed-time model and resolves scrub positions", () => {
    const plan = buildPlaybackPlan(fixture(2), "standard");
    expect(plan.segments[0].startMs).toBe(0);
    for (let index = 1; index < plan.segments.length; index += 1) {
      const previous = plan.segments[index - 1];
      expect(plan.segments[index].startMs).toBe(previous.startMs + previous.durationMs);
    }
    expect(playbackElapsedForFraction(plan, 0.5)).toBe(plan.totalDurationMs / 2);
    expect(playbackSegmentAtElapsed(plan, plan.totalDurationMs)).toBe(plan.segments.at(-1));
  });

  it("skips internal travel bookkeeping for manual next/back", () => {
    const plan = buildPlaybackPlan(fixture(1), "standard");
    const travel = plan.segments.find((segment) => segment.kind === "travel")!;
    const before = nextMeaningfulStepIndex(plan, travel.stepIndex, -1);
    const after = nextMeaningfulStepIndex(plan, travel.stepIndex, 1);
    expect(plan.segments[before].kind).not.toBe("travel");
    expect(plan.segments[after].kind).not.toBe("travel");
    expect(after).toBeGreaterThan(travel.stepIndex);
  });

  it("scales long journeys through explicit tempo policy without dropping media", () => {
    const journey = fixture(25);
    const standard = buildPlaybackPlan(journey, "standard");
    const fast = buildPlaybackPlan(journey, "fast");
    expect(standard.segments.filter((segment) => segment.kind === "media")).toHaveLength(50);
    expect(fast.segments.filter((segment) => segment.kind === "media")).toHaveLength(50);
    expect(fast.totalDurationMs).toBeLessThan(standard.totalDurationMs);
  });
});
