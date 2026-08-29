import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowDown,
  IconArrowUp,
  IconDots,
  IconPhotoStar,
  IconEdit,
  IconLayoutGrid,
  IconMaximize,
  IconMusic,
  IconPhoto,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "@tabler/icons-react";
import { IconActionButton } from "../components/IconActionButton";
import { deleteMedia, getPrivateMediaRead, reorderJourneyMedia, setJourneyCover } from "./journeyApi";
import { runSharedElementMorph } from "../motion/primitives/sharedElement";
import { uploadJourneyMedia } from "./JourneyComposer";
import {
  createDecodeRegistry,
  decodeImageUrl,
  prefetchWindowFor,
} from "./mediaPrefetch";
import { createSoundtrackSampler } from "../motion/audioSampler";
import {
  resetAudioAtmosphereEnergy,
  writeAudioAtmosphereEnergy,
} from "../motion/audioAtmosphere";
import { prefersReducedMotion } from "../motion/preferences";
import {
  applyScopeReorder,
  journeyCover,
  journeySoundtrack,
  journeyVisualMedia,
  stripMediaExtension,
  validateJourneyFiles,
  validateJourneySoundtrack,
} from "./journeyModel";
import type { Journey, JourneyMediaAsset } from "./types";
import { useModalFocus, useNestedModalFocus } from "./useModalFocus";
import { useCompactMobileLayout } from "./mobileLayout";
import { useMobileSurfaceHistory } from "./useMobileSurfaceHistory";

const SOUNDTRACK_INPUT_ACCEPT = [
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".wav",
].join(",");

// A signed read is refreshed this far ahead of its expiry so a long browsing
// session never shows an expired thumbnail.
const MEDIA_READ_REFRESH_MARGIN_MS = 60_000;
const MEDIA_READ_SWEEP_MS = 20_000;
// How far a mobile swipe drag must travel before it commits to the neighbor
// instead of springing back — unchanged from the release-only gesture this
// replaced.
const MEDIA_DRAG_THRESHOLD_PX = 48;
const MEDIA_DRAG_SETTLE_MS = 220;

type MediaReadState =
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: number }
  | { status: "error"; message: string };

