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
  IconPhoto,
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
  onClose: () => void;
  onNavigate: (journeyId: string) => void;
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

export function JourneyStory({
  journeys,
  journeyId,
  onClose,
  onNavigate,
  onMediaAdded,
}: JourneyStoryProps) {
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeys[journeyIndex];
  const [assetIndex, setAssetIndex] = useState(0);
  const [mediaReads, setMediaReads] = useState<Record<string, MediaReadState>>({});
  const [uploadState, setUploadState] = useState<MediaUploadState>({ status: "idle" });
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function requestClose() {
    if (uploadState.status === "uploading") {
      setCloseBlocked(true);
      return;
    }
    onClose();
  }

  const dialogRef = useModalFocus<HTMLElement>(requestClose);

  useEffect(() => {
    setAssetIndex(0);
    setUploadState({ status: "idle" });
    setRetryFiles([]);
    setCloseBlocked(false);
  }, [journeyId]);

  useEffect(() => {
    if (!journey) return;
    setAssetIndex((current) => Math.min(
      current,
      Math.max(0, journey.media.length - 1),
    ));
  }, [journey]);

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
  const asset = journey.media[assetIndex] ?? null;
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
    const firstNewAssetIndex = journey.media.length;
    const result = await uploadJourneyMedia({
      journeyId: journey.id,
      files,
      onProgress: (progress) => setUploadState({ status: "uploading", ...progress }),
    });

    let refreshFailed = false;
    if (result.uploadedCount > 0) {
      try {
        const refreshedJourney = await onMediaAdded(journey.id);
        if (refreshedJourney?.media[firstNewAssetIndex]) {
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
        message: `已将 ${result.uploadedCount} 个媒体添加到这段旅程。`,
      });
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (selected.length > 0) void uploadFiles(selected);
  }

  return (
    <div className="journey-story-backdrop" role="presentation" onClick={closeFromBackdrop}>
      <article ref={dialogRef} tabIndex={-1} className="journey-story" role="dialog" aria-modal="true" aria-labelledby="journey-story-title">
        <header>
          <div>
            <p>PRIVATE JOURNEY · {journeyRange(journey)}</p>
            <h2 id="journey-story-title">{journey.title}</h2>
          </div>
          <button className="journey-story__close" type="button" onClick={requestClose} aria-label="退出旅程故事">
            <span>{uploadState.status === "uploading" ? "上传中" : "退出"}</span><IconX size={19} stroke={1.35} aria-hidden="true" />
          </button>
        </header>

        <div className="journey-story__layout">
          <section className="journey-story__media" aria-label="旅程媒体">
            {!asset ? <div className="journey-story__empty-media"><IconPhoto size={36} stroke={1.05} style={{ color: journey.lightColor }} aria-hidden="true" />这段旅程没有附加媒体</div> : null}
            {asset && (!read || read.status === "loading") ? <div className="journey-story__media-state">正在打开私有媒体…</div> : null}
            {asset && read?.status === "error" ? <div className="journey-story__media-state is-error">{read.message}</div> : null}
            {asset && read?.status === "ready" && asset.mimeType.startsWith("video/") ? <video key={asset.id} src={read.url} controls playsInline preload="metadata" /> : null}
            {asset && read?.status === "ready" && !asset.mimeType.startsWith("video/") ? <img key={asset.id} src={read.url} alt={asset.fileName} /> : null}
            {journey.media.length > 1 ? (
              <nav className="journey-story__media-nav" aria-label="媒体导航">
                <button type="button" disabled={assetIndex === 0} onClick={() => setAssetIndex((current) => current - 1)} aria-label="上一个媒体"><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" /></button>
                <span>{assetIndex + 1} / {journey.media.length}</span>
                <button type="button" disabled={assetIndex === journey.media.length - 1} onClick={() => setAssetIndex((current) => current + 1)} aria-label="下一个媒体"><IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
              </nav>
            ) : null}
          </section>

          <section className="journey-story__copy">
            <dl>
              <div><dt>ROUTE POINTS</dt><dd>{journey.routePoints.length}</dd></div>
              <div><dt>STOPS</dt><dd>{namedStops.length}</dd></div>
            </dl>
            {namedStops.length > 0 ? <p className="journey-story__stops">{namedStops.map((stop) => stop.label).join(" · ")}</p> : null}
            {journey.note ? <p className="journey-story__note">{journey.note}</p> : <p className="journey-story__note is-empty">没有文字，只有这条路线留下来。</p>}
            <div className="journey-story__media-add">
              <div>
                <p>PRIVATE MEDIA</p>
                <strong>{journey.media.length > 0 ? `${journey.media.length} 个媒体片段` : "为这段旅程留下影像"}</strong>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm,video/quicktime"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                onChange={selectFiles}
              />
              <button
                type="button"
                disabled={uploadState.status === "uploading"}
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
                <button className="journey-story__retry" type="button" onClick={() => void uploadFiles(retryFiles)}>
                  重试失败的 {retryFiles.length} 个文件
                </button>
              ) : null}
            </div>
          </section>
        </div>

        <footer>
          <button type="button" disabled={!previousJourney || uploadState.status === "uploading"} onClick={() => previousJourney && onNavigate(previousJourney.id)}><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" />上一段</button>
          <button type="button" disabled={!nextJourney || uploadState.status === "uploading"} onClick={() => nextJourney && onNavigate(nextJourney.id)}>下一段<IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
        </footer>
      </article>
    </div>
  );
}
