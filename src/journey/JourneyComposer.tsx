import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { uploadMediaInParts } from "../api/multipartUpload";
import { createJourney, searchLocations, updateJourney } from "./journeyApi";
import {
  MAX_JOURNEY_FILES,
  validateJourneyFiles,
  validateJourneyInput,
} from "./journeyModel";
import {
  appendRoutePoint,
  moveRoutePoint,
  removeRoutePoint,
  routeDraftToInput,
  toggleRouteStop,
  updateRoutePoint,
  type RouteDraftPoint,
} from "./routeDraft";
import type {
  Journey,
  JourneyInput,
  JourneyRoute,
  LocationSearchResponse,
  LocationSearchResult,
} from "./types";
import { useModalFocus } from "./useModalFocus";

const LIGHT_COLORS = ["#f4ce73", "#e99578", "#77c8c2", "#8ca8df", "#c49bd8"];

type UploadProgress = {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
};

export type JourneySaveResult = {
  journey: Journey;
  uploadedCount: number;
  mediaErrors: Array<{ fileIndex: number; fileName: string; message: string }>;
};

type JourneyMediaUploadResult = Pick<
  JourneySaveResult,
  "uploadedCount" | "mediaErrors"
>;

type UploadJourneyMediaOptions = {
  journeyId: string;
  routePointId?: string;
  files: readonly File[];
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
};

type PersistJourneyDraftOptions = {
  input: JourneyInput;
  files: readonly File[];
  persist?: (input: JourneyInput) => Promise<Journey>;
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
};

export async function uploadJourneyMedia({
  journeyId,
  routePointId,
  files,
  upload = uploadMediaInParts,
  onProgress,
}: UploadJourneyMediaOptions): Promise<JourneyMediaUploadResult> {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const mediaErrors: JourneySaveResult["mediaErrors"] = [];
  let uploadedCount = 0;
  let completedBytes = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    try {
      await upload({
        file,
        fileName: file.name,
        journeyId,
        routePointId,
        concurrency: 2,
        onProgress: ({ uploadedBytes }) => onProgress?.({
          fileName: file.name,
          uploadedBytes: completedBytes + uploadedBytes,
          totalBytes,
        }),
      });
      uploadedCount += 1;
    } catch (error) {
      mediaErrors.push({
        fileIndex,
        fileName: file.name,
        message: error instanceof Error ? error.message : "上传失败",
      });
    } finally {
      completedBytes += file.size;
      onProgress?.({
        fileName: file.name,
        uploadedBytes: completedBytes,
        totalBytes,
      });
    }
  }

  return { uploadedCount, mediaErrors };
}

export async function persistJourneyDraft({
  input,
  files,
  persist = createJourney,
  upload = uploadMediaInParts,
  onProgress,
}: PersistJourneyDraftOptions): Promise<JourneySaveResult> {
  const journey = await persist(input);
  const mediaResult = await uploadJourneyMedia({
    journeyId: journey.id,
    files,
    upload,
    onProgress,
  });
  return { journey, ...mediaResult };
}

export type GlobePointPick = {
  latitude: number;
  longitude: number;
};

type JourneyComposerProps = {
  open: boolean;
  journey?: Journey | null;
  onClose: () => void;
  onSaved: (result: JourneySaveResult) => void | Promise<void>;
  onGlobePickRequest?: (accept: (point: GlobePointPick) => void) => void;
  onGlobePickCancel?: () => void;
  onRoutePreviewChange?: (route: JourneyRoute | null) => void;
};

function draftId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDraftPoint(
  latitude: number,
  longitude: number,
  label = "",
  isStop = false,
): RouteDraftPoint {
  return {
    draftId: draftId(),
    latitude,
    longitude,
    label,
    isStop,
    occurredAt: null,
  };
}

