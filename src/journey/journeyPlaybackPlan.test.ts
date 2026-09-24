import { describe, expect, it } from "vitest";
import {
  buildPlaybackPlan,
  nextMeaningfulStepIndex,
  resolvePlaybackStepDurationMs,
  type PlaybackStepDurationResolver,
  playbackElapsedForFraction,
  playbackSegmentAtElapsed,
  playbackStepDurationForTempo,
} from "./journeyPlaybackPlan";
import { buildPlaybackSteps, playbackCameraTargetForStep, playbackStepIdentity, type PlaybackStep } from "./journeyPlayback";
import type { HomeNarrativeContext } from "./homeBasePrelude";
import { NARRATIVE_TIMING_PROFILES } from "./narrativeTiming";
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


function homeContext(): HomeNarrativeContext {
  return {
    prelude: {
      eligible: true,
      reason: "eligible",
      cameraTarget: {
        kind: "home", homeBaseId: "home-start", latitude: 22.54, longitude: 114.05,
        anchor: { x: 1, y: 2, z: 3 },
      },
    },
    epilogue: {
      eligible: true,
      reason: "eligible",
      cameraTarget: {
        kind: "home", homeBaseId: "home-end", latitude: 35.67, longitude: 139.65,
        anchor: { x: 4, y: 5, z: 6 },
      },
    },
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
      NARRATIVE_TIMING_PROFILES.full.fast,
    )).toBe(1700);
    expect(playbackStepDurationForTempo(
      journey,
      mediaStep,
      NARRATIVE_TIMING_PROFILES.full.immersive,
    )).toBe(4500);
  });

  it.each([
    ["fast", 425.235987755983],
    ["standard", 657.8539816339745],
    ["immersive", 911.3446401379631],
  ] as const)("retains fractional live travel at %s tempo", (tempo, expectedMs) => {
    const journey = fixture(1);
    journey.routePoints = [
      { ...point("p0", 0, 0), latitude: 0 },
      { ...point("p1", 1, 1), latitude: 0 },
    ];
    // One degree along the equator has an independently known angular distance.
    const durationMs = resolvePlaybackStepDurationMs(journey, { kind: "travel", to: 1 }, tempo);
    expect(durationMs).toBeCloseTo(expectedMs, 10);
    expect(Number.isInteger(durationMs)).toBe(false);
    expect(buildPlaybackPlan(journey, tempo).segments.find((segment) => segment.kind === "travel")?.durationMs)
      .toBe(durationMs);
  });

  it("preserves non-finite live travel and applies usable overrides before fallback", () => {
    const journey = fixture(1);
    journey.routePoints[1].longitude = Number.NaN;
    const travel = { kind: "travel", to: 1 } as const;
    expect(resolvePlaybackStepDurationMs(journey, travel, "standard")).toBeNaN();
    expect(resolvePlaybackStepDurationMs(journey, travel, "standard", () => 0)).toBe(0);
    for (const invalidOverride of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(resolvePlaybackStepDurationMs(journey, travel, "standard", () => invalidOverride))
        .toBeNaN();
    }
  });

  it("maps tempo independently by phase instead of applying one global multiplier", () => {
    const journey = fixture(1);
    const fast = buildPlaybackPlan(journey, "fast");
    const standard = buildPlaybackPlan(journey, "standard");
    const immersive = buildPlaybackPlan(journey, "immersive");
    expect(fast.totalDurationMs).toBeLessThan(standard.totalDurationMs);
    expect(standard.totalDurationMs).toBeLessThan(immersive.totalDurationMs);
    expect(NARRATIVE_TIMING_PROFILES.full.fast.imageRoleMs.representative
      / NARRATIVE_TIMING_PROFILES.full.standard.imageRoleMs.representative)
      .not.toBeCloseTo(
        NARRATIVE_TIMING_PROFILES.full.fast.travelBaseMs / NARRATIVE_TIMING_PROFILES.full.standard.travelBaseMs,
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

  it("plans large mixed chapters with stable ties and only linear media-owner reads", () => {
    const journey = fixture(0);
    journey.routePoints = [point("p1", 1, 114.2), point("empty", 2, 114.3), point("p0", 0, 114.1)];
    const unconsumed = [
      media("intro-a", null), media("intro-b", null),
      media("orphan-a", "missing"), media("orphan-b", "missing"),
      media("audio-a", "p0", "audio/mpeg"), media("audio-b", "p0", "audio/mpeg"),
    ];
    for (const asset of unconsumed) {
      Object.defineProperty(asset, "sortOrder", {
        get: () => { throw new Error("unconsumed media must not be sorted"); },
      });
    }
    journey.media = [
      ...["p0", "p1"].flatMap((owner) => Array.from({ length: 80 }, (_, index) => (
        media(`${owner}-${index}`, owner, index % 3 === 0 ? "video/mp4" : "image/jpeg", Math.floor((79 - index) / 2))
      ))),
      ...unconsumed,
    ];
    const originalMedia = journey.media.slice();
    let ownerReads = 0;
    for (const asset of journey.media) {
      const owner = asset.routePointId;
      Object.defineProperty(asset, "routePointId", { get: () => { ownerReads += 1; return owner; } });
      Object.freeze(asset);
    }
    Object.freeze(journey.media);
    Object.freeze(journey.routePoints);

    const plan = buildPlaybackPlan(journey, "standard");
    const planOwnerReads = ownerReads;
    const sortedIndexes = Array.from({ length: 40 }, (_, pair) => [78 - pair * 2, 79 - pair * 2]).flat();
    expect(plan.segments.filter((segment) => segment.kind === "media").map((segment) => ({
      id: segment.id, assetId: segment.assetId, routePointId: segment.routePointId, durationMs: segment.durationMs,
    }))).toEqual(["p1", "p0"].flatMap((owner) => sortedIndexes.map((index) => ({
      id: `media:${owner}-${index}`,
      assetId: `${owner}-${index}`,
      routePointId: owner,
      durationMs: index % 3 === 0 ? 6000 : 2800,
    }))));
    expect(plan.segments.filter((segment) => segment.kind === "arrival").map((segment) => segment.routePointId))
      .toEqual(["p1", "empty", "p0"]);
    expect(planOwnerReads).toBeGreaterThanOrEqual(journey.media.length);
    expect(planOwnerReads).toBeLessThanOrEqual(2 * journey.media.length);
    journey.media.forEach((asset, index) => expect(asset).toBe(originalMedia[index]));
  });

  it("rebuilds media ownership and order from changed input without altering the prior plan", () => {
    const journey = fixture(1);
    const original = buildPlaybackPlan(journey);
    journey.media[0].routePointId = "p1";
    journey.media[0].sortOrder = 1;
    journey.media.push(media("new-p0", "p0"));
    const rebuilt = buildPlaybackPlan(journey);
    expect(original.segments.filter((segment) => segment.kind === "media").map((segment) => segment.assetId))
      .toEqual(["p0-m0", "p1-m0"]);
    expect(rebuilt.segments.filter((segment) => segment.kind === "media").map((segment) => segment.assetId))
      .toEqual(["new-p0", "p1-m0", "p0-m0"]);
  });

  it("invokes overrides once with the original arguments before reading the duration fallback", () => {
    const journey = fixture(1);
    const mediaStep = { kind: "media", pointIndex: 0, mediaIndex: 0 } as const;
    const directJourney = { ...journey };
    Object.defineProperty(directJourney, "media", {
      get: () => { throw new Error("a usable override must bypass media selection"); },
    });
    let directCalls = 0;
    expect(resolvePlaybackStepDurationMs(directJourney, mediaStep, "standard", (target, step, tempo) => {
      directCalls += 1;
      expect(target).toBe(directJourney);
      expect(step).toBe(mediaStep);
      expect(tempo).toBe("standard");
      return 0;
    })).toBe(0);
    expect(directCalls).toBe(1);
  });

  it.each([0, 625, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "evaluates each plan override once and preserves Home/fallback timing for %s",
    (override) => {
      const journey = fixture(1);
      const seen: PlaybackStep[] = [];
      const plan = buildPlaybackPlan(journey, "standard", (target, step, tempo) => {
        expect(target).toBe(journey);
        expect(tempo).toBe("standard");
        seen.push(step);
        return override;
      }, homeContext());
      expect(seen.map((step) => step.kind)).toEqual([
        "home-prelude", "intro", "stop", "media", "travel", "stop", "media", "home-epilogue", "outro",
      ]);
      const usableOverride = override !== undefined && Number.isFinite(override) && override >= 0;
      expect(plan.segments.map((segment) => segment.durationMs)).toEqual(seen.map((step) => (
        usableOverride ? override : resolvePlaybackStepDurationMs(journey, step, "standard")
      )));
    },
  );

  it("keeps Home context first-class and aligned without fabricating Route Points", () => {
    const journey = fixture(1);
    const routeBefore = structuredClone(journey.routePoints);
    const context = homeContext();
    const steps = buildPlaybackSteps(journey, context);
    const plan = buildPlaybackPlan(journey, "standard", undefined, context);

    expect(steps.map((step) => step.kind)).toEqual([
      "home-prelude", "intro", "stop", "media", "travel", "stop", "media", "home-epilogue", "outro",
    ]);
    expect(plan.segments).toHaveLength(steps.length);
    plan.segments.forEach((segment, index) => {
      expect(segment.stepIndex).toBe(index);
      expect(segment.id).toBe(playbackStepIdentity(journey, steps[index]).replace(/^stop:/, "arrival:"));
    });
    expect(plan.segments.filter((segment) => segment.kind.startsWith("home-")))
      .toMatchObject([
        { kind: "home-prelude", routePointId: null },
        { kind: "home-epilogue", routePointId: null },
      ]);
    const routeIds = new Set(journey.routePoints.map((point) => point.id));
    expect(plan.segments.every((segment) => segment.routePointId === null || routeIds.has(segment.routePointId)))
      .toBe(true);
    expect(journey.routePoints).toEqual(routeBefore);

    const homeSteps = steps.filter((step) => step.kind === "home-prelude" || step.kind === "home-epilogue");
    expect(homeSteps.map((step) => playbackCameraTargetForStep(step, journey)?.kind)).toEqual(["home", "home"]);
    expect(homeSteps.map((step) => step.cameraTarget.kind)).toEqual(["home", "home"]);
  });

  it("adds exactly introMs + outroMs when both Home beats are eligible", () => {
    const journey = fixture(1);
    const context = homeContext();
    const expectedHomeMs = { fast: 1800, standard: 2600, immersive: 3400 };
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const plain = buildPlaybackPlan(journey, tempo);
      const withHome = buildPlaybackPlan(journey, tempo, undefined, context);
      expect(withHome.totalDurationMs - plain.totalDurationMs).toBeCloseTo(
        expectedHomeMs[tempo],
        8,
      );
    }
  });

});
