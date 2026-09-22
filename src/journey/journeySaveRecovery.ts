import type { PendingJourneyMedia } from "./journeyDraftMedia";
import type { JourneyMediaUploadResult } from "./journeyMediaUpload";
import type { RouteDraftPoint } from "./routeDraft";
import type { Journey, JourneyInput, RoutePointInput } from "./types";

export type JourneySaveResult = {
  journey: Journey;
} & Pick<JourneyMediaUploadResult, "uploadedCount" | "mediaErrors">;

export type UnknownJourneyCreateAttempt = {
  input: JourneyInput;
  knownJourneyIdsBeforeCreate: string[];
  mode: "recheck" | "confirmation-required" | "ambiguous";
  routePoints?: RouteDraftPoint[];
  mediaFiles?: PendingJourneyMedia[];
};

export function unknownCreateRecheckMessage(hasPendingMedia: boolean) {
  const sameSession = "你可以重新确认，或先关闭创建器，稍后在当前 Atlas 会话中重新打开继续核对。";
  const pendingMediaNotice = hasPendingMedia
    ? "当前会话会保留尚未上传的本地媒体和路线点归属；请不要刷新整个页面，刷新后这些本地内容需要重新选择。"
    : "请继续在当前 Atlas 会话中核对，不要把刷新整个页面当作保留这次恢复状态的方式。";
  return `暂时无法确认这段旅程是否已经保存。${sameSession}${pendingMediaNotice}关闭不会创建另一段 Journey，也不会把这次不确定结果当作未保存。`;
}

export function confirmationRequiredUnknownCreateMessage(hasPendingMedia: boolean) {
  const pendingMediaNotice = hasPendingMedia
    ? "当前会话仍会保留尚未上传的本地媒体和路线点归属；请不要刷新整个页面。"
    : "";
  return `检测到一条与本次提交内容完全相同、且在本次尝试后出现的 Journey，但当前系统没有能证明它属于这次保存请求的服务端尝试标识。为避免把其他会话创建的 Journey 当成本次结果，当前不会自动采用它、上传媒体或触发抵达焦点，也不会再次创建。请先关闭创建器，在 Atlas 中核对这条 Journey。${pendingMediaNotice}`;
}

export function ambiguousUnknownCreateMessage(hasPendingMedia: boolean) {
  const refreshWarning = hasPendingMedia
    ? "如果你选择刷新整个页面，尚未上传的本地媒体和路线点归属会丢失，需要重新选择。"
    : "";
  return `检测到多条与本次提交完全相同的新 Journey，无法安全判断哪一条属于这次保存。为避免重复创建，当前不会再次提交；请关闭创建器后在 Atlas 中核对这些 Journey。${refreshWarning}`;
}

export type JourneySaveRecoveryDecision =
  | { status: "not-persisted" }
  | { status: "confirmation-required"; matchingJourneyId: string }
  | { status: "ambiguous"; matchingJourneyIds: string[] };

export type JourneySaveCallbackScope = "initial-save" | "media-retry";

function canonicalOccurredAt(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function canonicalPoint(point: RoutePointInput | Journey["routePoints"][number]) {
  return {
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    label: point.label.trim(),
    isStop: point.isStop,
    occurredAt: canonicalOccurredAt(point.occurredAt),
    note: typeof point.note === "string" && point.note.trim().length > 0
      ? point.note
      : null,
  };
}

function matchesSubmittedDraft(input: JourneyInput, journey: Journey) {
  if (journey.title !== input.title.trim()) return false;
  if (journey.startedOn !== input.startedOn) return false;
  if (journey.endedOn !== (input.endedOn || null)) return false;
  if (journey.note !== input.note.trim()) return false;
  if (journey.lightColor !== input.lightColor) return false;
  if ((journey.lightEffect ?? null) !== (input.lightEffect ?? null)) return false;
  if (journey.routePoints.length !== input.routePoints.length) return false;
  return input.routePoints.every((point, index) => {
    const left = canonicalPoint(point);
    const right = canonicalPoint(journey.routePoints[index]);
    return left.latitude === right.latitude
      && left.longitude === right.longitude
      && left.label === right.label
      && left.isStop === right.isStop
      && left.occurredAt === right.occurredAt
      && left.note === right.note;
  });
}

export function resolveJourneySaveRecovery(
  submittedDraft: JourneyInput,
  journeys: readonly Journey[],
  options: { knownJourneyIdsBeforeCreate?: ReadonlySet<string> } = {},
): JourneySaveRecoveryDecision {
  const knownIds = options.knownJourneyIdsBeforeCreate;
  const matches = journeys
    .filter((journey) => !knownIds?.has(journey.id))
    .filter((journey) => matchesSubmittedDraft(submittedDraft, journey));
  // Canonical equality proves only that a matching Journey appeared after the
  // pre-create snapshot. Without server-bound attempt provenance it cannot
  // prove that this specific POST created the Journey, so a single match is
  // confirmation-only rather than automatically adoptable.
  if (matches.length === 1) {
    return { status: "confirmation-required", matchingJourneyId: matches[0].id };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      matchingJourneyIds: matches.map((journey) => journey.id).sort(),
    };
  }
  return { status: "not-persisted" };
}

export function resolveJourneyArrivalHandoff({
  journeyId,
  editingJourneyId,
  callbackScope,
}: {
  journeyId: string;
  editingJourneyId: string | null;
  callbackScope: JourneySaveCallbackScope;
}) {
  if (callbackScope !== "initial-save") return null;
  if (editingJourneyId === journeyId) return null;
  return journeyId;
}
