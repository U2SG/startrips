import { describe, expect, it } from "vitest";
import { buildDeterministicQuickRecapPlan, type MediaDigestV1, validateAutoEditPlanV1 } from "./autoEditPlan";

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
      ["tokyo-opener", "hero", 3_100],
      ["tokyo-detail", "supporting", 1_800],
      ["tokyo-pin", "representative", 2_500],
    ]);
    expect(validateAutoEditPlanV1(plan, { ...baseInput, digests })).toMatchObject({ valid: true });
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
    for (const illegalRole of [null, "", 0]) {
      const plan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
      const video = plan.chapters[0]?.items[0];
      if (video) (video as unknown as { photoRole?: unknown }).photoRole = illegalRole;
      const result = validateAutoEditPlanV1(plan, { ...baseInput, routePointIds: ["tokyo"], digests });
      expect(result.errors).toContain("video photo role invalid video");
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

  it("fails closed on structurally malformed runtime plan input instead of throwing", () => {
    const digests = [digest("photo", "tokyo", 0)];
    const validPlan = buildDeterministicQuickRecapPlan({ ...baseInput, routePointIds: ["tokyo"], digests });
    const malformed: Array<{ plan: unknown; error: string }> = [
      { plan: null, error: "plan must be an object" },
      { plan: { ...validPlan, chapters: null }, error: "chapters must be an array" },
      { plan: { ...validPlan, omittedAssetIds: null }, error: "omittedAssetIds must be an array" },
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
      plan.plannedDurationMs = plan.chapters.reduce((sum, chapter) =>
        sum + chapter.camera.durationMs + (chapter.arrival?.durationMs ?? 0) + chapter.items.reduce((itemSum, item) =>
          itemSum + (item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : 0)), 0), 0);
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
});
