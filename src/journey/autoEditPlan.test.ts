import { describe, expect, it } from "vitest";
import { buildDeterministicQuickRecapPlan, type AutoEditPhotoRole, type AutoEditPlanV1, type AutoEditTempo, type MediaDigestV1, validateAutoEditPlanV1 } from "./autoEditPlan";
import { resolveNarrativeTiming } from "./narrativeTiming";

/**
 * Quick Recap durations are read from the shared narrative timing resolver
 * rather than restated as literals, so a resolver change moves the fixtures
 * with it instead of failing them. Full Playback fixtures below still carry
 * plain millisecond numbers: the validator no longer constrains those values at
 * all, it only requires that they add up to the plan's `plannedDurationMs`.
 */
const quickRecapDwellMs = (tempo: AutoEditTempo, mediaRole: AutoEditPhotoRole) =>
  resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "media", mediaKind: "image", mediaRole });
const quickRecapTravelMs = (tempo: AutoEditTempo) =>
  resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "travel" });
const quickRecapArrivalMs = (tempo: AutoEditTempo) =>
  resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "arrival" });

/**
 * Full Playback fixtures below are hand-written — this module builds only
 * Quick Recap plans, so their camera and arrival milliseconds have no resolver
 * to be derived from. They are deliberately *not* 1000 / 800: since #166 the
 * validator constrains neither value, requiring only that the plan's beats sum
 * to `plannedDurationMs`, and a fixture still carrying the flat camera and
 * arrival numbers this module used to export would read as though the removed
 * equalities were still in force. Each fixture states `plannedDurationMs` as
 * arithmetic over these constants so the totals stay honest.
 */
const FULL_CAMERA_DURATION = 1_234;
const FULL_ARRIVAL_DURATION = 777;

/** The validator's own duration recompute, mirrored so forged fixtures can reconcile. */
function sumPlannedDurationMs(plan: AutoEditPlanV1) {
  return plan.chapters.reduce((sum, chapter) =>
    sum + chapter.camera.durationMs + (chapter.arrival?.durationMs ?? 0) + chapter.items.reduce((itemSum, item) =>
      itemSum + (item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : 0)), 0), 0);
}

function digest(id: string, routePointId: string | null, sourceIndex: number, overrides: Partial<MediaDigestV1> = {}): MediaDigestV1 {
  return {
    schemaVersion: 1,
    assetId: id,
    journeyId: "journey-1",
    routePointId,
    sourceRevision: "7",
    mediaType: "image",
    mimeType: "image/jpeg",
    sourceIndex,
    intrinsic: {},
    userSignals: { isJourneyCover: false, pinnedForRecap: false, excludedFromRecap: false },
    ...overrides,
  };
}

const baseInput = {
  journeyId: "journey-1",
  journeyRevision: "7",
  routePointIds: ["tokyo", "kyoto", "osaka"],
  targetDurationMs: 20_000,
  tempo: "standard" as const,
  generatedAt: "2026-09-02T00:00:00.000Z",
};

