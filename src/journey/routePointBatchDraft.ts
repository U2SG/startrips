import type { Journey } from "./types";
import type {
  MediaPlacementProposalBasis,
  MediaPlacementProposalPlan,
  MediaPlacementReadResult,
} from "./mediaPlacement";

/**
 * #337: A proposal is never a persisted Route Point. File indexes are scoped to
 * one immutable upload selection; stable group ids survive edits and re-plans.
 */
export type RoutePointReviewGroup = {
  id: string;
  fileIndexes: number[];
  destination: "existing" | "new" | "unplaced";
  routePointId: string | null;
  label: string;
  latitude: number | null;
  longitude: number | null;
  occurredAt: string | null;
  spatialSource: string;
  accuracyMeters: number | null;
  basis: MediaPlacementProposalBasis;
  representativeFileIndex: number | null;
  manual: boolean;
};

export type RoutePointBatchDraft = {
  scope: MediaPlacementProposalPlan["scope"];
  groups: RoutePointReviewGroup[];
  nextGroupNumber: number;
  /** Deliberately not stored in preferences or outside this selected batch. */
  autoOrganize: boolean;
};

export type RoutePointReviewAction =
  | { type: "rename" | "retime"; id: string; value: string }
  | { type: "reposition"; id: string; latitude: number; longitude: number }
  | { type: "assign"; id: string; routePointId: string | null }
  | { type: "split"; id: string; fileIndex: number }
  | { type: "merge"; id: string; otherId: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "auto-organize"; enabled: boolean };

function signalFor(reads: readonly MediaPlacementReadResult[], index: number) {
  const read = reads[index];
  return read?.status === "signal" ? read.signal : null;
}

function takenAt(reads: readonly MediaPlacementReadResult[], index: number) {
  const signal = signalFor(reads, index);
  // Local-only wall clock is NOT an instant. Never coerce it through the
  // browser's timezone or create an occurredAt from unknown offset.
  return signal?.timezoneState === "offset-known" ? signal.capturedAt ?? null : null;
}

function safeAccuracy(reads: readonly MediaPlacementReadResult[], index: number) {
  const value = signalFor(reads, index)?.accuracyMeters;
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function assertCoverage(groups: readonly RoutePointReviewGroup[], fileCount: number) {
  const seen = new Set<number>();
  for (const group of groups) {
    if (group.fileIndexes.length === 0) throw new RangeError("Empty Route Point review group");
    for (const index of group.fileIndexes) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= fileCount || seen.has(index)) {
        throw new RangeError("Route Point review duplicated or invalid media index");
      }
      seen.add(index);
    }
  }
  if (seen.size !== fileCount) throw new RangeError("Route Point review omitted media");
}

export function createRoutePointBatchDraft(
  plan: MediaPlacementProposalPlan,
  journey: Journey,
  reads: readonly MediaPlacementReadResult[],
  fileCount: number,
): RoutePointBatchDraft {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1
    || plan.scope.journeyId !== journey.id || plan.scope.routeRevision !== journey.revision) {
    throw new RangeError("Route Point review scope is stale");
  }
  const groups: RoutePointReviewGroup[] = [];
  const add = (
    id: string,
    fileIndexes: number[],
    destination: RoutePointReviewGroup["destination"],
    routePointId: string | null,
    latitude: number | null,
    longitude: number | null,
    label: string,
    basis: MediaPlacementProposalBasis,
    representativeFileIndex: number | null,
  ) => {
    const representativeIndex = representativeFileIndex ?? fileIndexes[0];
    groups.push({
      id,
      fileIndexes: [...fileIndexes].sort((a, b) => a - b),
      destination,
      routePointId,
      label,
      latitude,
      longitude,
      occurredAt: takenAt(reads, representativeIndex),
      spatialSource: signalFor(reads, representativeIndex)?.spatialSource ?? "unknown",
      accuracyMeters: safeAccuracy(reads, representativeIndex),
      basis,
      representativeFileIndex,
      manual: false,
    });
  };
  for (const match of plan.matchExisting) {
    const point = journey.routePoints.find((candidate) => candidate.id === match.routePointId);
    if (!point || match.journeyId !== journey.id) throw new RangeError("Unknown target Route Point");
    add(`existing:${match.routePointId}:${match.fileIndexes.join("-")}`, match.fileIndexes,
      "existing", point.id, point.latitude, point.longitude,
      point.label || "已有途径点", match.basis, match.fileIndexes[0]);
  }
  for (const candidate of plan.suggestNew) {
    add(candidate.candidateId, candidate.fileIndexes, "new", null,
      candidate.representative.latitude, candidate.representative.longitude,
      "新途径点草案", candidate.basis, candidate.representative.fileIndex);
  }
  for (const pending of plan.pendingConfirmation) {
    add(`unplaced:${pending.fileIndexes.join("-")}`, pending.fileIndexes,
      "unplaced", null, null, null, "待归属的媒体", pending.basis, pending.fileIndexes[0]);
  }
  assertCoverage(groups, fileCount);
  return { scope: { ...plan.scope }, groups, nextGroupNumber: 1, autoOrganize: false };
}

