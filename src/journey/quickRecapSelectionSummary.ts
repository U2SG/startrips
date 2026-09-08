import {
  AUTO_EDIT_SELECTION_REASONS,
  type AutoEditPlanV1,
  type AutoEditSelectionReason,
} from "./autoEditPlan";
import type { Journey } from "./types";

export const QUICK_RECAP_OMISSION_REASONS = ["not-selected"] as const;
export type QuickRecapOmissionReason = typeof QUICK_RECAP_OMISSION_REASONS[number];

export type QuickRecapSelectionSummaryEntry = {
  routePointId: string | null;
  included: Array<{
    assetId: string;
    selectionReason: AutoEditSelectionReason;
  }>;
  omitted: Array<{
    assetId: string;
    reason: QuickRecapOmissionReason;
  }>;
};

export type QuickRecapSelectionSummary = QuickRecapSelectionSummaryEntry[];

function assertSelectionReason(reason: AutoEditPlanV1["chapters"][number]["items"][number]["selectionReason"]): AutoEditSelectionReason {
  if (!(AUTO_EDIT_SELECTION_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`invalid Quick Recap selection reason: ${String(reason)}`);
  }
  return reason;
}

function omittedChapterRoutePointId(
  assetId: string,
  plan: AutoEditPlanV1,
  journey: Journey,
): string | null | undefined {
  const asset = journey.media.find((candidate) => candidate.id === assetId);
  if (!asset) return undefined;

  if (plan.chapters.some((chapter) => chapter.routePointId === asset.routePointId)) {
    return asset.routePointId;
  }

  // Quick Recap projects Journey-scoped visual media into the first playable
  // Route Point chapter. The planner never mutates canonical ownership; this
  // mirrors that presentation-only projection solely to explain an omitted id.
  if (asset.routePointId === null) {
    return plan.chapters.find((chapter) => chapter.routePointId !== null)?.routePointId
      ?? plan.chapters[0]?.routePointId;
  }

  return undefined;
}

export function buildQuickRecapSelectionSummary(
  plan: AutoEditPlanV1,
  journey: Journey,
): QuickRecapSelectionSummary | null {
  if (plan.mode !== "quick-recap") return null;

  const summary = plan.chapters.map<QuickRecapSelectionSummaryEntry>((chapter) => ({
    routePointId: chapter.routePointId,
    included: chapter.items.map((item) => ({
      assetId: item.assetId,
      selectionReason: assertSelectionReason(item.selectionReason),
    })),
    omitted: [],
  }));
  const summaryByRoutePoint = new Map(summary.map((entry) => [entry.routePointId, entry]));

  for (const assetId of new Set(plan.omittedAssetIds)) {
    const routePointId = omittedChapterRoutePointId(assetId, plan, journey);
    const entry = routePointId === undefined ? undefined : summaryByRoutePoint.get(routePointId);
    if (!entry) continue;
    entry.omitted.push({ assetId, reason: "not-selected" });
  }

  return summary;
}
