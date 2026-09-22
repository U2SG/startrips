import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH,
  MAX_EVERYDAY_FRAGMENT_PLACE_LABEL_LENGTH,
  type EverydayFragment,
  type EverydayFragmentValues,
} from "./everydayFragment";
import { JourneyApiError, type EverydayFragmentClient } from "./journeyApi";

const REASONS: Record<string, string> = {
  EVERYDAY_FRAGMENT_INVALID_DATE: "请填写有效的日期。",
  EVERYDAY_FRAGMENT_INVALID_LATITUDE: "纬度应在 -90 到 90 之间。",
  EVERYDAY_FRAGMENT_INVALID_LONGITUDE: "经度应在 -180 到 180 之间。",
  EVERYDAY_FRAGMENT_INVALID_TEXT: "地点和随记请填写文字。",
  EVERYDAY_FRAGMENT_TEXT_TOO_LONG: "地点或随记太长，请缩短后重试。",
  EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD: "常住地关联无效，请关闭日常后重新打开。",
  EVERYDAY_FRAGMENT_HOME_BASE_MISMATCH: "日期不在原常住地阶段内，请检查日期后重试。",
  EVERYDAY_FRAGMENT_NOT_FOUND: "这条日常已不存在，请关闭日常后重新打开。",
  HOME_BASE_PERIOD_NOT_FOUND: "原常住地阶段已不存在，请关闭日常后重新打开。",
};

function errorMessage(error: unknown): string {
  if (error instanceof JourneyApiError) {
    if (REASONS[error.code]) return REASONS[error.code];
    if (error.status === 400) return "内容未能保存，请检查填写内容后重试。";
    if (error.status === 401 || error.status === 403) return "当前无法访问日常，请确认登录状态和图谱权限。";
  }
  return "请求未完成，请重试。";
}

