import { useState } from "react";
import type { Journey } from "./types";
import type { RoutePointBatchDraft, RoutePointReviewAction, RoutePointReviewGroup } from "./routePointBatchDraft";
import { canAutoOrganizeRoutePointBatch } from "./routePointBatchDraft";
import "../styles/route-point-batch-review.css";

function coordinateLabel(group: RoutePointReviewGroup) {
  if (group.latitude === null || group.longitude === null) return "位置待确认";
  return `${group.latitude.toFixed(5)}, ${group.longitude.toFixed(5)}`;
}

function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    "existing-route-point-evidence": "匹配已有地点",
    "spatiotemporal-cluster": "位置和时间构成独立分组",
    "single-observation-candidate": "单张照片的地点草案",
    "missing-coordinate-evidence": "无可用的坐标",
    "missing-time-evidence": "拍摄时间不完整",
    "accuracy-unknown": "定位精度未知",
    "accuracy-too-coarse": "定位范围过大",
    "implausible-speed": "位置与时间存在冲突",
    "conflicting-route-evidence": "已有路线与定位信息冲突",
    "manual-split": "手动拆分，等待确认",
    "manual-merge": "手动合并，等待确认",
  };
  return labels[reason] ?? reason;
}

function GroupEditor({
  group, journey, index, total, disabled, mergeTargets, onEdit,
}: {
  group: RoutePointReviewGroup;
  journey: Journey;
  index: number;
  total: number;
  disabled: boolean;
  mergeTargets: Array<{ id: string; label: string }>;
  onEdit: (action: RoutePointReviewAction) => void;
}) {
  const [latInput, setLatInput] = useState(() => group.latitude?.toString() ?? "");
  const [lonInput, setLonInput] = useState(() => group.longitude?.toString() ?? "");
  const [timeInput, setTimeInput] = useState(() => group.occurredAt ?? "");
  const [mergeId, setMergeId] = useState("");
  function applyCoordinates() {
    const latitude = Number(latInput);
    const longitude = Number(lonInput);
    if (!latInput.trim() || !lonInput.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
    onEdit({ type: "reposition", id: group.id, latitude, longitude });
  }
  return (
    <li className="route-batch__group" data-review-group={group.id}>
      <div className="route-batch__group-heading">
        <span className="route-batch__number">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{group.destination === "new" ? "新途径点 · 草案" : group.destination === "existing" ? "已有途径点" : "未归属媒体"}</strong>
          <p>{reasonLabel(group.basis.reason)} · {group.fileIndexes.length} 个媒体 · {group.spatialSource === "unknown" ? "未定位" : `来源 ${group.spatialSource}`}</p>
        </div>
        <div className="route-batch__reorder" aria-label="调整分组顺序">
          <button disabled={disabled || index === 0} type="button" onClick={() => onEdit({ type: "move", id: group.id, direction: -1 })} aria-label={`上移第 ${index + 1} 组`}>↑</button>
          <button disabled={disabled || index === total - 1} type="button" onClick={() => onEdit({ type: "move", id: group.id, direction: 1 })} aria-label={`下移第 ${index + 1} 组`}>↓</button>
        </div>
      </div>
      <p className="route-batch__evidence">{coordinateLabel(group)} · {group.accuracyMeters === null ? "精度未知或手动选择" : `约 ±${Math.round(group.accuracyMeters)} 米`} · {group.occurredAt ?? "拍摄时间未知"}</p>
      {group.basis.uncertainty.length > 0 ? <p className="route-batch__uncertain">需要确认：{group.basis.uncertainty.join(" · ")}</p> : null}
      <div className="route-batch__fields">
        <label>途径点名称
          <input type="text" maxLength={120} disabled={disabled || group.destination !== "new"} value={group.label}
            onChange={(event) => onEdit({ type: "rename", id: group.id, value: event.target.value })} />
        </label>
        {group.destination !== "new" ? <p className="route-batch__fine-print">已有途径点名称不会随媒体归属修改；如需改名请单独编辑途径点。新建草案才可命名。</p> : null}
        <label>媒体去向
          <select disabled={disabled} value={group.destination === "new" ? "__new" : group.routePointId ?? "__journey"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "__new") {
                applyCoordinates();
              } else onEdit({ type: "assign", id: group.id, routePointId: value === "__journey" ? null : value });
            }}>
            <option value="__journey">保留在整段 Journey（不推测 GPS）</option>
            {group.destination === "new" ? <option value="__new">新建途径点草案</option> : null}
            {journey.routePoints.map((point) => <option key={point.id} value={point.id}>{point.label || "已有途径点"}</option>)}
          </select>
        </label>
        <label>纬度
          <input type="number" step="any" min="-90" max="90" disabled={disabled} value={latInput}
            onChange={(event) => setLatInput(event.target.value)} />
        </label>
        <label>经度
          <input type="number" step="any" min="-180" max="180" disabled={disabled} value={lonInput}
            onChange={(event) => setLonInput(event.target.value)} />
        </label>
        <button type="button" disabled={disabled || !latInput.trim() || !lonInput.trim()} onClick={applyCoordinates}>使用手动坐标作为新站草案</button>
        <label>时间（新站草案，含时区；未知可留空）
          <input type="text" disabled={disabled || group.destination !== "new"} value={timeInput} placeholder="2026-11-03T14:00:00+08:00"
            onChange={(event) => setTimeInput(event.target.value)} />
        </label>
        <button type="button" disabled={disabled || group.destination !== "new"} onClick={() => onEdit({ type: "retime", id: group.id, value: timeInput })}>确认时间</button>
      </div>
      <div className="route-batch__group-footer">
        <span>文件编号：{group.fileIndexes.map((idx) => idx + 1).join("、")}</span>
        {group.fileIndexes.length > 1 ? <button type="button" disabled={disabled}
          onClick={() => onEdit({ type: "split", id: group.id, fileIndex: group.fileIndexes.at(-1)! })}>拆出最后一个媒体</button> : null}
        {index < total - 1 ? (
          <>
            <label>合并目标
              <select value={mergeId} disabled={disabled} onChange={(event) => setMergeId(event.target.value)}>
                <option value="">选择要并入的分组</option>
                {mergeTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
            </label>
            <button type="button" disabled={disabled || !mergeId}
              onClick={() => onEdit({ type: "merge", id: group.id, otherId: mergeId })}>确认合并</button>
          </>
        ) : null}
      </div>
    </li>
  );
}

