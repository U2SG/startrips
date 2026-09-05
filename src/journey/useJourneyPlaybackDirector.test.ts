import { describe, expect, it } from "vitest";
import {
  consumePlaybackTimerBudget,
  playbackProgressFraction,
  replanPlaybackTimerBudget,
  resolvePlaybackTimerBudget,
} from "./useJourneyPlaybackDirector";
import { buildPlaybackPlan } from "./journeyPlaybackPlan";
import { resolveVideoTrim, videoTrimPlayedFraction } from "./videoTrimPlayback";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

describe("consumePlaybackTimerBudget (#126)", () => {
  it("subtracts only elapsed active time from the current step budget", () => {
    expect(consumePlaybackTimerBudget(4500, 1_000, 2_250)).toBe(3250);
  });

  it("never returns a negative remaining duration", () => {
    expect(consumePlaybackTimerBudget(900, 1_000, 2_500)).toBe(0);
  });

  it("ignores a backwards clock sample", () => {
    expect(consumePlaybackTimerBudget(1200, 2_000, 1_500)).toBe(1200);
  });
});


describe("replanPlaybackTimerBudget (#126)", () => {
  it("preserves elapsed progress when tempo changes during an active beat", () => {
    expect(replanPlaybackTimerBudget(1400, 2800, 1700)).toBe(850);
    expect(replanPlaybackTimerBudget(1400, 2800, 4500)).toBe(2250);
  });

  it("keeps completed beats completed and clamps invalid remaining input", () => {
    expect(replanPlaybackTimerBudget(0, 2800, 1700)).toBe(0);
    expect(replanPlaybackTimerBudget(4000, 2800, 1700)).toBe(1700);
  });

  it("falls back to the new duration when the previous budget is invalid", () => {
    expect(replanPlaybackTimerBudget(0, 0, 1700)).toBe(1700);
  });
});

describe("resolvePlaybackTimerBudget (#210)", () => {
  const beat = "j1:media:asset-a";
  const other = "j1:media:asset-b";

  it("scales the remaining budget when the same beat is re-resolved to a new length", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: beat,
      nextKey: beat,
      current: { remainingMs: 1400, fullDurationMs: 2800 },
      nextFullDurationMs: 1700,
      carry: null,
      carryAllowed: false,
    });
    expect(result.budget).toEqual({ remainingMs: 850, fullDurationMs: 1700 });
  });

  it("keeps the elapsed fraction when a rebuild moves the playing beat to another index", () => {
    // Frame 1: the rebuilt plan arrives before the remapping seek, so the old
    // index now addresses a different beat and parks the live budget.
    const parked = resolvePlaybackTimerBudget({
      previousKey: beat,
      nextKey: other,
      current: { remainingMs: 1400, fullDurationMs: 2800 },
      nextFullDurationMs: 3000,
      carry: null,
      carryAllowed: false,
    });
    expect(parked.budget).toEqual({ remainingMs: 3000, fullDurationMs: 3000 });
    expect(parked.carry).toEqual({ key: beat, remainingMs: 1400, fullDurationMs: 2800 });

    // Frame 2: the remap seek lands back on the same beat at its new index and
    // resumes it half-watched instead of restarting the image.
    const remapped = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: beat,
      current: parked.budget,
      nextFullDurationMs: 1700,
      carry: parked.carry,
      carryAllowed: true,
    });
    expect(remapped.budget).toEqual({ remainingMs: 850, fullDurationMs: 1700 });
    expect(remapped.carry).toBeNull();
  });

  it("starts fresh when the rebuild deleted the beat and playback lands on a neighbour", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: "j1:stop:point-2",
      current: { remainingMs: 3000, fullDurationMs: 3000 },
      nextFullDurationMs: 1700,
      carry: { key: beat, remainingMs: 1400, fullDurationMs: 2800 },
      carryAllowed: true,
    });
    expect(result.budget).toEqual({ remainingMs: 1700, fullDurationMs: 1700 });
  });

  it("restarts a beat the viewer seeks back to instead of resuming it", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: other,
      nextKey: beat,
      current: { remainingMs: 3000, fullDurationMs: 3000 },
      nextFullDurationMs: 2800,
      carry: { key: beat, remainingMs: 1400, fullDurationMs: 2800 },
      carryAllowed: false,
    });
    expect(result.budget).toEqual({ remainingMs: 2800, fullDurationMs: 2800 });
  });

  it("starts the first beat of a run at its full duration", () => {
    const result = resolvePlaybackTimerBudget({
      previousKey: null,
      nextKey: beat,
      current: null,
      nextFullDurationMs: 2800,
      carry: null,
      carryAllowed: true,
    });
    expect(result.budget).toEqual({ remainingMs: 2800, fullDurationMs: 2800 });
    expect(result.carry).toBeNull();
  });
});


