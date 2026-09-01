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