export function RoutePointBatchReview({
  draft, journey, disabled = false, message = null, onEdit, onConfirm, onCancel,
}: {
  draft: RoutePointBatchDraft;
  journey: Journey;
  disabled?: boolean;
  message?: string | null;
  onEdit: (action: RoutePointReviewAction) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const autoReady = canAutoOrganizeRoutePointBatch(draft);
  const unresolved = draft.groups.filter((group) =>
    group.destination === "new" && (!group.label.trim() || group.latitude === null || group.longitude === null));
  const valid = unresolved.length === 0 && draft.scope.routeRevision === journey.revision;
  return (
    <section aria-label="批量媒体途径点草案审阅" className="route-batch">
      <header className="route-batch__header">
        <p className="route-batch__eyebrow">BATCH · ROUTE POINTS</p>
        <h3>先确认照片要去哪里</h3>
        <p>草案尚未创建途径点。只有确认后才保存；手动调整不会被重新分析覆盖。</p>
      </header>
      <ol className="route-batch__groups">
        {draft.groups.map((group, index) => <GroupEditor
          key={group.id} group={group} journey={journey} index={index} total={draft.groups.length}
          disabled={disabled}
          mergeTargets={draft.groups.filter((candidate) => candidate.id !== group.id).map((candidate) => ({ id: candidate.id, label: candidate.label }))}
          onEdit={(action) => {
            try { setError(null); onEdit(action); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "更改无效"); }
          }}
        />)}
      </ol>
      <label className="route-batch__opt">
        <input type="checkbox" checked={draft.autoOrganize} disabled={disabled}
          onChange={(event) => onEdit({ type: "auto-organize", enabled: event.target.checked })} />
        仅本批允许自动整理
      </label>
      <p className="route-batch__fine-print">
        {draft.autoOrganize
          ? autoReady ? "仅有完整、无冲突的高把握分组可自动提交。"
            : "本批存在未归属、手动调整或不确定位置，仍需逐组审阅并手动确认。"
          : "默认不自动整理；每组均由你审阅后确认。"}
      </p>
      {!valid ? <p role="alert">Journey 已修改或仍有不完整的新站草案，请重新核对。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="route-batch__actions">
        <button type="button" disabled={disabled || !valid} onClick={onConfirm}>
          {autoReady ? "按本批授权确认并整理" : "确认这些分组并上传"}
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>取消草案</button>
      </div>
    </section>
  );
}