/** Each mounted form/row owns its writes. Late responses never reach a new
 * editor or a reopened Home context. Writes on other rows remain independent. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<object | null>(null);
  const lifetime = useRef<object | null>(null);
  useEffect(() => {
    lifetime.current = {};
    return () => { lifetime.current = null; active.current = null; };
  }, []);
  async function run<T>(request: () => Promise<T>, commit: (value: T) => void) {
    if (active.current) return;
    const token = {};
    const owner = lifetime.current;
    active.current = token;
    setPending(true);
    setError(null);
    const current = () => lifetime.current === owner && owner !== null && active.current === token;
    try {
      const value = await request();
      if (current()) commit(value);
    } catch (failure) {
      if (current()) setError(errorMessage(failure));
    } finally {
      if (current()) { active.current = null; setPending(false); }
    }
  }
  return { pending, error, run };
}

function FragmentForm({ fragment, save, onSaved, onCancel }: {
  fragment?: EverydayFragment;
  save: (values: EverydayFragmentValues) => Promise<EverydayFragment>;
  onSaved: (fragment: EverydayFragment) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(fragment?.occurredOn ?? "");
  const [latitude, setLatitude] = useState(fragment ? String(fragment.latitude) : "");
  const [longitude, setLongitude] = useState(fragment ? String(fragment.longitude) : "");
  const [place, setPlace] = useState(fragment?.placeLabel ?? "");
  const [note, setNote] = useState(fragment?.note ?? "");
  const action = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(() => save({
      occurredOn: date,
      latitude: Number(latitude),
      longitude: Number(longitude),
      placeLabel: place.trim() || null,
      note: note.trim() || null,
      // Home context is presentation only. Never infer ownership from it.
      homeBasePeriodId: fragment?.homeBasePeriodId ?? null,
    }), onSaved);
  }
  return (
    <form className="everyday-fragments__form" onSubmit={submit} aria-label={fragment ? "编辑日常" : "记录日常"} aria-busy={action.pending}>
      <fieldset disabled={action.pending}>
        <legend>{fragment ? "编辑日常" : "记录日常"}</legend>
        <label>日期<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <div className="everyday-fragments__coordinates">
          <label>纬度<input type="number" required min={-90} max={90} step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label>
          <label>经度<input type="number" required min={-180} max={180} step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label>
        </div>
        <label>地点（选填）<input maxLength={MAX_EVERYDAY_FRAGMENT_PLACE_LABEL_LENGTH} value={place} onChange={(event) => setPlace(event.target.value)} /></label>
        <label>随记（选填）<textarea rows={3} maxLength={MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <div className="everyday-fragments__actions">
          <button type="submit">{action.pending ? "保存中…" : "保存日常"}</button>
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      </fieldset>
      {action.error ? <p role="alert">{action.error}</p> : null}
    </form>
  );
}

function FragmentRow({ fragment, client, canEdit, onSaved, onDeleted }: {
  fragment: EverydayFragment;
  client: EverydayFragmentClient;
  canEdit: boolean;
  onSaved: (fragment: EverydayFragment) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletion = useAction();
  return (
    <li data-everyday-fragment-id={fragment.id}>
      {editing ? (
        <FragmentForm fragment={fragment} save={(values) => client.update(fragment.id, values)}
          onSaved={(saved) => { onSaved(saved); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <time dateTime={fragment.occurredOn}>{fragment.occurredOn}</time>
          <p>{fragment.placeLabel || `${fragment.latitude.toFixed(5)}, ${fragment.longitude.toFixed(5)}`}</p>
          {fragment.note ? <p className="everyday-fragments__note">{fragment.note}</p> : null}
          {canEdit ? (
            <div className="everyday-fragments__actions" aria-busy={deletion.pending}>
              {confirmDelete ? <>
                <span>删除这条日常？</span>
                <button type="button" disabled={deletion.pending} onClick={() => void deletion.run(() => client.remove(fragment.id), () => onDeleted(fragment.id))}>
                  {deletion.pending ? "删除中…" : "确认删除"}
                </button>
                <button type="button" disabled={deletion.pending} onClick={() => setConfirmDelete(false)}>取消</button>
              </> : <>
                <button type="button" onClick={() => setEditing(true)}>编辑</button>
                <button type="button" onClick={() => setConfirmDelete(true)}>删除</button>
              </>}
            </div>
          ) : null}
          {deletion.error ? <p role="alert">{deletion.error}</p> : null}
        </>
      )}
    </li>
  );
}

function FragmentList({ client, canCreate, canEdit, startCreating }: {
  client: EverydayFragmentClient;
  canCreate: boolean;
  canEdit: boolean;
  startCreating: boolean;
}) {
  const [fragments, setFragments] = useState<EverydayFragment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(startCreating);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.list(controller.signal).then((rows) => {
      if (!controller.signal.aborted) setFragments(rows);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [client, attempt]);

  // Mutations mount only after the initial read succeeds, so an older GET can
  // never overwrite a successful write. There is no Journey refresh here.
  function saved(fragment: EverydayFragment) {
    setFragments((rows) => [...rows.filter((row) => row.id !== fragment.id), fragment]);
  }
  return (
    <div id="everyday-fragments-list" aria-busy={loading}>
      {loading ? <p role="status">正在读取日常…</p> : error ? <>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
      </> : <>
        <p>所有日常 · {fragments.length} 条</p>
        {canCreate && (creating ? (
          <FragmentForm save={(values) => client.create(values)} onSaved={(fragment) => { saved(fragment); setCreating(false); }} onCancel={() => setCreating(false)} />
        ) : <button type="button" onClick={() => setCreating(true)}>记录日常</button>)}
        {fragments.length === 0 ? <p>还没有日常，记下某一天、某个地方。</p> : null}
        <ul>
          {[...fragments].sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || a.id.localeCompare(b.id)).map((fragment) => (
            <FragmentRow key={fragment.id} fragment={fragment} client={client} canEdit={canEdit} onSaved={saved}
              onDeleted={(id) => setFragments((rows) => rows.filter((row) => row.id !== id))} />
          ))}
        </ul>
      </>}
    </div>
  );
}

/** #463: a disclosure inside #233's Home context, with no geographic or
 * Journey state input. Closing/switching Home unmounts its request owners. */
export function EverydayFragments({ client, canCreate, canEdit }: {
  client: EverydayFragmentClient;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [mode, setMode] = useState<"list" | "create" | null>(null);
  return (
    <section className="everyday-fragments" aria-label="日常" data-everyday-fragments>
      <div className="everyday-fragments__actions">
        <button type="button" aria-expanded={mode !== null} aria-controls={mode ? "everyday-fragments-list" : undefined}
          onClick={() => setMode((current) => current ? null : "list")}>日常</button>
        {mode === null && canCreate ? <button type="button" onClick={() => setMode("create")}>记录日常</button> : null}
      </div>
      {mode ? <FragmentList client={client} canCreate={canCreate} canEdit={canEdit} startCreating={mode === "create"} /> : null}
    </section>
  );
}