type JourneyStoryProps = {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  onClose: (sharedSource?: HTMLElement | null) => void;
  onNavigate: (journeyId: string) => void;
  onEdit: (journeyId: string) => void;
  onDelete?: (journeyId: string) => void | Promise<void>;
  onMediaAdded: (journeyId: string) => Journey | null | Promise<Journey | null>;
  onMediaDelete?: (assetId: string) => void | Promise<void>;
  onMediaReorder?: (
    journeyId: string,
    assetIds: readonly string[],
  ) => Journey | Promise<Journey>;
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

export function storyInitialMediaSelection(
  journey: Journey | undefined,
  requestedRoutePointId: string | null,
) {
  if (!journey) {
    return { routePointId: requestedRoutePointId, assetIndex: 0, assetId: null };
  }

  const visualMedia = journeyVisualMedia(journey);
  if (requestedRoutePointId !== null) {
    const scoped = visualMedia.filter((asset) => asset.routePointId === requestedRoutePointId);
    return {
      routePointId: requestedRoutePointId,
      assetIndex: 0,
      assetId: scoped[0]?.id ?? null,
    };
  }

  // #18 follow-up: the active Journey card displays journeyCover(), so the
  // Story must open on that exact asset. This also follows a cover attached to
  // a route point into the matching media scope instead of silently showing a
  // different journey-level asset at index 0.
  const cover = journeyCover(journey);
  if (!cover) return { routePointId: null, assetIndex: 0, assetId: null };
  const scoped = visualMedia.filter((asset) => asset.routePointId === cover.routePointId);
  const coverIndex = scoped.findIndex((asset) => asset.id === cover.id);
  return {
    routePointId: cover.routePointId,
    assetIndex: coverIndex >= 0 ? coverIndex : 0,
    assetId: cover.id,
  };
}

export type SoundtrackReplacement = {
  uploaded: boolean;
  uploadError: string | null;
  refreshed: Journey | null;
  refreshFailed: boolean;
  cleanupFailed: boolean;
  // True when the upload resolved to the track that was already active, so
  // nothing was replaced and nothing may be deleted.
  unchanged: boolean;
};

// A journey keeps exactly one soundtrack. The replacement order matters: the
// new track is uploaded and confirmed first, and only then is the previous one
// removed, so a failed upload never leaves a journey without its music.
export async function replaceJourneySoundtrack({
  journeyId,
  file,
  previous,
  upload = uploadJourneyMedia,
  refresh,
  remove,
  onProgress,
}: {
  journeyId: string;
  file: File;
  previous: JourneyMediaAsset | null;
  upload?: typeof uploadJourneyMedia;
  refresh: (journeyId: string) => Journey | null | Promise<Journey | null>;
  remove: (assetId: string) => void | Promise<void>;
  onProgress?: (progress: {
    fileName: string;
    uploadedBytes: number;
    totalBytes: number;
  }) => void;
}): Promise<SoundtrackReplacement> {
  const result = await upload({ journeyId, files: [file], onProgress });
  if (result.uploadedCount === 0) {
    return {
      uploaded: false,
      uploadError: result.mediaErrors[0]?.message ?? null,
      refreshed: null,
      refreshFailed: false,
      cleanupFailed: false,
      unchanged: false,
    };
  }

  // Every permitted soundtrack is small enough to be content hashed, so
  // choosing the current track again is deduplicated by the server to the
  // existing asset. Removing "the previous track" would then delete the only
  // one there is.
  const unchanged = previous !== null
    && result.assets.some((asset) => asset.id === previous.id);

  let refreshed: Journey | null = null;
  let refreshFailed = false;
  try {
    refreshed = await refresh(journeyId);
    refreshFailed = refreshed === null;
  } catch {
    refreshFailed = true;
  }

  let cleanupFailed = false;
  if (previous && !unchanged) {
    try {
      await remove(previous.id);
      try {
        const cleaned = await refresh(journeyId);
        if (cleaned) refreshed = cleaned;
      } catch {
        // The new track is already active; a stale list recovers on reopen.
      }
    } catch {
      cleanupFailed = true;
    }
  }

  return {
    uploaded: true,
    uploadError: null,
    refreshed,
    refreshFailed,
    cleanupFailed,
    unchanged,
  };
}

function StoryMediaTile({
  asset,
  index,
  isCurrent,
  isCover,
  read,
  disabled,
  onRequestRead,
  onSelect,
  onSetCover,
}: {
  asset: JourneyMediaAsset;
  index: number;
  isCurrent: boolean;
  isCover: boolean;
  read: MediaReadState | undefined;
  disabled: boolean;
  onRequestRead: (assetId: string) => void;
  onSelect: (index: number, source: HTMLButtonElement) => void;
  onSetCover?: (assetId: string) => void;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const isVideo = asset.mimeType.startsWith("video/");

  // Every visible tile prefetches its signed read. Images render a thumbnail;
  // video tiles keep the lightweight badge but have the target URL ready so a
  // tile -> stage shared transition does not collapse into a loading cut.
  useEffect(() => {
    const element = tileRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      onRequestRead(asset.id);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        onRequestRead(asset.id);
      },
      { root: element.closest(".journey-story__media-grid"), rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [asset.id, isVideo, onRequestRead]);

  return (
    <>
      <button
        ref={tileRef}
        type="button"
        className={isCurrent ? "is-current" : ""}
        aria-current={isCurrent ? "true" : undefined}
        aria-label={`第 ${index + 1} 个媒体 ${asset.fileName}${isCover ? "，当前封面" : ""}`}
        data-media-tile-index={index}
        disabled={disabled}
        onClick={(event) => onSelect(index, event.currentTarget)}
      >
        {isVideo ? (
          <span className="journey-story__media-tile-badge">
            <IconVideo size={20} stroke={1.3} aria-hidden="true" />
          </span>
        ) : read?.status === "ready" ? (
          <img src={read.url} alt={asset.fileName} loading="lazy" decoding="async" />
        ) : (
          <span className="journey-story__media-tile-badge">
            {read?.status === "error" ? "不可用" : "载入中"}
          </span>
        )}
        {isCover ? <span className="journey-story__media-tile-cover">封面</span> : null}
        <small>{String(index + 1).padStart(2, "0")}</small>
      </button>
      {onSetCover && !isCover ? (
        <IconActionButton
          type="button"
          className="journey-story__media-tile-set-cover"
          label={`将 ${asset.fileName} 设为封面`}
          tooltip="设为封面"
          onClick={() => onSetCover(asset.id)}
        >
          <IconPhotoStar size={16} stroke={1.35} aria-hidden="true" />
        </IconActionButton>
      ) : null}
    </>
  );
}

// #12: a sortable wrapper around StoryMediaTile. The <li> becomes the drag
// handle surface; dragging lifts the tile and leaves the grid layout animating
// around it (dnd-kit layout animation), with the sortable styles applied via
// transform/transition so reduced-motion falls back to instant moves.
function SortableMediaTile({
  asset,
  index,
  isCurrent,
  isCover,
  read,
  disabled,
  onRequestRead,
  onSelect,
  onSetCover,
}: {
  asset: JourneyMediaAsset;
  index: number;
  isCurrent: boolean;
  isCover: boolean;
  read: MediaReadState | undefined;
  disabled: boolean;
  onRequestRead: (assetId: string) => void;
  onSelect: (index: number, source: HTMLButtonElement) => void;
  onSetCover?: (assetId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: asset.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`${isDragging ? "is-dragging" : ""}${isCover ? " is-cover" : ""}`}
      {...attributes}
      {...listeners}
    >
      <StoryMediaTile
        asset={asset}
        index={index}
        isCurrent={isCurrent}
        isCover={isCover}
        read={read}
        disabled={disabled || isDragging}
        onRequestRead={onRequestRead}
        onSelect={onSelect}
        onSetCover={onSetCover}
      />
    </li>
  );
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
  onMediaDelete,
  onMediaReorder,
}: JourneyStoryProps) {
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeys[journeyIndex];
  const initialMediaSelection = storyInitialMediaSelection(journey, routePointId);
  const [assetIndex, setAssetIndex] = useState(initialMediaSelection.assetIndex);
  const [selectedRoutePointId, setSelectedRoutePointId] = useState<string | null>(
    initialMediaSelection.routePointId,
  );
  const [mediaReads, setMediaReads] = useState<Record<string, MediaReadState>>({});
  // Browser-side decode readiness, separate from signed-read readiness (#11):
  // a URL being available never implies the image is decoded, so the slideshow
  // holds the current frame until the next one is truly ready.
  const decodeRegistryRef = useRef(createDecodeRegistry(decodeImageUrl));
  // Review P1: decode settles asynchronously without React state; this
  // revision counter bumps on every settle so the pending-navigation effect
  // re-runs and can observe the newly decoded target.
  const [decodeSettleRevision, setDecodeSettleRevision] = useState(0);
  useEffect(() => decodeRegistryRef.current.onSettle(
    () => setDecodeSettleRevision((current) => current + 1),
  ), []);
  // Two-layer media stage (#11): `shownAssetId` is the frame that has fully
  // settled (base layer); `incomingAssetId` is the frame fading in on top.
  // When they are equal the stage is single-layered. A target that is not yet
  // decoded stays pending and the current frame keeps showing until it is.
  const [shownAssetId, setShownAssetId] = useState<string | null>(null);
  const [incomingAssetId, setIncomingAssetId] = useState<string | null>(null);
  const pendingTargetRef = useRef<number | null>(null);
  const [uploadState, setUploadState] = useState<MediaUploadState>({ status: "idle" });
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "pending">("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [mediaDeleteState, setMediaDeleteState] = useState<"idle" | "confirming" | "pending">("idle");
  const [mediaDeleteMessage, setMediaDeleteMessage] = useState("");
  const [orderPending, setOrderPending] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  // Review P2: optimistic drag order for the current scope (asset ids). Set
  // on drop before the API round-trip; cleared on success/rollback so the
  // grid follows server truth.
  const [localMediaOrder, setLocalMediaOrder] = useState<readonly string[] | null>(null);
  // #14: setting a cover is a lightweight mutation that disables the grid.
  const [coverPending, setCoverPending] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Review P2: mirrors `playing` so gesture handlers can read it synchronously.
  const playingRef = useRef(false);
  playingRef.current = playing;
  const mobileLayout = useCompactMobileLayout();
  const [fullscreen, setFullscreen] = useState(false);
  // #7: fullscreen controls fade out after idle; any pointer/key activity
  // brings them back. Mobile starts fully immersive and reveals controls only
  // after an explicit interaction.
  const [fullscreenControlsHidden, setFullscreenControlsHidden] = useState(false);
  const fullscreenMobileIdleTimerRef = useRef(0);
  const storyMediaGestureConsumedRef = useRef(false);
  // Mobile swipe: a live, finger-following slide shared by the inline stage
  // and the fullscreen stage, replacing a release-only "guess and crossfade"
  // gesture that gave zero visual feedback while dragging. The dragged frame
  // and (when the neighbor's signed read is already cached from the #11
  // prefetch window) a peeking neighbor move directly with the pointer via
  // imperative style writes, not React state, so tracking never waits on a
  // re-render. It is a separate visual system from the settle-driven opacity
  // crossfade below — it only ever ends by jumping straight to the
  // already-settled state it just finished animating to, the same fast path
  // selectMediaIndex uses when a target's read is already ready.
  const mediaDragRef = useRef<{
    container: HTMLElement;
    base: HTMLElement;
    peek: HTMLImageElement | null;
    startX: number;
    startY: number;
    dx: number;
    axis: "x" | "y" | null;
    wrap: boolean;
    neighborIndex: number;
    neighborAsset: JourneyMediaAsset | null;
    width: number;
  } | null>(null);
  const [mobileMediaMenuOpen, setMobileMediaMenuOpen] = useState(false);
  // Review P2: the fullscreen overlay is a focus trap of its own (it is
  // rendered outside the story dialog, whose useModalFocus would otherwise
  // steal Tab focus back into the article).
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState(false);
  const [soundtrackUpload, setSoundtrackUpload] = useState<MediaUploadState>({ status: "idle" });
  const [soundtrackRemovePending, setSoundtrackRemovePending] = useState(false);
  const [soundtrackNotice, setSoundtrackNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const soundtrackInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // #20: one sampler per soundtrack element; the analyser is built on first
  // play and drives the light strip with smoothed energy.
  const audioSamplerRef = useRef(createSoundtrackSampler());
  const soundtrackLightRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const mediaDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLElement>(null);
  const pendingReads = useRef(new Set<string>());
  const mediaReadsRef = useRef(mediaReads);
  const uploading = uploadState.status === "uploading"
    || soundtrackUpload.status === "uploading";

  function exitFullscreen() {
    if (typeof window !== "undefined") {
      window.clearTimeout(fullscreenMobileIdleTimerRef.current);
      fullscreenMobileIdleTimerRef.current = 0;
    }
    setFullscreen(false);
    setFullscreenControlsHidden(false);
  }

  function enterFullscreen(autoPlay: boolean) {
    setPlayingFromGesture(autoPlay);
    setFullscreenControlsHidden(mobileLayout);
    setMobileMediaMenuOpen(false);
    setFullscreen(true);
  }

  function closeMobileMediaDelete() {
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>(".journey-story__mobile-media-menu-trigger")
            ?.focus({ preventScroll: true });
        });
      });
    }
  }

  function requestClose() {
    if (fullscreen) {
      exitFullscreen();
      return;
    }
    if (mobileLayout && mobileMediaMenuOpen) {
      setMobileMediaMenuOpen(false);
      return;
    }
    if (mobileLayout && mediaDeleteState === "confirming") {
      closeMobileMediaDelete();
      return;
    }
    if (uploading) {
      setCloseBlocked(true);
      return;
    }
    if (
      deleteState === "pending"
      || mediaDeleteState === "pending"
      || soundtrackRemovePending
    ) {
      return;
    }
    const sharedSource = dialogRef.current?.querySelector<HTMLElement>(
      '[data-shared-journey-cover="true"]',
    ) ?? null;
    onClose(sharedSource);
  }

  useMobileSurfaceHistory(fullscreen && mobileLayout, "story-fullscreen", exitFullscreen);
  const dialogRef = useModalFocus<HTMLElement>(requestClose);
  const mobileMediaSheetRef = useNestedModalFocus<HTMLElement>(
    mobileLayout && (mobileMediaMenuOpen || mediaDeleteState !== "idle"),
    mobileMediaMenuOpen ? "manage" : mediaDeleteState !== "idle" ? "delete" : null,
  );

  useEffect(() => {
    const nextInitialMedia = storyInitialMediaSelection(journey, routePointId);
    setAssetIndex(nextInitialMedia.assetIndex);
    setSelectedRoutePointId(nextInitialMedia.routePointId);
    setUploadState({ status: "idle" });
    setRetryFiles([]);
    setCloseBlocked(false);
    setDeleteState("idle");
    setDeleteMessage("");
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    setOrderPending(false);
    setOrderMessage("");
    setPlaying(false);
    exitFullscreen();
    setMobileMediaMenuOpen(false);
    setOverview(false);
    setSoundtrackUpload({ status: "idle" });
    setSoundtrackRemovePending(false);
    setSoundtrackNotice("");
    // Signed reads belong to the journey that requested them.
    pendingReads.current.clear();
    setMediaReads({});
    decodeRegistryRef.current.reset();
    setShownAssetId(null);
    setIncomingAssetId(null);
    pendingTargetRef.current = null;
    audioSamplerRef.current.stop();
    resetAudioAtmosphereEnergy();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [journeyId, routePointId]);

  useEffect(() => {
    if (deleteState === "confirming") deleteCancelRef.current?.focus();
  }, [deleteState]);

  useEffect(() => {
    if (mediaDeleteState === "confirming") mediaDeleteCancelRef.current?.focus();
  }, [mediaDeleteState]);

  // Only photos and videos are browsable media. The journey soundtrack is
  // audio, so it never enters the grid, the counts, or the ordering controls.
  const visualMedia = useMemo(
    () => journey ? journeyVisualMedia(journey) : [],
    [journey],
  );
  const scopedMedia = useMemo(
    () => visualMedia.filter((asset) => asset.routePointId === selectedRoutePointId),
    [visualMedia, selectedRoutePointId],
  );
  // Review P2: while a drag is pending, the overview renders the optimistic
  // order; otherwise it follows scopedMedia (server truth).
  const orderedScopedMedia = useMemo(() => {
    if (!localMediaOrder) return scopedMedia;
    const byId = new Map(scopedMedia.map((asset) => [asset.id, asset]));
    const ordered = localMediaOrder.map((id) => byId.get(id)).filter(
      (asset): asset is JourneyMediaAsset => asset !== undefined,
    );
    // Any asset not in the local order (e.g. a just-uploaded one) appends.
    for (const asset of scopedMedia) {
      if (!localMediaOrder.includes(asset.id)) ordered.push(asset);
    }
    return ordered;
  }, [localMediaOrder, scopedMedia]);
  const soundtrack = journey ? journeySoundtrack(journey) : null;
  const activeAsset = scopedMedia[assetIndex] ?? null;
  const activeRead = activeAsset ? mediaReads[activeAsset.id] : null;
  const soundtrackRead = soundtrack ? mediaReads[soundtrack.id] : null;
  // #14: the journey cover — explicit coverMediaAssetId, else first visual
  // media by sortOrder, else null. Cards/story use it as the representative
  // image; it is independent of slideshow order.
  const cover = journey ? journeyCover(journey) : null;

  function visualMediaCount(pointId: string | null) {
    return visualMedia.filter((asset) => asset.routePointId === pointId).length;
  }

  function scopedVisualMedia(target: Journey) {
    return journeyVisualMedia(target)
      .filter((asset) => asset.routePointId === selectedRoutePointId);
  }

  // Ken Burns playback: advance every slide when playing, restarting the
  // timer whenever the user navigates manually or the media list changes.
  // #11: autoplay goes through the two-layer stage too, so a slow network
  // keeps the current frame until the next one is decoded.
  const navigateToMediaRef = useRef<(index: number) => void>(() => undefined);
  navigateToMediaRef.current = navigateToMedia;
  useEffect(() => {
    if (!playing) return;
    if (scopedMedia.length < 2) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      navigateToMediaRef.current((assetIndex + 1) % scopedMedia.length);
    }, 5200);
    return () => window.clearTimeout(timer);
  }, [assetIndex, playing, scopedMedia.length]);

  // The soundtrack follows the slideshow: it keeps its position across pauses
  // and only rewinds when the story closes or moves to another journey.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!playing) {
      audio.pause();
      return;
    }
    // A rejected play() means this browser will not decode or autoplay the
    // track. The slideshow continues silently instead of reporting a failure.
    void audio.play().catch(() => undefined);
  }, [playing, soundtrackRead?.status === "ready"]);

  // #20: analyser lifetime is tied to the soundtrack element, not to each
  // play/pause toggle. The sampler keeps a single MediaElementSource for the
  // element, decays energy on pause, and the global atmosphere channel lets
  // the Three scene read the same smoothed values without React frame updates.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !soundtrackRead || soundtrackRead.status !== "ready") {
      audioSamplerRef.current.stop();
      resetAudioAtmosphereEnergy();
      return;
    }
    if (prefersReducedMotion()) {
      audioSamplerRef.current.stop();
      resetAudioAtmosphereEnergy();
      return;
    }
    const sampler = audioSamplerRef.current;
    if (playing) sampler.start(audio);
    sampler.setPlaying(playing);
    const strip = soundtrackLightRef.current;
    if (!sampler.isActive()) {
      resetAudioAtmosphereEnergy();
      return;
    }
    let frame = 0;
    const drive = () => {
      const energy = sampler.getEnergy();
      writeAudioAtmosphereEnergy(energy);
      if (strip) {
        strip.style.setProperty("--audio-width", String(1 + energy.mid * 0.15));
        strip.style.setProperty("--audio-brightness", String(1 + energy.overall * 0.12));
      }
      frame = window.requestAnimationFrame(drive);
    };
    frame = window.requestAnimationFrame(drive);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, soundtrackRead?.status === "ready"]);

  // Final teardown only when the Story leaves this soundtrack element.
  useEffect(() => () => {
    audioSamplerRef.current.stop();
    resetAudioAtmosphereEnergy();
  }, []);

  useEffect(() => () => audioRef.current?.pause(), []);

  useEffect(() => {
    if (mobileLayout) return;
    setMobileMediaMenuOpen(false);
  }, [mobileLayout]);

  // #7 + review P2: fullscreen playback — Esc exits, arrows switch media,
  // Space toggles play/pause. Controls fade out after 2.5s of idle; any
  // pointer/key/touch activity shows them AND restarts the idle timer, so
  // "hide after inactivity" actually re-arms after every interaction.
  useEffect(() => {
    if (!fullscreen) {
      setFullscreenControlsHidden(false);
      return;
    }
    let idleTimer = 0;
    const restartIdle = () => {
      setFullscreenControlsHidden(false);
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => setFullscreenControlsHidden(true), 2500);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      restartIdle();
      if (event.key === "Escape") {
        exitFullscreen();
      } else if (event.key === "ArrowLeft") {
        navigateToMediaRef.current((assetIndex - 1 + scopedMedia.length) % scopedMedia.length);
      } else if (event.key === "ArrowRight") {
        navigateToMediaRef.current((assetIndex + 1) % scopedMedia.length);
      } else if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        togglePlaying();
      }
    };
    const onActivity = () => restartIdle();
    window.addEventListener("keydown", onKeyDown);
    if (!mobileLayout) {
      window.addEventListener("pointermove", onActivity);
      window.addEventListener("pointerdown", onActivity);
      window.addEventListener("touchstart", onActivity, { passive: true });
      restartIdle();
    } else {
      setFullscreenControlsHidden(true);
    }
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (!mobileLayout) {
        window.removeEventListener("pointermove", onActivity);
        window.removeEventListener("pointerdown", onActivity);
        window.removeEventListener("touchstart", onActivity);
      }
      window.clearTimeout(idleTimer);
    };
  }, [fullscreen, assetIndex, scopedMedia.length, mobileLayout]);

  // Review P2: the fullscreen overlay is its own focus trap. The story
  // dialog's useModalFocus redirects Tab into the article; when fullscreen is
  // open we own Tab cycling inside it and focus its close button on entry.
  useEffect(() => {
    if (!fullscreen) return;
    const root = fullscreenRef.current;
    if (!root) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => [...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => (
      element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden"
    ));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === root || current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === root || current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    const firstButton = focusable()[0];
    if (firstButton) firstButton.focus();
    else root.focus({ preventScroll: true });
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen || !mobileLayout || !fullscreenControlsHidden) return;
    const root = fullscreenRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active) && active !== root) {
      root.focus({ preventScroll: true });
    }
  }, [fullscreen, fullscreenControlsHidden, mobileLayout]);

  useEffect(() => {
    setAssetIndex((current) => Math.min(
      current,
      Math.max(0, scopedMedia.length - 1),
    ));
    // A list shrink can leave the stage pointing at a removed asset; fall
    // back to the (clamped) active frame so the stage never goes stale.
    if (shownAssetId && !scopedMedia.some((candidate) => candidate.id === shownAssetId)) {
      setShownAssetId(null);
      setIncomingAssetId(null);
      pendingTargetRef.current = null;
    }
  }, [scopedMedia.length]);

  useEffect(() => {
    mediaReadsRef.current = mediaReads;
  }, [mediaReads]);

  // Signed reads are cached for the lifetime of the open dialog so revisiting a
  // photo, or opening the overview grid again, costs no extra request.
  const loadMediaRead = useCallback((assetId: string) => {
    if (pendingReads.current.has(assetId)) return;
    pendingReads.current.add(assetId);
    setMediaReads((current) => current[assetId]?.status === "ready"
      ? current
      : { ...current, [assetId]: { status: "loading" } });
    void getPrivateMediaRead(assetId).then(
      (read) => setMediaReads((current) => ({
        ...current,
        [assetId]: {
          status: "ready",
          url: read.url,
          expiresAt: Date.parse(read.expiresAt),
        },
      })),
      (error) => setMediaReads((current) => ({
        ...current,
        [assetId]: {
          status: "error",
          message: error instanceof Error ? error.message : "媒体读取失败",
        },
      })),
    ).finally(() => pendingReads.current.delete(assetId));
  }, []);

  // #11: settle the two-layer stage after the incoming frame's crossfade.
  // Under reduced motion the animation is disabled and never fires
  // animationend, so the caller settles immediately in that case.
  const settleIncoming = useCallback((assetId: string) => {
    setShownAssetId((current) => current === assetId ? current : assetId);
    setIncomingAssetId((current) => current === assetId ? null : current);
  }, []);

  useEffect(() => {
    if (activeAsset) loadMediaRead(activeAsset.id);
  }, [activeAsset?.id, loadMediaRead]);

  useEffect(() => {
    if (soundtrack) loadMediaRead(soundtrack.id);
  }, [soundtrack?.id, loadMediaRead]);

  // #11: prepare adjacent slideshow media while the active one is on screen.
  // The window is next 1 + previous 1 for manual browsing, next 2 for
  // autoplay. Only images are decoded ahead; videos stay at preload metadata.
  useEffect(() => {
    if (!activeAsset || scopedMedia.length < 2) return;
    const activeIndex = scopedMedia.findIndex((candidate) => candidate.id === activeAsset.id);
    if (activeIndex < 0) return;
    const windowFor = prefetchWindowFor(activeIndex, scopedMedia.length, playing);
    const target = new Set(
      [...windowFor.next, ...windowFor.previous]
        .map((index) => scopedMedia[index])
        .filter((asset): asset is JourneyMediaAsset => asset !== undefined),
    );
    for (const candidate of target) {
      // Request the signed read (cached; no duplicate requests).
      loadMediaRead(candidate.id);
    }
    // Release decoded refs outside the window so hundreds of images are not
    // all kept in memory for one open dialog.
    const keep = new Set<string>([activeAsset.id]);
    for (const index of windowFor.next) keep.add(scopedMedia[index]?.id ?? "");
    for (const index of windowFor.previous) keep.add(scopedMedia[index]?.id ?? "");
    for (const [assetId, state] of Object.entries(mediaReadsRef.current)) {
      if (state.status === "ready" && !keep.has(assetId)) {
        decodeRegistryRef.current.release(assetId);
      }
    }
  }, [activeAsset?.id, scopedMedia, playing, loadMediaRead]);

  // #11: start the browser decode for any image whose signed read became
  // ready inside the prefetch window (or is the current frame). Runs whenever
  // reads settle, so an async read completion starts the decode automatically.
  useEffect(() => {
    const windowTargets = new Set<string>([activeAsset?.id ?? ""]);
    if (activeAsset && scopedMedia.length >= 2) {
      const activeIndex = scopedMedia.findIndex((candidate) => candidate.id === activeAsset.id);
      if (activeIndex >= 0) {
        const windowFor = prefetchWindowFor(activeIndex, scopedMedia.length, playing);
        for (const index of [...windowFor.next, ...windowFor.previous]) {
          const candidate = scopedMedia[index];
          if (candidate) windowTargets.add(candidate.id);
        }
      }
    }
    for (const [assetId, state] of Object.entries(mediaReads)) {
      if (
        state.status === "ready"
        && windowTargets.has(assetId)
      ) {
        const asset = scopedMedia.find((candidate) => candidate.id === assetId);
        if (asset?.mimeType.startsWith("image/")) {
          decodeRegistryRef.current.ensure(assetId, state.url);
        }
      }
    }
  }, [mediaReads, activeAsset?.id, scopedMedia, playing]);

  // #11: when the incoming layer settles (transition end handled in the JSX),
  // the base layer follows. This effect covers the entry case: no incoming and
  // no settled frame yet, so the active frame becomes the base immediately.
  useEffect(() => {
    if (incomingAssetId !== null || shownAssetId !== null) return;
    if (activeAsset) setShownAssetId(activeAsset.id);
  }, [activeAsset?.id, incomingAssetId, shownAssetId]);

  // #11: under reduced motion the crossfade animation is disabled, so no
  // animationend fires; settle the stage as soon as the incoming frame mounts.
  useEffect(() => {
    if (incomingAssetId === null) return;
    if (!prefersReducedMotion()) return;
    const timer = window.setTimeout(() => settleIncoming(incomingAssetId), 16);
    return () => window.clearTimeout(timer);
  }, [incomingAssetId, settleIncoming]);

  // #11: a navigation target that was not decoded yet stays pending; the
  // current frame keeps showing until the target's read and decode settle,
  // then the switch fires with the incoming layer crossfading in.
  // Review P1: the effect re-runs on every decode settle revision, and when
  // the target's signed read is already ready it starts the decode so a
  // pending target can never stall.
  useEffect(() => {
    const pendingIndex = pendingTargetRef.current;
    if (pendingIndex === null) return;
    const target = scopedMedia[pendingIndex];
    if (!target) return;
    const targetRead = mediaReads[target.id];
    if (targetRead?.status === "ready" && target.mimeType.startsWith("image/")) {
      decodeRegistryRef.current.ensure(target.id, targetRead.url);
    }
    const ready = targetRead?.status === "ready"
      && (target.mimeType.startsWith("video/") || decodeRegistryRef.current.isDecoded(target.id));
    if (!ready) return;
    pendingTargetRef.current = null;
    setIncomingAssetId(target.id);
    setAssetIndex(pendingIndex);
  }, [decodeSettleRevision, mediaReads, scopedMedia, activeAsset?.id, playing]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const [assetId, state] of Object.entries(mediaReadsRef.current)) {
        if (
          state.status === "ready"
          && Number.isFinite(state.expiresAt)
          && state.expiresAt - now < MEDIA_READ_REFRESH_MARGIN_MS
        ) {
          loadMediaRead(assetId);
        }
      }
    }, MEDIA_READ_SWEEP_MS);
    return () => window.clearInterval(timer);
  }, [loadMediaRead]);

  const namedStops = useMemo(
    () => journey?.routePoints.filter((point) => point.isStop) ?? [],
    [journey],
  );

  if (!journey) return null;
  const selectedRoutePoint = selectedRoutePointId
    ? journey.routePoints.find((point) => point.id === selectedRoutePointId) ?? null
    : null;
  const asset = activeAsset;
  const read = asset ? mediaReads[asset.id] : null;
  // #11 two-layer stage: `shownAsset` is the settled base frame, `incoming`
  // (when present) is fading in on top. The base frame is released only after
  // the incoming one settles, so a switch never flashes an empty stage.
  const shownAsset = shownAssetId
    ? scopedMedia.find((candidate) => candidate.id === shownAssetId) ?? null
    : asset;
  const shownRead = shownAsset ? mediaReads[shownAsset.id] : null;
  const shownIndex = shownAsset
    ? scopedMedia.findIndex((candidate) => candidate.id === shownAsset.id)
    : -1;
  const incoming = incomingAssetId && incomingAssetId !== shownAssetId
    ? scopedMedia.find((candidate) => candidate.id === incomingAssetId) ?? null
    : null;
  const incomingRead = incoming ? mediaReads[incoming.id] : null;
  const fullMediaIndex = asset
    ? visualMedia.findIndex((candidate) => candidate.id === asset.id)
    : -1;
  const canMoveEarlier = asset && fullMediaIndex > 0
    && visualMedia[fullMediaIndex - 1].routePointId === asset.routePointId;
  const canMoveLater = asset && fullMediaIndex >= 0
    && fullMediaIndex < visualMedia.length - 1
    && visualMedia[fullMediaIndex + 1].routePointId === asset.routePointId;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;
  const uploadPercent = uploadState.status === "uploading" && uploadState.totalBytes > 0
    ? Math.round((uploadState.uploadedBytes / uploadState.totalBytes) * 100)
    : 0;
  const soundtrackPercent = soundtrackUpload.status === "uploading"
    && soundtrackUpload.totalBytes > 0
    ? Math.round((soundtrackUpload.uploadedBytes / soundtrackUpload.totalBytes) * 100)
    : 0;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) requestClose();
  }

  function scrollCopyFromMedia(event: WheelEvent<HTMLElement>) {
    if ((event.target as Element).closest(".journey-story__copy")) return;
    const copy = copyRef.current;
    if (!copy || copy.scrollHeight <= copy.clientHeight) return;
    copy.scrollTop += event.deltaY;
    event.preventDefault();
  }

  function mediaGestureCanStart(target: EventTarget | null, clientY: number) {
    if (!(target instanceof Element)) return false;
    const video = target.closest("video");
    if (video instanceof HTMLVideoElement) {
      // Keep the native scrubber/control strip untouched while still allowing
      // the upper video surface to participate in gesture-first navigation.
      const rect = video.getBoundingClientRect();
      const nativeControlGuard = Math.min(72, rect.height * 0.25);
      if (clientY >= rect.bottom - nativeControlGuard) return false;
    }
    return !target.closest("button, input, select, textarea, [role='button']");
  }

  function resolveMediaDragNeighbor(dx: number, wrap: boolean) {
    if (dx === 0 || scopedMedia.length < 2) return null;
    const direction = dx < 0 ? 1 : -1;
    let index = assetIndex + direction;
    if (wrap) {
      index = (index + scopedMedia.length) % scopedMedia.length;
    } else if (index < 0 || index >= scopedMedia.length) {
      return null;
    }
    const asset = scopedMedia[index];
    return asset ? { index, asset } : null;
  }

  function attachMediaDragPeek(container: HTMLElement, neighbor: JourneyMediaAsset | null) {
    if (!neighbor || !neighbor.mimeType.startsWith("image/")) return null;
    const read = mediaReads[neighbor.id];
    if (read?.status !== "ready") return null;
    const peek = container.querySelector<HTMLImageElement>("[data-media-drag-peek]");
    if (!peek) return null;
    peek.src = read.url;
    peek.style.display = "block";
    peek.classList.toggle("journey-story__media-drag-page", container === fullscreenRef.current);
    return peek;
  }

  function applyMediaDragTransform() {
    const drag = mediaDragRef.current;
    if (!drag) return;
    const dx = drag.neighborAsset ? drag.dx : drag.dx * 0.3;
    drag.base.style.transform = `translateX(${dx}px)`;
    if (drag.peek) {
      const edge = drag.dx < 0 ? drag.width : -drag.width;
      drag.peek.style.transform = `translateX(${edge + dx}px)`;
    }
  }

  function beginMediaDrag(container: HTMLElement | null, clientX: number, clientY: number, wrap: boolean) {
    if (!container || incomingAssetId !== null || mutationPending || overview || scopedMedia.length < 2) return;
    const base = container.querySelector<HTMLElement>(":scope > img, :scope > video");
    if (!base) return;
    base.classList.toggle("journey-story__media-drag-page", container === fullscreenRef.current);
    mediaDragRef.current = {
      container,
      base,
      peek: null,
      startX: clientX,
      startY: clientY,
      dx: 0,
      axis: null,
      wrap,
      neighborIndex: -1,
      neighborAsset: null,
      width: container.clientWidth,
    };
  }

  // Locks onto an axis (8px of intent) the first time either axis moves
  // enough to tell horizontal from vertical, then live-tracks the pointer
  // on the horizontal axis only; a vertical lock leaves the gesture alone so
  // the fullscreen stage's own swipe-down-to-exit keeps working unchanged.
  function updateMediaDrag(clientX: number, clientY: number) {
    const drag = mediaDragRef.current;
    if (!drag) return;
    if (drag.axis === null) {
      const dx = clientX - drag.startX;
      const dy = clientY - drag.startY;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.15) {
        drag.axis = "y";
        return;
      }
      drag.axis = "x";
    }
    if (drag.axis !== "x") return;
    drag.dx = clientX - drag.startX;
    const neighbor = resolveMediaDragNeighbor(drag.dx, drag.wrap);
    const neighborIndex = neighbor?.index ?? -1;
    if (neighborIndex !== drag.neighborIndex) {
      drag.neighborIndex = neighborIndex;
      drag.neighborAsset = neighbor?.asset ?? null;
      drag.peek = attachMediaDragPeek(drag.container, drag.neighborAsset);
    }
    applyMediaDragTransform();
  }

  function finishMediaDrag(drag: NonNullable<typeof mediaDragRef.current>) {
    drag.base.style.transition = "";
    drag.base.style.transform = "";
    drag.base.classList.remove("journey-story__media-drag-settle", "journey-story__media-drag-page");
    if (drag.peek) {
      drag.peek.style.transition = "";
      drag.peek.style.transform = "";
      drag.peek.style.display = "none";
      drag.peek.removeAttribute("src");
      drag.peek.classList.remove("journey-story__media-drag-settle", "journey-story__media-drag-page");
    }
  }

  // A neighbor with a cached read isn't necessarily safe to land on: images
  // also need their browser-side decode to finish (#11) or the settled
  // frame flashes an undecoded paint. Mirrors navigateToMedia's own check.
  function isMediaDragTargetReady(asset: JourneyMediaAsset) {
    const read = mediaReads[asset.id];
    return read?.status === "ready"
      && (asset.mimeType.startsWith("video/") || decodeRegistryRef.current.isDecoded(asset.id));
  }

  function landMediaDrag(asset: JourneyMediaAsset, index: number) {
    pendingTargetRef.current = null;
    setIncomingAssetId(null);
    setAssetIndex(index);
    setShownAssetId(asset.id);
  }

  // Commits to the neighbor the drag already dragged into view, or springs
  // the current frame back to rest. Committing lands directly on the
  // settled two-layer state (bypassing the crossfade above) because the
  // slide the user just watched *was* the transition — unless the target
  // wasn't actually ready yet (slow network outrunning a fast swipe), in
  // which case it falls back to the same pending-navigation path a
  // release-only swipe onto unready media already used, and only springs
  // back visually since landing on it now would flash an undecoded frame.
  function settleMediaDrag(commit: boolean) {
    const drag = mediaDragRef.current;
    mediaDragRef.current = null;
    if (!drag) return;
    const asset = commit ? drag.neighborAsset : null;
    const ready = asset !== null && isMediaDragTargetReady(asset);
    if (asset && !ready) {
      pendingTargetRef.current = drag.neighborIndex;
      const read = mediaReads[asset.id];
      if (read?.status !== "ready") {
        loadMediaRead(asset.id);
      } else if (asset.mimeType.startsWith("image/")) {
        decodeRegistryRef.current.ensure(asset.id, read.url);
      }
    }
    if (prefersReducedMotion()) {
      if (ready && asset) landMediaDrag(asset, drag.neighborIndex);
      finishMediaDrag(drag);
      return;
    }
    drag.base.classList.add("journey-story__media-drag-settle");
    if (drag.peek) drag.peek.classList.add("journey-story__media-drag-settle");
    if (ready && asset) {
      const index = drag.neighborIndex;
      const edge = drag.dx < 0 ? -drag.width : drag.width;
      drag.base.style.transform = `translateX(${edge}px)`;
      if (drag.peek) drag.peek.style.transform = "translateX(0)";
      window.setTimeout(() => {
        finishMediaDrag(drag);
        landMediaDrag(asset, index);
      }, MEDIA_DRAG_SETTLE_MS);
      return;
    }
    drag.base.style.transform = "translateX(0)";
    if (drag.peek) {
      const edge = drag.dx < 0 ? drag.width : -drag.width;
      drag.peek.style.transform = `translateX(${edge}px)`;
    }
    window.setTimeout(() => finishMediaDrag(drag), MEDIA_DRAG_SETTLE_MS);
  }

  function handleStoryMediaPointerDown(event: ReactPointerEvent<HTMLElement>) {
    storyMediaGestureConsumedRef.current = false;
    if (!mobileLayout || overview || !event.isPrimary || !mediaGestureCanStart(event.target, event.clientY)) return;
    beginMediaDrag(event.currentTarget, event.clientX, event.clientY, false);
  }

  function handleStoryMediaPointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary) return;
    updateMediaDrag(event.clientX, event.clientY);
  }

  function handleStoryMediaPointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary) return;
    const drag = mediaDragRef.current;
    // Only a committed swipe (>= the threshold, same as before this gesture
    // grew live tracking) suppresses the tap-to-fullscreen click that
    // otherwise follows this same release; a drag that axis-locked but
    // didn't cross the threshold still reads as a tap, same as pre-drag.
    const commit = Boolean(drag && drag.axis === "x" && Math.abs(drag.dx) >= MEDIA_DRAG_THRESHOLD_PX && drag.neighborAsset);
    if (commit) storyMediaGestureConsumedRef.current = true;
    settleMediaDrag(commit);
  }

  function handleStoryMediaPointerCancel() {
    settleMediaDrag(false);
  }

  function openImageFullscreenAfterTap() {
    if (mobileLayout && storyMediaGestureConsumedRef.current) {
      storyMediaGestureConsumedRef.current = false;
      return;
    }
    enterFullscreen(false);
  }

  function revealMobileFullscreenControls() {
    if (!mobileLayout || typeof window === "undefined") return;
    window.clearTimeout(fullscreenMobileIdleTimerRef.current);
    setFullscreenControlsHidden(false);
    fullscreenMobileIdleTimerRef.current = window.setTimeout(
      () => setFullscreenControlsHidden(true),
      2500,
    );
  }

  function handleFullscreenPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!mobileLayout || !event.isPrimary || !mediaGestureCanStart(event.target, event.clientY)) return;
    beginMediaDrag(event.currentTarget, event.clientX, event.clientY, true);
  }

  function handleFullscreenPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    updateMediaDrag(event.clientX, event.clientY);
  }

  function handleFullscreenPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!mobileLayout || !event.isPrimary) return;
    const drag = mediaDragRef.current;
    if (!drag) {
      revealMobileFullscreenControls();
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.axis === "x" && Math.abs(dx) >= MEDIA_DRAG_THRESHOLD_PX && drag.neighborAsset) {
      settleMediaDrag(true);
      return;
    }
    settleMediaDrag(false);
    if (dy >= 72 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      exitFullscreen();
      return;
    }
    if (drag.axis === null) revealMobileFullscreenControls();
  }

  function handleFullscreenPointerCancel() {
    settleMediaDrag(false);
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
          ? scopedVisualMedia(refreshedJourney)
          : [];
        if (refreshedMedia[firstNewAssetIndex]) {
          setAssetIndex(firstNewAssetIndex);
          setShownAssetId(refreshedMedia[firstNewAssetIndex].id);
          setIncomingAssetId(null);
          pendingTargetRef.current = null;
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

  async function confirmMediaDelete() {
    if (!asset || mutationPending) return;
    setMediaDeleteState("pending");
    setMediaDeleteMessage("");
    try {
      await (onMediaDelete ?? deleteMedia)(asset.id);
    } catch (error) {
      setMediaDeleteState("confirming");
      setMediaDeleteMessage(error instanceof Error ? error.message : "媒体删除失败，请稍后重试。");
      return;
    }
    if (onMediaDelete) {
      // The parent owns the state change in previews.
      setMediaDeleteState("idle");
      return;
    }
    try {
      const refreshedJourney = await onMediaAdded(journey.id);
      if (!refreshedJourney) {
        setUploadState({
          status: "complete",
          tone: "error",
          message: "媒体已删除，但当前列表刷新失败。重新打开这段旅程即可，不需要重复操作。",
        });
      }
    } catch {
      setUploadState({
        status: "complete",
        tone: "error",
        message: "媒体已删除，但当前列表刷新失败。重新打开这段旅程即可，不需要重复操作。",
      });
    }
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
  }

  async function moveMedia(direction: -1 | 1) {
    if (!asset || mutationPending) return;
    // Ordering is expressed over visual media only; the soundtrack keeps its
    // own position and is never part of the reorder payload.
    const currentIndex = visualMedia.findIndex((candidate) => candidate.id === asset.id);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= visualMedia.length) return;
    const neighbor = visualMedia[targetIndex];
    if (neighbor.routePointId !== asset.routePointId) return;

    const nextOrder = [...visualMedia];
    [nextOrder[currentIndex], nextOrder[targetIndex]] = [
      nextOrder[targetIndex],
      nextOrder[currentIndex],
    ];
    setOrderPending(true);
    setOrderMessage("");
    try {
      if (onMediaReorder) {
        // The parent owns the state change in previews.
        await onMediaReorder(journey.id, nextOrder.map((candidate) => candidate.id));
      } else {
        await reorderJourneyMedia(journey.id, nextOrder.map((candidate) => candidate.id));
        const refreshedJourney = await onMediaAdded(journey.id);
        const scoped = scopedVisualMedia(refreshedJourney ?? journey);
        const movedIndex = scoped.findIndex((candidate) => candidate.id === asset.id);
        if (movedIndex >= 0) {
          setAssetIndex(movedIndex);
          setShownAssetId(asset.id);
          setIncomingAssetId(null);
          pendingTargetRef.current = null;
        }
      }
    } catch (error) {
      setOrderMessage(error instanceof Error ? error.message : "顺序调整失败，请稍后重试。");
      return;
    } finally {
      setOrderPending(false);
    }
  }

  const mutationPending = uploading
    || deleteState === "pending"
    || mediaDeleteState === "pending"
    || soundtrackRemovePending
    || orderPending
    || coverPending;

  function selectMediaScope(routePointId: string | null) {
    if (mutationPending) return;
    setSelectedRoutePointId(routePointId);
    setAssetIndex(0);
    setShownAssetId(null);
    setIncomingAssetId(null);
    pendingTargetRef.current = null;
    setLocalMediaOrder(null);
    setOverview(false);
    setRetryFiles([]);
    setUploadState({ status: "idle" });
  }

  // #11: navigate to an index through the two-layer stage. The target must be
  // decoded before it replaces the current frame; otherwise the target stays
  // pending and the current frame remains until it settles.
  function navigateToMedia(index: number) {
    if (index < 0 || index >= scopedMedia.length) return;
    if (index === assetIndex) return;
    const target = scopedMedia[index];
    if (!target) return;
    const targetRead = mediaReads[target.id];
    const ready = targetRead?.status === "ready"
      && (target.mimeType.startsWith("video/") || decodeRegistryRef.current.isDecoded(target.id));
    if (ready) {
      setIncomingAssetId(target.id);
      setAssetIndex(index);
    } else {
      // Review P1: even when the read is already ready, a pending target
      // must start its decode; otherwise it can sit forever with a decoded
      // image that never triggers a re-check.
      pendingTargetRef.current = index;
      if (targetRead?.status !== "ready") {
        loadMediaRead(target.id);
      } else if (target.mimeType.startsWith("image/")) {
        decodeRegistryRef.current.ensure(target.id, targetRead.url);
      }
    }
  }

  // #18: overview tile -> single-media stage. The clicked tile itself is the
  // source; when its signed read is already ready we promote that exact asset
  // directly to the settled base layer so the morph never lands on a loading
  // frame. Unsupported browsers use the WAAPI fixed-clone fallback.
  function selectMediaIndex(index: number, tile: HTMLButtonElement) {
    const target = scopedMedia[index];
    if (!target) return;
    const targetRead = mediaReads[target.id];
    const sourceElement = tile.querySelector<HTMLElement>("img") ?? tile;
    runSharedElementMorph({
      source: sourceElement,
      name: `story-media-${target.id}`,
      update: () => {
        if (targetRead?.status === "ready") {
          pendingTargetRef.current = null;
          setIncomingAssetId(null);
          setAssetIndex(index);
          setShownAssetId(target.id);
          if (target.mimeType.startsWith("image/")) {
            decodeRegistryRef.current.ensure(target.id, targetRead.url);
          }
        } else {
          navigateToMedia(index);
        }
        setOverview(false);
      },
      resolveTarget: () => dialogRef.current?.querySelector<HTMLElement>(
        ".journey-story__media > img, .journey-story__media > video",
      ) ?? null,
    });
  }

  function toggleMediaOverview() {
    if (overview) {
      const tile = dialogRef.current?.querySelector<HTMLButtonElement>(
        `.journey-story__media-grid [data-media-tile-index="${assetIndex}"]`,
      );
      if (tile) {
        selectMediaIndex(assetIndex, tile);
      } else {
        setOverview(false);
      }
      return;
    }

    const current = scopedMedia[assetIndex];
    const source = dialogRef.current?.querySelector<HTMLElement>(
      ".journey-story__media > img, .journey-story__media > video",
    ) ?? null;
    runSharedElementMorph({
      source,
      name: `story-media-${current?.id ?? "current"}`,
      update: () => {
        setPlaying(false);
        setOverview(true);
      },
      resolveTarget: () => {
        const tile = dialogRef.current?.querySelector<HTMLButtonElement>(
          `.journey-story__media-grid [data-media-tile-index="${assetIndex}"]`,
        );
        return tile?.querySelector<HTMLElement>("img") ?? tile ?? null;
      },
    });
  }

  // #12: overview drag-and-drop reordering. Pointer (mouse + touch) and
  // keyboard; keyboard uses sortable arrow-key coordinates. Review P2: the
  // pointer sensor uses a small distance for mouse but a long-press (delay)
  // activation on touch so a scrollable grid does not fight the drag.
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handleMediaReorderEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = scopedMedia.findIndex((candidate) => candidate.id === active.id);
    const newIndex = scopedMedia.findIndex((candidate) => candidate.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    // Review P2: optimistic — apply the new scope order to the grid
    // immediately, then persist; rollback clears the local order so the grid
    // follows server truth on failure.
    const nextScoped = arrayMove(scopedMedia, oldIndex, newIndex);
    const nextVisual = applyScopeReorder(
      visualMedia,
      selectedRoutePointId,
      nextScoped.map((candidate) => candidate.id),
    );
    const nextAssetIndex = nextScoped.findIndex(
      (candidate) => candidate.id === active.id,
    );
    setLocalMediaOrder(nextScoped.map((candidate) => candidate.id));
    setOrderPending(true);
    setOrderMessage("");
    try {
      if (onMediaReorder) {
        await onMediaReorder(journey.id, nextVisual.map((candidate) => candidate.id));
      } else {
        await reorderJourneyMedia(journey.id, nextVisual.map((candidate) => candidate.id));
        const refreshedJourney = await onMediaAdded(journey.id);
        if (refreshedJourney) {
          const refreshedScoped = scopedVisualMedia(refreshedJourney);
          setAssetIndex((current) => Math.min(current, Math.max(0, refreshedScoped.length - 1)));
          setShownAssetId(null);
          setIncomingAssetId(null);
          pendingTargetRef.current = null;
        }
      }
      setAssetIndex(Math.max(0, nextAssetIndex));
    } catch (error) {
      setOrderMessage(error instanceof Error ? error.message : "顺序调整失败，请稍后重试。");
      // Rollback: drop the optimistic order; the grid returns to server truth.
      setLocalMediaOrder(null);
    } finally {
      setOrderPending(false);
      setLocalMediaOrder(null);
    }
  }

  // #14: set this journey's cover media. The parent owns journey state; after
  // the API call we ask it to refresh, so the card updates immediately and a
  // failure rolls back to server truth.
  async function handleSetCover(assetId: string) {
    if (!journey || coverPending || mutationPending) return;
    setCoverPending(true);
    setOrderMessage("");
    try {
      await setJourneyCover(journey.id, assetId);
      await onMediaAdded(journey.id);
    } catch (error) {
      setOrderMessage(error instanceof Error ? error.message : "封面设置失败，请稍后重试。");
    } finally {
      setCoverPending(false);
    }
  }

  function setPlayingFromGesture(willPlay: boolean) {
    const audio = audioRef.current;
    // #20: establish the analyser graph in the same user gesture that starts
    // audio. If Web Audio/CORS is unavailable the sampler fails closed and the
    // ordinary audio element still plays with the static/CSS fallback.
    if (willPlay && audio && soundtrackRead?.status === "ready") {
      if (!prefersReducedMotion()) audioSamplerRef.current.start(audio);
      audioSamplerRef.current.setPlaying(true);
      void audio.play().catch(() => undefined);
    } else if (!willPlay) {
      audioSamplerRef.current.setPlaying(false);
    }
    setPlaying(willPlay);
  }

  function togglePlaying() {
    // Autoplay always runs on a single item, so entering it leaves the grid.
    setOverview(false);
    setPlayingFromGesture(!playingRef.current);
  }

  async function uploadSoundtrack(file: File) {
    setSoundtrackNotice("");
    setCloseBlocked(false);
    const validation = validateJourneySoundtrack([file]);
    if (!validation.accepted) {
      setSoundtrackUpload({
        status: "complete",
        tone: "error",
        message: validation.errors[0],
      });
      return;
    }

    const replaced = soundtrack;
    setSoundtrackUpload({
      status: "uploading",
      fileName: file.name,
      uploadedBytes: 0,
      totalBytes: file.size,
    });
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: replaced,
      refresh: onMediaAdded,
      remove: onMediaDelete ?? deleteMedia,
      onProgress: (progress) => setSoundtrackUpload({ status: "uploading", ...progress }),
    });
    setCloseBlocked(false);

    if (!result.uploaded) {
      setSoundtrackUpload({
        status: "complete",
        tone: "error",
        message: formatUploadError(result.uploadError ?? "配乐上传失败，请稍后重试。"),
      });
      return;
    }

    if (result.cleanupFailed && replaced) {
      setSoundtrackNotice(
        `新配乐已生效，但旧配乐「${replaced.fileName}」没有清理成功，可以稍后再移除。`,
      );
    }

    setSoundtrackUpload({
      status: "complete",
      tone: result.refreshFailed ? "error" : "success",
      message: result.refreshFailed
        ? "配乐已上传，但当前列表刷新失败。重新打开这段旅程即可看到，不需要重复上传。"
        : result.unchanged
        ? `「${file.name}」已经是这段旅程的配乐，没有变化。`
        : `已把「${file.name}」设为这段旅程的配乐。`,
    });
  }

  function selectSoundtrack(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (selected.length > 0) void uploadSoundtrack(selected[0]);
  }

  async function removeSoundtrack() {
    if (!soundtrack || mutationPending) return;
    setSoundtrackRemovePending(true);
    setSoundtrackNotice("");
    setPlaying(false);
    audioSamplerRef.current.setPlaying(false);
    resetAudioAtmosphereEnergy();
    try {
      await (onMediaDelete ?? deleteMedia)(soundtrack.id);
      if (!onMediaDelete) await onMediaAdded(journey.id);
      setSoundtrackUpload({
        status: "complete",
        tone: "success",
        message: "配乐已移除，幻灯片会安静播放。",
      });
    } catch (error) {
      setSoundtrackUpload({
        status: "complete",
        tone: "error",
        message: error instanceof Error ? error.message : "配乐移除失败，请稍后重试。",
      });
    } finally {
      setSoundtrackRemovePending(false);
    }
  }

  const content = (
    <div className="journey-story-backdrop" role="presentation" onClick={closeFromBackdrop}>
      <article ref={dialogRef} tabIndex={-1} className="journey-story motion-staged" role="dialog" aria-modal="true" aria-labelledby="journey-story-title" onWheel={scrollCopyFromMedia}>
        <header>
          <div>
            <p>PRIVATE JOURNEY · {journeyRange(journey)}</p>
            <h2 id="journey-story-title">{journey.title}</h2>
          </div>
          {/* An upload in flight keeps this button clickable so pressing it
              explains the wait instead of silently doing nothing. */}
          <button className="journey-story__close" type="button" disabled={mutationPending && !uploading} onClick={requestClose} aria-label="退出旅程故事">
            <span>{deleteState === "pending" ? "删除中" : uploading ? "上传中" : "退出"}</span><IconX size={19} stroke={1.35} aria-hidden="true" />
          </button>
        </header>

        {closeBlocked && uploading ? (
          <p className="journey-story__close-blocked" role="status">正在完成分块上传，完成后即可安全退出。</p>
        ) : null}

        <div className="journey-story__layout">
          <section
            className="journey-story__media"
            aria-label="旅程媒体"
            data-mobile-layout={mobileLayout ? "true" : undefined}
            onPointerDown={handleStoryMediaPointerDown}
            onPointerMove={handleStoryMediaPointerMove}
            onPointerUp={handleStoryMediaPointerUp}
            onPointerCancel={handleStoryMediaPointerCancel}
          >
            {!asset ? <div className="journey-story__empty-media"><IconPhoto size={36} stroke={1.05} style={{ color: journey.lightColor }} aria-hidden="true" />{selectedRoutePoint ? "这个途径点还没有媒体" : "整段旅程还没有媒体"}</div> : null}
            {scopedMedia.length > 1 && !mobileLayout ? (
              <button
                type="button"
                className={`journey-story__media-overview${overview ? " is-active" : ""}`}
                aria-pressed={overview}
                onClick={toggleMediaOverview}
              >
                <IconLayoutGrid size={16} stroke={1.35} aria-hidden="true" />
                {overview ? "返回单张" : "全部照片"}
              </button>
            ) : null}
            {!overview && asset && read?.status === "ready" && !mobileLayout ? (
              <button
                type="button"
                className="journey-story__fullscreen-entry"
                aria-label="全屏播放"
                title="全屏播放"
                onClick={() => enterFullscreen(scopedMedia.length > 1)}
              >
                <IconMaximize size={16} stroke={1.35} aria-hidden="true" />
              </button>
            ) : null}
            {overview && mobileLayout ? (
              <button
                type="button"
                className="journey-story__mobile-sort-done"
                onClick={() => setOverview(false)}
              >
                完成
              </button>
            ) : null}
            {overview ? (
              <DndContext
                sensors={dragSensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => void handleMediaReorderEnd(event)}
              >
                <SortableContext
                  items={orderedScopedMedia.map((candidate) => candidate.id)}
                  strategy={rectSortingStrategy}
                >
                  <ul className="journey-story__media-grid" aria-label={`全部媒体，共 ${orderedScopedMedia.length} 个`}>
                    {orderedScopedMedia.map((tile, index) => (
                      <SortableMediaTile
                        key={tile.id}
                        asset={tile}
                        index={index}
                        isCurrent={index === assetIndex}
                        isCover={cover?.id === tile.id}
                        read={mediaReads[tile.id]}
                        disabled={mutationPending}
                        onRequestRead={loadMediaRead}
                        onSelect={selectMediaIndex}
                        onSetCover={mobileLayout ? undefined : handleSetCover}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            ) : null}
            {!overview && shownAsset && (!shownRead || shownRead.status === "loading") ? <div className="journey-story__media-state">正在打开私有媒体…</div> : null}
            {!overview && shownAsset && shownRead?.status === "error" ? <div className="journey-story__media-state is-error">{shownRead.message}</div> : null}
            {!overview && shownAsset && shownRead?.status === "ready" && shownAsset.mimeType.startsWith("video/") ? (
              <video
                key={`media-${shownAsset.id}`}
                src={shownRead.url}
                controls
                playsInline
                preload="metadata"
                data-shared-media-id={shownAsset.id}
                data-shared-journey-cover={cover?.id === shownAsset.id ? "true" : undefined}
              />
            ) : null}
            {!overview && shownAsset && shownRead?.status === "ready" && !shownAsset.mimeType.startsWith("video/") ? (
              <img
                key={`media-${shownAsset.id}`}
                className={playing && scopedMedia.length > 1
                  ? `is-kenburns kenburns-${shownIndex % 2}`
                  : "is-zoomable"}
                src={shownRead.url}
                alt={shownAsset.fileName}
                data-shared-media-id={shownAsset.id}
                data-shared-journey-cover={cover?.id === shownAsset.id ? "true" : undefined}
                onClick={openImageFullscreenAfterTap}
              />
            ) : null}
            {!overview && incoming && incomingRead?.status === "ready" && !incoming.mimeType.startsWith("video/") ? (
              <img
                key={`media-${incoming.id}`}
                className={`journey-story__media-incoming${playing && scopedMedia.length > 1 ? " is-kenburns" : ""}`}
                src={incomingRead.url}
                alt={incoming.fileName}
                onAnimationEnd={(event) => {
                  // Settle the stage only once the fade completes; the base
                  // frame is released after this, never before.
                  if (event.target === event.currentTarget && event.animationName === "motionMediaIn") {
                    settleIncoming(incoming.id);
                  }
                }}
                onClick={openImageFullscreenAfterTap}
              />
            ) : null}
            {!overview && incoming && incomingRead?.status === "ready" && incoming.mimeType.startsWith("video/") ? (
              <video
                key={`media-${incoming.id}`}
                className="journey-story__media-incoming"
                src={incomingRead.url}
                controls
                playsInline
                preload="metadata"
                onAnimationEnd={(event) => {
                  if (event.target === event.currentTarget && event.animationName === "motionMediaIn") {
                    settleIncoming(incoming.id);
                  }
                }}
              />
            ) : null}
            {mobileLayout && !overview ? (
              <img
                data-media-drag-peek
                alt=""
                aria-hidden="true"
                style={{ display: "none" }}
              />
            ) : null}
            {!mobileLayout && !overview && (scopedMedia.length > 1 || visualMedia.length > 1) ? (
              <div className="journey-story__media-controls">
                <nav className="journey-story__media-nav" aria-label="媒体导航">
                <button
                  type="button"
                  className={playing ? "is-active" : ""}
                  disabled={mutationPending || scopedMedia.length < 2}
                  onClick={togglePlaying}
                  aria-label={playing ? "暂停自动播放" : "自动播放照片"}
                  aria-pressed={playing}
                >
                  {playing
                    ? <IconPlayerPause size={17} stroke={1.35} aria-hidden="true" />
                    : <IconPlayerPlay size={17} stroke={1.35} aria-hidden="true" />}
                </button>
                <button type="button" disabled={assetIndex === 0 || mutationPending} onClick={() => navigateToMedia(assetIndex - 1)} aria-label="上一个媒体"><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" /></button>
                <span>{scopedMedia.length > 0 ? `${assetIndex + 1} / ${scopedMedia.length}` : "0 / 0"}</span>
                <button type="button" disabled={assetIndex === scopedMedia.length - 1 || mutationPending} onClick={() => navigateToMedia(assetIndex + 1)} aria-label="下一个媒体"><IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
                </nav>
                {asset && visualMedia.length > 1 ? (
                  <div className="journey-story__media-order" role="group" aria-label="媒体排序">
                    <span>排序</span>
                    <IconActionButton type="button" disabled={!canMoveEarlier || mutationPending} onClick={() => void moveMedia(-1)} label="向前调整媒体顺序" tooltip="上移媒体"><IconArrowUp size={16} stroke={1.35} aria-hidden="true" /></IconActionButton>
                    <IconActionButton type="button" disabled={!canMoveLater || mutationPending} onClick={() => void moveMedia(1)} label="向后调整媒体顺序" tooltip="下移媒体"><IconArrowDown size={16} stroke={1.35} aria-hidden="true" /></IconActionButton>
                  </div>
                ) : null}
              </div>
            ) : null}
            {orderMessage ? <p className="journey-story__order-message" role="status">{orderMessage}</p> : null}
            {mobileLayout && !overview && asset ? (
              <div className="journey-story__mobile-media-actions">
                <IconActionButton
                  type="button"
                  className="journey-story__mobile-media-menu-trigger"
                  label="管理当前媒体"
                  tooltip="管理媒体"
                  aria-expanded={mobileMediaMenuOpen}
                  aria-hidden={mediaDeleteState !== "idle"}
                  tabIndex={mediaDeleteState === "idle" ? 0 : -1}
                  style={mediaDeleteState === "idle" ? undefined : { visibility: "hidden", pointerEvents: "none" }}
                  disabled={mutationPending}
                  onClick={() => setMobileMediaMenuOpen((open) => !open)}
                >
                  <IconDots size={19} stroke={1.5} aria-hidden="true" />
                </IconActionButton>
                {mobileMediaMenuOpen && mediaDeleteState === "idle" ? (
                  <>
                    <button
                      type="button"
                      className="journey-story__mobile-media-sheet-backdrop"
                      aria-label="关闭媒体管理"
                      onClick={() => setMobileMediaMenuOpen(false)}
                    />
                    <section ref={mobileMediaSheetRef} tabIndex={-1} data-focus-trap-exempt="true" className="journey-story__mobile-media-sheet" role="dialog" aria-modal="true" aria-label="媒体管理">
                      <div>
                        <small>当前媒体</small>
                        <strong>{asset.fileName}</strong>
                      </div>
                      {cover?.id !== asset.id ? (
                        <button
                          type="button"
                          disabled={mutationPending || coverPending}
                          onClick={() => {
                            setMobileMediaMenuOpen(false);
                            void handleSetCover(asset.id);
                          }}
                        >
                          <IconPhotoStar size={18} stroke={1.35} aria-hidden="true" />
                          设为旅程封面
                        </button>
                      ) : <p className="journey-story__mobile-media-sheet-current">当前旅程封面</p>}
                      {scopedMedia.length > 1 ? (
                        <button
                          type="button"
                          disabled={mutationPending}
                          onClick={() => {
                            setPlaying(false);
                            setMobileMediaMenuOpen(false);
                            setOverview(true);
                          }}
                        >
                          <IconLayoutGrid size={18} stroke={1.35} aria-hidden="true" />
                          整理媒体
                        </button>
                      ) : null}
                      <button type="button" disabled={mutationPending} onClick={() => enterFullscreen(scopedMedia.length > 1)}>
                        <IconPlayerPlay size={18} stroke={1.35} aria-hidden="true" />
                        {scopedMedia.length > 1 ? "沉浸播放" : "沉浸查看"}
                      </button>
                      <button
                        type="button"
                        className="is-destructive"
                        disabled={mutationPending}
                        onClick={() => {
                          setMobileMediaMenuOpen(false);
                          setMediaDeleteState("confirming");
                        }}
                      >
                        <IconTrash size={18} stroke={1.35} aria-hidden="true" />
                        删除媒体
                      </button>
                    </section>
                  </>
                ) : null}
                {mediaDeleteState !== "idle" ? (
                  <>
                    <button
                      type="button"
                      className="journey-story__mobile-media-sheet-backdrop"
                      aria-label="取消删除媒体"
                      disabled={mediaDeleteState === "pending"}
                      onClick={closeMobileMediaDelete}
                    />
                    <section ref={mobileMediaSheetRef} tabIndex={-1} data-focus-trap-exempt="true" className="journey-story__mobile-media-sheet is-confirming" role="alertdialog" aria-modal="true" aria-label="确认删除媒体">
                      <div>
                        <small>删除媒体</small>
                        <strong>确定删除这段媒体？</strong>
                      </div>
                      <p>这个操作需要再次确认，不会由滑动手势直接触发。</p>
                      <div className="journey-story__mobile-media-confirm-actions">
                        <button ref={mediaDeleteCancelRef} type="button" disabled={mediaDeleteState === "pending"} onClick={closeMobileMediaDelete}>取消</button>
                        <button className="is-destructive" type="button" disabled={mediaDeleteState === "pending"} onClick={() => void confirmMediaDelete()}>{mediaDeleteState === "pending" ? "正在删除…" : "确认删除"}</button>
                      </div>
                      {mediaDeleteMessage ? <p className="journey-story__media-remove__error" role="alert">{mediaDeleteMessage}</p> : null}
                    </section>
                  </>
                ) : null}
              </div>
            ) : null}
            {!mobileLayout && !overview && asset ? (
              <div className="journey-story__media-actions">
                {mediaDeleteState === "idle" ? (
                  cover?.id !== asset.id ? (
                    <IconActionButton
                      type="button"
                      className="journey-story__media-set-cover"
                      label="将当前媒体设为封面"
                      tooltip="设为封面"
                      disabled={mutationPending || coverPending}
                      onClick={() => void handleSetCover(asset.id)}
                    >
                      <IconPhotoStar size={17} stroke={1.35} aria-hidden="true" />
                    </IconActionButton>
                  ) : (
                    <span className="journey-story__media-cover-current">当前封面</span>
                  )
                ) : null}
                <div className="journey-story__media-remove">
                  {mediaDeleteState === "idle" ? (
                    <IconActionButton type="button" className="is-destructive-secondary" disabled={mutationPending} onClick={() => setMediaDeleteState("confirming")} label="删除这段媒体" tooltip="删除媒体">
                      <IconTrash size={17} stroke={1.35} aria-hidden="true" />
                    </IconActionButton>
                  ) : (
                    <div className="journey-story__media-remove__confirm" role="group" aria-label="确认删除媒体">
                      <span>删除这段媒体？</span>
                      <button ref={mediaDeleteCancelRef} type="button" disabled={mediaDeleteState === "pending"} onClick={() => { setMediaDeleteState("idle"); setMediaDeleteMessage(""); }}>取消</button>
                      <button className="is-destructive" type="button" disabled={mediaDeleteState === "pending"} onClick={() => void confirmMediaDelete()}>{mediaDeleteState === "pending" ? "正在删除…" : "确认删除"}</button>
                      {mediaDeleteMessage ? <p className="journey-story__media-remove__error" role="alert">{mediaDeleteMessage}</p> : null}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </section>

          <section ref={copyRef} className="journey-story__copy">
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
                <small>{visualMediaCount(null)}</small>
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
                  <small>{visualMediaCount(point.id)}</small>
                </button>
              ))}
            </nav>
            <dl>
              <div><dt>ROUTE POINTS</dt><dd>{journey.routePoints.length}</dd></div>
              <div><dt>STOPS</dt><dd>{namedStops.length}</dd></div>
            </dl>
            {namedStops.length > 0 ? <p className="journey-story__stops">{namedStops.map((stop) => stop.label).join(" · ")}</p> : null}
            {/* #10: a selected route point shows its own note near the place
                name — distinct from system metadata. Journey-scoped view never
                fabricates a note. */}
            {selectedRoutePoint && selectedRoutePoint.note ? (
              <blockquote className="journey-story__point-note">{selectedRoutePoint.note}</blockquote>
            ) : null}
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
              {uploadState.status === "complete" ? (
                <p className={`journey-story__upload-message is-${uploadState.tone}`} role="status">{uploadState.message}</p>
              ) : null}
              {retryFiles.length > 0 && uploadState.status !== "uploading" ? (
                <button className="journey-story__retry" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => void uploadFiles(retryFiles)}>
                  重试失败的 {retryFiles.length} 个文件
                </button>
              ) : null}
            </div>

            <div className={`journey-story__soundtrack${soundtrack && soundtrackRead?.status === "ready" ? " has-track" : ""}${playing ? " is-playing" : ""}`}>
              <div className="journey-story__soundtrack-head">
                <p>JOURNEY SOUNDTRACK</p>
                <strong>{soundtrack ? stripMediaExtension(soundtrack.fileName) : "还没有配乐，幻灯片会安静播放"}</strong>
              </div>
              {/* #7: the audio element is a hidden playback engine only — no
                  native control bar; play/pause follows the slideshow. */}
              {soundtrack && soundtrackRead?.status === "ready" ? (
                <audio
                  ref={audioRef}
                  key={soundtrack.id}
                  src={soundtrackRead.url}
                  loop
                  preload="metadata"
                  tabIndex={-1}
                  aria-hidden="true"
                />
              ) : null}
              {/* Light strip: a subtle flowing gradient while playing, static
                  otherwise; reduced motion keeps it static (#7). */}
              <div ref={soundtrackLightRef} className="journey-story__soundtrack-light" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {soundtrack && (!soundtrackRead || soundtrackRead.status === "loading") ? (
                <p className="journey-story__upload-message" role="status">正在打开配乐…</p>
              ) : null}
              {soundtrack && soundtrackRead?.status === "error" ? (
                <p className="journey-story__upload-message is-error" role="alert">{soundtrackRead.message}</p>
              ) : null}
              <input
                ref={soundtrackInputRef}
                type="file"
                accept={SOUNDTRACK_INPUT_ACCEPT}
                tabIndex={-1}
                aria-hidden="true"
                disabled={mutationPending || deleteState !== "idle"}
                onChange={selectSoundtrack}
              />
              <div className="journey-story__soundtrack-actions">
                <button
                  type="button"
                  disabled={mutationPending || deleteState !== "idle"}
                  onClick={() => soundtrackInputRef.current?.click()}
                >
                  <IconMusic size={17} stroke={1.35} aria-hidden="true" />
                  {soundtrackUpload.status === "uploading"
                    ? `正在上传 ${soundtrackPercent}%`
                    : soundtrack ? "替换配乐" : "上传配乐"}
                </button>
                {soundtrack ? (
                  <button
                    className="is-destructive"
                    type="button"
                    disabled={mutationPending || deleteState !== "idle"}
                    onClick={() => void removeSoundtrack()}
                  >
                    <IconTrash size={17} stroke={1.35} aria-hidden="true" />
                    {soundtrackRemovePending ? "正在移除…" : "移除配乐"}
                  </button>
                ) : null}
              </div>
              {soundtrackUpload.status === "uploading" ? (
                <div
                  className="journey-story__upload-progress"
                  role="progressbar"
                  aria-label={`正在上传 ${soundtrackUpload.fileName}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={soundtrackPercent}
                >
                  <span style={{ width: `${soundtrackPercent}%` }} />
                  <small>{soundtrackUpload.fileName}</small>
                </div>
              ) : null}
              {soundtrackUpload.status === "complete" ? (
                <p className={`journey-story__upload-message is-${soundtrackUpload.tone}`} role="status">{soundtrackUpload.message}</p>
              ) : null}
              {soundtrackNotice ? (
                <p className="journey-story__upload-message is-error" role="status">{soundtrackNotice}</p>
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

      {fullscreen && asset && read?.status === "ready" ? (
        <div
          ref={fullscreenRef}
          className={`journey-story-fullscreen${fullscreenControlsHidden ? " is-controls-hidden" : ""}${playing ? " is-playing" : ""}`}
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          data-focus-trap-exempt="true"
          data-mobile-layout={mobileLayout ? "true" : undefined}
          aria-label="沉浸播放媒体"
          onPointerDown={handleFullscreenPointerDown}
          onPointerMove={handleFullscreenPointerMove}
          onPointerUp={handleFullscreenPointerUp}
          onPointerCancel={handleFullscreenPointerCancel}
          onClick={(event) => {
            if (!mobileLayout && event.target === event.currentTarget) exitFullscreen();
          }}
        >
          <button className="journey-story-fullscreen__close" type="button" onClick={() => exitFullscreen()} aria-label="退出沉浸媒体"><IconX size={22} stroke={1.35} aria-hidden="true" /></button>
          {/* #11 two-layer stage also serves fullscreen: the incoming frame
              crossfades over the settled base frame without flashing. */}
          {shownAsset && shownRead?.status === "ready" && shownAsset.mimeType.startsWith("video/")
            ? <video key={`media-${shownAsset.id}`} src={shownRead.url} controls autoPlay playsInline />
            : shownAsset && shownRead?.status === "ready"
              ? <img key={`media-${shownAsset.id}`} src={shownRead.url} alt={shownAsset.fileName} />
              : null}
          {incoming && incomingRead?.status === "ready" && incoming.mimeType.startsWith("video/")
            ? <video key={`media-${incoming.id}`} className="journey-story__media-incoming" src={incomingRead.url} autoPlay playsInline onAnimationEnd={(event) => { if (event.target === event.currentTarget && event.animationName === "motionMediaIn") settleIncoming(incoming.id); }} />
            : incoming && incomingRead?.status === "ready"
              ? <img key={`media-${incoming.id}`} className="journey-story__media-incoming" src={incomingRead.url} alt={incoming.fileName} onAnimationEnd={(event) => { if (event.target === event.currentTarget && event.animationName === "motionMediaIn") settleIncoming(incoming.id); }} />
              : null}
          {mobileLayout ? <img data-media-drag-peek alt="" aria-hidden="true" style={{ display: "none" }} /> : null}
          {scopedMedia.length > 1 ? (
            <nav className="journey-story-fullscreen__nav" aria-label="全屏媒体导航">
              <button
                type="button"
                onClick={() => navigateToMedia((assetIndex - 1 + scopedMedia.length) % scopedMedia.length)}
                aria-label="上一个媒体"
              >
                <IconArrowLeft size={22} stroke={1.35} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={playing ? "is-active" : ""}
                onClick={togglePlaying}
                aria-label={playing ? "暂停自动播放" : "自动播放照片"}
                aria-pressed={playing}
              >
                {playing
                  ? <IconPlayerPause size={22} stroke={1.35} aria-hidden="true" />
                  : <IconPlayerPlay size={22} stroke={1.35} aria-hidden="true" />}
              </button>
              <span>{assetIndex + 1} / {scopedMedia.length}</span>
              <button
                type="button"
                onClick={() => navigateToMedia((assetIndex + 1) % scopedMedia.length)}
                aria-label="下一个媒体"
              >
                <IconArrowRight size={22} stroke={1.35} aria-hidden="true" />
              </button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