export function editRoutePointBatchDraft(
  draft: RoutePointBatchDraft,
  action: RoutePointReviewAction,
  journey: Journey,
): RoutePointBatchDraft {
  if (draft.scope.journeyId !== journey.id || draft.scope.routeRevision !== journey.revision) {
    throw new RangeError("Route Point review revision changed");
  }
  if (action.type === "auto-organize") return { ...draft, autoOrganize: action.enabled };
  const groups = draft.groups.map((group) => ({ ...group, fileIndexes: [...group.fileIndexes] }));
  const index = groups.findIndex((group) => group.id === action.id);
  if (index < 0) throw new RangeError("Route Point group not found");
  const group = groups[index];
  if (action.type === "move") {
    const target = index + action.direction;
    if (target < 0 || target >= groups.length) return draft;
    [groups[index], groups[target]] = [groups[target], groups[index]];
    return { ...draft, groups };
  }
  if (action.type === "rename") {
    group.label = action.value.slice(0, 120);
  } else if (action.type === "retime") {
    if (action.value && !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))$/.test(action.value)) {
      throw new RangeError("Time needs an explicit timezone offset");
    }
    group.occurredAt = action.value ? new Date(action.value).toISOString() : null;
    if (action.value && !Number.isFinite(new Date(action.value).valueOf())) {
      throw new RangeError("Invalid Route Point time");
    }
  } else if (action.type === "reposition") {
    if (!Number.isFinite(action.latitude) || !Number.isFinite(action.longitude)
      || Math.abs(action.latitude) > 90 || Math.abs(action.longitude) > 180) {
      throw new RangeError("Invalid Route Point coordinate");
    }
    group.destination = "new";
    group.routePointId = null;
    group.latitude = action.latitude;
    group.longitude = action.longitude;
    group.spatialSource = "manual";
    group.accuracyMeters = null; // Manual reposition cannot inherit EXIF precision.
  } else if (action.type === "assign") {
    if (action.routePointId !== null && !journey.routePoints.some((point) => point.id === action.routePointId)) {
      throw new RangeError("Unknown Route Point assignment");
    }
    const point = journey.routePoints.find((candidate) => candidate.id === action.routePointId);
    group.destination = point ? "existing" : "unplaced";
    group.routePointId = point?.id ?? null;
    group.latitude = point?.latitude ?? null;
    group.longitude = point?.longitude ?? null;
    group.label = point?.label || "保留在整段旅程";
    group.spatialSource = "manual";
    group.accuracyMeters = null;
  } else if (action.type === "split") {
    if (group.fileIndexes.length < 2 || !group.fileIndexes.includes(action.fileIndex)) {
      throw new RangeError("Split must select one member of a multi-file group");
    }
    group.fileIndexes = group.fileIndexes.filter((value) => value !== action.fileIndex);
    // The representative GPS may belong to the removed file. Both halves must
    // be explicitly assigned; never copy one photo's location to another.
    group.destination = "unplaced";
    group.routePointId = null;
    group.latitude = null;
    group.longitude = null;
    group.accuracyMeters = null;
    group.spatialSource = "unknown";
    // A split invalidates the representative's timestamp for BOTH subsets;
    // neither may silently borrow another photograph's capture time.
    group.occurredAt = null;
    const split: RoutePointReviewGroup = {
      ...group,
      id: `manual:${draft.nextGroupNumber}`,
      fileIndexes: [action.fileIndex],
      label: "待指定地点",
      representativeFileIndex: action.fileIndex,
      manual: true,
      basis: { reason: "manual-split", evidence: [], uncertainty: ["requires-review"] },
    };
    group.manual = true;
    group.basis = { reason: "manual-split", evidence: [], uncertainty: ["requires-review"] };
    groups.splice(index + 1, 0, split);
    return { ...draft, groups, nextGroupNumber: draft.nextGroupNumber + 1 };
  } else if (action.type === "merge") {
    const otherIndex = groups.findIndex((candidate) => candidate.id === action.otherId);
    if (otherIndex < 0 || index === otherIndex) throw new RangeError("Invalid Route Point merge");
    const other = groups[otherIndex];
    group.fileIndexes = [...group.fileIndexes, ...other.fileIndexes].sort((a, b) => a - b);
    // A merge is a grouping decision, not evidence that every file has the
    // same GPS. A mixed target requires a new explicit assignment.
    if (group.destination !== other.destination
      || group.routePointId !== other.routePointId
      || (group.destination === "new"
        && (group.latitude !== other.latitude || group.longitude !== other.longitude))) {
      group.destination = "unplaced";
      group.routePointId = null;
      group.latitude = null;
      group.longitude = null;
      group.label = "合并后待指定地点";
    }
    group.accuracyMeters = null;
    group.occurredAt = null; // A merged candidate has no shared time evidence.
    group.spatialSource = "manual";
    group.basis = { reason: "manual-merge", evidence: [], uncertainty: ["requires-review"] };
    groups.splice(otherIndex, 1);
  }
  group.manual = true;
  return { ...draft, groups };
}

