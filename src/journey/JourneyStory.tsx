import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconEdit,
  IconPhoto,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { getPrivateMediaRead } from "./journeyApi";
import { uploadJourneyMedia } from "./JourneyComposer";
import { validateJourneyFiles } from "./journeyModel";
import type { Journey } from "./types";
import { useModalFocus } from "./useModalFocus";

type MediaReadState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

type JourneyStoryProps = {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  onClose: () => void;
  onNavigate: (journeyId: string) => void;
  onEdit: (journeyId: string) => void;
  onDelete?: (journeyId: string) => void | Promise<void>;
  onMediaAdded: (journeyId: string) => Journey | null | Promise<Journey | null>;
};

type MediaUploadState =
  | { status: "idle" }
  | {
      status: "uploading";
      fileName: string;
      uploadedBytes: number;
      totalBytes: number;
    }
  | { status: "complete"; message: string; tone: "success" | "error" };

function journeyRange(journey: Journey) {
  return journey.endedOn && journey.endedOn !== journey.startedOn
    ? `${journey.startedOn} — ${journey.endedOn}`
    : journey.startedOn;
}

function formatUploadError(message: string) {
  if (/object storage|storage is not configured|storage unavailable/i.test(message)) {
    return "媒体存储尚未配置，旅程内容不会受影响。配置对象存储后可以直接重试。";
  }
  return message;
}

export function journeyDeleteDescription(journey: Journey) {
  return `先从图谱隐藏；7 天内可撤销，之后才会清理路线和 ${journey.media.length} 个私有媒体。`;
}

export function mediaForRoutePoint(
  journey: Journey,
  routePointId: string | null,
) {
  return journey.media.filter((asset) => asset.routePointId === routePointId);
}