function progressPoint(id: string, sortOrder: number): RoutePoint {
  return {
    id,
    journeyId: "journey-progress",
    sortOrder,
    latitude: 22 + sortOrder,
    longitude: 114 + sortOrder,
    label: id,
    isStop: true,
    occurredAt: null,
    note: "a note",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function progressMedia(id: string, routePointId: string): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-progress",
    routePointId,
    storageDriver: "test",
    storageKey: id,
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    bytes: 64,
    sortOrder: 0,
    uploadedByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

const progressJourney: Journey = {
  id: "journey-progress",
  atlasId: "atlas-1",
  title: "Progress fixture",
  startedOn: "2026-09-01",
  endedOn: null,
  note: "",
  lightColor: "#ffffff",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  routePoints: [progressPoint("point-0", 0), progressPoint("point-1", 1)],
  media: [progressMedia("media-0", "point-0"), progressMedia("media-1", "point-1")],
};

describe("playbackProgressFraction (#126)", () => {
  const plan = buildPlaybackPlan(progressJourney, "standard");

  it("moves inside a single beat as that beat's budget drains", () => {
    const stepIndex = 2;
    const fullDurationMs = plan.segments[stepIndex].durationMs;
    const samples = [fullDurationMs, fullDurationMs * 0.75, fullDurationMs * 0.5, 0]
      .map((remainingMs) => playbackProgressFraction(plan, stepIndex, remainingMs, fullDurationMs));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1]);
    }
    // The beat owns its own stretch of the bar and nothing beyond it.
    expect(samples[0]).toBe(plan.segments[stepIndex].startMs / plan.totalDurationMs);
    expect(samples.at(-1)).toBe(
      (plan.segments[stepIndex].startMs + fullDurationMs) / plan.totalDurationMs,
    );
    expect(samples.at(-1)).toBe(plan.segments[stepIndex + 1].startMs / plan.totalDurationMs);
  });

  it("reaches exactly 1 when the last beat's budget is spent", () => {
    const lastIndex = plan.segments.length - 1;
    const fullDurationMs = plan.segments[lastIndex].durationMs;
    expect(playbackProgressFraction(plan, lastIndex, 0, fullDurationMs)).toBe(1);
    expect(playbackProgressFraction(plan, lastIndex, fullDurationMs, fullDurationMs))
      .toBeLessThan(1);
  });

  it("stays inside the beat when the live budget and the planned length disagree", () => {
    const stepIndex = 2;
    const planned = plan.segments[stepIndex];
    // A tempo change re-resolves the beat before the plan is rebuilt at that
    // tempo, so the live budget is briefly longer or shorter than the plan's.
    for (const fullDurationMs of [planned.durationMs * 3, planned.durationMs / 3]) {
      const fraction = playbackProgressFraction(plan, stepIndex, 0, fullDurationMs);
      expect(fraction).toBe((planned.startMs + planned.durationMs) / plan.totalDurationMs);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it("never returns NaN for a missing plan, an unknown beat or an empty budget", () => {
    expect(playbackProgressFraction(null, 0, 0, 1000)).toBe(0);
    expect(playbackProgressFraction(plan, plan.segments.length, 0, 1000)).toBe(0);
    expect(playbackProgressFraction(plan, -1, 0, 1000)).toBe(0);
    expect(playbackProgressFraction(plan, 0, 0, 0))
      .toBe(plan.segments[0].durationMs / plan.totalDurationMs);
    expect(playbackProgressFraction({ ...plan, segments: [], totalDurationMs: 0 }, 0, 0, 0)).toBe(0);
  });

  // Review follow-up on #236: an untrimmed video beat is held by
  // `playbackMediaWaitPolicy` until `ended`, so its budget never drains and the
  // budget-driven position stands still for the video's whole runtime. The
  // overlay reads that beat from the element instead, through this same
  // helper — the composition below is what both the visible fill and the
  // scrubber's announced value are given, so they cannot disagree.
  it("positions a media-owned beat from the element's played share of it", () => {
    const stepIndex = 2;
    const planned = plan.segments[stepIndex];
    const sourceSeconds = 12;
    const untrimmed = resolveVideoTrim(null, sourceSeconds);
    const positionAt = (currentTimeSeconds: number) => playbackProgressFraction(
      plan,
      stepIndex,
      1 - videoTrimPlayedFraction(untrimmed, currentTimeSeconds, sourceSeconds),
      1,
    );

    // Held: the budget says the beat has not started, for the whole video.
    const heldByBudget = playbackProgressFraction(plan, stepIndex, planned.durationMs, planned.durationMs);
    expect(heldByBudget).toBe(planned.startMs / plan.totalDurationMs);

    const samples = [0, 3, 6, 9, 12].map(positionAt);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1]);
    }
    // Mid-video the element's position and the pinned budget disagree — that
    // disagreement is the defect this covers.
    expect(samples[2]).toBeGreaterThan(heldByBudget);
    // The beat still owns exactly its own stretch of the bar, whatever the
    // source's real length is against the length the plan booked for it.
    expect(samples[0]).toBe(planned.startMs / plan.totalDurationMs);
    expect(samples.at(-1)).toBe((planned.startMs + planned.durationMs) / plan.totalDurationMs);
    expect(samples[2]).toBe((planned.startMs + planned.durationMs / 2) / plan.totalDurationMs);
  });
});
