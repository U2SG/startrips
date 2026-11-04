import type { Journey } from "./types";
import {
  recoverUploadedRoutePointBatchSubset, resolveRoutePointBatchAssetAssignments,
  type RoutePointBatchDraft, type RoutePointReviewGroup,
} from "./routePointBatchDraft";

// Session-only, bounded review decisions, NOT the source files/EXIF or consent.
// Indexes always refer to the original selection, even after partial completion.
type SavedGroup = Pick<RoutePointReviewGroup, "id" | "fileIndexes" | "destination"
  | "routePointId" | "label" | "latitude" | "longitude" | "occurredAt"
  | "representativeFileIndex" | "manual"> & { manualCoordinate: boolean };
export type RoutePointBatchRecovery = {
  version: 2;
  atlasId: string;
  scope: RoutePointBatchDraft["scope"];
  fileCount: number;
  groups: SavedGroup[];
  nextGroupNumber: number;
  confirmed: Array<{ fileIndex: number; assetId: string }>;
  phase: "uploading" | "review" | "applying";
};
const MAX_FILES = 500;
const MAX_BYTES = 256_000;
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
export const routePointBatchRecoveryKey = (journeyId: string) =>
  `startrips:route-point-batch-partial:${journeyId}`;

export function createRoutePointBatchRecovery(
  draft: RoutePointBatchDraft, journey: Journey, fileCount: number,
): RoutePointBatchRecovery {
  const value: RoutePointBatchRecovery = {
    version: 2, atlasId: journey.atlasId,
    scope: { batchId: draft.scope.batchId, journeyId: draft.scope.journeyId, routeRevision: draft.scope.routeRevision },
    fileCount, nextGroupNumber: draft.nextGroupNumber, phase: "uploading", confirmed: [],
    groups: draft.groups.map((group) => ({
      id: group.id, fileIndexes: [...group.fileIndexes], destination: group.destination,
      routePointId: group.routePointId, label: group.label, latitude: group.latitude,
      longitude: group.longitude, occurredAt: group.occurredAt,
      representativeFileIndex: group.representativeFileIndex, manual: group.manual,
      manualCoordinate: group.spatialSource === "manual",
    })),
  };
  if (!parseRoutePointBatchRecovery(JSON.stringify(value), journey.id)) {
    throw new Error("本批草案超出会话恢复范围，请减少文件后重新审阅。");
  }
  return value;
}

export function parseRoutePointBatchRecovery(raw: string | null, journeyId: string): RoutePointBatchRecovery | null {
  if (!raw || raw.length > MAX_BYTES) return null;
  try {
    const v = JSON.parse(raw) as RoutePointBatchRecovery;
    if (v.version !== 2 || !identity(v.atlasId) || !identity(v.scope?.batchId)
      || v.scope.journeyId !== journeyId || !Number.isSafeInteger(v.scope.routeRevision) || v.scope.routeRevision < 0
      || !Number.isSafeInteger(v.fileCount) || v.fileCount < 1 || v.fileCount > MAX_FILES
      || !Number.isSafeInteger(v.nextGroupNumber) || v.nextGroupNumber < 1
      || !["uploading", "review", "applying"].includes(v.phase)
      || !Array.isArray(v.groups) || !v.groups.length || v.groups.length > v.fileCount
      || !Array.isArray(v.confirmed) || v.confirmed.length > v.fileCount) return null;
    const indexes = new Set<number>();
    const groupIds = new Set<string>();
    const validIndex = (index: number) => Number.isSafeInteger(index) && index >= 0 && index < v.fileCount;
    for (const g of v.groups) {
      if (!identity(g.id) || groupIds.has(g.id) || !Array.isArray(g.fileIndexes) || !g.fileIndexes.length
        || g.fileIndexes.length > v.fileCount || typeof g.manual !== "boolean" || typeof g.manualCoordinate !== "boolean"
        || typeof g.label !== "string" || g.label.length > 120
        || !["new", "existing", "unplaced"].includes(g.destination)
        || (g.destination === "existing" ? !identity(g.routePointId) : g.routePointId !== null)
        || (g.latitude !== null && (typeof g.latitude !== "number" || !Number.isFinite(g.latitude) || Math.abs(g.latitude) > 90))
        || (g.longitude !== null && (typeof g.longitude !== "number" || !Number.isFinite(g.longitude) || Math.abs(g.longitude) > 180))
        || (g.destination === "new" && (g.latitude === null || g.longitude === null))
        || (g.occurredAt !== null && (typeof g.occurredAt !== "string" || g.occurredAt.length > 40
          || !/(Z|[+-]\d{2}:\d{2})$/.test(g.occurredAt) || !Number.isFinite(Date.parse(g.occurredAt))))
        || (g.representativeFileIndex !== null && !g.fileIndexes.includes(g.representativeFileIndex))) return null;
      groupIds.add(g.id);
      for (const index of g.fileIndexes) {
        if (!validIndex(index) || indexes.has(index)) return null;
        indexes.add(index);
      }
    }
    if (indexes.size !== v.fileCount) return null;
    const confirmedIndexes = new Set<number>();
    for (const item of v.confirmed) {
      if (!validIndex(item.fileIndex) || confirmedIndexes.has(item.fileIndex) || !identity(item.assetId)) return null;
      confirmedIndexes.add(item.fileIndex);
    }
    return v;
  } catch { return null; }
}

