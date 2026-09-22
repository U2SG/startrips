import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  importJourneyRecordedTrack,
  JourneyRecordedTrackApiError,
  listJourneyRecordedTracks,
  withdrawJourneyRecordedTrack,
  type JourneyRecordedTrackSummary,
} from "./journeyRecordedTracksApi";

const RECORDED_TRACK_FILE_ACCEPT = ".gpx,application/gpx+xml,application/xml,text/xml";

type SelectedTrackFile = {
  file: File;
  document: string;
};

export type JourneyRecordedTrackRequestScope = {
  journeyId: string | null;
  revision: number;
};

export function isJourneyRecordedTrackRequestCurrent(
  request: JourneyRecordedTrackRequestScope,
  active: JourneyRecordedTrackRequestScope,
) {
  return request.journeyId !== null
    && request.journeyId === active.journeyId
    && request.revision === active.revision;
}

export function journeyRecordedTrackErrorMessage(error: unknown, action: "load" | "import" | "withdraw") {
  if (!(error instanceof JourneyRecordedTrackApiError)) {
    return action === "import"
      ? "这次导入的结果暂时无法确认。文件仍保留在这里；网络恢复后可安全重试，相同文件不会生成第二份记录。"
      : action === "withdraw"
        ? "暂时无法确认是否已经撤回。请重新打开这段 Journey 核对后再操作。"
        : "暂时无法读取已保存的轨迹记录。";
  }
  switch (error.code) {
    case "UNSUPPORTED_FORMAT":
      return "这份 GPX 暂不受支持；仅含航点（wpt）或路线（rte）的文件目前不会被当作记录轨迹导入。";
    case "MALFORMED_FILE":
    case "INVALID_IMPORT_REQUEST":
      return "这份 GPX 无法完整读取。请检查文件是否损坏，再重新选择。";
    case "UNSAFE_DOCUMENT":
      return "这份 GPX 引用了外部内容，为保护隐私没有导入。";
    case "FILE_TOO_LARGE":
    case "REQUEST_TOO_LARGE":
      return "这份 GPX 超过当前导入大小限制。请选择更小的记录文件。";
    case "TOO_MANY_POINTS":
    case "TOO_MANY_SEGMENTS":
      return "这份 GPX 的记录量超过当前单次导入范围。请按原始记录边界拆分后再试。";
    case "RECORDED_TRACK_CONFLICT":
      return "服务器发现同一份记录与已有证据冲突；现有记录没有被覆盖。";
    case "JOURNEY_NOT_FOUND":
    case "RECORDED_TRACK_NOT_FOUND":
      return action === "withdraw"
        ? "这份记录已不存在，或你已失去这段 Journey 的编辑权限。重新打开 Journey 后再核对。"
        : "这段 Journey 已不存在，或你已失去访问权限。没有写入任何新的轨迹记录。";
    default:
      if (error.status === 401 || error.status === 403) {
        return "当前会话没有管理这段 Journey 记录轨迹的权限。";
      }
      return error.message || "轨迹记录操作失败，请稍后再试。";
  }
}

function formatCoverage(track: JourneyRecordedTrackSummary) {
  if (!track.startedAt && !track.endedAt) return "没有可用的时间范围";
  const format = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };
  if (track.startedAt && track.endedAt && track.startedAt !== track.endedAt) {
    return `${format(track.startedAt)} — ${format(track.endedAt)}`;
  }
  return format(track.startedAt ?? track.endedAt!);
}

function provenanceLabel(track: JourneyRecordedTrackSummary) {
  if (track.source === "imported-file" && track.provenance === "gpx") return "GPX 文件导入";
  return track.provenance ? `${track.source} · ${track.provenance}` : track.source;
}

