import type { ChangeEvent } from "react";
import type { RoutePoint } from "./types";

export type StoryNotesSaveState = "idle" | "saving" | "saved" | "error";

export type StoryNotesEditorProps = {
  journeyNote: string;
  selectedRoutePoint: Pick<RoutePoint, "id" | "label"> | null;
  selectedRoutePointNote: string;
  removedRoutePointDrafts: ReadonlyArray<{ id: string; label: string; note: string }>;
  saving: boolean;
  saveState: StoryNotesSaveState;
  message: string;
  dirty: boolean;
  onJourneyNoteChange: (value: string) => void;
  onRoutePointNoteChange: (routePointId: string, value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onDiscardRoutePointDraft: (routePointId: string) => void;
};

function stopInputEvent(event: ChangeEvent<HTMLTextAreaElement>) {
  event.stopPropagation();
}

export function StoryNotesEditor({
  journeyNote,
  selectedRoutePoint,
  selectedRoutePointNote,
  removedRoutePointDrafts,
  saving,
  saveState,
  message,
  dirty,
  onJourneyNoteChange,
  onRoutePointNoteChange,
  onSave,
  onDiscard,
  onDiscardRoutePointDraft,
}: StoryNotesEditorProps) {
  return (
    <section className="story-notes-editor" aria-label="编辑旅程感想">
      <div className="story-notes-editor__intro">
        <h3>旅程感想</h3>
      </div>

      <label className="story-notes-editor__field">
        <span>整段旅程</span>
        <textarea
          value={journeyNote}
          maxLength={2000}
          disabled={saving}
          aria-label="旅程感想"
          onChange={(event) => {
            stopInputEvent(event);
            onJourneyNoteChange(event.target.value);
          }}
        />
        <small>{journeyNote.length} / 2000</small>
      </label>

      {selectedRoutePoint ? (
        <label className="story-notes-editor__field">
          <span>地点 · {selectedRoutePoint.label || "未命名地点"}</span>
          <textarea
            value={selectedRoutePointNote}
            maxLength={500}
            disabled={saving}
            aria-label={`${selectedRoutePoint.label || "当前地点"}感想`}
            onChange={(event) => {
              stopInputEvent(event);
              onRoutePointNoteChange(selectedRoutePoint.id, event.target.value);
            }}
          />
          <small>{selectedRoutePointNote.length} / 500</small>
        </label>
      ) : null}

      {removedRoutePointDrafts.map((draft) => (
        <div key={draft.id} className="story-notes-editor__field">
          <label className="story-notes-editor__field">
            <span>{draft.label} · 地点已删除，草稿保留</span>
            <textarea value={draft.note} readOnly aria-label={`${draft.label}已删除地点的感想草稿`} />
          </label>
          <div className="story-notes-editor__actions">
            <button type="button" disabled={saving} onClick={() => onDiscardRoutePointDraft(draft.id)}>
              放弃此地点草稿
            </button>
          </div>
        </div>
      ))}

      {message ? (
        <p className={`story-notes-editor__message is-${saveState}`} role={saveState === "error" ? "alert" : "status"}>
          {message}
        </p>
      ) : null}

      <div className="story-notes-editor__actions">
        <button type="button" className="story-notes-editor__discard" disabled={saving || !dirty} onClick={onDiscard}>
          放弃更改
        </button>
        <button type="button" className="story-notes-editor__save" disabled={saving || !dirty || removedRoutePointDrafts.length > 0} onClick={onSave}>
          {saving ? "正在保存…" : "保存感想"}
        </button>
      </div>
    </section>
  );
}