export function JourneyStory({
  journeys,
  journeyId,
  routePointId = null,
  onClose,
  onNavigate,
  onEdit,
  onDelete,
  onMediaAdded,
}: JourneyStoryProps) {
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeys[journeyIndex];
  const [assetIndex, setAssetIndex] = useState(0);
  const [selectedRoutePointId, setSelectedRoutePointId] = useState<string | null>(
    routePointId,
  );
  const [mediaReads, setMediaReads] = useState<Record<string, MediaReadState>>({});
  const [uploadState, setUploadState] = useState<MediaUploadState>({ status: "idle" });
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "pending">("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  function requestClose() {
    if (uploadState.status === "uploading") {
      setCloseBlocked(true);
      return;
    }
    if (deleteState === "pending") return;
    onClose();
  }

  const dialogRef = useModalFocus<HTMLElement>(requestClose);

  useEffect(() => {
    setAssetIndex(0);
    setSelectedRoutePointId(routePointId);
    setUploadState({ status: "idle" });
    setRetryFiles([]);
    setCloseBlocked(false);
    setDeleteState("idle");
    setDeleteMessage("");
  }, [journeyId, routePointId]);

  useEffect(() => {
    if (deleteState === "confirming") deleteCancelRef.current?.focus();
  }, [deleteState]);

  const scopedMedia = useMemo(
    () => journey ? mediaForRoutePoint(journey, selectedRoutePointId) : [],
    [journey, selectedRoutePointId],
  );

  useEffect(() => {
    setAssetIndex((current) => Math.min(
      current,
      Math.max(0, scopedMedia.length - 1),
    ));
  }, [scopedMedia.length]);

  useEffect(() => {
    let cancelled = false;
    if (!journey || journey.media.length === 0) {
      setMediaReads({});
      return () => {
        cancelled = true;
      };
    }

    setMediaReads(Object.fromEntries(
      journey.media.map((asset) => [asset.id, { status: "loading" }]),
    ));
    for (const asset of journey.media) {
      void getPrivateMediaRead(asset.id).then(
        (read) => {
          if (cancelled) return;
          setMediaReads((current) => ({
            ...current,
            [asset.id]: { status: "ready", url: read.url },
          }));
        },
        (error) => {
          if (cancelled) return;
          setMediaReads((current) => ({
            ...current,
            [asset.id]: {
              status: "error",
              message: error instanceof Error ? error.message : "媒体读取失败",
            },
          }));
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [journey]);

  const namedStops = useMemo(
    () => journey?.routePoints.filter((point) => point.isStop) ?? [],
    [journey],
  );

  if (!journey) return null;
  const selectedRoutePoint = selectedRoutePointId
    ? journey.routePoints.find((point) => point.id === selectedRoutePointId) ?? null
    : null;
  const asset = scopedMedia[assetIndex] ?? null;
  const read = asset ? mediaReads[asset.id] : null;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;
  const uploadPercent = uploadState.status === "uploading" && uploadState.totalBytes > 0
    ? Math.round((uploadState.uploadedBytes / uploadState.totalBytes) * 100)
    : 0;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) requestClose();
  }

  async function uploadFiles(files: readonly File[]) {
    setRetryFiles([]);
    setCloseBlocked(false);
    const validation = validateJourneyFiles(files);
    if (!validation.accepted) {
      setUploadState({ status: "complete", tone: "error", message: validation.errors[0] });
      return;
    }

    setUploadState({
      status: "uploading",
      fileName: files[0]?.name ?? "媒体",
      uploadedBytes: 0,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    });
    const firstNewAssetIndex = scopedMedia.length;
    const result = await uploadJourneyMedia({
      journeyId: journey.id,
      routePointId: selectedRoutePointId ?? undefined,
      files,
      onProgress: (progress) => setUploadState({ status: "uploading", ...progress }),
    });

    let refreshFailed = false;
    if (result.uploadedCount > 0) {
      try {
        const refreshedJourney = await onMediaAdded(journey.id);
        const refreshedMedia = refreshedJourney
          ? mediaForRoutePoint(refreshedJourney, selectedRoutePointId)
          : [];
        if (refreshedMedia[firstNewAssetIndex]) {
          setAssetIndex(firstNewAssetIndex);
        } else {
          refreshFailed = true;
        }
      } catch {
        refreshFailed = true;
      }
    }

    const failedFiles = result.mediaErrors.map((error) => files[error.fileIndex]);
    setRetryFiles(failedFiles);
    setCloseBlocked(false);
    if (result.mediaErrors.length > 0) {
      const failure = formatUploadError(result.mediaErrors[0].message);
      setUploadState({
        status: "complete",
        tone: "error",
        message: result.uploadedCount > 0
          ? `已添加 ${result.uploadedCount} 个；${result.mediaErrors.length} 个失败。${failure}`
          : failure,
      });
    } else if (refreshFailed) {
      setUploadState({
        status: "complete",
        tone: "error",
        message: "媒体已上传，但当前列表刷新失败。重新打开这段旅程即可看到，不需要重复上传。",
      });
    } else {
      setUploadState({
        status: "complete",
        tone: "success",
        message: selectedRoutePoint
          ? `已将 ${result.uploadedCount} 个媒体添加到「${selectedRoutePoint.label || `途径点 ${selectedRoutePoint.sortOrder + 1}`}」。`
          : `已将 ${result.uploadedCount} 个媒体添加到整段旅程。`,
      });
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (selected.length > 0) void uploadFiles(selected);
  }

  async function confirmDelete() {
    if (!onDelete || uploadState.status === "uploading" || deleteState === "pending") {
      return;
    }
    setDeleteState("pending");
    setDeleteMessage("");
    try {
      await onDelete(journey.id);
    } catch (error) {
      setDeleteState("confirming");
      setDeleteMessage(error instanceof Error ? error.message : "旅程删除失败，请稍后重试。");
    }
  }

  const mutationPending = uploadState.status === "uploading" || deleteState === "pending";

  function selectMediaScope(routePointId: string | null) {
    if (mutationPending) return;
    setSelectedRoutePointId(routePointId);
    setAssetIndex(0);
    setRetryFiles([]);
    setUploadState({ status: "idle" });
  }

  return (
    <div className="journey-story-backdrop" role="presentation" onClick={closeFromBackdrop}>
      <article ref={dialogRef} tabIndex={-1} className="journey-story" role="dialog" aria-modal="true" aria-labelledby="journey-story-title">
        <header>
          <div>
            <p>PRIVATE JOURNEY · {journeyRange(journey)}</p>
            <h2 id="journey-story-title">{journey.title}</h2>
          </div>
          <button className="journey-story__close" type="button" disabled={mutationPending} onClick={requestClose} aria-label="退出旅程故事">
            <span>{deleteState === "pending" ? "删除中" : uploadState.status === "uploading" ? "上传中" : "退出"}</span><IconX size={19} stroke={1.35} aria-hidden="true" />
          </button>
        </header>

        <div className="journey-story__layout">
          <section className="journey-story__media" aria-label="旅程媒体">
            {!asset ? <div className="journey-story__empty-media"><IconPhoto size={36} stroke={1.05} style={{ color: journey.lightColor }} aria-hidden="true" />{selectedRoutePoint ? "这个途径点还没有媒体" : "整段旅程还没有媒体"}</div> : null}
            {asset && (!read || read.status === "loading") ? <div className="journey-story__media-state">正在打开私有媒体…</div> : null}
            {asset && read?.status === "error" ? <div className="journey-story__media-state is-error">{read.message}</div> : null}
            {asset && read?.status === "ready" && asset.mimeType.startsWith("video/") ? <video key={asset.id} src={read.url} controls playsInline preload="metadata" /> : null}
            {asset && read?.status === "ready" && !asset.mimeType.startsWith("video/") ? <img key={asset.id} src={read.url} alt={asset.fileName} /> : null}
            {scopedMedia.length > 1 ? (
              <nav className="journey-story__media-nav" aria-label="媒体导航">
                <button type="button" disabled={assetIndex === 0 || mutationPending} onClick={() => setAssetIndex((current) => current - 1)} aria-label="上一个媒体"><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" /></button>
                <span>{assetIndex + 1} / {scopedMedia.length}</span>
                <button type="button" disabled={assetIndex === scopedMedia.length - 1 || mutationPending} onClick={() => setAssetIndex((current) => current + 1)} aria-label="下一个媒体"><IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
              </nav>
            ) : null}
          </section>

          <section className="journey-story__copy">
            <nav className="journey-story__route-points" aria-label="选择旅程途径点">
              <button
                type="button"
                disabled={mutationPending}
                className={selectedRoutePointId === null ? "is-active" : ""}
                aria-pressed={selectedRoutePointId === null}
                onClick={() => selectMediaScope(null)}
              >
                <span>00</span>
                <strong>整段旅程</strong>
                <small>{mediaForRoutePoint(journey, null).length}</small>
              </button>
              {journey.routePoints.map((point, index) => (
                <button
                  key={point.id}
                  type="button"
                  disabled={mutationPending}
                  className={selectedRoutePointId === point.id ? "is-active" : ""}
                  aria-pressed={selectedRoutePointId === point.id}
                  data-route-point-id={point.id}
                  onClick={() => selectMediaScope(point.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{point.label || `途径点 ${index + 1}`}</strong>
                  <small>{mediaForRoutePoint(journey, point.id).length}</small>
                </button>
              ))}
            </nav>
            <dl>
              <div><dt>ROUTE POINTS</dt><dd>{journey.routePoints.length}</dd></div>
              <div><dt>STOPS</dt><dd>{namedStops.length}</dd></div>
            </dl>
            {namedStops.length > 0 ? <p className="journey-story__stops">{namedStops.map((stop) => stop.label).join(" · ")}</p> : null}
            {journey.note ? <p className="journey-story__note">{journey.note}</p> : <p className="journey-story__note is-empty">没有文字，只有这条路线留下来。</p>}
            {onDelete && deleteState !== "idle" ? (
              <section className="journey-story__delete-confirmation" aria-label="确认删除旅程">
                <div>
                  <p>REMOVE FROM ATLAS</p>
                  <strong>7 天内可以恢复</strong>
                  <span>{journeyDeleteDescription(journey)}</span>
                </div>
                <div>
                  <button ref={deleteCancelRef} type="button" disabled={deleteState === "pending"} onClick={() => { setDeleteState("idle"); setDeleteMessage(""); }}>取消</button>
                  <button type="button" disabled={mutationPending} onClick={() => void confirmDelete()}>{deleteState === "pending" ? "正在删除…" : "确认删除"}</button>
                </div>
                {deleteMessage ? <p className="journey-story__delete-error" role="alert">{deleteMessage}</p> : null}
              </section>
            ) : null}
            <div className="journey-story__media-add">
              <div>
                <p>PRIVATE MEDIA</p>
                <strong>{scopedMedia.length > 0
                  ? `${scopedMedia.length} 个媒体片段 · ${selectedRoutePoint?.label || (selectedRoutePoint ? `途径点 ${selectedRoutePoint.sortOrder + 1}` : "整段旅程")}`
                  : selectedRoutePoint
                  ? `为「${selectedRoutePoint.label || `途径点 ${selectedRoutePoint.sortOrder + 1}`}」留下影像`
                  : "为整段旅程留下影像"}</strong>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm,video/quicktime"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                disabled={mutationPending || deleteState !== "idle"}
                onChange={selectFiles}
              />
              <button
                type="button"
                disabled={mutationPending || deleteState !== "idle"}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconUpload size={17} stroke={1.35} aria-hidden="true" />
                {uploadState.status === "uploading" ? `正在上传 ${uploadPercent}%` : "添加照片或视频"}
              </button>
              {uploadState.status === "uploading" ? (
                <div
                  className="journey-story__upload-progress"
                  role="progressbar"
                  aria-label={`正在上传 ${uploadState.fileName}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadPercent}
                >
                  <span style={{ width: `${uploadPercent}%` }} />
                  <small>{uploadState.fileName}</small>
                </div>
              ) : null}
              {closeBlocked && uploadState.status === "uploading" ? (
                <p className="journey-story__upload-message" role="status">正在完成分块上传，完成后即可安全退出。</p>
              ) : null}
              {uploadState.status === "complete" ? (
                <p className={`journey-story__upload-message is-${uploadState.tone}`} role="status">{uploadState.message}</p>
              ) : null}
              {retryFiles.length > 0 && uploadState.status !== "uploading" ? (
                <button className="journey-story__retry" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => void uploadFiles(retryFiles)}>
                  重试失败的 {retryFiles.length} 个文件
                </button>
              ) : null}
            </div>
          </section>
        </div>

        <footer>
          <div className="journey-story__manage">
            <button type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => onEdit(journey.id)}><IconEdit size={16} stroke={1.35} aria-hidden="true" />编辑旅程</button>
            {onDelete ? <button className="is-destructive" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => { setDeleteState("confirming"); setDeleteMessage(""); }}><IconTrash size={16} stroke={1.35} aria-hidden="true" />删除旅程</button> : null}
          </div>
          <div className="journey-story__navigation">
            <button type="button" disabled={!previousJourney || mutationPending || deleteState !== "idle"} onClick={() => previousJourney && onNavigate(previousJourney.id)}><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" />上一段</button>
            <button type="button" disabled={!nextJourney || mutationPending || deleteState !== "idle"} onClick={() => nextJourney && onNavigate(nextJourney.id)}>下一段<IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
          </div>
        </footer>
      </article>
    </div>
  );
}