export function JourneyRecordedTracks({ journeyId }: { journeyId: string }) {
  const [tracks, setTracks] = useState<JourneyRecordedTrackSummary[]>([]);
  const [selected, setSelected] = useState<SelectedTrackFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [readingFile, setReadingFile] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [withdrawPending, setWithdrawPending] = useState(false);
  const [confirmWithdrawal, setConfirmWithdrawal] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const activeScopeRef = useRef<JourneyRecordedTrackRequestScope>({ journeyId, revision: 0 });
  const fileReadRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const fileInputRef = useRef<HTMLInputElement>(null);

  function abortRequests() {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }

  function requestController() {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  }

  function scopeIsCurrent(scope: JourneyRecordedTrackRequestScope) {
    return isJourneyRecordedTrackRequestCurrent(scope, activeScopeRef.current);
  }

  async function refreshTracks(scope: JourneyRecordedTrackRequestScope, preserveMessage = false) {
    if (!scope.journeyId) return false;
    const controller = requestController();
    setLoading(true);
    try {
      const next = await listJourneyRecordedTracks(scope.journeyId, { signal: controller.signal });
      if (!scopeIsCurrent(scope)) return false;
      setTracks(next);
      if (!preserveMessage) setMessage("");
      return true;
    } catch (error) {
      if (controller.signal.aborted || !scopeIsCurrent(scope)) return false;
      setMessage(journeyRecordedTrackErrorMessage(error, "load"));
      return false;
    } finally {
      controllersRef.current.delete(controller);
      if (scopeIsCurrent(scope)) setLoading(false);
    }
  }

  useEffect(() => {
    const scope = {
      journeyId,
      revision: activeScopeRef.current.revision + 1,
    } satisfies JourneyRecordedTrackRequestScope;
    activeScopeRef.current = scope;
    fileReadRef.current += 1;
    abortRequests();
    setTracks([]);
    setSelected(null);
    setConfirmWithdrawal(null);
    setMessage("");
    setImportPending(false);
    setWithdrawPending(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    void refreshTracks(scope);
    return () => {
      if (scopeIsCurrent(scope)) {
        activeScopeRef.current = { journeyId: null, revision: scope.revision + 1 };
      }
      fileReadRef.current += 1;
      abortRequests();
    };
  }, [journeyId]);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    const readRevision = fileReadRef.current + 1;
    fileReadRef.current = readRevision;
    setSelected(null);
    setConfirmWithdrawal(null);
    setMessage("");
    if (!file) return;
    setReadingFile(true);
    try {
      const document = await file.text();
      if (fileReadRef.current !== readRevision) return;
      if (!document.trim()) {
        setMessage("这个文件是空的，没有提交到服务器。");
        return;
      }
      setSelected({ file, document });
    } catch {
      if (fileReadRef.current === readRevision) setMessage("无法读取这个本地文件，请重新选择。");
    } finally {
      if (fileReadRef.current === readRevision) setReadingFile(false);
    }
  }

  async function importSelected() {
    if (!selected || importPending || withdrawPending) return;
    const scope = activeScopeRef.current;
    if (!scope.journeyId) return;
    const controller = requestController();
    setImportPending(true);
    setConfirmWithdrawal(null);
    setMessage("");
    try {
      const result = await importJourneyRecordedTrack(scope.journeyId, selected.document, {
        signal: controller.signal,
      });
      if (!scopeIsCurrent(scope)) return;
      const confirmed = result.replayed
        ? "服务器确认这份文件与已有记录相同；没有创建第二份记录。"
        : "记录轨迹已导入。";
      setMessage(confirmed);
      const reconciled = await refreshTracks(scope, true);
      if (!scopeIsCurrent(scope)) return;
      if (!reconciled) {
        setMessage(`${confirmed} 但当前无法重新读取列表；重新打开 Journey 后会从服务器恢复。`);
        return;
      }
      setSelected(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      if (controller.signal.aborted || !scopeIsCurrent(scope)) return;
      setMessage(journeyRecordedTrackErrorMessage(error, "import"));
      // On transport uncertainty the selected File/document deliberately stays
      // in memory. A retry resends the exact bytes and relies on the server's
      // content-derived operation key instead of guessing whether the first
      // request committed.
    } finally {
      controllersRef.current.delete(controller);
      if (scopeIsCurrent(scope)) setImportPending(false);
    }
  }

  async function confirmWithdraw(operationKey: string) {
    if (withdrawPending || importPending) return;
    const scope = activeScopeRef.current;
    if (!scope.journeyId) return;
    const controller = requestController();
    setWithdrawPending(true);
    setMessage("");
    try {
      await withdrawJourneyRecordedTrack(scope.journeyId, operationKey, { signal: controller.signal });
      if (!scopeIsCurrent(scope)) return;
      setConfirmWithdrawal(null);
      setTracks((current) => current.filter((track) => track.operationKey !== operationKey));
      setMessage("这份记录轨迹已撤回；Route Point 和媒体没有被修改。 ");
    } catch (error) {
      if (controller.signal.aborted || !scopeIsCurrent(scope)) return;
      setMessage(journeyRecordedTrackErrorMessage(error, "withdraw"));
    } finally {
      controllersRef.current.delete(controller);
      if (scopeIsCurrent(scope)) setWithdrawPending(false);
    }
  }

  return (
    <section className="journey-recorded-tracks" aria-labelledby="journey-recorded-tracks-title">
      <div className="journey-recorded-tracks__heading">
        <div>
          <small>RECORDED TRACE</small>
          <h4 id="journey-recorded-tracks-title">记录轨迹</h4>
        </div>
        <p>导入你已有的 GPX 记录。它只作为这段 Journey 的私密记录，不会自动生成 Route Point。</p>
      </div>

      <div className="journey-recorded-tracks__import">
        <label>
          <span>选择 GPX 文件</span>
          <input
            ref={fileInputRef}
            type="file"
            accept={RECORDED_TRACK_FILE_ACCEPT}
            onChange={chooseFile}
            disabled={importPending || withdrawPending}
          />
        </label>
        {selected ? (
          <div className="journey-recorded-tracks__selection" role="status">
            <span>{selected.file.name}</span>
            <small>{Math.max(1, Math.ceil(selected.file.size / 1024))} KB · 文件只在当前编辑会话中保留</small>
          </div>
        ) : null}
        <button
          type="button"
          className="journey-recorded-tracks__import-button"
          disabled={!selected || readingFile || importPending || withdrawPending}
          onClick={importSelected}
        >
          {readingFile ? "正在读取…" : importPending ? "正在导入…" : "导入这份 GPX"}
        </button>
      </div>

      <div className="journey-recorded-tracks__list" aria-busy={loading || undefined}>
        <div className="journey-recorded-tracks__list-heading">
          <strong>已保存的记录</strong>
          <span>{loading ? "读取中…" : `${tracks.length} 份`}</span>
        </div>
        {!loading && tracks.length === 0 ? <p className="journey-recorded-tracks__empty">还没有记录轨迹。</p> : null}
        {tracks.length > 0 ? (
          <ul>
            {tracks.map((track, index) => (
              <li key={track.operationKey}>
                <div className="journey-recorded-tracks__summary">
                  <strong>记录 {String(index + 1).padStart(2, "0")}</strong>
                  <span>{provenanceLabel(track)}</span>
                  <small>{track.segmentCount} 段 · {track.sampleCount} 个采样点</small>
                  <small>{formatCoverage(track)}</small>
                </div>
                {confirmWithdrawal === track.operationKey ? (
                  <div className="journey-recorded-tracks__confirm" role="alertdialog" aria-label={`确认撤回记录 ${index + 1}`}>
                    <p>只撤回这份记录轨迹；不会删除 Route Point、照片或视频。</p>
                    <div>
                      <button type="button" disabled={withdrawPending} onClick={() => setConfirmWithdrawal(null)}>取消</button>
                      <button
                        type="button"
                        className="is-destructive"
                        disabled={withdrawPending}
                        onClick={() => void confirmWithdraw(track.operationKey)}
                      >
                        {withdrawPending ? "正在撤回…" : "确认撤回"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="journey-recorded-tracks__withdraw"
                    disabled={importPending || withdrawPending}
                    onClick={() => setConfirmWithdrawal(track.operationKey)}
                  >
                    撤回此记录
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {message ? <p className="journey-recorded-tracks__message" role="status">{message}</p> : null}
    </section>
  );
}