describe("deterministic auto-edit foundation (#127)", () => {
  it("produces the same baseline plan for the same normalized input", () => {
    const digests = [digest("a", "tokyo", 0), digest("b", "kyoto", 1), digest("c", "osaka", 2)];
    expect(buildDeterministicQuickRecapPlan({ ...baseInput, digests })).toEqual(buildDeterministicQuickRecapPlan({ ...baseInput, digests }));
  });

  it("keeps every route point represented and preserves canonical chronology", () => {
    const digests = [digest("osaka-1", "osaka", 2), digest("tokyo-1", "tokyo", 0), digest("kyoto-1", "kyoto", 1)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["tokyo", "kyoto", "osaka"]);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests }).valid).toBe(true);
  });

  it("rejects duplicate digest identities before one digest can shadow another", () => {
    const canonicalDigests = [digest("tokyo-photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      digests: canonicalDigests,
    });
    const ambiguousDigests = [
      canonicalDigests[0]!,
      digest("tokyo-photo", "kyoto", 99, { sourceRevision: "stale" }),
    ];

    expect(validateAutoEditPlanV1(plan, {
      ...baseInput,
      routePointIds: ["tokyo", "kyoto"],
      digests: ambiguousDigests,
    }).errors).toContain("duplicate digest asset tokyo-photo");
  });

  it("assigns photo-first chapter roles with distinct tempo-aware dwell", () => {
    const digests = [
      digest("tokyo-opener", "tokyo", 0),
      digest("tokyo-detail", "tokyo", 1),
      digest("tokyo-pin", "tokyo", 2, {
        userSignals: { isJourneyCover: false, pinnedForRecap: true, excludedFromRecap: false },
      }),
      digest("kyoto", "kyoto", 3),
      digest("osaka", "osaka", 4),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, targetDurationMs: 30_000, digests });
    const tokyo = plan.chapters.find((chapter) => chapter.routePointId === "tokyo");
    expect(tokyo?.items.map((item) => [item.assetId, item.photoRole, item.dwellMs])).toEqual([
      ["tokyo-opener", "hero", quickRecapDwellMs("standard", "hero")],
      ["tokyo-detail", "supporting", quickRecapDwellMs("standard", "supporting")],
      ["tokyo-pin", "representative", quickRecapDwellMs("standard", "representative")],
    ]);
    expect(new Set(tokyo?.items.map((item) => item.dwellMs)).size).toBe(3);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true });
  });

  it("rejects forged Quick Recap photo roles and dwell even when planned duration is reconciled", () => {
    const digests = [
      digest("hero", "tokyo", 0),
      digest("support", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 20_000,
      digests,
    });
    const forgedRole = structuredClone(plan);
    forgedRole.chapters[0]!.items[1]!.photoRole = "hero";
    forgedRole.chapters[0]!.items[1]!.dwellMs = forgedRole.chapters[0]!.items[0]!.dwellMs;
    forgedRole.plannedDurationMs = sumPlannedDurationMs(forgedRole);
    const roleResult = validateAutoEditPlanV1(forgedRole, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(roleResult.valid).toBe(false);
    expect(roleResult.errors).toContain("photo role semantic mismatch support");

    // A dwell may now be any finite non-negative number the resolver could
    // produce, but it may not disagree with the plan's own declared duration.
    const forgedDwell = structuredClone(plan);
    forgedDwell.chapters[0]!.items[0]!.dwellMs = 9_999;
    const dwellResult = validateAutoEditPlanV1(forgedDwell, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(dwellResult.valid).toBe(false);
    expect(dwellResult.errors).toContain("planned duration mismatch");
  });

  it("rejects a tampered planned duration for every beat that contributes to it", () => {
    const digests = [
      digest("hero", "tokyo", 0),
      digest("clip", "tokyo", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 10_000 } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 20_000, digests,
    });
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).valid).toBe(true);

    const tamperings: Array<[string, (forged: AutoEditPlanV1) => void]> = [
      ["camera", (forged) => { forged.chapters[0]!.camera.durationMs += 500; }],
      ["arrival", (forged) => { forged.chapters[0]!.arrival!.durationMs += 500; }],
      ["dwell", (forged) => { forged.chapters[0]!.items[0]!.dwellMs = 9_999; }],
      ["trim", (forged) => { forged.chapters[0]!.items[1]!.trim = { inMs: 0, outMs: 1_234 }; }],
      ["declared total", (forged) => { forged.plannedDurationMs += 1; }],
    ];
    for (const [label, tamper] of tamperings) {
      const forged = structuredClone(plan);
      tamper(forged);
      const result = validateAutoEditPlanV1(forged, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.valid, label).toBe(false);
      expect(result.errors, label).toContain("planned duration mismatch");
    }
  });

  it("still rejects a Quick Recap video trim that leaves its source bounds", () => {
    const digests = [digest("clip", "tokyo", 0, {
      mediaType: "video",
      mimeType: "video/mp4",
      intrinsic: { durationMs: 3_000 },
    })];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 20_000,
      digests,
    });
    // The resolver clamps the clip to its own source duration, not to a fixed budget.
    expect(plan.chapters[0]!.items[0]!.trim).toEqual({ inMs: 0, outMs: 3_000 });
    const forged = structuredClone(plan);
    forged.chapters[0]!.items[0]!.trim = { inMs: 1_000, outMs: 6_000 };
    forged.plannedDurationMs = sumPlannedDurationMs(forged);
    const result = validateAutoEditPlanV1(forged, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("invalid trim clip");
  });

  it("rejects a source-bounded Quick Recap trim whose in-point is not zero", () => {
    const digests = [digest("clip", "tokyo", 0, {
      mediaType: "video",
      mimeType: "video/mp4",
      intrinsic: { durationMs: 12_000 },
    })];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 60_000,
      digests,
    });
    // Phase 1 of #195 keeps a Quick Recap video whole, so the planner itself
    // never emits a late in-point.
    expect(plan.chapters[0]!.items[0]!.trim!.inMs).toBe(0);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).valid).toBe(true);

    // An externally authored plan selecting the clip's final second stays inside
    // the source bounds and reconciles with `plannedDurationMs`, so neither the
    // bounds check nor the duration recompute catches it. Live playback would
    // still autoplay the clip from 0 and hold the step until `ended`, i.e. play
    // the *first* second while claiming the last one.
    const forged = structuredClone(plan);
    forged.chapters[0]!.items[0]!.trim = { inMs: 9_000, outMs: 10_000 };
    forged.plannedDurationMs = sumPlannedDurationMs(forged);
    const result = validateAutoEditPlanV1(forged, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("trim in-point unsupported clip");
    expect(result.errors).not.toContain("invalid trim clip");
    expect(result.errors).not.toContain("planned duration mismatch");

    // A zero in-point selecting a shorter window remains legitimate: the media
    // element starts where the plan says it starts.
    const shortened = structuredClone(plan);
    shortened.chapters[0]!.items[0]!.trim = { inMs: 0, outMs: 1_000 };
    shortened.plannedDurationMs = sumPlannedDurationMs(shortened);
    const shortenedResult = validateAutoEditPlanV1(shortened, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(shortenedResult.errors).toEqual([]);
    expect(shortenedResult.valid).toBe(true);
  });

  it("accepts any route travel primitive and any resolver-shaped Quick Recap timing", () => {
    const digests = [digest("tokyo-photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 20_000, digests,
    });
    // The route travel grammar is the complement of `hold`, so a nearby leg
    // rendered as a short arc is as legitimate as a long-haul travel.
    for (const primitive of ["travel", "pullback-travel", "short-arc"] as const) {
      const variant = structuredClone(plan);
      variant.chapters[0]!.camera = { primitive, durationMs: 1_337 };
      variant.chapters[0]!.arrival = { durationMs: 911, showPlaceLabel: false, showNote: false };
      variant.plannedDurationMs = sumPlannedDurationMs(variant);
      expect(validateAutoEditPlanV1(variant, { ...baseInput, routePointIds: ["tokyo"], digests }), primitive)
        .toMatchObject({ valid: true, errors: [] });
    }

    // Permissive is not unbounded. The grammar check is the complement of
    // `hold`, so on its own it would wave through a primitive that does not
    // exist; the vocabulary check in the same chapter loop is what stops it.
    const unknown = structuredClone(plan);
    unknown.chapters[0]!.camera = { primitive: "barrel-roll" as unknown as typeof plan.chapters[0]["camera"]["primitive"], durationMs: 1_337 };
    unknown.plannedDurationMs = sumPlannedDurationMs(unknown);
    const unknownResult = validateAutoEditPlanV1(unknown, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(unknownResult.valid).toBe(false);
    expect(unknownResult.errors).toContain("camera primitive invalid route:tokyo");
  });

  it("rejects Quick Recap chapters that break the intro and route choreography (#166)", () => {
    const digests = [digest("intro", null, 0), digest("tokyo-photo", "tokyo", 1)];
    const base = buildDeterministicQuickRecapPlan({
      ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 30_000, digests,
    });
    expect(base.chapters.map((chapter) => chapter.routePointId)).toEqual([null, "tokyo"]);
    const reconcile = (plan: AutoEditPlanV1) => {
      plan.plannedDurationMs = sumPlannedDurationMs(plan);
    };

    const cases: Array<{ mutate: (plan: AutoEditPlanV1) => void; error: string }> = [
      {
        mutate: (plan) => { plan.chapters[0]!.arrival = { durationMs: quickRecapArrivalMs("standard"), showPlaceLabel: true, showNote: true }; },
        error: "quick recap intro arrival invalid journey-intro",
      },
      {
        mutate: (plan) => { plan.chapters[0]!.camera = { primitive: "travel", durationMs: 0 }; },
        error: "quick recap intro camera mismatch journey-intro",
      },
      {
        mutate: (plan) => { plan.chapters[0]!.camera = { primitive: "hold", durationMs: 250 }; },
        error: "quick recap intro camera mismatch journey-intro",
      },
      {
        mutate: (plan) => { plan.chapters[1]!.camera = { primitive: "hold", durationMs: plan.chapters[1]!.camera.durationMs }; },
        error: "quick recap route camera mismatch route:tokyo",
      },
      {
        mutate: (plan) => { delete plan.chapters[1]!.arrival; },
        error: "quick recap route arrival mismatch route:tokyo",
      },
      {
        // A non-boolean flag never reaches the quick-recap grammar branch: the
        // structural pass rejects the shape first and returns early. Asserted
        // here against the error that is actually raised, so the test documents
        // where the guarantee lives rather than a branch it cannot reach.
        mutate: (plan) => {
          plan.chapters[1]!.arrival = { durationMs: quickRecapArrivalMs("standard"), showPlaceLabel: "yes" as unknown as boolean, showNote: true };
        },
        error: "chapter arrival flags invalid 1",
      },
    ];

    for (const { mutate, error } of cases) {
      const forged = structuredClone(base);
      mutate(forged);
      reconcile(forged);
      const result = validateAutoEditPlanV1(forged, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.valid, error).toBe(false);
      expect(result.errors, error).toContain(error);
    }
  });

  it("rejects Quick Recap route chapters that never travel or never arrive (#166)", () => {
    const digests = [digest("intro", null, 0), digest("tokyo-photo", "tokyo", 1)];
    const scope = { ...baseInput, routePointIds: ["tokyo"], digests };
    const base = buildDeterministicQuickRecapPlan({
      ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 30_000, digests,
    });
    // The planner's own choreography stays valid: the floor rejects only zero.
    expect(validateAutoEditPlanV1(base, scope)).toMatchObject({ valid: true, errors: [] });

    // Each forgery reconciles `plannedDurationMs`, so the error array is
    // exactly the new one - a zero duration is a legal non-negative number to
    // every other check in the validator.
    const stalled = structuredClone(base);
    stalled.chapters[1]!.camera.durationMs = 0;
    stalled.plannedDurationMs = sumPlannedDurationMs(stalled);
    expect(validateAutoEditPlanV1(stalled, scope).errors)
      .toEqual(["route camera duration must be positive route:tokyo"]);

    const unannounced = structuredClone(base);
    unannounced.chapters[1]!.arrival!.durationMs = 0;
    unannounced.plannedDurationMs = sumPlannedDurationMs(unannounced);
    expect(validateAutoEditPlanV1(unannounced, scope).errors)
      .toEqual(["route arrival duration must be positive route:tokyo"]);

    // The journey intro is the deliberate exception: it holds at zero and has
    // nothing to arrive at.
    expect(base.chapters[0]!.camera.durationMs).toBe(0);
    expect(base.chapters[0]!.arrival).toBeUndefined();
  });

  it("gives fast, standard and immersive distinct Quick Recap timing for one fixture", () => {
    const digests = [
      digest("hero", "tokyo", 0),
      digest("support", "tokyo", 1),
      digest("clip", "kyoto", 2, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 60_000 } }),
    ];
    const plans = (["fast", "standard", "immersive"] as const).map((tempo) =>
      buildDeterministicQuickRecapPlan({
        ...baseInput, routePointIds: ["tokyo", "kyoto"], targetDurationMs: 60_000, tempo, digests,
      }));
    for (const plan of plans) {
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests }))
        .toMatchObject({ valid: true, errors: [] });
    }
    const dwells = plans.map((plan) => plan.chapters[0]!.items[0]!.dwellMs);
    const trims = plans.map((plan) => plan.chapters[1]!.items[0]!.trim!.outMs);
    const totals = plans.map((plan) => plan.plannedDurationMs);
    expect(new Set(dwells).size).toBe(3);
    expect(new Set(trims).size).toBe(3);
    expect(new Set(totals).size).toBe(3);
    // Slower tempi hold every beat longer.
    expect(dwells[0]!).toBeLessThan(dwells[1]!);
    expect(dwells[1]!).toBeLessThan(dwells[2]!);
    expect(totals[0]!).toBeLessThan(totals[1]!);
    expect(totals[1]!).toBeLessThan(totals[2]!);

    // Camera and arrival are flat across tempo in the plan because the
    // deterministic input carries no route geometry and no notes. The resolver
    // itself is already tempo-, distance- and note-sensitive; threading those
    // terms into Quick Recap belongs to the director wiring.
    expect(new Set(plans.map((plan) => plan.chapters[1]!.camera.durationMs)).size).toBe(1);
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      expect(resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "travel", routeDistanceRadians: 2 }))
        .toBeGreaterThan(resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "travel" }));
      expect(resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "arrival", noteLength: 40 }))
        .toBeGreaterThan(resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "arrival" }));
    }
    const longHaul = (["fast", "standard", "immersive"] as const).map((tempo) =>
      resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "travel", routeDistanceRadians: 1 }));
    expect(new Set(longHaul).size).toBe(3);
  });

  it("keeps builder media timing valid across every Quick Recap tempo", () => {
    const digests = [
      digest("photo", "tokyo", 0),
      digest("clip", "tokyo", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 10_000 } }),
    ];
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const plan = buildDeterministicQuickRecapPlan({
        ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 20_000, tempo, digests,
      });
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
        .toMatchObject({ valid: true, errors: [] });
    }
  });

  it("uses role-aware dwell when deciding whether optional photos fit the recap budget", () => {
    const digests = [
      digest("tokyo-opener", "tokyo", 0),
      digest("tokyo-detail", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 6_500,
      digests,
    });
    expect(plan.chapters[0]?.items.map((item) => item.assetId)).toEqual(["tokyo-opener"]);
    expect(plan.plannedDurationMs).toBe(4_900);
  });

  it("keeps hero image dwell inside the intended tempo bands", () => {
    const digests = [digest("tokyo", "tokyo", 0)];
    const fast = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 10_000, tempo: "fast", digests });
    const immersive = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 10_000, tempo: "immersive", digests });
    expect(fast.chapters[0]?.items[0]).toMatchObject({ photoRole: "hero", dwellMs: 2_000 });
    expect(immersive.chapters[0]?.items[0]).toMatchObject({ photoRole: "hero", dwellMs: 4_900 });
  });

  it("keeps pinned media even when the duration budget is already tight", () => {
    const digests = [
      digest("tokyo", "tokyo", 0),
      digest("kyoto", "kyoto", 1),
      digest("osaka", "osaka", 2),
      digest("pin", "tokyo", 3, { userSignals: { isJourneyCover: false, pinnedForRecap: true, excludedFromRecap: false } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, targetDurationMs: 8_000, digests });
    expect(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId))).toContain("pin");
  });

  it("reduces duplicate bursts without altering source identity and chooses the stronger representative", () => {
    const digests = [
      digest("weak", "tokyo", 0, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.2, exposureQuality: 0.2 } }),
      digest("strong", "tokyo", 1, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.9, exposureQuality: 0.8 } }),
      digest("kyoto", "kyoto", 2), digest("osaka", "osaka", 3),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    const ids = plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId));
    expect(ids).toContain("strong");
    expect(ids).not.toContain("weak");
    expect(plan.omittedAssetIds).toContain("weak");
  });


  it("preserves route coverage when duplicate clusters span route points", () => {
    const digests = [
      digest("tokyo-burst", "tokyo", 0, { similarity: { duplicateClusterId: "shared-burst" } }),
      digest("kyoto-burst", "kyoto", 1, { similarity: { duplicateClusterId: "shared-burst" } }),
      digest("osaka", "osaka", 2),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["tokyo", "kyoto", "osaka"]);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true, errors: [] });
  });

  it("keeps the photograph as every route representative when videos were uploaded first", () => {
    const routePointIds = Array.from({ length: 7 }, (_, index) => `point-${index}`);
    const digests = routePointIds.flatMap((routePointId, index) => [
      digest(`${routePointId}-video`, routePointId, index * 2, {
        mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 6_000 },
      }),
      digest(`${routePointId}-photo`, routePointId, index * 2 + 1),
    ]);
    // The real Quick Recap chapter budget: 45s target less intro and outro.
    const input = { ...baseInput, routePointIds, targetDurationMs: 42_000, digests };
    const plan = buildDeterministicQuickRecapPlan(input);

    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual(routePointIds);
    for (const routePointId of routePointIds) {
      const chapter = plan.chapters.find((candidate) => candidate.routePointId === routePointId)!;
      expect(chapter.items.map((item) => item.assetId)).toContain(`${routePointId}-photo`);
    }
    expect(plan.plannedDurationMs).toBeLessThanOrEqual(42_000);
    expect(validateAutoEditPlanV1(plan, input)).toMatchObject({ valid: true, errors: [] });
  });

  it("omits videos without known positive duration and bounds short-video trims to the source", () => {
    const digests = [
      digest("unknown-video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: {} }),
      digest("tokyo", "tokyo", 1),
      digest("short-video", "kyoto", 2, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 420 } }),
      digest("osaka", "osaka", 3),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    const items = plan.chapters.flatMap((chapter) => chapter.items);
    expect(items.find((item) => item.assetId === "unknown-video")).toBeUndefined();
    expect(plan.omittedAssetIds).not.toContain("unknown-video");
    expect(items.find((item) => item.assetId === "short-video")?.trim).toEqual({ inMs: 0, outMs: 420 });
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true, errors: [] });
  });

  it("treats non-finite video durations as noneligible before plan construction", () => {
    const digests = [
      digest("infinite-video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: Number.POSITIVE_INFINITY } }),
      digest("nan-video", "kyoto", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: Number.NaN } }),
      digest("osaka", "osaka", 2),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["osaka"]);
    expect(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId))).not.toEqual(
      expect.arrayContaining(["infinite-video", "nan-video"]),
    );
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true, errors: [] });
  });

  it("does not require route coverage for noneligible videos", () => {
    const digests = [
      digest("unknown-video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: {} }),
      digest("zero-video", "kyoto", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 0 } }),
      digest("osaka", "osaka", 2),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual(["osaka"]);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true, errors: [] });
  });

  it("never selects recap-excluded media", () => {
    const digests = [
      digest("excluded", "tokyo", 0, { userSignals: { isJourneyCover: false, pinnedForRecap: false, excludedFromRecap: true } }),
      digest("tokyo", "tokyo", 1), digest("kyoto", "kyoto", 2), digest("osaka", "osaka", 3),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    expect(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId))).not.toContain("excluded");
  });

  it("ignores stale or foreign digests when checking route coverage", () => {
    const digests = [
      digest("tokyo", "tokyo", 0),
      digest("stale-kyoto", "kyoto", 1, { sourceRevision: "6" }),
      digest("foreign-osaka", "osaka", 2, { journeyId: "journey-2" }),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, digests });
    const result = validateAutoEditPlanV1(plan, { ...baseInput, digests });
    expect(result.errors).not.toEqual(expect.arrayContaining(["route point omitted kyoto", "route point omitted osaka"]));
  });

  it("rejects unknown plan tempo and mode from runtime input", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    (plan as unknown as { mode: unknown }).mode = "experimental";
    (plan as unknown as { tempo: unknown }).tempo = "warp";
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toEqual(expect.arrayContaining(["plan mode invalid", "plan tempo invalid"]));
  });

  it("rejects unknown camera and item behavior vocabulary from runtime input", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const chapter = plan.chapters[0];
    const item = chapter?.items[0];
    if (chapter) (chapter.camera as unknown as { primitive: unknown }).primitive = "teleport";
    if (item) {
      (item as unknown as { framing: unknown }).framing = "stretch";
      (item as unknown as { transition: unknown }).transition = "flash";
      (item as unknown as { selectionReason: unknown }).selectionReason = "model-choice";
    }
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toEqual(expect.arrayContaining([
      "camera primitive invalid route:tokyo",
      "framing invalid photo",
      "transition invalid photo",
      "selection reason invalid photo",
    ]));
  });

  it("rejects vocabulary-valid Quick Recap framing and transition that diverge from V1 semantics", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const item = plan.chapters[0]?.items[0];
    if (item) {
      item.framing = "cover";
      item.transition = "soft-dissolve";
    }
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toEqual(expect.arrayContaining([
      "quick recap framing mismatch photo",
      "quick recap transition mismatch photo",
    ]));
  });

  it("rejects forged Quick Recap selection reasons while preserving builder precedence", () => {
    const scenarios = [
      {
        digest: digest("pinned", "tokyo", 0, { userSignals: { isJourneyCover: true, pinnedForRecap: true, excludedFromRecap: false } }),
        expected: "user-pinned",
      },
      {
        digest: digest("cover", "tokyo", 0, { userSignals: { isJourneyCover: true, pinnedForRecap: false, excludedFromRecap: false } }),
        expected: "journey-cover",
      },
      {
        digest: digest("video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 2_000 } }),
        expected: "video-highlight",
      },
    ] as const;
    for (const scenario of scenarios) {
      const digests = [scenario.digest];
      const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
      const item = plan.chapters[0]?.items[0];
      expect(item?.selectionReason).toBe(scenario.expected);
      if (item) item.selectionReason = "visual-diversity";
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
        .toContain(`selection reason mismatch ${scenario.digest.assetId}`);
    }
  });

  it("derives duplicate-cluster selection reasoning from eligible source digests", () => {
    const digests = [
      digest("weak", "tokyo", 0, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.1 } }),
      digest("strong", "tokyo", 1, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.9 } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const selected = plan.chapters[0]?.items[0];
    expect(selected?.assetId).toBe("strong");
    expect(selected?.selectionReason).toBe("duplicate-cluster-representative");
    if (selected) selected.selectionReason = "route-point-representative";
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("selection reason mismatch strong");
  });

  it("rejects unknown quick-recap photo roles from untyped plan input", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const photo = plan.chapters[0]?.items[0];
    if (photo) (photo as unknown as { photoRole?: unknown }).photoRole = "primary";
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toContain("photo role invalid photo");
  });

  it("rejects any present photoRole field on quick-recap videos", () => {
    const digests = [
      digest("video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 2_000 } }),
    ];
    for (const { illegalRole, expectedError } of [
      { illegalRole: null, expectedError: "item photoRole invalid 0:0" },
      { illegalRole: "", expectedError: "video photo role invalid video" },
      { illegalRole: 0, expectedError: "item photoRole invalid 0:0" },
    ]) {
      const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
      const video = plan.chapters[0]?.items[0];
      if (video) (video as unknown as { photoRole?: unknown }).photoRole = illegalRole;
      const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.errors).toContain(expectedError);
    }
  });

  it("requires explicit photo roles on quick-recap images and forbids them on videos", () => {
    const digests = [
      digest("photo", "tokyo", 0),
      digest("video", "tokyo", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 2_000 } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const photo = plan.chapters[0]?.items.find((item) => item.assetId === "photo");
    const video = plan.chapters[0]?.items.find((item) => item.assetId === "video");
    if (photo) delete photo.photoRole;
    if (video) video.photoRole = "supporting";
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toEqual(expect.arrayContaining([
      "photo role missing photo",
      "video photo role invalid video",
    ]));
  });

  it("fails closed on malformed omission-ledger entries", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const validPlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    for (const omittedAssetIds of [[null], [42], new Array(1)]) {
      const result = validateAutoEditPlanV1(
        { ...validPlan, omittedAssetIds },
        { ...baseInput, routePointIds: ["tokyo"], digests },
      );
      expect(result.errors).toContain("omitted asset id invalid 0");
    }
  });

  it("requires Quick Recap omission ledger to exactly match eligible unselected media", () => {
    const digests = [
      digest("selected", "tokyo", 0),
      digest("omitted-a", "tokyo", 1, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.1 } }),
      digest("omitted-b", "tokyo", 2, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.9 } }),
      digest("excluded", "tokyo", 3, { userSignals: { isJourneyCover: false, pinnedForRecap: false, excludedFromRecap: true } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 4_900,
      digests,
    });
    expect(plan.omittedAssetIds.length).toBeGreaterThan(0);
    const actualOmitted = [...plan.omittedAssetIds];
    const selectedId = plan.chapters[0]!.items[0]!.assetId;

    const cases = [
      { omittedAssetIds: [], error: "omission ledger mismatch" },
      { omittedAssetIds: [...actualOmitted, ...actualOmitted], error: `duplicate omitted asset ${actualOmitted[0]}` },
      { omittedAssetIds: [selectedId, ...actualOmitted], error: `selected asset listed omitted ${selectedId}` },
      { omittedAssetIds: ["excluded", ...actualOmitted], error: "noneligible omitted asset excluded" },
      { omittedAssetIds: [...actualOmitted].reverse(), error: "omission ledger mismatch" },
    ];
    for (const testCase of cases) {
      const result = validateAutoEditPlanV1(
        { ...plan, omittedAssetIds: testCase.omittedAssetIds },
        { ...baseInput, routePointIds: ["tokyo"], digests },
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(testCase.error);
    }
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
      .toMatchObject({ valid: true, errors: [] });
  });

  it("accepts builder omission order when eligible media share a source index", () => {
    const digests = [
      digest("z-selected", "tokyo", 0, { technical: { sharpness: 1 } }),
      digest("z-omitted", "tokyo", 1, { similarity: { duplicateClusterId: "same" }, technical: { sharpness: 0.1 } }),
      digest("a-omitted", "tokyo", 1, { similarity: { duplicateClusterId: "same" }, technical: { sharpness: 0.9 } }),
      digest("m-optional", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 4_900,
      digests,
    });
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
      .toMatchObject({ valid: true, errors: [] });
  });

  it("preserves media-less Full Playback route points with camera-only chapters", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1,
      planId: "full:media-less-route",
      journeyId: "journey-1",
      journeyRevision: "7",
      generatedAt: baseInput.generatedAt,
      mode: "full",
      plannedDurationMs: 2_000 + 2 * FULL_CAMERA_DURATION + 2 * FULL_ARRIVAL_DURATION,
      tempo: "standard",
      chapters: [
        {
          chapterId: "route:tokyo",
          routePointId: "tokyo",
          camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
          arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true },
          items: [{ assetId: "photo", sourceIndex: 0, dwellMs: 2_000, framing: "contain", transition: "direct", selectionReason: "all-media" }],
        },
        {
          chapterId: "route:kyoto:camera-only",
          routePointId: "kyoto",
          camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
          arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true },
          items: [],
        },
      ],
      omittedAssetIds: [],
    };
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests }))
      .toMatchObject({ valid: true, errors: [] });
  });

  it("rejects Full Playback plans that omit a media-less canonical route point", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:missing-media-less-route", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + FULL_CAMERA_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [{
        chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
        items: [{ assetId: "photo", sourceIndex: 0, dwellMs: 2_000, framing: "contain", transition: "direct", selectionReason: "all-media" }],
      }],
    };
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("full route point omitted kyoto");
    expect(result.errors).not.toContain("planned duration mismatch");
  });

  it("still rejects empty Full Playback chapters when that route owns canonical media", () => {
    const digests = [digest("photo", "tokyo", 0), digest("kyoto-photo", "kyoto", 1)];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:empty-populated-route", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + 2 * FULL_CAMERA_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [
        {
          chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
          items: [{ assetId: "photo", sourceIndex: 0, dwellMs: 2_000, framing: "contain", transition: "direct", selectionReason: "all-media" }],
        },
        { chapterId: "route:kyoto", routePointId: "kyoto", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, items: [] },
      ],
    };
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("empty full chapter route:kyoto");
    expect(result.errors).not.toContain("planned duration mismatch");
  });

  it("rejects duplicate Full Playback route and journey-intro scopes", () => {
    const digests = [
      digest("intro-a", null, 0),
      digest("intro-b", null, 1),
      digest("tokyo-a", "tokyo", 2),
      digest("tokyo-b", "tokyo", 3),
    ];
    const item = (assetId: string, sourceIndex: number) => ({
      assetId, sourceIndex, dwellMs: 1_000, framing: "contain" as const, transition: "direct" as const, selectionReason: "all-media" as const,
    });
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1,
      planId: "full:split-scopes",
      journeyId: "journey-1",
      journeyRevision: "7",
      generatedAt: baseInput.generatedAt,
      mode: "full",
      plannedDurationMs: 4_000 + 2 * FULL_CAMERA_DURATION,
      tempo: "standard",
      chapters: [
        { chapterId: "journey-intro:a", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [item("intro-a", 0)] },
        { chapterId: "journey-intro:b", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [item("intro-b", 1)] },
        { chapterId: "route:tokyo:a", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, items: [item("tokyo-a", 2)] },
        { chapterId: "route:tokyo:b", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, items: [item("tokyo-b", 3)] },
      ],
      omittedAssetIds: [],
    };
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "duplicate full chapter scope journey-intro",
      "duplicate full chapter scope tokyo",
    ]));
    expect(result.errors).not.toContain("planned duration mismatch");
  });

  it("rejects forged Full Playback camera and arrival choreography even when duration reconciles", () => {
    const digests = [digest("intro", null, 0), digest("tokyo", "tokyo", 1)];
    const base: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:camera", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [
        { chapterId: "journey-intro", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [{ assetId: "intro", sourceIndex: 0, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
        { chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true }, items: [{ assetId: "tokyo", sourceIndex: 1, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
      ],
    };
    expect(validateAutoEditPlanV1(base, { ...baseInput, routePointIds: ["tokyo"], digests })).toMatchObject({ valid: true });

    const cases = [
      { mutate: (plan: AutoEditPlanV1) => { plan.chapters[1]!.camera = { primitive: "hold", durationMs: 0 }; }, error: "full route camera mismatch route:tokyo" },
      { mutate: (plan: AutoEditPlanV1) => { delete plan.chapters[1]!.arrival; }, error: "full route arrival mismatch route:tokyo" },
      { mutate: (plan: AutoEditPlanV1) => { plan.chapters[1]!.arrival = { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: false, showNote: true }; }, error: "full route arrival mismatch route:tokyo" },
      { mutate: (plan: AutoEditPlanV1) => { plan.chapters[0]!.camera = { primitive: "travel", durationMs: FULL_CAMERA_DURATION }; }, error: "full intro camera mismatch journey-intro" },
      { mutate: (plan: AutoEditPlanV1) => { plan.chapters[0]!.arrival = { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true }; }, error: "full intro arrival invalid journey-intro" },
    ];
    for (const testCase of cases) {
      const plan = structuredClone(base);
      testCase.mutate(plan);
      plan.plannedDurationMs = sumPlannedDurationMs(plan);
      const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(testCase.error);
      expect(result.errors).not.toContain("planned duration mismatch");
    }
  });

  it("rejects Full Playback route chapters that never travel or never arrive (#166)", () => {
    const digests = [digest("intro", null, 0), digest("tokyo", "tokyo", 1)];
    const scope = { ...baseInput, routePointIds: ["tokyo"], digests };
    const base: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:route-duration", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [
        { chapterId: "journey-intro", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [{ assetId: "intro", sourceIndex: 0, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
        { chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true }, items: [{ assetId: "tokyo", sourceIndex: 1, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
      ],
    };
    expect(validateAutoEditPlanV1(base, scope)).toMatchObject({ valid: true, errors: [] });

    const stalled = structuredClone(base);
    stalled.chapters[1]!.camera.durationMs = 0;
    stalled.plannedDurationMs = sumPlannedDurationMs(stalled);
    expect(validateAutoEditPlanV1(stalled, scope).errors)
      .toEqual(["route camera duration must be positive route:tokyo"]);

    const unannounced = structuredClone(base);
    unannounced.chapters[1]!.arrival!.durationMs = 0;
    unannounced.plannedDurationMs = sumPlannedDurationMs(unannounced);
    expect(validateAutoEditPlanV1(unannounced, scope).errors)
      .toEqual(["route arrival duration must be positive route:tokyo"]);
  });

  it("keeps one populated Full Playback chapter per scope valid", () => {
    const digests = [digest("intro", null, 0), digest("tokyo", "tokyo", 1)];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:canonical", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [
        { chapterId: "journey-intro", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [{ assetId: "intro", sourceIndex: 0, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
        { chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true }, items: [{ assetId: "tokyo", sourceIndex: 1, dwellMs: 1_000, framing: "contain", transition: "direct", selectionReason: "all-media" }] },
      ],
    };
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests })).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects empty Quick Recap route chapters even when canonical choreography and forged duration reconcile", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo", "kyoto"],
      targetDurationMs: 20_000,
      digests,
    });
    plan.chapters.push({
      chapterId: "route:kyoto:camera-only",
      routePointId: "kyoto",
      camera: { primitive: "travel", durationMs: quickRecapTravelMs("standard") },
      arrival: { durationMs: quickRecapArrivalMs("standard"), showPlaceLabel: true, showNote: true },
      items: [],
    });
    plan.plannedDurationMs = sumPlannedDurationMs(plan);

    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("empty quick recap chapter route:kyoto:camera-only");
    expect(result.errors).not.toContain("planned duration mismatch");
  });
  it("rejects duplicate Quick Recap route chapters even when distinct assets and duration still reconcile", () => {
    const digests = [
      digest("first", "tokyo", 0),
      digest("second", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 20_000,
      digests,
    });
    const original = plan.chapters[0]!;
    const [first, second] = original.items;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    plan.chapters = [
      { ...structuredClone(original), items: [structuredClone(first!)] },
      { ...structuredClone(original), chapterId: "route:tokyo:split", items: [structuredClone(second!)] },
    ];
    plan.plannedDurationMs = sumPlannedDurationMs(plan);

    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("duplicate chapter scope tokyo");
  });

  it("rejects duplicate Quick Recap journey-intro chapters", () => {
    const digests = [
      digest("intro-a", null, 0),
      digest("intro-b", null, 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: [],
      targetDurationMs: 20_000,
      digests,
    });
    const original = plan.chapters[0]!;
    const [first, second] = original.items;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    plan.chapters = [
      { ...structuredClone(original), items: [structuredClone(first!)] },
      { ...structuredClone(original), chapterId: "journey-intro:split", items: [structuredClone(second!)] },
    ];
    plan.plannedDurationMs = sumPlannedDurationMs(plan);

    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: [], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("duplicate chapter scope journey-intro");
  });

  it("rejects Full Playback journey intro after route chapters even when duration reconciles", () => {
    const digests = [digest("intro", null, 0), digest("tokyo", "tokyo", 1)];
    const item = (assetId: string, sourceIndex: number) => ({
      assetId, sourceIndex, dwellMs: 1_000, framing: "contain" as const, transition: "direct" as const, selectionReason: "all-media" as const,
    });
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1, planId: "full:late-intro", journeyId: "journey-1", journeyRevision: "7", generatedAt: baseInput.generatedAt,
      mode: "full", plannedDurationMs: 2_000 + FULL_CAMERA_DURATION, tempo: "standard", omittedAssetIds: [],
      chapters: [
        { chapterId: "route:tokyo", routePointId: "tokyo", camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION }, items: [item("tokyo", 1)] },
        { chapterId: "journey-intro", routePointId: null, camera: { primitive: "hold", durationMs: 0 }, items: [item("intro", 0)] },
      ],
    };
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("journey intro chronology mismatch");
    expect(result.errors).not.toContain("planned duration mismatch");
  });

  it("rejects Quick Recap journey intro after route chapters even when duration reconciles", () => {
    const digests = [digest("intro", null, 0), digest("tokyo", "tokyo", 1)];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput, routePointIds: ["tokyo"], targetDurationMs: 20_000, digests,
    });
    expect(plan.chapters.map((chapter) => chapter.routePointId)).toEqual([null, "tokyo"]);
    plan.chapters.reverse();
    plan.plannedDurationMs = sumPlannedDurationMs(plan);
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("journey intro chronology mismatch");
    expect(result.errors).not.toContain("planned duration mismatch");
  });

  it("rejects forged selected-media source indexes and reversed chapter chronology", () => {
    const digests = [
      digest("first", "tokyo", 0),
      digest("second", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 20_000,
      digests,
    });
    expect(plan.chapters[0]?.items.map((item) => item.assetId)).toEqual(["first", "second"]);

    const forged = structuredClone(plan);
    forged.chapters[0]!.items[0]!.sourceIndex = 99;
    expect(validateAutoEditPlanV1(forged, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("source index mismatch first");

    const reversed = structuredClone(plan);
    reversed.chapters[0]!.items.reverse();
    expect(validateAutoEditPlanV1(reversed, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("item source order mismatch route:tokyo");
  });

  it("fails closed on malformed selected-media source index leaves", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const validPlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const cases = [
      { sourceIndex: "0", error: "item source index invalid 0:0" },
      { sourceIndex: Number.NaN, error: "invalid source index photo" },
      { sourceIndex: Number.POSITIVE_INFINITY, error: "invalid source index photo" },
      { sourceIndex: -1, error: "invalid source index photo" },
      { sourceIndex: 0.5, error: "invalid source index photo" },
    ];
    for (const testCase of cases) {
      const plan: any = structuredClone(validPlan);
      plan.chapters[0].items[0].sourceIndex = testCase.sourceIndex;
      const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(testCase.error);
    }
  });

  it("allows stable equal source indexes without inventing a tie-breaker", () => {
    const digests = [
      digest("z-first", "tokyo", 1),
      digest("a-second", "tokyo", 1),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 20_000,
      digests,
    });
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
      .toMatchObject({ valid: true, errors: [] });
  });

  it("fails closed on structurally malformed runtime plan input instead of throwing", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const validPlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const malformed: Array<{ plan: unknown; error: string }> = [
      { plan: null, error: "plan must be an object" },
      { plan: { ...validPlan, chapters: null }, error: "chapters must be an array" },
      { plan: { ...validPlan, omittedAssetIds: null }, error: "omittedAssetIds must be an array" },
      { plan: { ...validPlan, planId: 7 }, error: "planId must be a string" },
      { plan: { ...validPlan, generatedAt: false }, error: "generatedAt must be a string" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], chapterId: 7 }] }, error: "chapter id invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], routePointId: 7 }] }, error: "chapter route point invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], camera: { ...validPlan.chapters[0]!.camera, primitive: 7 } }] }, error: "camera primitive shape invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], arrival: { ...validPlan.chapters[0]!.arrival!, showNote: "yes" } }] }, error: "chapter arrival flags invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], items: [{ ...validPlan.chapters[0]!.items[0], assetId: 7 }] }] }, error: "item assetId invalid 0:0" },
      { plan: { ...validPlan, chapters: [null] }, error: "chapter 0 must be an object" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], camera: null }] }, error: "chapter camera invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], items: null }] }, error: "chapter items invalid 0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], items: [null] }] }, error: "chapter item invalid 0:0" },
      { plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], arrival: [] }] }, error: "chapter arrival invalid 0" },
      {
        plan: { ...validPlan, chapters: [{ ...validPlan.chapters[0], items: [{ ...validPlan.chapters[0]!.items[0], trim: [] }] }] },
        error: "item trim invalid 0:0",
      },
    ];
    for (const testCase of malformed) {
      expect(() => validateAutoEditPlanV1(testCase.plan, { ...baseInput, routePointIds: ["tokyo"], digests })).not.toThrow();
      expect(validateAutoEditPlanV1(testCase.plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors).toContain(testCase.error);
    }
  });

  it("rejects non-string chapter ids before duplicate identity checks", () => {
    const digests = [digest("tokyo", "tokyo", 0)];
    const basePlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const malformedIds: unknown[] = [{ forged: "route:tokyo" }, Symbol("route:tokyo")];

    for (const chapterId of malformedIds) {
      const plan = structuredClone(basePlan) as any;
      plan.chapters[0].chapterId = chapterId;
      expect(() => validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests })).not.toThrow();
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
        .toContain("chapter id invalid 0");
    }
  });

  it("rejects duplicate chapter ids even when chapter scopes are otherwise valid", () => {
    const digests = [digest("tokyo", "tokyo", 0), digest("kyoto", "kyoto", 1)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo", "kyoto"], digests });
    expect(plan.chapters).toHaveLength(2);
    plan.chapters[1]!.chapterId = plan.chapters[0]!.chapterId;
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo", "kyoto"], digests }).errors)
      .toContain(`duplicate chapter id ${plan.chapters[0]!.chapterId}`);
  });

  it("fails closed on sparse chapter/item arrays instead of traversing holes", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const validPlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const sparseChapters = { ...validPlan, chapters: new Array(1) };
    const sparseItems = {
      ...validPlan,
      chapters: [{ ...validPlan.chapters[0], items: new Array(1) }],
    };
    expect(validateAutoEditPlanV1(sparseChapters, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("chapter 0 must be an object");
    expect(validateAutoEditPlanV1(sparseItems, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("chapter item invalid 0:0");
  });

  it("rejects non-number duration leaves before recomputing plan arithmetic", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const hostile = { valueOf: null, toString: null };
    const cases = [
      { mutate: (plan: any) => { plan.chapters[0].camera.durationMs = hostile; }, error: "chapter camera duration invalid 0" },
      { mutate: (plan: any) => { plan.chapters[0].arrival.durationMs = hostile; }, error: "chapter arrival duration invalid 0" },
      { mutate: (plan: any) => { plan.chapters[0].items[0].dwellMs = hostile; }, error: "item dwell invalid 0:0" },
    ];
    for (const testCase of cases) {
      const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
      testCase.mutate(plan);
      expect(() => validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests })).not.toThrow();
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
        .toContain(testCase.error);
    }
  });

  it("rejects malformed media timing shapes even when planned duration is forged to match", () => {
    const digests = [
      digest("photo", "tokyo", 0),
      digest("video", "tokyo", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 5_000 } }),
    ];
    const cases = [
      { mutate: (photo: any) => { photo.dwellMs = -10; }, error: "invalid dwell photo" },
      { mutate: (photo: any) => { photo.dwellMs = Number.NaN; }, error: "invalid dwell photo" },
      { mutate: (photo: any) => { photo.trim = { inMs: 0, outMs: 100 }; }, error: "image trim invalid photo" },
      { mutate: (_photo: any, video: any) => { video.dwellMs = 500; }, error: "video dwell invalid video" },
      { mutate: (_photo: any, video: any) => { delete video.trim; }, error: "video trim missing video" },
    ];
    for (const testCase of cases) {
      const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
      const items = plan.chapters[0]!.items;
      const photo = items.find((item) => item.assetId === "photo")!;
      const video = items.find((item) => item.assetId === "video")!;
      testCase.mutate(photo, video);
      plan.plannedDurationMs = sumPlannedDurationMs(plan);
      const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.errors).toContain(testCase.error);
    }
  });

  it("rejects non-finite or negative chapter timing", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    plan.chapters[0]!.camera.durationMs = -1;
    plan.chapters[0]!.arrival!.durationMs = Number.NaN;
    plan.plannedDurationMs = Number.NaN;
    plan.targetDurationMs = 0;
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toEqual(expect.arrayContaining([
      "invalid camera duration route:tokyo",
      "invalid arrival duration route:tokyo",
      "planned duration invalid",
      "target duration invalid",
    ]));
  });

  it("rejects stale revisions, chapter mismatches, invalid trims, and omitted pins", () => {
    const digests = [
      digest("video", "tokyo", 0, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 5_000 } }),
      digest("pin", "kyoto", 1, { userSignals: { isJourneyCover: false, pinnedForRecap: true, excludedFromRecap: false } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo", "kyoto"], digests });
    plan.chapters[0]!.items[0]!.trim = { inMs: 0, outMs: 9_000 };
    plan.chapters = plan.chapters.filter((chapter) => chapter.routePointId !== "kyoto");
    const result = validateAutoEditPlanV1(plan, { journeyId: "journey-1", journeyRevision: "7", routePointIds: ["tokyo", "kyoto"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["invalid trim video", "pinned asset omitted pin", "route point omitted kyoto"]));
  });

  it("rejects substituting a weaker duplicate-cluster member while omission bookkeeping stays internally consistent", () => {
    const digests = [
      digest("weak", "tokyo", 0, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.1 } }),
      digest("strong", "tokyo", 1, { similarity: { duplicateClusterId: "burst" }, technical: { sharpness: 0.9 } }),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 10_000,
      digests,
    });
    expect(plan.chapters[0]?.items[0]?.assetId).toBe("strong");
    const item = plan.chapters[0]?.items[0];
    if (item) {
      item.assetId = "weak";
      item.sourceIndex = 0;
    }
    plan.omittedAssetIds = ["strong"];
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toContain("quick recap selection mismatch");
    expect(result.errors).not.toContain("omission ledger mismatch");
  });

  it("rejects swapping an optional eligible photo for one the deterministic duration budget did not choose", () => {
    const digests = [
      digest("hero", "tokyo", 0),
      digest("chosen-detail", "tokyo", 1),
      digest("later-detail", "tokyo", 2),
    ];
    const plan = buildDeterministicQuickRecapPlan({
      ...baseInput,
      routePointIds: ["tokyo"],
      targetDurationMs: 7_000,
      digests,
    });
    expect(plan.chapters[0]?.items.map((item) => item.assetId)).toEqual(["hero", "chosen-detail"]);
    const detail = plan.chapters[0]?.items[1];
    if (detail) {
      detail.assetId = "later-detail";
      detail.sourceIndex = 2;
    }
    plan.omittedAssetIds = ["chosen-detail"];
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.errors).toContain("quick recap selection mismatch");
    expect(result.errors).not.toContain("omission ledger mismatch");
  });

  it("keeps builder-generated deterministic selection valid across every Quick Recap tempo", () => {
    const digests = [digest("photo", "tokyo", 0)];
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      const plan = buildDeterministicQuickRecapPlan({
        ...baseInput,
        routePointIds: ["tokyo"],
        targetDurationMs: 12_000,
        tempo,
        digests,
      });
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
        .toMatchObject({ valid: true, errors: [] });
    }
  });


  it("requires Quick Recap target duration before deterministic selection can be trusted", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    delete plan.targetDurationMs;
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }).errors)
      .toContain("quick recap target duration invalid");
  });

  it("requires Full Playback to preserve every canonical visual asset exactly once", () => {
    const digests = [
      digest("intro", null, 0),
      digest("photo", "tokyo", 1),
      digest("video", "tokyo", 2, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 40_000 } }),
      digest("foreign", "tokyo", 3, { journeyId: "journey-2" }),
      digest("stale", "tokyo", 4, { sourceRevision: "6" }),
      digest("orphan", "deleted-route", 5),
    ];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1,
      planId: "full:test",
      journeyId: "journey-1",
      journeyRevision: "7",
      generatedAt: baseInput.generatedAt,
      mode: "full",
      plannedDurationMs: 44_200 + FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION,
      tempo: "standard",
      chapters: [
        {
          chapterId: "journey-intro",
          routePointId: null,
          camera: { primitive: "hold", durationMs: 0 },
          items: [{ assetId: "intro", sourceIndex: 0, dwellMs: 3_000, framing: "contain", transition: "direct", selectionReason: "all-media" }],
        },
        {
          chapterId: "route:tokyo",
          routePointId: "tokyo",
          camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
          arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true },
          items: [
            { assetId: "photo", sourceIndex: 1, dwellMs: 1_200, framing: "contain", transition: "direct", selectionReason: "all-media" },
            { assetId: "video", sourceIndex: 2, trim: { inMs: 0, outMs: 40_000 }, framing: "contain", transition: "direct", selectionReason: "all-media" },
          ],
        },
      ],
      omittedAssetIds: [],
    };
    expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
      .toMatchObject({ valid: true, errors: [] });

    plan.chapters[1]!.items = plan.chapters[1]!.items.filter((item) => item.assetId !== "photo");
    plan.plannedDurationMs -= 1_200;
    const missing = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(missing.errors).toContain("full asset omitted photo");
  });

  it("preserves Full Playback videos with unknown intrinsic duration without inventing trims", () => {
    const unknownDurations = [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY];
    for (const durationMs of unknownDurations) {
      const digests = [
        digest("video", "tokyo", 0, {
          mediaType: "video",
          mimeType: "video/mp4",
          intrinsic: durationMs === undefined ? {} : { durationMs },
        }),
      ];
      const plan: AutoEditPlanV1 = {
        schemaVersion: 1,
        planId: "full:unknown-video",
        journeyId: "journey-1",
        journeyRevision: "7",
        generatedAt: baseInput.generatedAt,
        mode: "full",
        plannedDurationMs: FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION,
        tempo: "standard",
        omittedAssetIds: [],
        chapters: [{
          chapterId: "route:tokyo",
          routePointId: "tokyo",
          camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
          arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true },
          items: [{
            assetId: "video",
            sourceIndex: 0,
            framing: "contain",
            transition: "direct",
            selectionReason: "all-media",
          }],
        }],
      };
      expect(validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests }))
        .toMatchObject({ valid: true, errors: [], recomputedDurationMs: FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION });

      plan.chapters[0]!.items = [];
      const missing = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(missing.errors).toContain("full asset omitted video");
    }
  });

  it("rejects Full omission bookkeeping, recap selection reasons, and silent video truncation", () => {
    const digests = [
      digest("photo", "tokyo", 0),
      digest("video", "tokyo", 1, { mediaType: "video", mimeType: "video/mp4", intrinsic: { durationMs: 40_000 } }),
    ];
    const plan: AutoEditPlanV1 = {
      schemaVersion: 1,
      planId: "full:forged",
      journeyId: "journey-1",
      journeyRevision: "7",
      generatedAt: baseInput.generatedAt,
      mode: "full",
      plannedDurationMs: 5_500 + FULL_CAMERA_DURATION + FULL_ARRIVAL_DURATION,
      tempo: "standard",
      chapters: [{
        chapterId: "route:tokyo",
        routePointId: "tokyo",
        camera: { primitive: "travel", durationMs: FULL_CAMERA_DURATION },
        arrival: { durationMs: FULL_ARRIVAL_DURATION, showPlaceLabel: true, showNote: true },
        items: [
          { assetId: "photo", sourceIndex: 0, dwellMs: 2_000, framing: "contain", transition: "direct", selectionReason: "route-point-representative" },
          { assetId: "video", sourceIndex: 1, trim: { inMs: 0, outMs: 3_500 }, framing: "contain", transition: "direct", selectionReason: "all-media" },
        ],
      }],
      omittedAssetIds: ["photo"],
    };
    const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "full omission ledger must be empty",
      "full selection reason mismatch photo",
      "full video trim mismatch video",
    ]));
    expect(result.errors).not.toContain("planned duration mismatch");
  });

});