export function journeyToDraftPoints(journey: Journey): RouteDraftPoint[] {
  return journey.routePoints.map((point) => ({
    draftId: `saved-${point.id}`,
    id: point.id,
    latitude: point.latitude,
    longitude: point.longitude,
    label: point.label,
    isStop: point.isStop,
    occurredAt: point.occurredAt,
  }));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseCoordinateInput(
  value: string,
  minimum: number,
  maximum: number,
) {
  const normalized = value.trim();
  if (!normalized) return null;
  const coordinate = Number(normalized);
  return Number.isFinite(coordinate)
    && coordinate >= minimum
    && coordinate <= maximum
    ? coordinate
    : null;
}

export function JourneyComposer({
  open,
  journey,
  onClose,
  onSaved,
  onGlobePickRequest,
  onGlobePickCancel,
  onRoutePreviewChange,
}: JourneyComposerProps) {
  const [routePoints, setRoutePoints] = useState<RouteDraftPoint[]>(
    () => journey ? journeyToDraftPoints(journey) : [],
  );
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [pointLabel, setPointLabel] = useState("");
  const [pointIsStop, setPointIsStop] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationSearchResult[]>([]);
  const [searchAttribution, setSearchAttribution] = useState<
    LocationSearchResponse["attribution"]
  >(null);
  const [searchPending, setSearchPending] = useState(false);
  const [title, setTitle] = useState(journey?.title ?? "");
  const [startedOn, setStartedOn] = useState(
    () => journey?.startedOn ?? new Date().toISOString().slice(0, 10),
  );
  const [endedOn, setEndedOn] = useState(journey?.endedOn ?? "");
  const [note, setNote] = useState(journey?.note ?? "");
  const [lightColor, setLightColor] = useState(journey?.lightColor ?? LIGHT_COLORS[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [savedResult, setSavedResult] = useState<JourneySaveResult | null>(null);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [globePicking, setGlobePicking] = useState(false);
  const dialogRef = useModalFocus<HTMLElement>(() => {
    if (!saving) closeComposer();
  }, !globePicking);

  const input = useMemo<JourneyInput>(() => ({
    title: title.trim(),
    startedOn,
    endedOn: endedOn || null,
    note: note.trim(),
    lightColor,
    revision: journey?.revision,
    routePoints: routeDraftToInput(routePoints),
  }), [endedOn, journey?.revision, lightColor, note, routePoints, startedOn, title]);

  useEffect(() => {
    onRoutePreviewChange?.(routePoints.length === 0 ? null : {
      id: journey?.id ?? "draft-route-preview",
      color: lightColor,
      points: routePoints.map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
        isStop: point.isStop,
        label: point.label,
      })),
    });
  }, [journey?.id, lightColor, onRoutePreviewChange, routePoints]);

  useEffect(() => {
    if (!globePicking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setGlobePicking(false);
      setMessage("");
      onGlobePickCancel?.();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [globePicking, onGlobePickCancel]);

  if (!open) return null;

  function addPoint(point: RouteDraftPoint) {
    setRoutePoints((current) => appendRoutePoint(current, point));
    setMessage("");
  }

  function addManualPoint() {
    const parsedLatitude = parseCoordinateInput(latitude, -90, 90);
    const parsedLongitude = parseCoordinateInput(longitude, -180, 180);
    if (parsedLatitude === null || parsedLongitude === null) {
      setMessage("请填写有效的纬度（-90 到 90）和经度（-180 到 180）；也可以使用上方搜索直接选择地点。");
      return;
    }
    if (pointIsStop && !pointLabel.trim()) {
      setMessage("停靠点需要一个地点名称。");
      return;
    }
    addPoint(toDraftPoint(
      parsedLatitude,
      parsedLongitude,
      pointLabel.trim(),
      pointIsStop,
    ));
    setLatitude("");
    setLongitude("");
    setPointLabel("");
    setPointIsStop(false);
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) {
      setMessage("至少输入两个字符再搜索。");
      return;
    }
    setSearchPending(true);
    setMessage("");
    try {
      const response = await searchLocations(query);
      setSearchResults(response.results);
      setSearchAttribution(response.attribution);
    } catch (error) {
      setSearchResults([]);
      setSearchAttribution(null);
      setMessage(error instanceof Error ? error.message : "地点搜索暂时不可用");
    } finally {
      setSearchPending(false);
    }
  }

  function chooseSearchResult(result: LocationSearchResult) {
    addPoint(toDraftPoint(
      result.latitude,
      result.longitude,
      result.label,
      true,
    ));
    setSearchResults([]);
    setSearchQuery("");
  }

  function requestGlobePoint() {
    if (!onGlobePickRequest) return;
    setGlobePicking(true);
    setMessage("请在地球上点击一个位置。");
    onGlobePickRequest((point) => {
      setGlobePicking(false);
      addPoint(toDraftPoint(
        point.latitude,
        point.longitude,
        "",
        routePoints.length === 0,
      ));
      setMessage("已从地球添加地点；首个地点会默认标记为停留，可继续补充精确名称。");
    });
  }

  function cancelGlobePoint() {
    setGlobePicking(false);
    setMessage("");
    onGlobePickCancel?.();
  }

  function closeComposer() {
    if (globePicking) onGlobePickCancel?.();
    onRoutePreviewChange?.(null);
    onClose();
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    const next = [...files, ...selected];
    const validation = validateJourneyFiles(next);
    if (!validation.accepted) {
      setMessage(validation.errors[0]);
    } else {
      setFiles(next);
      setMessage("");
    }
    event.currentTarget.value = "";
  }

  async function save() {
    const validation = validateJourneyInput(input);
    const mediaValidation = validateJourneyFiles(files);
    const error = validation.errors[0] ?? mediaValidation.errors[0];
    if (error) {
      setMessage(error);
      return;
    }
    setSaving(true);
    setMessage("");
    setProgress(null);
    try {
      const result = await persistJourneyDraft({
        input,
        files,
        persist: journey
          ? (nextInput) => updateJourney(journey.id, nextInput)
          : createJourney,
        onProgress: setProgress,
      });
      setSavedResult(result);
      setRetryFiles(result.mediaErrors.map((error) => files[error.fileIndex]));
      await onSaved(result);
      if (result.mediaErrors.length === 0) closeComposer();
    } catch (errorValue) {
      setMessage(errorValue instanceof Error ? errorValue.message : "旅程保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function retryFailedMedia() {
    if (!savedResult || retryFiles.length === 0) return;
    setSaving(true);
    setMessage("");
    setProgress(null);
    try {
      const retried = await uploadJourneyMedia({
        journeyId: savedResult.journey.id,
        files: retryFiles,
        onProgress: setProgress,
      });
      const nextResult: JourneySaveResult = {
        journey: savedResult.journey,
        uploadedCount: savedResult.uploadedCount + retried.uploadedCount,
        mediaErrors: retried.mediaErrors,
      };
      setSavedResult(nextResult);
      setRetryFiles(retried.mediaErrors.map((error) => retryFiles[error.fileIndex]));
      await onSaved(nextResult);
    } catch (errorValue) {
      setMessage(errorValue instanceof Error ? errorValue.message : "媒体重试失败");
    } finally {
      setSaving(false);
    }
  }

  const progressPercent = progress && progress.totalBytes > 0
    ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100)
    : 0;
  const isEditing = Boolean(journey);
  const editorLocked = saving || savedResult !== null;

  return (
    <div className={`journey-composer-backdrop${globePicking ? " is-globe-picking" : ""}`} role="presentation">
      {globePicking ? (
        <aside className="journey-globe-pick-hint" role="status">
          <IconMapPin size={18} stroke={1.4} aria-hidden="true" />
          <div><strong>在地球上选择路线点</strong><span>点击球面；路线会按添加顺序连接。</span></div>
          <button type="button" onClick={cancelGlobePoint}><IconX size={18} stroke={1.4} aria-hidden="true" /><span>取消</span></button>
        </aside>
      ) : null}
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="journey-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="journey-composer-title"
      >
        <header className="journey-composer__header">
          <div>
            <p>PRIVATE ATLAS · {isEditing ? "EDIT JOURNEY" : "NEW JOURNEY"}</p>
            <h2 id="journey-composer-title">{isEditing ? "重新整理这段旅程" : "把一段旅程，收进你的星球"}</h2>
            <span>{isEditing ? "调整故事、日期和路线；已有媒体会原样保留。" : "一次停留、跨城路径，或一直在路上。"}</span>
          </div>
          <button type="button" onClick={closeComposer} disabled={saving} aria-label={isEditing ? "关闭旅程编辑器" : "关闭创建器"}><IconX size={20} stroke={1.35} aria-hidden="true" /></button>
        </header>

        <div className="journey-composer__body">
          <div
            className="journey-composer__editor"
            aria-disabled={editorLocked}
            inert={editorLocked}
          >
            <section className="journey-composer__narrative" aria-labelledby="journey-story-heading">
              <div className="journey-composer__section-heading">
                <p>01 · MEMORY</p>
                <h3>照片与影像</h3>
                <span>可选，旅程会先保存，媒体按文件分块上传。</span>
              </div>
              <div className="journey-media-fields">
                <label className="journey-media-picker">
                  <IconUpload size={26} stroke={1.2} aria-hidden="true" />
                  <span>添加照片或视频</span>
                  <strong>{journey?.media.length ? `${journey.media.length} 个已有媒体 · 继续添加` : `最多 ${MAX_JOURNEY_FILES} 个文件`}</strong>
                  <input type="file" accept="image/avif,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple onChange={selectFiles} />
                </label>
                <ul>
                  {files.map((file, index) => (
                    <li key={`${file.name}-${file.lastModified}-${index}`}>
                      <span>{file.name}<small>{formatBytes(file.size)}</small></span>
                      <button type="button" onClick={() => setFiles((current) => current.filter((_, candidate) => candidate !== index))}>移除</button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="journey-composer__section-heading journey-composer__story-heading">
                <p>02 · JOURNEY</p>
                <h3 id="journey-story-heading">这段旅程</h3>
              </div>
              <div className="journey-story-fields">
                <label className="journey-title-field"><span>旅程标题</span><input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="穿过北方的夜车" /></label>
                <div className="journey-story-fields__dates">
                  <label><span>开始日期</span><input type="date" required value={startedOn} onChange={(event) => setStartedOn(event.target.value)} /></label>
                  <label><span>结束日期 <small>可选</small></span><input type="date" min={startedOn} value={endedOn} onChange={(event) => setEndedOn(event.target.value)} /></label>
                </div>
                <label><span>旅程故事 <small>可选</small></span><textarea rows={5} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记下沿途发生了什么，也可以留白。" /></label>
                <fieldset className="journey-light-colors">
                  <legend>这段旅程的光</legend>
                  {LIGHT_COLORS.map((color) => <button key={color} type="button" className={lightColor === color ? "is-selected" : ""} style={{ backgroundColor: color }} onClick={() => setLightColor(color)} aria-label={`选择颜色 ${color}`} aria-pressed={lightColor === color} />)}
                </fieldset>
              </div>
            </section>

            <section className="journey-composer__route" aria-labelledby="journey-route-heading">
              <div className="journey-composer__section-heading">
                <p>03 · TRACE</p>
                <h3 id="journey-route-heading">在地图上留下它</h3>
                <span>一个地点就是一次停留；继续添加会自然连成路径。</span>
              </div>

              <div className="journey-composer__route-tools">
                <form onSubmit={runSearch} className="journey-location-search">
                  <label>
                    <span>搜索地点、建筑或城市</span>
                    <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} maxLength={120} placeholder="建筑、景点、街道、街区或城市" />
                  </label>
                  <button type="submit" disabled={searchPending}><IconSearch size={16} stroke={1.4} aria-hidden="true" />{searchPending ? "搜索中…" : "搜索"}</button>
                </form>
                {searchResults.length > 0 ? (
                  <>
                    <ul className="journey-location-results">
                      {searchResults.map((result) => (
                        <li key={result.id}>
                          <button type="button" onClick={() => chooseSearchResult(result)}>
                            <strong>{result.label}</strong><span>{[result.context, result.countryCode].filter(Boolean).join(" · ")}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {searchAttribution ? (
                      <a className="journey-location-attribution" href={searchAttribution.url} target="_blank" rel="noreferrer">
                        地点数据 {searchAttribution.label}
                      </a>
                    ) : null}
                  </>
                ) : null}
                {onGlobePickRequest ? <button className="journey-globe-pick-button" type="button" onClick={requestGlobePoint}><IconMapPin size={17} stroke={1.35} aria-hidden="true" /><span><strong>直接在地球上取点</strong><small>适合在路上、海上或没有准确名称的位置</small></span></button> : null}
              </div>

              <ol className="journey-route-draft" aria-label="已添加的地点">
                {routePoints.length === 0 ? <li className="is-empty"><IconMapPin size={22} stroke={1.15} aria-hidden="true" /><span>还没有地点</span><small>先搜索一个地点，或直接在地球上取点。</small></li> : null}
                {routePoints.map((point, index) => (
                  <li key={point.draftId}>
                    <span className="journey-route-draft__index">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <input
                        aria-label={`地点 ${index + 1} 名称`}
                        maxLength={120}
                        placeholder="地点名称（可精确到建筑或景点）"
                        value={point.label}
                        onChange={(event) => setRoutePoints((current) => updateRoutePoint(current, point.draftId, { label: event.target.value }))}
                      />
                      <small>{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</small>
                    </div>
                    <label className="journey-checkbox"><input type="checkbox" checked={point.isStop} onChange={() => setRoutePoints((current) => toggleRouteStop(current, point.draftId))} />停靠</label>
                    <div className="journey-route-draft__actions">
                      <button type="button" disabled={index === 0} onClick={() => setRoutePoints((current) => moveRoutePoint(current, point.draftId, -1))} aria-label="向前移动"><IconArrowUp size={15} stroke={1.4} aria-hidden="true" /></button>
                      <button type="button" disabled={index === routePoints.length - 1} onClick={() => setRoutePoints((current) => moveRoutePoint(current, point.draftId, 1))} aria-label="向后移动"><IconArrowDown size={15} stroke={1.4} aria-hidden="true" /></button>
                      <button type="button" onClick={() => setRoutePoints((current) => removeRoutePoint(current, point.draftId))} aria-label="删除地点"><IconTrash size={15} stroke={1.4} aria-hidden="true" /></button>
                    </div>
                  </li>
                ))}
              </ol>

              <details className="journey-precise-location">
                <summary><span><IconMapPin size={17} stroke={1.35} aria-hidden="true" />精确位置</span><small>手动输入经纬度</small><IconChevronDown className="journey-precise-location__chevron" size={17} stroke={1.35} aria-hidden="true" /></summary>
                <div className="journey-coordinate-fields">
                  <label className="journey-coordinate-fields__label"><span>地点名称</span><input maxLength={120} value={pointLabel} onChange={(event) => setPointLabel(event.target.value)} placeholder="可精确到建筑、景点或沿途位置" /></label>
                  <label><span>纬度</span><input inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="31.2304" /></label>
                  <label><span>经度</span><input inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="121.4737" /></label>
                  <label className="journey-checkbox"><input type="checkbox" checked={pointIsStop} onChange={(event) => setPointIsStop(event.target.checked)} />这是一个停留地点</label>
                  <button type="button" onClick={addManualPoint}><IconPlus size={16} stroke={1.4} aria-hidden="true" />添加精确位置</button>
                </div>
              </details>
            </section>
          </div>
        </div>

        {progress || savedResult ? (
          <div className="journey-composer__save-status">
            {progress ? <div className="journey-upload-progress" aria-live="polite"><span>{progress.fileName}</span><progress max={100} value={progressPercent} /> <strong>{progressPercent}%</strong></div> : null}
            {savedResult?.mediaErrors.length ? (
              <div className="journey-save-partial" role="status">
                <h4>旅程已保存，部分媒体没有上传成功</h4>
                <p>成功 {savedResult.uploadedCount} 个，失败 {savedResult.mediaErrors.length} 个。路线和故事不会丢失。</p>
                <ul>{savedResult.mediaErrors.map((error) => <li key={`${error.fileIndex}-${error.fileName}`}><strong>{error.fileName}</strong>：{error.message}</li>)}</ul>
                <button type="button" onClick={retryFailedMedia} disabled={saving}>{saving ? "正在重试…" : "重试失败媒体"}</button>
              </div>
            ) : null}
            {savedResult && savedResult.mediaErrors.length === 0 && files.length > 0 ? (
              <div className="journey-save-complete" role="status">媒体已经全部上传完成，可以返回地球查看这段旅程。</div>
            ) : null}
          </div>
        ) : null}
        {message ? <p className="journey-composer__message" role="alert">{message}</p> : null}
        <footer className="journey-composer__footer">
          <div className="journey-composer__summary" aria-live="polite">
            <strong>{routePoints.length === 0 ? "还没有地点" : routePoints.length === 1 ? "1 个地点" : `${routePoints.length} 个地点 · 一段路径`}</strong>
            <span>{files.length > 0
              ? `${files.length} 个新媒体文件`
              : journey?.media.length
                ? `${journey.media.length} 个已有媒体`
                : "媒体可以稍后补充"}</span>
          </div>
          {savedResult ? <button type="button" onClick={closeComposer}><IconCheck size={18} stroke={1.4} aria-hidden="true" />完成</button> : <button type="button" onClick={save} disabled={saving}><IconCheck size={18} stroke={1.4} aria-hidden="true" />{saving ? "正在保存…" : isEditing ? "保存修改" : "保存到星球"}</button>}
        </footer>
      </section>
    </div>
  );
}