export function canAutoOrganizeRoutePointBatch(draft: RoutePointBatchDraft) {
  return draft.autoOrganize && draft.groups.length > 0 && draft.groups.every((group) =>
    !group.manual
    && group.destination !== "unplaced"
    && group.fileIndexes.length > 0
    && group.basis.uncertainty.length === 0
    && group.basis.evidence.length > 0
    && (group.destination === "existing" || group.basis.reason === "spatiotemporal-cluster"),
  );
}

/** A planner refresh can update untouched candidates, never user-edited ones. */
export function reconcileRoutePointBatchDraft(
  prior: RoutePointBatchDraft,
  refreshed: RoutePointBatchDraft,
): RoutePointBatchDraft {
  if (prior.scope.batchId !== refreshed.scope.batchId
    || prior.scope.journeyId !== refreshed.scope.journeyId
    || prior.scope.routeRevision !== refreshed.scope.routeRevision) {
    throw new RangeError("Cannot reuse draft from another Journey revision or batch");
  }
  const pinned = prior.groups.filter((group) => group.manual);
  const protectedIndexes = new Set(pinned.flatMap((group) => group.fileIndexes));
  const untouched = refreshed.groups.flatMap((group) => {
    const allowed = group.fileIndexes.filter((index) => !protectedIndexes.has(index));
    return allowed.length ? [{ ...group, fileIndexes: allowed }] : [];
  });
  const groups = [...pinned, ...untouched];
  const indexes = [...prior.groups.flatMap((group) => group.fileIndexes)];
  assertCoverage(groups, indexes.length);
  return { ...prior, groups, nextGroupNumber: prior.nextGroupNumber };
}

export type RoutePointBatchApplyBody = {
  operationId: string;
  baseRevision: number;
  points: Array<{ candidateId: string; latitude: number; longitude: number; label: string; isStop: true; occurredAt: string | null }>;
  attachments: Array<{ assetId: string; candidateId?: string; routePointId?: string; intentionalReuse: false }>;
};

/** Existing-only and unplaced groups use ordinary upload/move, not #336's
 * new-point-only atomic endpoint. Null means there are no new points to create. */
export type RoutePointBatchAssetAssignment = {
  assetId: string;
  destination: RoutePointReviewGroup["destination"];
  routePointId: string | null;
  candidateId: string | null;
};

/** Multipart upload may deduplicate identical files onto ONE asset id.
 * A repeated id with a single destination must become ONE attachment. A
 * repeated id with conflicting destinations must never pick a winner.
 */
export function resolveRoutePointBatchAssetAssignments(
  draft: RoutePointBatchDraft,
  assetIdsByFileIndex: readonly string[],
): RoutePointBatchAssetAssignment[] {
  assertCoverage(draft.groups, assetIdsByFileIndex.length);
  const byAsset = new Map<string, RoutePointBatchAssetAssignment>();
  for (const group of draft.groups) {
    for (const index of group.fileIndexes) {
      const assetId = assetIdsByFileIndex[index];
      if (!assetId) throw new RangeError("Route Point batch media upload incomplete");
      const next: RoutePointBatchAssetAssignment = {
        assetId,
        destination: group.destination,
        routePointId: group.destination === "existing" ? group.routePointId : null,
        candidateId: group.destination === "new" ? group.id : null,
      };
      const prior = byAsset.get(assetId);
      if (prior && (prior.destination !== next.destination
        || prior.routePointId !== next.routePointId
        || prior.candidateId !== next.candidateId)) {
        throw new RangeError("同一上传媒体被分配到不同地点：请先把重复照片归到同一个目的地，再确认；不必重复上传。");
      }
      if (!prior) byAsset.set(assetId, next);
    }
  }
  return [...byAsset.values()];
}

export function buildRoutePointBatchApplyBody(
  draft: RoutePointBatchDraft,
  assetIdsByFileIndex: readonly string[],
  operationId: string,
): RoutePointBatchApplyBody | null {
  const assignments = resolveRoutePointBatchAssetAssignments(draft, assetIdsByFileIndex);
  const points: RoutePointBatchApplyBody["points"] = [];
  for (const group of draft.groups) {
    if (group.destination !== "new") continue;
    if (!group.label.trim() || group.latitude === null || group.longitude === null) {
      throw new RangeError("New Route Point needs a confirmed name and coordinate");
    }
    points.push({
      candidateId: group.id, label: group.label.trim(), latitude: group.latitude,
      longitude: group.longitude, occurredAt: group.occurredAt, isStop: true,
    });
  }
  const attachments: RoutePointBatchApplyBody["attachments"] = assignments
    .filter((value) => value.destination !== "unplaced")
    .map((value) => ({
      assetId: value.assetId, intentionalReuse: false as const,
      ...(value.candidateId ? { candidateId: value.candidateId } : { routePointId: value.routePointId! }),
    }));
  if (!points.length) return null;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(operationId) || !attachments.length) {
    throw new RangeError("Invalid or empty Route Point batch operation");
  }
  return { operationId, baseRevision: draft.scope.routeRevision, points, attachments };
}
