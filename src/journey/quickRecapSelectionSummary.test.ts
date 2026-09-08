import { describe, expect, it } from "vitest";
import { AUTO_EDIT_SELECTION_REASONS, type AutoEditPlanV1 } from "./autoEditPlan";
import {
  QUICK_RECAP_OMISSION_REASONS,
  buildQuickRecapSelectionSummary,
} from "./quickRecapSelectionSummary";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

function routePoint(id: string, sortOrder: number): RoutePoint {
  return {
    id,
    journeyId: "journey-a",
    sortOrder,
    latitude: 22 + sortOrder,
    longitude: 114 + sortOrder,
    label: `Route Point ${sortOrder + 1}`,
    isStop: true,
    occurredAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function media(id: string, routePointId: string | null, sortOrder: number): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-a",
    routePointId,
    storageDriver: "local",
    storageKey: `journey-a/${id}.jpg`,
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    bytes: 1_024,
    sortOrder,
    uploadedByUserId: "user-a",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function journey(): Journey {
  return {
    id: "journey-a",
    atlasId: "atlas-a",
    title: "Selection summary fixture",
    startedOn: "2026-09-01",
    endedOn: null,
    note: "",
    lightColor: "#ffffff",
    revision: 7,
    createdByUserId: "user-a",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    routePoints: [routePoint("route-a", 0), routePoint("route-b", 1)],
    media: [
      media("a-selected", "route-a", 0),
      media("a-omitted", "route-a", 1),
      media("journey-omitted", null, 2),
      media("b-selected", "route-b", 3),
      media("b-omitted", "route-b", 4),
    ],
  };
}

function quickPlan(): AutoEditPlanV1 {
  return {
    schemaVersion: 1,
    planId: "baseline:v1:journey-a:7",
    journeyId: "journey-a",
    journeyRevision: "7",
    generatedAt: "2026-09-01T00:00:00.000Z",
    mode: "quick-recap",
    targetDurationMs: 45_000,
    plannedDurationMs: 8_000,
    tempo: "standard",
    chapters: [
      {
        chapterId: "route:route-a",
        routePointId: "route-a",
        camera: { primitive: "travel", durationMs: 1_000 },
        items: [{
          assetId: "a-selected",
          sourceIndex: 0,
          dwellMs: 2_000,
          framing: "contain",
          transition: "direct",
          selectionReason: "route-point-representative",
        }],
      },
      {
        chapterId: "route:route-b",
        routePointId: "route-b",
        camera: { primitive: "travel", durationMs: 1_000 },
        items: [{
          assetId: "b-selected",
          sourceIndex: 3,
          dwellMs: 2_000,
          framing: "contain",
          transition: "direct",
          selectionReason: "visual-diversity",
        }],
      },
    ],
    omittedAssetIds: ["a-omitted", "journey-omitted", "b-omitted"],
  };
}

describe("buildQuickRecapSelectionSummary", () => {
  it("returns one per-chapter summary and assigns every omitted id exactly once", () => {
    const plan = quickPlan();
    const summary = buildQuickRecapSelectionSummary(plan, journey());
    expect(summary).not.toBeNull();
    expect(summary).toHaveLength(plan.chapters.length);

    const omitted = summary!.flatMap((entry) => entry.omitted.map((item) => item.assetId));
    expect(omitted).toHaveLength(plan.omittedAssetIds.length);
    expect(new Set(omitted)).toEqual(new Set(plan.omittedAssetIds));
    for (const assetId of plan.omittedAssetIds) {
      expect(omitted.filter((candidate) => candidate === assetId)).toHaveLength(1);
    }

    // Journey-scoped visual media is projected into the first playable Route
    // Point by Quick Recap, and the explainability summary follows that same
    // presentation-only ownership without mutating the Journey.
    expect(summary![0].omitted.map((item) => item.assetId)).toContain("journey-omitted");
  });

  it("keeps included ids in their plan chapter and never overlaps included and omitted sets", () => {
    const plan = quickPlan();
    const summary = buildQuickRecapSelectionSummary(plan, journey())!;

    summary.forEach((entry, index) => {
      const plannedIds = new Set(plan.chapters[index].items.map((item) => item.assetId));
      expect(entry.routePointId).toBe(plan.chapters[index].routePointId);
      for (const item of entry.included) expect(plannedIds.has(item.assetId)).toBe(true);
    });

    const included = new Set(summary.flatMap((entry) => entry.included.map((item) => item.assetId)));
    const omitted = summary.flatMap((entry) => entry.omitted.map((item) => item.assetId));
    expect(omitted.every((assetId) => !included.has(assetId))).toBe(true);
  });

  it("emits only closed selection and omission reason codes", () => {
    const summary = buildQuickRecapSelectionSummary(quickPlan(), journey())!;
    for (const entry of summary) {
      for (const item of entry.included) {
        expect(AUTO_EDIT_SELECTION_REASONS).toContain(item.selectionReason);
      }
      for (const item of entry.omitted) {
        expect(QUICK_RECAP_OMISSION_REASONS).toContain(item.reason);
      }
    }
  });

  it("returns null for Full Playback plans", () => {
    const plan = { ...quickPlan(), mode: "full" as const, omittedAssetIds: [] };
    expect(buildQuickRecapSelectionSummary(plan, journey())).toBeNull();
  });

  it("does not mutate either input", () => {
    const plan = quickPlan();
    const sourceJourney = journey();
    const planBefore = structuredClone(plan);
    const journeyBefore = structuredClone(sourceJourney);

    buildQuickRecapSelectionSummary(plan, sourceJourney);

    expect(plan).toEqual(planBefore);
    expect(sourceJourney).toEqual(journeyBefore);
  });
});