/** A fresh authorized Journey read is required on resume AND immediately before apply. */
export function recoverRoutePointBatchReview(value: RoutePointBatchRecovery, journey: Journey) {
  if (value.phase === "applying") throw new Error("本批提交结果需按原操作编号读回，不能再次提交；请手动核对回执。");
  if (value.atlasId !== journey.atlasId || value.scope.journeyId !== journey.id
    || value.scope.routeRevision !== journey.revision) throw new Error("旅程范围或路线版本已变化，草案不能继续套用；请手动核对已上传媒体。");
  if (!value.confirmed.length) throw new Error("没有可验证的服务端媒体ID；待处理文件结果未知，请手动读回，勿重复上传。");
  const confirmed = [...value.confirmed].sort((a, b) => a.fileIndex - b.fileIndex);
  for (const item of confirmed) {
    const matches = journey.media.filter((asset) => asset.id === item.assetId);
    if (matches.length !== 1 || matches[0].journeyId !== journey.id || matches[0].routePointId !== null) {
      throw new Error("已确认媒体ID缺失、重复或归属已变化，请手动核对；不会猜测文件映射或重新上传。");
    }
  }
  if (value.groups.some((g) => g.destination === "existing"
    && !journey.routePoints.some((point) => point.id === g.routePointId))) throw new Error("原途径点已不存在，请手动核对。");
  const draft: RoutePointBatchDraft = {
    scope: value.scope, nextGroupNumber: value.nextGroupNumber, autoOrganize: false,
    groups: value.groups.map((group) => ({ ...group, spatialSource: group.manualCoordinate ? "manual" : "unknown", accuracyMeters: null,
      basis: { reason: "session-reviewed-draft", evidence: [], uncertainty: ["requires-review"] } })),
  };
  const confirmedIndexes = new Set(confirmed.map((item) => item.fileIndex));
  const recovered = recoverUploadedRoutePointBatchSubset(draft, value.fileCount, {
    uploadedCount: confirmed.length, assets: confirmed.map((item) => ({ id: item.assetId })),
    mediaErrors: Array.from({ length: value.fileCount }, (_, fileIndex) => ({ fileIndex }))
      .filter((item) => !confirmedIndexes.has(item.fileIndex)),
  });
  if (!recovered) throw new Error("原文件索引无法验证，请手动核对已上传媒体。");
  resolveRoutePointBatchAssetAssignments(recovered.draft, recovered.assetIds);
  return { ...recovered, originalFileIndexes: confirmed.map((item) => item.fileIndex) };
}

/** Keep edits to the verified subset at their original indexes. Unconfirmed
 * files remain separate and cannot inherit a new destination from that subset. */
export function updateRoutePointBatchRecoveryDraft(
  value: RoutePointBatchRecovery, draft: RoutePointBatchDraft, originalIndexes: readonly number[], journey: Journey,
): RoutePointBatchRecovery {
  if (value.phase === "applying" || value.scope.batchId !== draft.scope.batchId) throw new Error("本批已提交或身份已变化。");
  const expected = value.confirmed.map((item) => item.fileIndex).sort((a, b) => a - b);
  if (JSON.stringify(expected) !== JSON.stringify(originalIndexes)) throw new Error("原文件索引已变化。");
  const selected = new Set(originalIndexes);
  const pending: SavedGroup[] = value.groups.flatMap((group) => {
    const fileIndexes = group.fileIndexes.filter((index) => !selected.has(index));
    return fileIndexes.length ? [{ ...group, id: `pending:${fileIndexes[0]}`, fileIndexes,
      representativeFileIndex: null, destination: "unplaced", routePointId: null,
      latitude: null, longitude: null, occurredAt: null, manualCoordinate: false }] : [];
  });
  const edited = createRoutePointBatchRecovery(draft, journey, originalIndexes.length);
  const groups = edited.groups.map((group) => ({ ...group,
    fileIndexes: group.fileIndexes.map((index) => originalIndexes[index]),
    representativeFileIndex: group.representativeFileIndex === null ? null : originalIndexes[group.representativeFileIndex],
  }));
  return { ...value, groups: [...groups, ...pending], nextGroupNumber: draft.nextGroupNumber };
}
