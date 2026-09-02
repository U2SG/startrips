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
