import {
  type StoryLogicalObservation,
  storyLogicalObservation,
  storyMediaNeighborIndex,
  storyAssetIndexForId,
  indexStoryMedia,
  storyMediaInOptimisticOrder,
  storyAutoplayVideoCandidate,
  storyNavigationTargetDisposition,
  storyAutoplayCanStart,
  storyImmersiveEntryKeepsPlaying,
  storyStageVideoOwner,
  STORY_AUTOPLAY_STEP_MS,
  STORY_VIDEO_STALL_WATCHDOG_MS,
  storyAutoplayAdvance,
  storyMediaAvailability,
  storyAutoplayWaitsForVideoEnd,
  storyUploadedAssetIndex,
  groupedPlacementRefreshSelection,
  storyInitialMediaSelection,
} from "./storyMediaPolicy";
import {
  mobileStoryExpandedForLayout,
  storyFullscreenTargetIsCurrent,
  type StoryGlobeCoverState,
  storyGlobeCoverState,
  mobileStoryHistoryLayers,
  showMobileStoryPlayControl,
  showMobileStoryFullscreenControl,
  journeyDeleteDescription,
} from "./storySurfacePolicy";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconDots,
  IconEdit,
  IconLayoutGrid,
  IconMaximize,
  IconMusic,
  IconPhoto,
  IconPhotoStar,
  IconPlayerPause,
  IconPlayerPlay,
  IconShare,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "@tabler/icons-react";
import { IconActionButton } from "../components/IconActionButton";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import { StoryMediaRail } from "./StoryMediaRail";
import { StoryMediaPages, type StoryMediaGestureCancel, type StoryMediaPagesHandle } from "./StoryMediaPages";
import { StoryMediaOrganizer } from "./StoryMediaOrganizer";
import { StoryNotesEditor, type StoryNotesSaveState } from "./StoryNotesEditor";
import { CoverRevealRequest } from "./CoverRevealRequest";
import { MEDIA_STACK_DURATION, mediaStackNeighbors } from "./mediaStackMotion";
import "../styles/starlight-media.css";
import "../styles/story-experience.css";
import {
  JourneyApiError,
  type JourneyMediaMoveUndo,
} from "./journeyApi";
import { useAtlasView, type AtlasMutations, type UploadJourneyMedia } from "./atlasView";
import { shouldRefreshStoryMediaRead, type MediaReadState } from "./mediaReadRefresh";
import { mediaPreviewLayer } from "./mediaPreviewLayer";
import { cancelSharedElementMorph, runSharedElementMorph } from "../motion/primitives/sharedElement";
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
import { playbackIntroMedia, storyMediaForScope } from "./journeyPlayback";
import type { Journey, JourneyInput, JourneyMediaAsset } from "./types";
import {
  completeMediaPlacementUploadPlan,
  groupMediaPlacementSuggestions,
  readMediaPlacementSignal,
  type MediaPlacementBatchResult,
} from "./mediaPlacement";
import { createPlacementAnalysisAuthority, placementAnalysisScope, type PlacementAnalysisIntent } from "./placementAnalysisAuthority";
import { isModalFocusCandidate, useModalFocus, useNestedModalFocus } from "./useModalFocus";
import { useCompactMobileLayout } from "./mobileLayout";
import { useMobileSurfaceHistory } from "./useMobileSurfaceHistory";
import "../styles/story-notes.css";

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

const MEDIA_READ_SWEEP_MS = 20_000;
// Mobile drag settles after distance/velocity intent is resolved by
// mediaSwipeDecision; keep the visual snap duration independent of that input.
const MEDIA_DRAG_SETTLE_MS = MEDIA_STACK_DURATION;

export function finalizeMediaDragCommit(
  commit: () => void,
  cleanup: () => void,
  syncCommit: (callback: () => void) => void = flushSync,
) {
  syncCommit(commit);
  cleanup();
}

export function scheduleCancelableMediaDragSettle(
  run: () => void,
  cleanup: () => void,
  delayMs: number = MEDIA_DRAG_SETTLE_MS,
  schedule: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  cancel: (timerId: number) => void = (timerId) => window.clearTimeout(timerId),
) {
  let active = true;
  const timerId = schedule(() => {
    if (!active) return;
    active = false;
    run();
  }, delayMs);
  return () => {
    if (!active) return;
    active = false;
    cancel(timerId);
    cleanup();
  };
}

export function scheduleCancelableDeferredFullscreenEntry(
  run: () => void,
  capturedScopeRevision: number,
  currentScopeRevision: () => number,
  delayMs: number = MEDIA_DRAG_SETTLE_MS,
  schedule: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  cancel: (timerId: number) => void = (timerId) => window.clearTimeout(timerId),
) {
  let active = true;
  const timerId = schedule(() => {
    if (!active) return;
    active = false;
    if (currentScopeRevision() !== capturedScopeRevision) return;
    run();
  }, delayMs);
  return () => {
    if (!active) return;
    active = false;
    cancel(timerId);
  };
}

export function cancelPendingStoryMediaOwners(
  cancelDragSettle: (() => void) | null,
  cancelDeferredFullscreen: (() => void) | null,
) {
  cancelDragSettle?.();
  cancelDeferredFullscreen?.();
}

type JourneyStoryProps = {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  initialAssetId?: string | null;
  initialSnapState?: "in-context" | "expanded";
  focusVisibleControlOnOpen?: boolean;
  onObservationChange?: (observation: StoryLogicalObservation | null) => void;
  onGlobeCoverChange?: (state: StoryGlobeCoverState) => void;
  onClose: (sharedSource?: HTMLElement | null) => void;
  onNavigate: (journeyId: string) => void;
  /** Absent when the view has no edit capability (#200 shared mode). */
  onEdit?: (journeyId: string) => void;
  onJourneyUpdated?: (journey: Journey) => void | Promise<void>;
  onDelete?: (journeyId: string) => void | Promise<void>;
  /**
   * #200 phase E. Opening the owner share surface for this Journey. Like
   * `onEdit`, its absence is one half of the gate and `canShareAtlas` is the
   * other: the dialog itself lives in the Atlas shell, so the story never
   * holds a share client of its own.
   */
  onShare?: (journeyId: string) => void;
  onMediaAdded: (journeyId: string) => Journey | null | Promise<Journey | null>;
  onMediaDelete?: (assetId: string) => void | Promise<void>;
  onMediaReorder?: (
    journeyId: string,
    assetIds: readonly string[],
  ) => Journey | Promise<Journey>;
};

type PendingPlacementReview = {
  files: File[];
  batch: MediaPlacementBatchResult;
};

type PendingPlacementUploadGroup = {
  journeyId: string;
  routePointId: string | null;
  files: File[];
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

export function createStoryAutoplayFallbackController(
  schedule: () => number,
  clear: (timer: number) => void,
) {
  let disposed = false;
  let timer = 0;
  const cancel = () => {
    if (timer) clear(timer);
    timer = 0;
  };
  return {
    arm() {
      if (disposed || timer) return;
      timer = schedule();
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

export function mediaMoveUndoForSelection(
  journey: Journey,
  assetIds: readonly string[],
  expectedRoutePointId: string | null,
): JourneyMediaMoveUndo | null {
  const selected = new Set(assetIds);
  const assignments = journey.media
    .filter((asset) => selected.has(asset.id))
    .map((asset) => ({ assetId: asset.id, routePointId: asset.routePointId }));
  if (assignments.length !== selected.size) return null;
  const assetOrder = [...journey.media]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((asset) => asset.id);
  return {
    journeyId: journey.id,
    expectedRoutePointId,
    assignments,
    assetOrder,
  };
}

export function retainMediaMoveUndoAfterError(error: unknown): boolean {
  if (!(error instanceof JourneyApiError)) return true;
  return error.status >= 500
    || error.status === 408
    || error.status === 425
    || error.status === 429;
}

export function mediaMoveUndoNeedsServerReconcile(error: unknown): boolean {
  return error instanceof JourneyApiError && error.code === "MEDIA_MOVE_UNDO_STALE";
}

export function reorderInvalidatesMediaMoveUndo(
  media: readonly JourneyMediaAsset[],
  activeAssetId: string,
  overAssetId: string,
): boolean {
  if (activeAssetId === overAssetId) return false;
  const activeAsset = media.find((candidate) => candidate.id === activeAssetId);
  const overAsset = media.find((candidate) => candidate.id === overAssetId);
  if (!activeAsset || !overAsset) return false;
  return activeAsset.routePointId === overAsset.routePointId;
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
  upload,
  refresh,
  remove,
  onProgress,
}: {
  journeyId: string;
  file: File;
  previous: JourneyMediaAsset | null;
  upload: UploadJourneyMedia;
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
}: {
  asset: JourneyMediaAsset;
  index: number;
  isCurrent: boolean;
  isCover: boolean;
  read: MediaReadState | undefined;
  disabled: boolean;
  onRequestRead: (assetId: string) => void;
  onSelect: (index: number, source: HTMLButtonElement) => void;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const isVideo = asset.mimeType.startsWith("video/");
  const [originalReady, setOriginalReady] = useState(false);
  const readUrl = read?.status === "ready" ? read.url : null;
  useEffect(() => setOriginalReady(false), [asset.id, readUrl]);
  const layer = read?.status === "ready" ? mediaPreviewLayer({
    assetId: asset.id,
    readAssetId: asset.id,
    read,
    originalReady: !isVideo && originalReady,
  }) : null;

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
    <button
      ref={tileRef}
      type="button"
      className={isCurrent ? "is-current" : ""}
      aria-current={isCurrent ? "true" : undefined}
      aria-label={`第 ${index + 1} 个媒体 ${asset.fileName}${isCover ? "，当前封面" : ""}`}
      data-media-tile-index={index}
      data-media-layer={layer?.kind}
      data-media-preview-asset={layer?.kind === "preview" ? layer.assetId : undefined}
      data-media-preview-width={layer?.kind === "preview" ? layer.frame?.width : undefined}
      data-media-preview-height={layer?.kind === "preview" ? layer.frame?.height : undefined}
      style={layer?.kind === "preview" ? {
        backgroundImage: `url(${JSON.stringify(layer.url)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      } : undefined}
      disabled={disabled}
      onClick={(event) => onSelect(index, event.currentTarget)}
    >
      {isVideo ? (
        <span className="journey-story__media-tile-badge">
          <IconVideo size={20} stroke={1.3} aria-hidden="true" />
        </span>
      ) : read?.status === "ready" ? (
        <img src={read.url} alt={asset.fileName} loading="lazy" decoding="async"
          onLoad={() => setOriginalReady(true)} />
      ) : (
        <span className="journey-story__media-tile-badge">
          {read?.status === "error" ? "不可用" : "载入中"}
        </span>
      )}
      {isCover ? <span className="journey-story__media-tile-cover">封面</span> : null}
      <small>{String(index + 1).padStart(2, "0")}</small>
    </button>
  );
}

export function JourneyStory({
  journeys,
  journeyId,
  routePointId = null,
  initialAssetId = null,
  initialSnapState = "in-context",
  focusVisibleControlOnOpen = false,
  onObservationChange,
  onGlobeCoverChange,
  onClose,
  onNavigate,
  onEdit,
  onJourneyUpdated,
  onDelete,
  onShare,
  onMediaAdded,
  onMediaDelete,
  onMediaReorder,
}: JourneyStoryProps) {
  // #200 phase D. `mutations` is null in shared mode, so `manageMedia` below
  // is null too and every media write in this component has nothing to call.
  // Before this contract an absent `onMediaDelete` fell through to the owner
  // API, which meant hiding the control left deletion reachable.
  const { capabilities, readMedia, listJourneys, mutations } = useAtlasView();
  const manageMedia: AtlasMutations | null = capabilities.canManageMedia ? mutations : null;
  const removeMedia = onMediaDelete ?? manageMedia?.deleteMedia ?? null;
  const updateJourneyNotes = mutations?.updateJourneyNotes ?? null;
  const canEditJourney = capabilities.canEditJourney && Boolean(onEdit);
  const canShareJourney = capabilities.canShareAtlas && Boolean(onShare);
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeys[journeyIndex];
  const initialMediaSelection = storyInitialMediaSelection(journey, routePointId, initialAssetId);
  const [assetIndex, setAssetIndex] = useState(initialMediaSelection.assetIndex);
  const [selectedRoutePointId, setSelectedRoutePointId] = useState<string | null>(
    initialMediaSelection.routePointId,
  );
  const selectedRoutePointIdRef = useRef(selectedRoutePointId);
  selectedRoutePointIdRef.current = selectedRoutePointId;
  const [mediaReads, setMediaReads] = useState<Record<string, MediaReadState & { generation?: number }>>({});
  // A re-signed read can carry the same URL (for example two requests in one
  // signing second). Presentation still needs a new resource generation.
  const mediaReadGeneration = useRef(0);
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
  // The semantic current/requested/ready identities are independent of the
  // three persistent presentation pages. A ready neighbor becomes current
  // after its horizontal handoff; no image changes compositor at that seam.
  const [shownAssetId, setShownAssetId] = useState<string | null>(null);
  const [incomingAssetId, setIncomingAssetId] = useState<string | null>(null);
  const pendingTargetRef = useRef<string | null>(null);
  const [pendingMediaId, setPendingMediaId] = useState<string | null>(null);
  const requestedMediaRef = useRef<string | null>(null);
  const mediaNavigationDirection = useRef<-1 | 1>(1);
  const incomingMediaRef = useRef(incomingAssetId);
  incomingMediaRef.current = incomingAssetId;
  const setPendingMediaTarget = useCallback((assetId: string | null) => {
    pendingTargetRef.current = assetId;
    setPendingMediaId(assetId);
  }, []);
  const [uploadState, setUploadState] = useState<MediaUploadState>({ status: "idle" });
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [retryRoutePointId, setRetryRoutePointId] = useState<string | null>(null);
  const [placementReview, setPlacementReview] = useState<PendingPlacementReview | null>(null);
  const [placementRetryGroups, setPlacementRetryGroups] = useState<PendingPlacementUploadGroup[]>([]);
  const [placementAnalyzing, setPlacementAnalyzing] = useState(false);
  const placementAnalysisAuthorityRef = useRef<ReturnType<typeof createPlacementAnalysisAuthority> | null>(null);
  if (!placementAnalysisAuthorityRef.current) {
    placementAnalysisAuthorityRef.current = createPlacementAnalysisAuthority();
  }
  const currentPlacementAnalysisScope = placementAnalysisScope(journeys, journeyId, selectedRoutePointId);
  const placementAnalysisScopeRef = useRef(currentPlacementAnalysisScope);
  placementAnalysisScopeRef.current = currentPlacementAnalysisScope;
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [journeyNoteDraft, setJourneyNoteDraft] = useState<string | undefined>(undefined);
  const [routePointNoteDrafts, setRoutePointNoteDrafts] = useState<Record<string, string>>({});
  const routePointDraftLabels = useRef(new Map<string, string>());
  const [notesSaveState, setNotesSaveState] = useState<StoryNotesSaveState>("idle");
  const [notesMessage, setNotesMessage] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const notesDirtyRef = useRef(false);
  notesDirtyRef.current = notesDirty;
  const notesDraftJourneyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!journey) return;
    if (notesDraftJourneyRef.current === journey.id && notesDirtyRef.current) return;
    setJourneyNoteDraft(undefined);
    setRoutePointNoteDrafts({});
    routePointDraftLabels.current.clear();
    setNotesSaveState("idle");
    setNotesMessage("");
    setNotesDirty(false);
    notesDraftJourneyRef.current = journey.id;
  }, [journey?.id, journey?.revision]);
  const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "pending">("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [mediaDeleteState, setMediaDeleteState] = useState<"idle" | "confirming" | "pending">("idle");
  const previousMediaDeleteStateRef = useRef(mediaDeleteState);
  const [mediaDeleteMessage, setMediaDeleteMessage] = useState("");
  const [orderPending, setOrderPending] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  // Review P2: optimistic drag order for the current scope (asset ids). Set
  // on drop before the API round-trip; cleared on success/rollback so the
  // grid follows server truth.
  const [localMediaOrder, setLocalMediaOrder] = useState<readonly string[] | null>(null);
  // #14: setting a cover is a lightweight mutation that disables the grid.
  const [coverPending, setCoverPending] = useState(false);
  // #20: batch move — fixes media that landed on the wrong route point
  // without re-uploading. `moveSelection` is only meaningful while
  // `moveSelectMode` is on; both reset together.
  const [moveSelectMode, setMoveSelectMode] = useState(false);
  const [moveSelection, setMoveSelection] = useState<ReadonlySet<string>>(new Set());
  const [movePending, setMovePending] = useState(false);
  const [moveMessage, setMoveMessage] = useState("");
  const [moveUndo, setMoveUndo] = useState<JourneyMediaMoveUndo | null>(null);

  function invalidateMoveUndo() {
    setMoveUndo(null);
    setMoveMessage("");
  }
  const [playing, setPlaying] = useState(false);
  const [mediaGestureHolding, setMediaGestureHolding] = useState(false);
  // Review P2: mirrors `playing` so gesture handlers can read it synchronously.
  const playingRef = useRef(false);
  playingRef.current = playing;
  const mobileLayout = useCompactMobileLayout();
  const [mobileStoryExpanded, setMobileStoryExpanded] = useState(initialSnapState === "expanded");
  const [mobileStoryCoverTransitionActive, setMobileStoryCoverTransitionActive] = useState(false);
  const storySheetGestureRef = useRef<{ startY: number; pointerId: number } | null>(null);
  const storySheetGestureConsumedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    onGlobeCoverChange?.(storyGlobeCoverState({
      mobileLayout,
      mobileStoryExpanded,
      fullscreen,
      coverTransitionActive: mobileStoryCoverTransitionActive,
    }));
  }, [fullscreen, mobileLayout, mobileStoryCoverTransitionActive, mobileStoryExpanded, onGlobeCoverChange]);
  useEffect(() => () => {
    onGlobeCoverChange?.({ opaqueMediaCover: false, coverTransitionActive: false });
  }, [onGlobeCoverChange]);
  // #7: fullscreen controls fade out after idle; any pointer/key activity
  // brings them back. Mobile starts fully immersive and reveals controls only
  // after an explicit interaction.
  const [fullscreenControlsHidden, setFullscreenControlsHidden] = useState(false);
  const fullscreenMobileIdleTimerRef = useRef(0);
  const storyMediaGestureConsumedRef = useRef(false);
  const mediaButtonTouchRef = useRef<{
    pointerId: number; key: "previous" | "next" | "play" | "fullscreen"; x: number; y: number; moved: boolean;
  } | null>(null);
  const mediaButtonTouchClickRef = useRef<{
    at: number; key: "previous" | "next" | "play" | "fullscreen";
  } | null>(null);
  const inlineStageRef = useRef<StoryMediaPagesHandle>(null);
  const fullscreenStageRef = useRef<StoryMediaPagesHandle>(null);
  const [mobileManageMode, setMobileManageMode] = useState(false);
  const mobileManageDoneRef = useRef<HTMLButtonElement>(null);
  const mobileManageViewerTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileManageFocusFrameRef = useRef<number | null>(null);
  const mediaDeleteFocusFrameRef = useRef<number | null>(null);
  const restoreMobileManageViewerFocusRef = useRef(false);
  const restoreMobileMediaDeleteFocusRef = useRef(false);
  const [mobileMediaMenuOpen, setMobileMediaMenuOpen] = useState(false);
  const mobileMoveSelectToggleRef = useRef<HTMLButtonElement>(null);
  const restoreMobileMoveSelectFocusRef = useRef(false);
  // Review P2: the fullscreen overlay is a focus trap of its own (it is
  // rendered outside the story dialog, whose useModalFocus would otherwise
  // steal Tab focus back into the article).
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState(false);
  const [desktopEditing, setDesktopEditing] = useState(false);
  const mediaEditing = mobileLayout ? mobileManageMode : desktopEditing;
  const notesEditing = desktopEditing || mobileManageMode;
  const [soundtrackUpload, setSoundtrackUpload] = useState<MediaUploadState>({ status: "idle" });
  const [soundtrackRemovePending, setSoundtrackRemovePending] = useState(false);
  const [soundtrackNotice, setSoundtrackNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const soundtrackInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // #199 review: the settled video of the current step, per stage. Autoplay
  // drives whichever stage is on screen so a video step can end itself.
  const storyVideoRef = useRef<HTMLVideoElement>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);
  const videoHandoffGenerationRef = useRef(0);
  const videoHandoffRef = useRef<{
    id: string; src: string; time: number; shouldPlay: boolean; toFullscreen: boolean;
    muted: boolean; volume: number; playbackRate: number;
    source: HTMLVideoElement; scopeKey: string;
    cancelMorph?: () => void;
    restoreSource?: () => boolean;
    dispose: (preservePlayback?: boolean) => void;
  } | null>(null);
  const [videoResumeBlocked, setVideoResumeBlocked] = useState<{ id: string; toFullscreen: boolean } | null>(null);
  const [videoHandoffRevision, setVideoHandoffRevision] = useState(0);
  const [stagePlaybackReady, setStagePlaybackReady] = useState<{ inline: string | null; fullscreen: string | null }>({ inline: null, fullscreen: null });
  const [renewalError, setRenewalError] = useState<{
    id: string; sourceGeneration: number | undefined; message: string; retrying: boolean;
  } | null>(null);
  const inlinePlaybackReady = useCallback((id: string | null) => {
    setStagePlaybackReady((current) => current.inline === id ? current : { ...current, inline: id });
  }, []);
  const fullscreenPlaybackReady = useCallback((id: string | null) => {
    setStagePlaybackReady((current) => current.fullscreen === id ? current : { ...current, fullscreen: id });
  }, []);
  const activeStagePlaybackReadyId = fullscreen ? stagePlaybackReady.fullscreen : stagePlaybackReady.inline;
  useEffect(() => {
    if (!renewalError || activeStagePlaybackReadyId !== renewalError.id) return;
    const read = mediaReads[renewalError.id];
    const video = fullscreen ? fullscreenVideoRef.current : storyVideoRef.current;
    if (read?.status === "ready" && read.generation !== undefined
      && read.generation > (renewalError.sourceGeneration ?? -1)
      && video?.dataset.sharedMediaId === renewalError.id
      && !video.hidden && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking
      && video.dataset.storyReadGeneration === String(read.generation)
      && video.currentSrc === new URL(read.url, document.baseURI).href) setRenewalError(null);
  }, [activeStagePlaybackReadyId, fullscreen, mediaReads, renewalError]);
  useEffect(() => () => {
    videoHandoffGenerationRef.current += 1;
    const handoff = videoHandoffRef.current;
    handoff?.cancelMorph?.();
    handoff?.dispose();
  }, []);
  // #20: one sampler per soundtrack element; the analyser is built on first
  // play and drives the light strip with smoothed energy.
  const audioSamplerRef = useRef(createSoundtrackSampler());
  const soundtrackLightRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const journeyDeleteTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreJourneyDeleteFocusRef = useRef(false);
  const mediaDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLElement>(null);
  const pendingReads = useRef(new Set<string>());
  const mediaReadScope = useRef({ journeyId, routePointId });
  const storyScopeRevisionRef = useRef(0);
  const storyScopeIdentityRef = useRef({ journeyId, routePointId });
  if (
    storyScopeIdentityRef.current.journeyId !== journeyId
    || storyScopeIdentityRef.current.routePointId !== routePointId
  ) {
    storyScopeIdentityRef.current = { journeyId, routePointId };
    storyScopeRevisionRef.current += 1;
  }
  const mediaReadsRef = useRef(mediaReads);
  const uploading = uploadState.status === "uploading"
    || soundtrackUpload.status === "uploading";
  const mutationPending = uploading
    || deleteState === "pending"
    || mediaDeleteState === "pending"
    || soundtrackRemovePending
    || orderPending
    || coverPending
    || movePending
    || notesSaveState === "saving";

  function setStoryJourneyNote(value: string) {
    setJourneyNoteDraft(value);
    setNotesDirty(true);
    setNotesSaveState("idle");
    setNotesMessage("");
  }

  function setStoryRoutePointNote(routePointId: string, value: string) {
    routePointDraftLabels.current.set(routePointId, journey?.routePoints.find((point) => point.id === routePointId)?.label || "未命名地点");
    setRoutePointNoteDrafts((current) => ({ ...current, [routePointId]: value }));
    setNotesDirty(true);
    setNotesSaveState("idle");
    setNotesMessage("");
  }

  function notifyNotesGuard(message: string) {
    setNotesMessage(message);
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".story-notes-editor")?.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
  }

  function notesPreventAction(savingMessage: string) {
    const message = notesSaveState === "saving"
      ? savingMessage
      : notesDirty ? "还有未保存的感想，请先保存或放弃更改。" : null;
    if (!message) return false;
    notifyNotesGuard(message);
    return true;
  }

  function discardStoryNotes() {
    if (!journey || notesSaveState === "saving") return;
    setJourneyNoteDraft(undefined);
    setRoutePointNoteDrafts({});
    routePointDraftLabels.current.clear();
    setNotesDirty(false);
    setNotesSaveState("idle");
    setNotesMessage("");
  }

  const removedRoutePointDrafts = Object.entries(routePointNoteDrafts)
    .filter(([id]) => !journey?.routePoints.some((point) => point.id === id))
    .map(([id, note]) => ({ id, note, label: routePointDraftLabels.current.get(id) || "已删除地点" }));

  function discardRemovedRoutePointDraft(routePointId: string) {
    if (mutationPending) return;
    const next = { ...routePointNoteDrafts };
    delete next[routePointId];
    routePointDraftLabels.current.delete(routePointId);
    setRoutePointNoteDrafts(next);
    setNotesDirty(journeyNoteDraft !== undefined || Object.keys(next).length > 0);
    setNotesSaveState("idle");
    setNotesMessage("");
  }

  async function saveStoryNotes() {
    if (!journey || !updateJourneyNotes || !notesDirty || mutationPending) return;
    if (removedRoutePointDrafts.length > 0) {
      notifyNotesGuard("有地点已被删除。请先复制需要保留的草稿，再放弃对应地点草稿。");
      return;
    }
    const journeyNoteWasTouched = journeyNoteDraft !== undefined;
    const touchedRoutePointIds = new Set(Object.keys(routePointNoteDrafts));
    const input: JourneyInput = {
      title: journey.title,
      startedOn: journey.startedOn,
      endedOn: journey.endedOn,
      note: journeyNoteDraft ?? journey.note ?? "",
      lightColor: journey.lightColor,
      lightEffect: journey.lightEffect ?? null,
      revision: journey.revision,
      routePoints: journey.routePoints.map((point) => ({
        id: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        label: point.label,
        isStop: point.isStop,
        occurredAt: point.occurredAt,
        note: Object.prototype.hasOwnProperty.call(routePointNoteDrafts, point.id)
          ? routePointNoteDrafts[point.id] || null
          : point.note ?? null,
      })),
    };
    setNotesSaveState("saving");
    setNotesMessage("");
    try {
      const updated = await updateJourneyNotes(journey.id, input);
      setJourneyNoteDraft(journeyNoteWasTouched ? updated.note ?? "" : undefined);
      setRoutePointNoteDrafts(Object.fromEntries(
        updated.routePoints
          .filter((point) => touchedRoutePointIds.has(point.id))
          .map((point) => [point.id, point.note ?? ""]),
      ));
      setNotesDirty(false);
      setNotesSaveState("saved");
      setNotesMessage("感想已保存。");
      try {
        await onJourneyUpdated?.(updated);
      } catch {
        setNotesMessage("感想已保存，但画面刷新失败；重新打开故事即可看到最新内容。");
      }
    } catch (error) {
      if (error instanceof JourneyApiError && error.code === "JOURNEY_ROUTE_CHANGED") {
        try {
          const latestJourney = (await listJourneys()).find((candidate) => candidate.id === journey.id);
          if (!latestJourney) {
            setNotesMessage("这段旅程已不在当前图谱中。草稿仍在，请复制需要保留的感想。");
            return;
          }
          if (onJourneyUpdated) await onJourneyUpdated(latestJourney);
          else {
            const refreshed = await onMediaAdded(journey.id);
            if (!refreshed || refreshed.revision < latestJourney.revision) throw new Error("Story refresh unavailable");
          }
          const removedDraft = [...touchedRoutePointIds].some((id) => !latestJourney.routePoints.some((point) => point.id === id));
          setNotesMessage(removedDraft
            ? "旅程已更新，部分地点已被删除。草稿仍在，请复制需要保留的内容，再放弃对应地点草稿。"
            : "旅程已更新，草稿已保留。请核对最新地点和感想，再点击保存感想。");
        } catch {
          setNotesMessage("旅程已更新，但读取最新内容失败。草稿仍在，请再次点击保存感想重试。");
        } finally {
          setNotesSaveState("error");
        }
        return;
      }
      setNotesSaveState("error");
      setNotesMessage(error instanceof Error ? error.message : "感想保存失败，请稍后重试。");
    }
  }

  function navigateStory(targetJourneyId: string) {
    if (notesPreventAction("正在保存感想，完成后才能切换旅程。")) return;
    invalidatePlacementAnalysis();
    onNavigate(targetJourneyId);
  }

  function collapseMobileStory() {
    setMobileStoryCoverTransitionActive(true);
    setMobileStoryExpanded(false);
  }

  function toggleMobileStoryPresentation() {
    if (storySheetGestureConsumedRef.current) {
      storySheetGestureConsumedRef.current = false;
      return;
    }
    setMobileStoryCoverTransitionActive(true);
    setMobileStoryExpanded((current) => !current);
  }

  function handleStorySheetPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!mobileLayout || event.pointerType === "mouse") return;
    storySheetGestureConsumedRef.current = false;
    storySheetGestureRef.current = { startY: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleStorySheetPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = storySheetGestureRef.current;
    storySheetGestureRef.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dy) >= 32) storySheetGestureConsumedRef.current = true;
    if (dy <= -32) {
      setMobileStoryCoverTransitionActive(true);
      setMobileStoryExpanded(true);
    } else if (dy >= 32) {
      setMobileStoryCoverTransitionActive(true);
      setMobileStoryExpanded(false);
    }
  }

  function handleStorySheetPointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    if (storySheetGestureRef.current?.pointerId !== event.pointerId) return;
    storySheetGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function presentFullscreen(nextFullscreen: boolean) {
    // The departing stage releases pointer capture and its paint before the
    // other surface becomes active. Story keeps the fullscreen intent, and a
    // swipe that already landed keeps its navigation (#530).
    cancelPendingMediaDragSettle(true);
    const previousHandoff = videoHandoffRef.current;
    // An immediate Back may find no settled video identity on the slow target.
    // Restore the original decoded transport before disposing its intent.
    if (previousHandoff?.toFullscreen !== nextFullscreen
      && previousHandoff?.restoreSource?.()) return;
    const generation = ++videoHandoffGenerationRef.current;
    cancelSharedElementMorph();
    previousHandoff?.dispose();
    setVideoResumeBlocked(null);
    const inlineStage = () => dialogRef.current?.querySelector<HTMLElement>(".journey-story__media") ?? null;
    const sourceRoot = nextFullscreen ? inlineStage() : fullscreenRef.current;
    const source = sourceRoot?.querySelector<HTMLElement>("[data-shared-media-id]") ?? null;
    const mediaId = source?.dataset.sharedMediaId;
    const targetRoot = () => nextFullscreen ? fullscreenRef.current : inlineStage();
    const sourceVideo = source instanceof HTMLVideoElement ? source : null;
    const targetVideo = sourceVideo
      ? nextFullscreen ? fullscreenVideoRef.current : storyVideoRef.current
      : null;
    const sourceUrl = sourceVideo?.currentSrc || sourceVideo?.src;
    const inherited = previousHandoff && previousHandoff.id === mediaId && previousHandoff.src === sourceUrl
      ? previousHandoff : null;
    const handoffTime = inherited?.time ?? sourceVideo?.currentTime ?? 0;
    // Native pause/play belongs to the transport, independent of Story autoplay.
    const shouldPlay = inherited?.shouldPlay ?? Boolean(sourceVideo && !sourceVideo.paused && !sourceVideo.ended);
    const muted = inherited?.muted ?? sourceVideo?.muted ?? false;
    const volume = inherited?.volume ?? sourceVideo?.volume ?? 1;
    const playbackRate = inherited?.playbackRate ?? sourceVideo?.playbackRate ?? 1;
    let targetAudio = targetVideo
      ? { muted: targetVideo.muted, volume: targetVideo.volume, playbackRate: targetVideo.playbackRate }
      : null;
    const scopeRevision = storyScopeRevisionRef.current;
    let ready = false;
    let morphDone = false;
    let seekIssued = false;
    let seekCompleted = false;
    let positionPrepared = false;
    let seekTarget: HTMLVideoElement | null = null;
    let timeout = 0;
    const removeVideoListeners = () => {
      if (!seekTarget) return;
      for (const event of ["loadedmetadata", "loadeddata", "canplay", "seeked", "timeupdate", "error"] as const) {
        seekTarget.removeEventListener(event, checkVideo);
      }
      seekTarget.removeAttribute("data-video-handoff-ready");
    };
    const videoHandoff: NonNullable<typeof videoHandoffRef.current> | null = sourceVideo && targetVideo
      && mediaId && sourceUrl && Number.isFinite(handoffTime)
      ? {
        id: mediaId, src: sourceUrl, time: handoffTime, shouldPlay, toFullscreen: nextFullscreen,
        muted, volume, playbackRate,
        source: sourceVideo, scopeKey: `${journeyId}:${selectedRoutePointId ?? ""}`,
        dispose: (preservePlayback = false) => {
          window.clearTimeout(timeout);
          removeVideoListeners();
          if (seekTarget) {
            if (!preservePlayback) seekTarget.pause();
            seekTarget.volume = preservePlayback ? volume : (targetAudio?.volume ?? volume);
            seekTarget.playbackRate = preservePlayback ? playbackRate : (targetAudio?.playbackRate ?? playbackRate);
            seekTarget.muted = preservePlayback ? muted : (targetAudio?.muted ?? muted);
          }
          if (videoHandoffRef.current === videoHandoff) videoHandoffRef.current = null;
        },
      } : null;
    const handoffCurrent = () => {
      if (!videoHandoff || videoHandoffRef.current !== videoHandoff
        || videoHandoffGenerationRef.current !== generation
        || storyScopeRevisionRef.current !== scopeRevision) return false;
      const stage = targetRoot();
      return storyFullscreenTargetIsCurrent({
        mediaId,
        nextFullscreen,
        overlayHidden: fullscreenRef.current?.hidden,
        stagePresent: stage !== null,
        currentPageId: stage?.querySelector<HTMLElement>('[data-media-page="current"]')?.dataset.mediaPageId,
        stageInterrupted: Boolean(stage?.querySelector('[data-media-incoming="true"], [role="alert"]')),
      });
    };
    if (videoHandoff && sourceVideo) videoHandoff.restoreSource = () => {
      if (videoHandoffRef.current !== videoHandoff
        || videoHandoffGenerationRef.current !== generation) return false;
      const read = mediaReadsRef.current[videoHandoff.id];
      const sourceCurrent = handoffCurrent()
        && videoHandoff.scopeKey === `${journeyId}:${selectedRoutePointIdRef.current ?? ""}`
        && requestedMediaRef.current === videoHandoff.id
        && incomingMediaRef.current === null
        && pendingTargetRef.current === null
        && sourceVideo.isConnected
        && (nextFullscreen ? storyVideoRef.current : fullscreenVideoRef.current) === sourceVideo
        && (sourceVideo.currentSrc || sourceVideo.src) === videoHandoff.src
        && read?.status === "ready"
        && new URL(read.url, document.baseURI).href === videoHandoff.src;
      // Invalidate all target callbacks before the scoped morph cleanup fires.
      videoHandoffGenerationRef.current += 1;
      videoHandoff.cancelMorph?.();
      videoHandoff.dispose();
      if (!sourceCurrent) return false;
      setVideoResumeBlocked(null);
      sourceVideo.muted = videoHandoff.muted;
      sourceVideo.volume = videoHandoff.volume;
      sourceVideo.playbackRate = videoHandoff.playbackRate;
      // The source was paused in place; avoid an unnecessary seek that could
      // discard its decoded frame when the destination decoder is still slow.
      if (Math.abs(sourceVideo.currentTime - videoHandoff.time) > 0.12) {
        sourceVideo.currentTime = videoHandoff.time;
      }
      flushSync(() => setFullscreen(!nextFullscreen));
      setFullscreenControlsHidden(false);
      if (videoHandoff.shouldPlay) {
        const restoredGeneration = videoHandoffGenerationRef.current;
        void sourceVideo.play().catch(() => {
          const currentRead = mediaReadsRef.current[videoHandoff.id];
          if (videoHandoffGenerationRef.current !== restoredGeneration
            || storyScopeRevisionRef.current !== scopeRevision
            || selectedRoutePointIdRef.current !== selectedRoutePointId
            || requestedMediaRef.current !== videoHandoff.id
            || currentRead?.status !== "ready"
            || new URL(currentRead.url, document.baseURI).href !== videoHandoff.src
            || !sourceVideo.isConnected
            || (nextFullscreen ? storyVideoRef.current : fullscreenVideoRef.current) !== sourceVideo
            || (sourceVideo.currentSrc || sourceVideo.src) !== videoHandoff.src
            || !sourceVideo.paused) return;
          setPlaying(false);
          setVideoResumeBlocked({ id: videoHandoff.id, toFullscreen: !nextFullscreen });
        });
      } else sourceVideo.pause();
      return true;
    };
    const reportResumeBlocked = (video: HTMLVideoElement) => {
      if (!videoHandoff || videoHandoffGenerationRef.current !== generation || !video.isConnected
        || video.dataset.sharedMediaId !== videoHandoff.id || !video.paused) return;
      setPlaying(false);
      setVideoResumeBlocked({ id: videoHandoff.id, toFullscreen: nextFullscreen });
    };
    const finishVideoHandoff = () => {
      if (!videoHandoff || !seekTarget || !ready || !morphDone || !handoffCurrent()) return;
      videoHandoff.dispose(true);
      if (shouldPlay && seekTarget.paused) {
        const video = seekTarget;
        void video.play().catch(() => reportResumeBlocked(video));
      }
      // Restart Story's own ended/timer listener only after the correct frame
      // is the active transport. Playback never owns this fullscreen intent.
      setVideoHandoffRevision((current) => current + 1);
    };
    const checkVideo = (event?: Event) => {
      if (!videoHandoff || !seekTarget) return;
      if (!handoffCurrent()) { videoHandoff.dispose(); return; }
      const actualUrl = seekTarget.currentSrc || seekTarget.src;
      if (actualUrl !== sourceUrl) return;
      if (seekTarget.error) return;
      if (seekTarget.readyState < HTMLMediaElement.HAVE_METADATA) return;
      if (event?.type === "seeked") seekCompleted = true;
      const time = Number.isFinite(seekTarget.duration)
        ? Math.min(handoffTime, seekTarget.duration) : handoffTime;
      if (!positionPrepared) {
        if (Math.abs(seekTarget.currentTime - time) > 0.08) {
          try { seekTarget.currentTime = time; seekIssued = true; } catch { return; }
        }
        positionPrepared = true;
      }
      if (seekTarget.seeking || seekTarget.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || (seekIssued && !seekCompleted)
        || (shouldPlay && !seekTarget.paused
          ? seekTarget.currentTime < time - 0.12
          : Math.abs(seekTarget.currentTime - time) > 0.12)) return;
      ready = true;
      seekTarget.dataset.videoHandoffReady = videoHandoff.id;
      finishVideoHandoff();
    };
    if (videoHandoff && sourceVideo && targetVideo) {
      videoHandoffRef.current = videoHandoff;
      // Keep one audio owner. The old stage's layout cleanup also pauses it;
      // the handoff guard below prevents that pause from stopping Story's clock.
      sourceVideo.pause();
      // The target may need a new user activation after an asynchronous seek;
      // the rejected resume path below leaves native Play visibly available.
      targetVideo.pause();
    }
    const cancelMorph = runSharedElementMorph({
      source,
      name: `story-fullscreen-${mediaId ?? "media"}`,
      update: () => setFullscreen(nextFullscreen),
      afterUpdate: videoHandoff ? () => {
        seekTarget = nextFullscreen ? fullscreenVideoRef.current : storyVideoRef.current;
        if (!seekTarget) return;
        if (seekTarget !== targetVideo) targetAudio = {
          muted: seekTarget.muted, volume: seekTarget.volume, playbackRate: seekTarget.playbackRate,
        };
        seekTarget.pause();
        seekTarget.volume = volume;
        seekTarget.playbackRate = playbackRate;
        seekTarget.muted = true;
        for (const event of ["loadedmetadata", "loadeddata", "canplay", "seeked", "timeupdate", "error"] as const) {
          seekTarget.addEventListener(event, checkVideo);
        }
        timeout = window.setTimeout(() => {
          if (ready) return;
          // Decoder delay is a handoff failure, not a signed media-read error.
          // Return to the original decoded frame and native playback intent.
          videoHandoff.restoreSource?.();
        }, 8_000);
        checkVideo();
        // Still inside the initiating click task: keep the destination's play
        // authorization pending through seek/decode, silently behind the clone.
        // The source was already paused, so there is never a second audio owner.
        if (shouldPlay && videoHandoffRef.current === videoHandoff) {
          const video = seekTarget;
          void video.play().catch(() => {
            if (ready && morphDone) reportResumeBlocked(video);
          });
        }
      } : undefined,
      readinessTimeoutMs: videoHandoff ? 8_500 : undefined,
      holdSnapshotForReducedMotion: Boolean(videoHandoff),
      resolvePendingTargetBounds: videoHandoff
        ? () => targetRoot()?.querySelector<HTMLElement>(".story-media-pages__video")?.getBoundingClientRect() ?? null
        : undefined,
      resolveTarget: () => mediaId
        ? [...targetRoot()?.querySelectorAll<HTMLElement>("[data-shared-media-id]") ?? []]
          .find((node) => node.dataset.sharedMediaId === mediaId && (!videoHandoff || ready)) ?? null
        : null,
      claimSource: sourceVideo ? () => {
        const page = sourceRoot?.querySelector<HTMLElement>('[data-media-page="current"]');
        return [sourceVideo, page, page?.querySelector<HTMLElement>("canvas")]
          .filter((node): node is HTMLElement => Boolean(node));
      } : undefined,
      // #489 C/V6: the destination page is in the tree as soon as the surface
      // commits, and it paints as soon as the browser decodes its picture --
      // before readiness lets resolveTarget claim it. Own it from the commit.
      claimDestination: () => {
        const stage = targetRoot();
        if (!mediaId || !stage) return null;
        const page = [...stage.querySelectorAll<HTMLElement>("[data-media-page-id]")]
          .find((node) => node.dataset.mediaPageId === mediaId);
        const destinationVideo = videoHandoff
          ? nextFullscreen ? fullscreenVideoRef.current : storyVideoRef.current
          : null;
        return [page, page?.querySelector<HTMLElement>("canvas"), destinationVideo]
          .filter((node): node is HTMLElement => Boolean(node));
      },
      isTargetCurrent: () => {
        const stage = targetRoot();
        return (!videoHandoff || (videoHandoffRef.current === videoHandoff
          && videoHandoffGenerationRef.current === generation))
          && storyFullscreenTargetIsCurrent({
          mediaId,
          nextFullscreen,
          overlayHidden: fullscreenRef.current?.hidden,
          stagePresent: stage !== null,
          currentPageId: stage?.querySelector<HTMLElement>('[data-media-page="current"]')?.dataset.mediaPageId,
          stageInterrupted: Boolean(stage?.querySelector('[data-media-incoming="true"], [role="alert"]')),
        });
      },
      onCleanup: videoHandoff ? () => {
        morphDone = true;
        if (!handoffCurrent()) { videoHandoff.dispose(); return; }
        if (ready) { finishVideoHandoff(); return; }
        // Resize, blur, or a pending decoder can end geometry ownership before
        // the destination has a frame. The clone is gone at this point, so
        // return to the still-decoded source instead of exposing an empty stage.
        videoHandoff.restoreSource?.();
      } : undefined,
    });
    if (videoHandoffRef.current === videoHandoff && videoHandoff) videoHandoff.cancelMorph = cancelMorph;
  }

  function exitFullscreen() {
    if (typeof window !== "undefined") {
      window.clearTimeout(fullscreenMobileIdleTimerRef.current);
      fullscreenMobileIdleTimerRef.current = 0;
    }
    presentFullscreen(false);
    setFullscreenControlsHidden(false);
  }

  function enterFullscreen(autoPlay: boolean) {
    // A renewed video has a retained picture while its replacement transport
    // seeks. It cannot be a fullscreen source until that frame is committed.
    if (shownAsset?.mimeType.startsWith("video/") && stagePlaybackReady.inline !== shownAsset.id) return;
    // A currently displayed video transfers its own native pause/play intent
    // after seeking. Do not start the target at zero and immediately abort it.
    setPlayingFromGesture(autoPlay, "fullscreen", Boolean(storyVideoRef.current?.dataset.sharedMediaId));
    setFullscreenControlsHidden(mobileLayout);
    setMobileMediaMenuOpen(false);
    presentFullscreen(true);
  }

  function closeMobileMediaDelete() {
    if (mediaDeleteState === "pending") return false;
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    return true;
  }

  function closeJourneyDelete() {
    if (deleteState === "pending") return false;
    restoreJourneyDeleteFocusRef.current = mobileLayout;
    setDeleteState("idle");
    setDeleteMessage("");
    return true;
  }

  function enterMobileManageMode() {
    setPlaying(false);
    setMobileManageMode(true);
  }

  function enterMobileMoveSelectMode() {
    setPlaying(false);
    setMobileMediaMenuOpen(false);
    setMoveSelection(new Set());
    setMoveMessage("");
    setMoveUndo(null);
    restoreMobileMoveSelectFocusRef.current = true;
    setMoveSelectMode(true);
    setOverview(true);
  }

  function exitMobileManageMode() {
    if (notesPreventAction("正在保存感想，完成后才能退出编辑。")) return false;
    if (mutationPending) return false;
    setDeleteState("idle");
    setDeleteMessage("");
    setMobileMediaMenuOpen(false);
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    setOverview(false);
    setMoveSelectMode(false);
    setMoveSelection(new Set());
    setMoveMessage("");
    setMoveUndo(null);
    restoreMobileManageViewerFocusRef.current = true;
    setMobileManageMode(false);
    setDesktopEditing(false);
    return true;
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
    if (mobileLayout && deleteState === "confirming") {
      closeJourneyDelete();
      return;
    }
    if (notesSaveState === "saving") setCloseBlocked(true);
    if (notesPreventAction("正在保存感想，完成后即可安全退出。")) return;
    if (mobileLayout && mobileManageMode) {
      if (!exitMobileManageMode() && uploading) setCloseBlocked(true);
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
      || movePending
      || orderPending
      || coverPending
    ) {
      return;
    }
    const sharedSource = dialogRef.current?.querySelector<HTMLElement>(
      routePointId !== null
        ? '.journey-story__media [data-shared-media-id]'
        : '[data-shared-journey-cover="true"]',
    ) ?? null;
    onClose(sharedSource);
  }

  // Expanded Story is the parent mobile presentation layer. Manage and its
  // transient mutation/fullscreen surfaces register afterward so Browser Back
  // unwinds the active intent before collapsing the Story sheet.
  useMobileSurfaceHistory(mobileStoryExpanded && mobileLayout, "story-expanded", collapseMobileStory);
  const mobileHistoryLayers = mobileStoryHistoryLayers({
    mobileLayout,
    mobileManageMode,
    fullscreen,
    mediaMenuOpen: mobileMediaMenuOpen,
    mediaDeleteOpen: mediaDeleteState !== "idle",
    journeyDeleteOpen: deleteState !== "idle",
  });
  useMobileSurfaceHistory(mobileHistoryLayers.manage, "story-manage", exitMobileManageMode);
  // Media menu, media-delete confirmation, and fullscreen are mutually
  // replacing transient surfaces on mobile. Keep them on one browser-history
  // layer so menu -> delete/fullscreen reuses the current entry instead of
  // burying a stale menu token underneath the replacement. Mutation-only
  // children are gated by Manage so desktop confirmations migrating into a
  // compact viewport push parent -> child tokens in the correct order.
  useMobileSurfaceHistory(mobileHistoryLayers.mediaSurface, "story-media-surface", () => {
    if (fullscreen) {
      exitFullscreen();
      return;
    }
    if (mediaDeleteState !== "idle") {
      return closeMobileMediaDelete();
    }
    if (mobileMediaMenuOpen) setMobileMediaMenuOpen(false);
  });
  useMobileSurfaceHistory(mobileHistoryLayers.journeyDelete, "story-journey-delete", closeJourneyDelete);
  const storyModal = !mobileLayout || mobileStoryExpanded;
  const resolvePlaybackReturnInitialFocus = useCallback((root: HTMLElement) => {
    if (!focusVisibleControlOnOpen) return null;
    const preferred = mobileLayout
      ? root.querySelector<HTMLElement>(".journey-story__sheet-handle")
      : null;
    const fallback = root.querySelector<HTMLElement>(".journey-story__close");
    return [preferred, fallback].find((candidate): candidate is HTMLElement => (
      candidate !== null && isModalFocusCandidate(candidate)
    )) ?? null;
  }, [focusVisibleControlOnOpen, mobileLayout]);
  const dialogRef = useModalFocus<HTMLElement>(
    requestClose,
    storyModal,
    false,
    resolvePlaybackReturnInitialFocus,
  );

  // #245: an active Story modal gives initial-focus ownership to useModalFocus
  // itself, so the trap cannot overwrite the Playback-return target in a later
  // passive effect. A collapsed mobile Story intentionally has no active trap;
  // only that path performs the one-shot focus handoff here.
  useLayoutEffect(() => {
    if (!focusVisibleControlOnOpen || storyModal) return;
    const root = dialogRef.current;
    if (!root) return;
    resolvePlaybackReturnInitialFocus(root)?.focus({ preventScroll: true });
  }, [focusVisibleControlOnOpen, resolvePlaybackReturnInitialFocus, storyModal]);

  // A collapsed mobile Story is intentionally not a modal, so useModalFocus
  // does not own Escape there. Give it the same top-layer-first close order as
  // Browser Back: transient children first, Manage second, Story last.
  useEffect(() => {
    if (!mobileLayout || storyModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (mutationPending) return;
      if (mobileMediaMenuOpen) {
        event.preventDefault();
        setMobileMediaMenuOpen(false);
        return;
      }
      if (mediaDeleteState !== "idle") {
        if (mediaDeleteState === "confirming" && closeMobileMediaDelete()) {
          event.preventDefault();
        }
        return;
      }
      if (deleteState !== "idle") {
        if (deleteState === "confirming" && closeJourneyDelete()) {
          event.preventDefault();
        }
        return;
      }
      // Fullscreen owns Escape on its window-level handler.
      if (fullscreen) return;
      event.preventDefault();
      if (mobileManageMode) {
        exitMobileManageMode();
        return;
      }
      requestClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    deleteState,
    fullscreen,
    mediaDeleteState,
    mobileLayout,
    mobileManageMode,
    mobileMediaMenuOpen,
    mutationPending,
    storyModal,
  ]);

  const mobileMediaSheetRef = useNestedModalFocus<HTMLElement>(
    mobileLayout && (mobileMediaMenuOpen || mediaDeleteState !== "idle"),
    mobileMediaMenuOpen ? "manage" : mediaDeleteState !== "idle" ? "delete" : null,
  );

  useLayoutEffect(() => {
    const authority = placementAnalysisAuthorityRef.current;
    if (!authority?.syncScope(currentPlacementAnalysisScope)) return;
    // #113: visible reset and async authority are the same scope transition.
    // A late metadata continuation can compute, but it no longer owns commits.
    setPlacementReview(null);
    setPlacementRetryGroups([]);
    setPlacementAnalyzing(false);
  }, [
    currentPlacementAnalysisScope.journeyId,
    currentPlacementAnalysisScope.routePointId,
    currentPlacementAnalysisScope.journeyMembershipKey,
    currentPlacementAnalysisScope.routePointMembershipKey,
    currentPlacementAnalysisScope.placementTruthKey,
    currentPlacementAnalysisScope.valid,
  ]);
  useLayoutEffect(() => {
    const authority = placementAnalysisAuthorityRef.current;
    authority?.resume(placementAnalysisScopeRef.current);
    return () => authority?.dispose();
  }, []);

  useEffect(() => {
    cancelPendingMediaDragSettle();

    const nextInitialMedia = storyInitialMediaSelection(journey, routePointId, initialAssetId);
    setAssetIndex(nextInitialMedia.assetIndex);
    setSelectedRoutePointId(nextInitialMedia.routePointId);
    setUploadState({ status: "idle" });
    setRetryFiles([]);
    setRetryRoutePointId(null);
    setPlacementReview(null);
    setPlacementRetryGroups([]);
    setPlacementAnalyzing(false);
    setCloseBlocked(false);
    setDeleteState("idle");
    setDeleteMessage("");
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    setOrderPending(false);
    setOrderMessage("");
    setPlaying(false);
    setMobileStoryCoverTransitionActive(false);
    setMobileStoryExpanded(initialSnapState === "expanded");
    // Scope initialization is not a user fullscreen transition. Reset that
    // presentation state directly so this no-op cannot steal ownership from
    // the Atlas -> Story shared-element handoff that mounted the Story.
    if (typeof window !== "undefined") {
      window.clearTimeout(fullscreenMobileIdleTimerRef.current);
      fullscreenMobileIdleTimerRef.current = 0;
    }
    setFullscreen(false);
    setFullscreenControlsHidden(false);
    setMobileManageMode(false);
    setDesktopEditing(false);
    setMobileMediaMenuOpen(false);
    setOverview(false);
    setMoveSelectMode(false);
    setMoveSelection(new Set());
    setMoveMessage("");
    setMoveUndo(null);
    setSoundtrackUpload({ status: "idle" });
    setSoundtrackRemovePending(false);
    setSoundtrackNotice("");
    // Signed reads belong to the journey that requested them.
    // StrictMode replays setup for the same scope. Keep its in-flight reads
    // coalesced; only a genuinely different selection invalidates ownership.
    if (mediaReadScope.current.journeyId !== journeyId || mediaReadScope.current.routePointId !== routePointId) {
      mediaReadScope.current = { journeyId, routePointId };
      pendingReads.current.clear();
    }
    setMediaReads({});
    setRenewalError(null);
    decodeRegistryRef.current.reset();
    setShownAssetId(null);
    setIncomingAssetId(null);
    setPendingMediaTarget(null);
    audioSamplerRef.current.stop();
    resetAudioAtmosphereEnergy();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    return () => {
      cancelPendingMediaDragSettle();
    };
  }, [initialAssetId, initialSnapState, journeyId, routePointId]);

  useEffect(() => {
    // #530: rotation, app switch and window blur interrupt the settle, not the
    // decision it carries. The effect's own cleanup is a lifecycle path and
    // stays cleanup-only.
    const cancel = () => cancelPendingMediaDragSettle(true);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
      cancelPendingMediaDragSettle();
    };
  }, [fullscreen, mobileLayout, overview]);

  useEffect(() => {
    if (deleteState === "confirming") deleteCancelRef.current?.focus();
  }, [deleteState]);

  useEffect(() => {
    if (
      !mobileLayout
      || deleteState !== "idle"
      || !restoreJourneyDeleteFocusRef.current
      || typeof window === "undefined"
    ) return;
    restoreJourneyDeleteFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      journeyDeleteTriggerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deleteState, mobileLayout]);

  useEffect(() => {
    if (!mobileLayout || typeof window === "undefined") return;
    const focusTarget = mobileManageMode
      ? mobileManageDoneRef
      : restoreMobileManageViewerFocusRef.current
        ? mobileManageViewerTriggerRef
        : null;
    if (!focusTarget) return;
    if (!mobileManageMode) restoreMobileManageViewerFocusRef.current = false;
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        focusTarget.current?.focus(mobileManageMode ? undefined : { preventScroll: true });
      });
      mobileManageFocusFrameRef.current = secondFrame;
    });
    mobileManageFocusFrameRef.current = firstFrame;
    return () => {
      if (mobileManageFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileManageFocusFrameRef.current);
        mobileManageFocusFrameRef.current = null;
      }
    };
  }, [mobileLayout, mobileManageMode]);

  useLayoutEffect(() => {
    const previousMediaDeleteState = previousMediaDeleteStateRef.current;
    previousMediaDeleteStateRef.current = mediaDeleteState;
    if (typeof window !== "undefined") {
      (window as Window & { __startripsMediaDeleteFocusDebug?: Record<string, unknown> })
        .__startripsMediaDeleteFocusDebug = {
          phase: "transition",
          previousMediaDeleteState,
          mediaDeleteState,
          mobileLayout,
          mobileManageMode,
          desktopEditing,
          intentBefore: restoreMobileMediaDeleteFocusRef.current,
        };
    }

    // Capture this semantic transition before paint. Browser QA can observe
    // the confirmation sheet and press Back before passive effects flush, so
    // previous-state ownership cannot live in the later focus effect.
    if (
      previousMediaDeleteState !== "idle"
      && mediaDeleteState === "idle"
      && mobileLayout
      && (mobileManageMode || desktopEditing)
    ) {
      restoreMobileMediaDeleteFocusRef.current = true;
    }
    if (typeof window !== "undefined") {
      const debugWindow = window as Window & {
        __startripsMediaDeleteFocusDebug?: Record<string, unknown>;
      };
      debugWindow.__startripsMediaDeleteFocusDebug = {
        ...debugWindow.__startripsMediaDeleteFocusDebug,
        intentAfter: restoreMobileMediaDeleteFocusRef.current,
      };
    }
  }, [desktopEditing, mediaDeleteState, mobileLayout, mobileManageMode]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const debugWindow = window as Window & {
        __startripsMediaDeleteFocusDebug?: Record<string, unknown>;
      };
      debugWindow.__startripsMediaDeleteFocusDebug = {
        ...debugWindow.__startripsMediaDeleteFocusDebug,
        restoreEffectEntered: true,
        restoreIntent: restoreMobileMediaDeleteFocusRef.current,
        restoreState: mediaDeleteState,
        restoreMobileLayout: mobileLayout,
        restoreMobileManageMode: mobileManageMode,
        restoreDesktopEditing: desktopEditing,
      };
    }
    if (!restoreMobileMediaDeleteFocusRef.current) return;
    if (mediaDeleteState !== "idle") return;

    if (!mobileLayout) {
      restoreMobileMediaDeleteFocusRef.current = false;
      return;
    }
    // A responsive desktop -> mobile transition can commit compact layout
    // before the follow-up effect establishes Manage ownership. desktopEditing
    // proves that Manage is still the intended compact owner, so keep the
    // restore intent alive for that next commit. A deliberate Manage exit sets
    // desktopEditing=false and must not leak this intent into a future entry.
    if (!mobileManageMode) {
      if (!desktopEditing) restoreMobileMediaDeleteFocusRef.current = false;
      return;
    }

    // This effect is deliberately declared after the normal Manage focus
    // effect. If Manage ownership was established in the same commit, its
    // two-frame handoff has already been scheduled and can be cancelled here.
    // Keep restore intent alive until the current media trigger is both visible
    // and actually owns document.activeElement.
    if (mobileManageFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileManageFocusFrameRef.current);
      mobileManageFocusFrameRef.current = null;
    }

    const debugWindow = typeof window !== "undefined"
      ? window as Window & { __startripsMediaDeleteFocusDebug?: Record<string, unknown> }
      : null;

    const focusCurrentOwner = () => {
      // Stop if this Story no longer owns the compact Manage surface.
      if (!restoreMobileMediaDeleteFocusRef.current) {
        mediaDeleteFocusFrameRef.current = null;
        return;
      }

      const target = mobileManageViewerTriggerRef.current ?? mobileManageDoneRef.current;
      const style = target ? getComputedStyle(target) : null;
      const targetReady = Boolean(
        target
        && target.isConnected
        && !target.closest("[inert]")
        && style?.visibility !== "hidden"
        && style?.display !== "none"
        && target.getClientRects().length > 0
      );

      if (debugWindow) {
        debugWindow.__startripsMediaDeleteFocusDebug = {
          ...debugWindow.__startripsMediaDeleteFocusDebug,
          targetExists: Boolean(target),
          targetConnected: target?.isConnected ?? false,
          targetInert: Boolean(target?.closest("[inert]")),
          targetVisibility: style?.visibility ?? null,
          targetDisplay: style?.display ?? null,
          targetRectCount: target?.getClientRects().length ?? 0,
          activeBeforeFocus: document.activeElement?.getAttribute?.("aria-label")
            ?? document.activeElement?.tagName
            ?? null,
        };
      }

      if (!targetReady || !target) {
        mediaDeleteFocusFrameRef.current = window.requestAnimationFrame(focusCurrentOwner);
        return;
      }

      target.focus({ preventScroll: true });
      if (document.activeElement !== target) {
        mediaDeleteFocusFrameRef.current = window.requestAnimationFrame(focusCurrentOwner);
        return;
      }

      restoreMobileMediaDeleteFocusRef.current = false;
      mediaDeleteFocusFrameRef.current = null;
      if (debugWindow) {
        debugWindow.__startripsMediaDeleteFocusDebug = {
          ...debugWindow.__startripsMediaDeleteFocusDebug,
          activeAfterFocus: target.getAttribute("aria-label") ?? target.tagName,
          focusRestored: true,
        };
      }
    };

    if (mediaDeleteFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(mediaDeleteFocusFrameRef.current);
      mediaDeleteFocusFrameRef.current = null;
    }
    focusCurrentOwner();

    return () => {
      if (mediaDeleteFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(mediaDeleteFocusFrameRef.current);
        mediaDeleteFocusFrameRef.current = null;
      }
    };
  }, [desktopEditing, mediaDeleteState, mobileLayout, mobileManageMode]);

  useEffect(() => {
    if (
      !mobileLayout
      || !overview
      || !moveSelectMode
      || !restoreMobileMoveSelectFocusRef.current
    ) return;
    const frame = window.requestAnimationFrame(() => {
      restoreMobileMoveSelectFocusRef.current = false;
      mobileMoveSelectToggleRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobileLayout, moveSelectMode, overview]);

  useEffect(() => {
    if (mediaDeleteState === "confirming") mediaDeleteCancelRef.current?.focus();
  }, [mediaDeleteState]);

  useEffect(() => {
    if (overview) return;
    setMoveSelectMode(false);
    setMoveSelection(new Set());
    setMoveMessage("");
    setMoveUndo(null);
  }, [overview]);

  // Only photos and videos are browsable media. The journey soundtrack is
  // audio, so it never enters the grid, the counts, or the ordering controls.
  const visualMedia = useMemo(
    () => journey ? journeyVisualMedia(journey) : [],
    [journey],
  );
  const scopedMedia = useMemo(
    () => journey ? storyMediaForScope(journey, selectedRoutePointId) : [],
    [journey, selectedRoutePointId],
  );
  const scopedMediaIndex = useMemo(() => indexStoryMedia(scopedMedia), [scopedMedia]);
  // Review P2: while a drag is pending, the overview renders the optimistic
  // order; otherwise it follows scopedMedia (server truth).
  const orderedScopedMedia = useMemo(
    () => storyMediaInOptimisticOrder(scopedMedia, localMediaOrder),
    [localMediaOrder, scopedMedia],
  );
  const soundtrack = journey ? journeySoundtrack(journey) : null;
  const activeAsset = scopedMedia[assetIndex] ?? null;
  useLayoutEffect(() => {
    const handoff = videoHandoffRef.current;
    if (!handoff) return;
    const read = mediaReads[handoff.id];
    if (handoff.id === requestedMediaRef.current
      && handoff.id === (shownAssetId ?? activeAsset?.id)
      && handoff.toFullscreen === fullscreen
      && handoff.scopeKey === `${journeyId}:${selectedRoutePointId ?? ""}`
      && read?.status === "ready"
      && new URL(read.url, document.baseURI).href === handoff.src) return;
    handoff.cancelMorph?.();
    handoff.dispose();
  }, [activeAsset?.id, fullscreen, incomingAssetId, journeyId, mediaReads, selectedRoutePointId, shownAssetId]);
  if (incomingAssetId === null && pendingTargetRef.current === null) {
    requestedMediaRef.current = activeAsset?.id ?? null;
  }
  const requestedMediaIndex = storyAssetIndexForId(scopedMedia, pendingMediaId ?? incomingAssetId, assetIndex, scopedMediaIndex.indexById);
  const autoplayVideoCandidate = storyAutoplayVideoCandidate(
    scopedMedia,
    assetIndex,
    selectedRoutePointId === null,
  );
  const autoplayVideoCandidateRead = autoplayVideoCandidate
    ? mediaReads[autoplayVideoCandidate.id]
    : null;
  const protectedPlaybackRead = useRef<string | null>(null);
  protectedPlaybackRead.current = playing && activeAsset?.mimeType.startsWith("video/") ? activeAsset.id : null;
  const protectedVideoRead = useCallback((assetId: string) => {
    if (protectedPlaybackRead.current === assetId || videoHandoffRef.current?.id === assetId) return true;
    // Fullscreen owns the shown video's time until it hands that time back to
    // inline. Refreshing one hidden stage during that interval would make Back
    // land on the renewed video's first frame instead of the paused position.
    if (fullscreenRef.current && !fullscreenRef.current.hidden
      && fullscreenVideoRef.current?.dataset.sharedMediaId === assetId) return true;
    // Native controls can play a clip independently of Story autoplay. An
    // in-flight renewal must not replace that transport or a fullscreen morph.
    return [storyVideoRef.current, fullscreenVideoRef.current].some((video) =>
      Boolean(video && video.dataset.sharedMediaId === assetId
        && (video.seeking || (!video.paused && !video.ended))));
  }, []);
  const activeRead = activeAsset ? mediaReads[activeAsset.id] : null;
  const soundtrackRead = soundtrack ? mediaReads[soundtrack.id] : null;
  // #14: the journey cover — explicit coverMediaAssetId, else first visual
  // media by sortOrder, else null. Cards/story use it as the representative
  // image; it is independent of slideshow order.
  const cover = journey ? journeyCover(journey) : null;

  useEffect(() => {
    if (!journey) return;
    onObservationChange?.(storyLogicalObservation(
      journey,
      selectedRoutePointId,
      shownAssetId ?? activeAsset?.id ?? null,
      mobileLayout,
      mobileStoryExpanded,
    ));
  }, [
    activeAsset?.id,
    journey,
    mobileLayout,
    mobileStoryExpanded,
    onObservationChange,
    selectedRoutePointId,
    shownAssetId,
  ]);
  function visualMediaCount(pointId: string | null) {
    return visualMedia.filter((asset) => asset.routePointId === pointId).length;
  }

  function scopedVisualMedia(target: Journey) {
    return storyMediaForScope(target, selectedRoutePointId);
  }

  // Media duration begins once the requested page has become visible.
  const navigateToMediaRef = useRef<(index: number) => void>(() => undefined);
  navigateToMediaRef.current = navigateToMedia;
  const navigateMediaStepRef = useRef<(direction: -1 | 1, wrap: boolean) => void>(() => undefined);
  navigateMediaStepRef.current = navigateMediaStep;
  useLayoutEffect(() => {
    if (!playing || mediaGestureHolding || incomingAssetId !== null || pendingMediaId !== null) return;
    if (videoHandoffRef.current?.id === activeAsset?.id
      && videoHandoffRef.current.toFullscreen === fullscreen) return;
    if (activeRead?.status !== "error" && activeStagePlaybackReadyId !== activeAsset?.id) return;
    const advance = storyAutoplayAdvance(
      assetIndex,
      scopedMedia.length,
      selectedRoutePointId === null,
    );
    if (advance.kind === "stop") {
      setPlaying(false);
      return;
    }
    const finishStep = advance.kind === "hold-terminal"
      ? () => setPlaying(false)
      : () => navigateToMediaRef.current(advance.nextIndex);
    // #199 review: a video step must last as long as the video, not 5.2s.
    // Only the settled element of this exact asset can report `ended`.
    const video = fullscreen ? fullscreenVideoRef.current : storyVideoRef.current;
    const waitsForVideoEnd = storyAutoplayWaitsForVideoEnd(
      activeAsset,
      storyMediaAvailability(activeRead?.status),
      video !== null && (shownAssetId ?? activeAsset?.id ?? null) === activeAsset?.id,
    );
    if (!video || !waitsForVideoEnd) {
      const timer = window.setTimeout(finishStep, STORY_AUTOPLAY_STEP_MS);
      return () => window.clearTimeout(timer);
    }
    // A browser that refuses to play, or an element that errors, must not
    // strand the sequence: it degrades to the ordinary slide timer.
    const fallback = createStoryAutoplayFallbackController(
      () => window.setTimeout(finishStep, STORY_AUTOPLAY_STEP_MS),
      (timer) => window.clearTimeout(timer),
    );
    const stallWatchdog = createStoryAutoplayFallbackController(
      () => window.setTimeout(finishStep, STORY_VIDEO_STALL_WATCHDOG_MS),
      (timer) => window.clearTimeout(timer),
    );
    const armFallback = () => fallback.arm();
    const armStallWatchdog = () => stallWatchdog.arm();
    const recoverFromStall = () => stallWatchdog.cancel();
    // Native controls are another playback owner. If the viewer pauses the
    // settled clip directly, stop Story autoplay too so soundtrack/state do
    // not claim the sequence is still progressing. Ignore the terminal pause
    // associated with an ended clip; `ended` owns that transition.
    const stopForNativePause = () => {
      if (!video.ended && videoHandoffRef.current?.source !== video) setPlaying(false);
    };
    video.addEventListener("ended", finishStep);
    video.addEventListener("error", armFallback);
    video.addEventListener("pause", stopForNativePause);
    video.addEventListener("stalled", armStallWatchdog);
    video.addEventListener("playing", recoverFromStall);
    video.addEventListener("progress", recoverFromStall);
    video.addEventListener("timeupdate", recoverFromStall);
    Promise.resolve(video.play()).catch(armFallback);
    return () => {
      video.removeEventListener("ended", finishStep);
      video.removeEventListener("error", armFallback);
      video.removeEventListener("pause", stopForNativePause);
      video.removeEventListener("stalled", armStallWatchdog);
      video.removeEventListener("playing", recoverFromStall);
      video.removeEventListener("progress", recoverFromStall);
      video.removeEventListener("timeupdate", recoverFromStall);
      // Dispose before touching the element: pending play() rejection/stall
      // callbacks after cleanup must not revive an obsolete Story step.
      fallback.dispose();
      stallWatchdog.dispose();
      // Leaving this step (pause, manual navigation, stage change) also stops
      // the video the sequence itself started.
      video.pause();
    };
  }, [
    activeAsset?.id,
    activeRead?.status,
    assetIndex,
    fullscreen,
    playing,
    mediaGestureHolding,
    scopedMedia.length,
    selectedRoutePointId,
    shownAssetId,
    incomingAssetId,
    pendingMediaId,
    activeStagePlaybackReadyId,
    videoHandoffRevision,
  ]);

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
    if (!mobileLayout) {
      if (mobileManageMode) setDesktopEditing(true);
      setMobileStoryCoverTransitionActive(false);
      setMobileStoryExpanded((expanded) => mobileStoryExpandedForLayout(false, expanded));
      setMobileMediaMenuOpen(false);
      return;
    }
    // A responsive desktop -> compact transition must preserve editing intent.
    // Never label the compact Story as Viewer while an edit-only surface is
    // still mounted; carry that state into explicit Manage mode instead.
    if (
      desktopEditing
      || overview
      || deleteState !== "idle"
      || mediaDeleteState !== "idle"
      || moveSelectMode
      || mutationPending
    ) {
      setMobileManageMode(true);
    }
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
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("video, audio, input, textarea, select, [contenteditable='true']")) return;
      if ((event.key === " " || event.key === "Spacebar") && target instanceof Element && target.closest("button")) return;
      if (event.key === "Escape") {
        exitFullscreen();
      } else if (event.key === "ArrowLeft") {
        navigateMediaStepRef.current(-1, selectedRoutePointId !== null);
      } else if (event.key === "ArrowRight") {
        navigateMediaStepRef.current(1, selectedRoutePointId !== null);
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
  }, [fullscreen, assetIndex, scopedMedia.length, mobileLayout, selectedRoutePointId]);

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
      // Returning to a persistent media node must not scroll the Story under
      // its sticky mobile header (the original photo may now be a back page).
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
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
    // Canonical whole-Journey ordering can change without changing list length
    // (for example after #67/#75 reassigns an asset to another chapter). Keep
    // the settled media identity stable and rebase its index onto the new
    // sequence instead of silently switching to whichever asset inherited the
    // previous numeric index.
    setAssetIndex((current) => storyAssetIndexForId(scopedMedia, shownAssetId, current, scopedMediaIndex.indexById));
    if (shownAssetId && !scopedMediaIndex.byId.has(shownAssetId)) {
      setShownAssetId(null);
      setIncomingAssetId(null);
      setPendingMediaTarget(null);
    }
  }, [scopedMedia, scopedMediaIndex, shownAssetId]);

  useEffect(() => {
    mediaReadsRef.current = mediaReads;
  }, [mediaReads]);

  // Signed reads are cached for the lifetime of the open dialog so revisiting a
  // photo, or opening the overview grid again, costs no extra request.
  const loadMediaRead = useCallback((assetId: string, refresh = false) => {
    // A warm neighbor becoming current must keep the decoded resource. A new
    // signature changes img.src and restarts an in-flight page handoff.
    const cached = mediaReadsRef.current[assetId];
    const renewingRead = cached?.status === "ready";
    if (!refresh && cached?.status === "ready"
      && !shouldRefreshStoryMediaRead(assetId, cached, Date.now(), protectedVideoRead(assetId) ? assetId : null)) return;
    if (pendingReads.current.has(assetId)) return;
    pendingReads.current.add(assetId);
    setMediaReads((current) => current[assetId]?.status === "ready"
      ? current
      : { ...current, [assetId]: { status: "loading" } });
    const issuedAt = Date.now();
    const generation = ++mediaReadGeneration.current;
    const scope = mediaReadScope.current;
    // Playback can claim the existing resource while this request is in flight.
    // Check again when React applies either completion; the next expiry sweep
    // may retry after playback releases it, without resetting a live transport.
    void readMedia(assetId).then(
      (read) => setMediaReads((current) => mediaReadScope.current !== scope
        || (protectedVideoRead(assetId) && current[assetId]?.status === "ready") ? current : ({
        ...current,
        [assetId]: {
          status: "ready",
          url: read.url,
          preview: read.preview,
          issuedAt,
          generation,
          expiresAt: Date.parse(read.expiresAt),
        },
      })),
      (error) => {
        const message = error instanceof Error ? error.message : "媒体读取失败";
        if (mediaReadScope.current === scope) {
          const previousRead = mediaReadsRef.current[assetId];
          const shownVideo = storyVideoRef.current?.dataset.sharedMediaId === assetId
            || fullscreenVideoRef.current?.dataset.sharedMediaId === assetId;
          if (renewingRead && previousRead?.status === "ready" && shownVideo && !protectedVideoRead(assetId)) {
            setRenewalError((current) => ({ id: assetId, sourceGeneration: current?.id === assetId
              ? current.sourceGeneration : previousRead.generation, message, retrying: false }));
          } else setRenewalError((current) => current?.id === assetId
            ? { ...current, message, retrying: false } : current);
        }
        setMediaReads((current) => mediaReadScope.current !== scope
          || ((renewingRead || protectedVideoRead(assetId)) && current[assetId]?.status === "ready") ? current : ({
          ...current, [assetId]: { status: "error", message },
        }));
      },
    ).finally(() => {
      if (mediaReadScope.current === scope) pendingReads.current.delete(assetId);
    });
  }, [protectedVideoRead]);

  // Presentation commits only the latest requested asset after it is ready.
  const settleIncoming = useCallback((assetId: string) => {
    // A late handoff from an abandoned request cannot replace the latest frame.
    if (incomingMediaRef.current !== assetId) return;
    setShownAssetId((current) => current === assetId ? current : assetId);
    setIncomingAssetId((current) => current === assetId ? null : current);
  }, []);

  const reportStageMediaError = useCallback((assetId: string, message: string, retainedVideoFrame = false) => {
    const currentRead = mediaReadsRef.current[assetId];
    if (retainedVideoFrame && currentRead?.status === "ready") {
      setRenewalError({ id: assetId, sourceGeneration: currentRead.generation,
        message, retrying: false });
      return;
    }
    setMediaReads((current) => ({ ...current, [assetId]: { status: "error", message } }));
    // Failed targets still own an unavailable interval in Story autoplay.
    if (incomingMediaRef.current === assetId) {
      setShownAssetId(assetId);
      setIncomingAssetId(null);
    }
  }, []);

  useEffect(() => {
    if (activeAsset) loadMediaRead(activeAsset.id);
  }, [activeAsset?.id, loadMediaRead]);

  useEffect(() => {
    if (soundtrack) loadMediaRead(soundtrack.id);
  }, [soundtrack?.id, loadMediaRead]);

  // #204 final review: keep the first future video read warm even when it is
  // farther than the ordinary neighbor window. Story can then mount one stable
  // video element before autoplay starts and authorize that same element inside
  // the initiating user gesture instead of creating a fresh untrusted element
  // several image steps later. This is one signed-read request, not a decode-all.
  useEffect(() => {
    if (autoplayVideoCandidate) loadMediaRead(autoplayVideoCandidate.id);
  }, [autoplayVideoCandidate?.id, loadMediaRead]);

  const stackNeighborIndices = useMemo(() => {
    const anchorId = shownAssetId ?? activeAsset?.id;
    return mediaStackNeighbors(
      anchorId === undefined ? -1 : scopedMediaIndex.indexById.get(anchorId) ?? -1,
      scopedMedia.length,
      selectedRoutePointId !== null,
    );
  }, [shownAssetId, activeAsset?.id, scopedMedia, scopedMediaIndex, selectedRoutePointId]);

  // #11: prepare adjacent slideshow media while the active one is on screen.
  // The window is next 1 + previous 1 for manual browsing, next 2 for
  // autoplay. Only images are decoded ahead; videos stay at preload metadata.
  useEffect(() => {
    if (!activeAsset || scopedMedia.length < 2) return;
    const activeIndex = scopedMediaIndex.indexById.get(activeAsset.id) ?? -1;
    if (activeIndex < 0) return;
    const windowFor = prefetchWindowFor(activeIndex, scopedMedia.length, playing);
    const target = new Set(
      [...windowFor.next, ...windowFor.previous, ...stackNeighborIndices]
        .map((index) => scopedMedia[index])
        .filter((asset): asset is JourneyMediaAsset => asset !== undefined),
    );
    for (const candidate of target) {
      // Request the signed read (cached; no duplicate requests).
      loadMediaRead(candidate.id);
    }
    // Release decoded refs outside the window so hundreds of images are not
    // all kept in memory for one open dialog.
    const keep = new Set<string>([activeAsset.id, ...[...target].map((asset) => asset.id)]);
    for (const index of windowFor.next) keep.add(scopedMedia[index]?.id ?? "");
    for (const index of windowFor.previous) keep.add(scopedMedia[index]?.id ?? "");
    for (const [assetId, state] of Object.entries(mediaReadsRef.current)) {
      if (state.status === "ready" && !keep.has(assetId)) {
        decodeRegistryRef.current.release(assetId);
      }
    }
  }, [activeAsset?.id, scopedMedia, scopedMediaIndex, playing, loadMediaRead, stackNeighborIndices]);

  // #11: start the browser decode for any image whose signed read became
  // ready inside the prefetch window (or is the current frame). Runs whenever
  // reads settle, so an async read completion starts the decode automatically.
  useEffect(() => {
    const windowTargets = new Set<string>([activeAsset?.id ?? "", ...stackNeighborIndices.map((index) => scopedMedia[index].id)]);
    if (activeAsset && scopedMedia.length >= 2) {
      const activeIndex = scopedMediaIndex.indexById.get(activeAsset.id) ?? -1;
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
        const asset = scopedMediaIndex.byId.get(assetId);
        if (asset?.mimeType.startsWith("image/")) {
          decodeRegistryRef.current.ensure(assetId, state.url);
        }
      }
    }
  }, [mediaReads, activeAsset?.id, scopedMedia, scopedMediaIndex, playing, stackNeighborIndices]);

  // Initial selection has no prior page to preserve.
  useEffect(() => {
    if (incomingAssetId !== null || shownAssetId !== null) return;
    if (activeAsset) setShownAssetId(activeAsset.id);
  }, [activeAsset?.id, incomingAssetId, shownAssetId]);

  // A requested target waits for its read and decode while the current page
  // remains visible. Only then may the presentation pages start their handoff.
  // Review P1: the effect re-runs on every decode settle revision, and when
  // the target's signed read is already ready it starts the decode so a
  // pending target can never stall.
  useEffect(() => {
    // A cold target may become ready while the pointer is held on the old
    // page. Let that gesture finish before changing its physical page owner.
    if (mediaGestureHolding) return;
    const pendingId = pendingTargetRef.current;
    if (pendingId === null) return;
    const pendingIndex = scopedMediaIndex.indexById.get(pendingId) ?? -1;
    const target = scopedMedia[pendingIndex];
    if (!target) {
      setPendingMediaTarget(null);
      return;
    }
    const targetRead = mediaReads[target.id];
    if (targetRead?.status === "ready" && target.mimeType.startsWith("image/")) {
      const readiness = decodeRegistryRef.current.ensure(target.id, targetRead.url);
      if (readiness.status === "error") {
        reportStageMediaError(target.id, readiness.message);
        return;
      }
    }
    const disposition = storyNavigationTargetDisposition(
      target,
      storyMediaAvailability(targetRead?.status),
      decodeRegistryRef.current.isDecoded(target.id),
    );
    if (disposition === "failed") {
      // A terminal read failure is still a completed navigation step. Promote
      // it so Story autoplay can own the unavailable-media interval and move
      // on, instead of leaving the prior frame pending forever.
      setPendingMediaTarget(null);
      setIncomingAssetId(null);
      setShownAssetId(target.id);
      setAssetIndex(pendingIndex);
      return;
    }
    if (disposition !== "ready") return;
    setPendingMediaTarget(null);
    setIncomingAssetId(target.id);
    setAssetIndex(pendingIndex);
  }, [decodeSettleRevision, mediaReads, scopedMedia, scopedMediaIndex, activeAsset?.id, playing, pendingMediaId, mediaGestureHolding, setPendingMediaTarget, reportStageMediaError]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      // #204 final review: while Story autoplay owns the settled video, do not
      // replace its signed URL underneath the element. Replacing `src` resets
      // the media resource and can pause/stall an otherwise healthy long clip.
      // Once autoplay releases ownership (pause/end/navigation), the next sweep
      // refreshes it normally before it is reused.
      for (const [assetId, state] of Object.entries(mediaReadsRef.current)) {
        if (shouldRefreshStoryMediaRead(assetId, state, now, protectedVideoRead(assetId) ? assetId : null)) {
          loadMediaRead(assetId, true);
        }
      }
    }, MEDIA_READ_SWEEP_MS);
    return () => window.clearInterval(timer);
  }, [loadMediaRead, protectedVideoRead]);

  const namedStops = useMemo(
    () => journey?.routePoints.filter((point) => point.isStop) ?? [],
    [journey],
  );
  useEffect(() => {
    if (renewalError && renewalError.id !== (shownAssetId ?? activeAsset?.id)) setRenewalError(null);
  }, [renewalError, shownAssetId, activeAsset?.id]);

  if (!journey) return null;
  const selectedRoutePoint = selectedRoutePointId
    ? journey.routePoints.find((point) => point.id === selectedRoutePointId) ?? null
    : null;
  const asset = activeAsset;
  const activeChapterRoutePointId = selectedRoutePointId === null
    ? asset?.routePointId ?? null
    : selectedRoutePointId;
  const activeChapterRoutePoint = activeChapterRoutePointId
    ? journey.routePoints.find((point) => point.id === activeChapterRoutePointId) ?? null
    : null;
  const notesRoutePoint = selectedRoutePoint ?? activeChapterRoutePoint;
  const notesRoutePointNote = notesRoutePoint
    ? routePointNoteDrafts[notesRoutePoint.id] ?? notesRoutePoint.note ?? ""
    : "";
  // These are semantic identities; StoryMediaPages retains the physical pages.
  const shownAsset = shownAssetId
    ? scopedMediaIndex.byId.get(shownAssetId) ?? null
    : asset;
  const videoNeedsResume = Boolean(videoResumeBlocked
    && videoResumeBlocked.id === shownAsset?.id
    && videoResumeBlocked.toFullscreen === fullscreen);
  const videoNavigationVisible = Boolean(shownAsset?.mimeType.startsWith("video/") && scopedMedia.length > 1);
  const canStepPrevious = !mutationPending && scopedMedia.length > 1
    && (selectedRoutePointId !== null || requestedMediaIndex > 0);
  const canStepNext = !mutationPending && scopedMedia.length > 1
    && (selectedRoutePointId !== null || requestedMediaIndex < scopedMedia.length - 1);
  const shownRead = shownAsset ? mediaReads[shownAsset.id] : null;
  const heldRenewalError = renewalError?.id === shownAsset?.id && shownRead?.status === "ready"
    ? renewalError : null;
  const incoming = incomingAssetId && incomingAssetId !== shownAssetId
    ? scopedMediaIndex.byId.get(incomingAssetId) ?? null
    : null;
  const pendingTarget = pendingTargetRef.current !== null
    ? scopedMediaIndex.byId.get(pendingTargetRef.current) ?? null
    : null;
  const pendingTargetRead = pendingTarget ? mediaReads[pendingTarget.id] : null;
  // #489 B/acceptance 3: once a page owns the stage the handoff is hidden by
  // contract -- the stack keeps that presentable frame and commits when the new
  // source is really drawable. A stage-level waiting cue over it is the
  // "loading flash" the issue forbids, so the cue belongs to a stage no page
  // owns yet (cold open, or a shown asset whose own read is still loading).
  const stageOwnedByPage = shownRead?.status === "ready";
  const mediaStageWaiting = !stageOwnedByPage && Boolean(
    (shownAsset && (!shownRead || shownRead.status === "loading"))
    || (
      pendingTarget
      && pendingTarget.id !== shownAsset?.id
      && pendingTargetRead?.status !== "error"
    ),
  );
  const mediaStageStatus = (
    <>
      {heldRenewalError ? (
        <div className="journey-story__media-state starlight-media-state is-over-media" role="alert">
          <strong>视频暂时无法更新，当前画面仍可查看</strong>
          <button type="button" style={{ pointerEvents: "auto" }} disabled={heldRenewalError.retrying} onClick={() => {
            if (!shownAsset) return;
            setRenewalError((current) => current?.id === shownAsset.id
              ? { ...current, retrying: true } : current);
            loadMediaRead(shownAsset.id, true);
          }} onKeyDown={(event) => {
            if (event.key === " " || event.key === "Spacebar") event.stopPropagation();
          }}>{heldRenewalError.retrying ? "正在重试…" : "重试打开"}</button>
        </div>
      ) : null}
      {mediaStageWaiting ? (
        <div className="journey-story__media-state starlight-media-state is-waiting" role="status" aria-live="polite">
          <StartripsJourneyCue state="waiting" size={58} className="starlight-media-state__cue" />
          <div className="starlight-media-state__copy" aria-label="正在载入媒体">
            <strong className={!mobileLayout ? "story-visually-hidden" : undefined}>
              {pendingTarget ? "正在打开所选媒体…" : "正在打开媒体…"}
            </strong>
          </div>
        </div>
      ) : null}
      {shownAsset && shownRead?.status === "error" ? (
        <div className="journey-story__media-state starlight-media-state is-error" role="alert">
          <StartripsJourneyCue state="rest" size={58} className="starlight-media-state__cue" />
          <div className="starlight-media-state__copy">
            <strong>媒体暂时无法打开</strong>
            <span>{shownRead.message}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              decodeRegistryRef.current.release(shownAsset.id);
              loadMediaRead(shownAsset.id);
            }}
            onKeyDown={(event) => {
              // Let Space activate Retry instead of the fullscreen play shortcut.
              if (event.key === " " || event.key === "Spacebar") event.stopPropagation();
            }}
          >重试打开</button>
          {!mobileLayout && scopedMedia.length > 1 ? <button
            type="button"
            disabled={mutationPending}
            onClick={() => navigateFromPicture(
              selectedRoutePointId !== null || requestedMediaIndex < scopedMedia.length - 1 ? 1 : -1,
              true,
            )}
          >{selectedRoutePointId !== null || requestedMediaIndex < scopedMedia.length - 1 ? "查看下一张" : "查看上一张"}</button> : null}
        </div>
      ) : null}
      {videoNeedsResume ? (
        <div className="journey-story__media-state starlight-media-state is-over-media" role="status">
          <strong>视频已暂停，点击画面上的播放键继续</strong>
        </div>
      ) : null}
    </>
  );
  // #204 CFAA family fix: one persistent video node owns priming, incoming, and
  // settled video states. Prefer the incoming video over the old settled video
  // so video→video navigation can actually mount and settle the destination.
  const storyStageVideoAsset = storyStageVideoOwner(
    shownAsset,
    incoming,
    autoplayVideoCandidate,
  );
  const storyStageVideoRead = storyStageVideoAsset ? mediaReads[storyStageVideoAsset.id] : null;
  const storyStageVideoSettled = Boolean(
    shownAsset
    && storyStageVideoAsset
    && shownAsset.id === storyStageVideoAsset.id
    && shownRead?.status === "ready"
    && shownAsset.mimeType.startsWith("video/"),
  );
  const storyStageVideoIncoming = Boolean(
    incoming
    && storyStageVideoAsset
    && incoming.id === storyStageVideoAsset.id
    && storyStageVideoRead?.status === "ready",
  );
  const storyStageVideoVisible = storyStageVideoSettled || storyStageVideoIncoming;
  function renderStageVideo(immersive: boolean) {
    return storyStageVideoAsset ? <video
      ref={immersive ? fullscreenVideoRef : storyVideoRef}
      src={storyStageVideoRead?.status === "ready" ? storyStageVideoRead.url : undefined}
      controls={storyStageVideoSettled}
      playsInline
      preload="metadata"
      hidden={!storyStageVideoVisible}
      aria-hidden={storyStageVideoVisible ? undefined : true}
      data-shared-media-id={storyStageVideoSettled ? storyStageVideoAsset.id : undefined}
      data-shared-journey-cover={storyStageVideoSettled && cover?.id === storyStageVideoAsset.id ? "true" : undefined}
      onPlay={(event) => {
        // The temporarily authorized target may emit play after a reverse.
        // Only the settled visible transport can dismiss its recovery cue.
        if (immersive === fullscreen && !videoHandoffRef.current
          && event.currentTarget.dataset.sharedMediaId === shownAsset?.id) setVideoResumeBlocked(null);
      }}
    /> : null;
  }
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

  function cancelPendingMediaDragSettle(commitDecided = false) {
    // Only a user-facing interruption may commit a landed swipe (#530); every
    // other caller is about to replace the selection or tear the stage down.
    for (const stage of [inlineStageRef.current, fullscreenStageRef.current]) {
      (stage?.cancelGesture as StoryMediaGestureCancel | undefined)?.(commitDecided);
    }
    setMediaGestureHolding(false);
  }

  function claimStoryMediaGesture(currentId: string) {
    // The stage owns the paint and pointer. Story only reclaims its latest
    // semantic request when a horizontal gesture actually takes ownership.
    setIncomingAssetId(null);
    setPendingMediaTarget(null);
    requestedMediaRef.current = currentId;
    setAssetIndex(storyAssetIndexForId(scopedMedia, currentId, assetIndex, scopedMediaIndex.indexById));
  }

  function commitStoryMediaGesture(targetId: string) {
    const index = scopedMediaIndex.indexById.get(targetId);
    if (index === undefined) return;
    requestedMediaRef.current = targetId;
    setPendingMediaTarget(null);
    setIncomingAssetId(null);
    setAssetIndex(index);
    setShownAssetId(targetId);
  }

  function prepareStoryMediaGestureTarget(targetId: string) {
    const asset = scopedMediaIndex.byId.get(targetId);
    if (!asset) return;
    const read = mediaReads[targetId];
    if (read?.status !== "ready") loadMediaRead(targetId);
    else if (asset.mimeType.startsWith("image/")) decodeRegistryRef.current.ensure(targetId, read.url);
  }

  function openFullscreenAfterStoryGesture() {
    // Story chooses the destination; the active stage reports the real spring
    // completion only while that gesture still owns its media and surface.
    enterFullscreen(false);
  }

  function openImageFullscreenAfterTap(accessibleActivation = false) {
    if (!accessibleActivation && storyMediaGestureConsumedRef.current) {
      storyMediaGestureConsumedRef.current = false;
      return;
    }
    storyMediaGestureConsumedRef.current = false;
    cancelPendingMediaDragSettle();
    enterFullscreen(mobileLayout ? false : playingRef.current);
  }

  function navigateFromPicture(direction: -1 | 1, accessibleActivation = false) {
    if (!accessibleActivation && storyMediaGestureConsumedRef.current) {
      storyMediaGestureConsumedRef.current = false;
      return;
    }
    if (mutationPending || overview) return;
    storyMediaGestureConsumedRef.current = false;
    navigateMediaStep(direction, selectedRoutePointId !== null);
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

  async function uploadFiles(
    files: readonly File[],
    targetRoutePointId: string | null = selectedRoutePointId,
  ) {
    if (!manageMedia) return;
    invalidateMoveUndo();
    setRetryFiles([]);
    setRetryRoutePointId(null);
    setPlacementReview(null);
    setPlacementRetryGroups([]);
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
    const result = await manageMedia.uploadJourneyMedia({
      journeyId: journey.id,
      routePointId: targetRoutePointId ?? undefined,
      files,
      onProgress: (progress) => setUploadState({ status: "uploading", ...progress }),
    });

    let refreshFailed = false;
    if (result.uploadedCount > 0) {
      try {
        const refreshedJourney = await onMediaAdded(journey.id);
        const refreshedMedia = refreshedJourney
          ? storyMediaForScope(refreshedJourney, targetRoutePointId)
          : [];
        const uploadedAssetIndex = storyUploadedAssetIndex(
          refreshedMedia,
          result.assets.map((asset) => asset.id),
        );
        if (uploadedAssetIndex !== null) {
          setAssetIndex(uploadedAssetIndex);
          setShownAssetId(refreshedMedia[uploadedAssetIndex].id);
          setIncomingAssetId(null);
          setPendingMediaTarget(null);
        } else {
          refreshFailed = true;
        }
      } catch {
        refreshFailed = true;
      }
    }

    const failedFiles = result.mediaErrors.map((error) => files[error.fileIndex]);
    setRetryFiles(failedFiles);
    setRetryRoutePointId(targetRoutePointId);
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
        message: targetRoutePointId
          ? `\u5df2\u5c06 ${result.uploadedCount} \u4e2a\u5a92\u4f53\u6dfb\u52a0\u5230\u300c${journey.routePoints.find((point) => point.id === targetRoutePointId)?.label || "\u6240\u9009\u65c5\u7a0b\u70b9"}\u300d\u3002`
          : `\u5df2\u5c06 ${result.uploadedCount} \u4e2a\u5a92\u4f53\u6dfb\u52a0\u5230\u6574\u6bb5\u65c5\u7a0b\u3002`,
      });
    }
  }

  function placementAnalysisIsCurrent(intent: PlacementAnalysisIntent) {
    return placementAnalysisAuthorityRef.current?.isCurrent(intent, placementAnalysisScopeRef.current) ?? false;
  }

  function invalidatePlacementAnalysis() {
    placementAnalysisAuthorityRef.current?.invalidate(placementAnalysisScopeRef.current);
    setPlacementReview(null);
    setPlacementRetryGroups([]);
    setPlacementAnalyzing(false);
  }

  async function reviewSelectedFiles(files: File[]) {
    const authority = placementAnalysisAuthorityRef.current;
    if (!authority) return;
    const intent = authority.start(placementAnalysisScopeRef.current);
    setPlacementRetryGroups([]);
    const validation = validateJourneyFiles(files);
    if (!validation.accepted) {
      if (placementAnalysisIsCurrent(intent)) await uploadFiles(files);
      return;
    }
    setPlacementAnalyzing(true);
    try {
      const signals = await Promise.all(files.map(readMediaPlacementSignal));
      if (!placementAnalysisIsCurrent(intent)) return;
      const batch = groupMediaPlacementSuggestions(signals, journeys, journey.id);
      if (batch.groups.length === 0) {
        if (placementAnalysisIsCurrent(intent)) await uploadFiles(files);
        return;
      }
      const completeSingleGroup = batch.groups.length === 1
        && batch.unsuggestedFileIndexes.length === 0
        && batch.groups[0].fileIndexes.length === files.length;
      const suggestion = completeSingleGroup ? batch.groups[0] : null;
      if (
        suggestion
        && suggestion.journeyId === journey.id
        && suggestion.routePointId === selectedRoutePointId
      ) {
        if (placementAnalysisIsCurrent(intent)) await uploadFiles(files);
        return;
      }
      if (placementAnalysisIsCurrent(intent)) setPlacementReview({ files, batch });
    } finally {
      // Analysis B may have started while A was awaiting metadata. A's finally
      // never clears B's analyzing owner.
      if (placementAnalysisIsCurrent(intent)) setPlacementAnalyzing(false);
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (selected.length > 0) void reviewSelectedFiles(selected);
  }


  async function uploadPlacementGroups(groups: readonly PendingPlacementUploadGroup[]) {
    if (groups.length === 0 || mutationPending || !manageMedia) return;
    setPlacementReview(null);
    setPlacementRetryGroups([]);
    setRetryFiles([]);
    setRetryRoutePointId(null);
    setCloseBlocked(false);
    const totalBytes = groups.reduce(
      (sum, group) => sum + group.files.reduce((groupSum, file) => groupSum + file.size, 0),
      0,
    );
    setUploadState({
      status: "uploading",
      fileName: "\u6309\u5efa\u8bae\u5206\u522b\u653e\u7f6e",
      uploadedBytes: 0,
      totalBytes,
    });

    let completedBytes = 0;
    let uploadedCount = 0;
    let refreshFailed = false;
    const failedGroups: PendingPlacementUploadGroup[] = [];
    let firstFailure: string | null = null;
    for (const group of groups) {
      const groupBytes = group.files.reduce((sum, file) => sum + file.size, 0);
      const result = await manageMedia.uploadJourneyMedia({
        journeyId: group.journeyId,
        routePointId: group.routePointId ?? undefined,
        files: group.files,
        onProgress: (progress) => setUploadState({
          status: "uploading",
          fileName: progress.fileName,
          uploadedBytes: completedBytes + progress.uploadedBytes,
          totalBytes,
        }),
      });
      uploadedCount += result.uploadedCount;
      if (result.uploadedCount > 0) {
        try {
          const refreshedJourney = await onMediaAdded(group.journeyId);
          if (!refreshedJourney) {
            refreshFailed = true;
          } else if (groups.length === 1 && group.journeyId === journey.id) {
            const selection = groupedPlacementRefreshSelection(
              refreshedJourney,
              group.routePointId,
              result.assets.map((asset) => asset.id),
            );
            if (!selection) {
              refreshFailed = true;
            } else {
              setAssetIndex(selection.assetIndex);
              setShownAssetId(selection.assetId);
              setIncomingAssetId(null);
              setPendingMediaTarget(null);
            }
          }
        } catch {
          // Upload is already canonical server state. A later refresh/reopen will
          // surface it; do not repeat the upload because a refresh failed.
          refreshFailed = true;
        }
      }
      if (result.mediaErrors.length > 0) {
        const failedFiles = result.mediaErrors.map((error) => group.files[error.fileIndex]).filter(Boolean);
        if (failedFiles.length > 0) {
          failedGroups.push({ ...group, files: failedFiles });
        }
        firstFailure ??= formatUploadError(result.mediaErrors[0].message);
      }
      completedBytes += groupBytes;
    }

    setPlacementRetryGroups(failedGroups);
    setCloseBlocked(false);
    if (failedGroups.length > 0) {
      const failedCount = failedGroups.reduce((sum, group) => sum + group.files.length, 0);
      setUploadState({
        status: "complete",
        tone: "error",
        message: uploadedCount > 0
          ? `\u5df2\u6309\u5efa\u8bae\u653e\u7f6e ${uploadedCount} \u4e2a\u5a92\u4f53\uff1b${failedCount} \u4e2a\u5931\u8d25\u3002${firstFailure ?? "\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"}${refreshFailed ? " \u5df2\u4e0a\u4f20\u7684\u5a92\u4f53\u6682\u672a\u5237\u65b0\uff0c\u91cd\u65b0\u6253\u5f00\u65c5\u7a0b\u5373\u53ef\u770b\u5230\uff0c\u4e0d\u9700\u8981\u91cd\u590d\u4e0a\u4f20\u3002" : ""}`
          : firstFailure ?? "\u6309\u5efa\u8bae\u653e\u7f6e\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
      });
      return;
    }
    if (refreshFailed) {
      setUploadState({
        status: "complete",
        tone: "error",
        message: "\u5a92\u4f53\u5df2\u4e0a\u4f20\uff0c\u4f46\u5f53\u524d\u5217\u8868\u5237\u65b0\u5931\u8d25\u3002\u91cd\u65b0\u6253\u5f00\u8fd9\u6bb5\u65c5\u7a0b\u5373\u53ef\u770b\u5230\uff0c\u4e0d\u9700\u8981\u91cd\u590d\u4e0a\u4f20\u3002",
      });
      return;
    }
    setUploadState({
      status: "complete",
      tone: "success",
      message: `\u5df2\u6309\u5efa\u8bae\u5206\u522b\u653e\u7f6e ${uploadedCount} \u4e2a\u5a92\u4f53\u3002`,
    });
  }

  function confirmSuggestedPlacementGroups() {
    if (!placementReview || mutationPending) return;
    const plan = completeMediaPlacementUploadPlan(placementReview.batch, placementReview.files.length);
    if (!plan) return;
    const groups = plan.map((group) => ({
      journeyId: group.journeyId,
      routePointId: group.routePointId,
      files: group.fileIndexes.map((index) => placementReview.files[index]),
    }));
    if (groups.length === 1 && groups[0].journeyId === journey.id) {
      setSelectedRoutePointId(groups[0].routePointId);
    }
    void uploadPlacementGroups(groups);
  }
  function confirmPlacementUpload(targetRoutePointId: string | null) {
    if (!placementReview || mutationPending) return;
    const files = placementReview.files;
    cancelPendingMediaDragSettle();
    setSelectedRoutePointId(targetRoutePointId);
    setPlacementReview(null);
    void uploadFiles(files, targetRoutePointId);
  }

  async function confirmDelete() {
    if (!onDelete || uploadState.status === "uploading" || deleteState === "pending") {
      return;
    }
    if (notesPreventAction("正在保存感想，完成后才能删除旅程。")) return;
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
    if (!asset || mutationPending || !removeMedia) return;
    invalidateMoveUndo();
    setMediaDeleteState("pending");
    setMediaDeleteMessage("");
    try {
      await removeMedia(asset.id);
    } catch (error) {
      setMediaDeleteState("confirming");
      setMediaDeleteMessage(error instanceof Error ? error.message : "媒体删除失败，请稍后重试。");
      return;
    }
    if (onMediaDelete) {
      // The parent owns the state change in previews. Focus restoration is
      // derived from the committed non-idle -> idle transition below.
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

  function selectMediaScope(routePointId: string | null) {
    if (mutationPending) return;
    cancelPendingMediaDragSettle();
    setPlayingFromGesture(false);
    invalidatePlacementAnalysis();
    setSelectedRoutePointId(routePointId);
    setAssetIndex(0);
    setShownAssetId(null);
    setIncomingAssetId(null);
    setPendingMediaTarget(null);
    setLocalMediaOrder(null);
    setOverview(false);
    setMoveSelectMode(false);
    setMoveSelection(new Set());
    setMoveMessage("");
    setRetryFiles([]);
    setUploadState({ status: "idle" });
  }

  // Buttons, keyboard and automatic advance share the same readiness gate.
  function navigateMediaStep(direction: -1 | 1, wrap = false) {
    const anchorIndex = storyAssetIndexForId(scopedMedia, requestedMediaRef.current, assetIndex, scopedMediaIndex.indexById);
    const index = storyMediaNeighborIndex(anchorIndex, scopedMedia.length, direction, wrap);
    if (index !== null) navigateToMedia(index, direction);
  }

  function mediaButtonInput(key: "previous" | "next" | "play" | "fullscreen", activate: () => void) {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "touch" || !event.isPrimary) {
          mediaButtonTouchRef.current = null;
          mediaButtonTouchClickRef.current = null;
          return;
        }
        mediaButtonTouchRef.current = {
          pointerId: event.pointerId, key, x: event.clientX, y: event.clientY, moved: false,
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const touch = mediaButtonTouchRef.current;
        if (!touch || touch.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 12) touch.moved = true;
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (mediaButtonTouchRef.current?.pointerId === event.pointerId) mediaButtonTouchRef.current = null;
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const touch = mediaButtonTouchRef.current;
        if (!touch || touch.pointerId !== event.pointerId || touch.key !== key) return;
        mediaButtonTouchRef.current = null;
        const bounds = event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        // A fast swipe followed by a touch button press can deliver pointerup
        // without a browser click. Complete that one touch here, and consume
        // its optional compatibility click below.
        mediaButtonTouchClickRef.current = { at: performance.now(), key };
        if (!touch.moved && inside && !event.currentTarget.disabled) activate();
      },
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        const touchClick = mediaButtonTouchClickRef.current;
        if (event.detail > 0 && touchClick !== null && touchClick.key === key
          && performance.now() - touchClick.at < 1_000) {
          mediaButtonTouchClickRef.current = null;
          event.preventDefault();
          return;
        }
        activate();
      },
    };
  }

  function videoStepButtonInput(direction: -1 | 1) {
    return mediaButtonInput(direction === -1 ? "previous" : "next",
      () => navigateMediaStep(direction, selectedRoutePointId !== null));
  }

  function navigateToMedia(index: number, direction?: -1 | 1) {
    if (index < 0 || index >= scopedMedia.length) return;
    cancelPendingMediaDragSettle();
    const target = scopedMedia[index];
    if (!target) return;
    mediaNavigationDirection.current = direction
      ?? (index < storyAssetIndexForId(scopedMedia, shownAssetId, assetIndex, scopedMediaIndex.indexById) ? -1 : 1);
    requestedMediaRef.current = target.id;
    // Reversing an in-flight transition back to the visible base needs no new
    // incoming layer (it would equal shownAssetId and never emit animationend).
    if (target.id === shownAssetId) {
      setPendingMediaTarget(null);
      setIncomingAssetId(null);
      setAssetIndex(index);
      return;
    }
    // A reverse input can cancel a cold next-frame request while staying here.
    if (index === assetIndex) {
      setPendingMediaTarget(null);
      return;
    }
    const targetRead = mediaReads[target.id];
    const disposition = storyNavigationTargetDisposition(
      target,
      storyMediaAvailability(targetRead?.status),
      decodeRegistryRef.current.isDecoded(target.id),
    );
    if (disposition === "failed") {
      setPendingMediaTarget(null);
      setIncomingAssetId(null);
      setShownAssetId(target.id);
      setAssetIndex(index);
    } else if (disposition === "ready") {
      setPendingMediaTarget(null);
      setIncomingAssetId(target.id);
      setAssetIndex(index);
    } else {
      // Review P1: even when the read is already ready, a pending target
      // must start its decode; otherwise it can sit forever with a decoded
      // image that never triggers a re-check.
      setPendingMediaTarget(target.id);
      setIncomingAssetId(null);
      setAssetIndex(storyAssetIndexForId(scopedMedia, shownAssetId, assetIndex, scopedMediaIndex.indexById));
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
          setPendingMediaTarget(null);
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
        ".journey-story__media [data-shared-media-id]",
      ) ?? null,
    });
  }

  function toggleMediaOverview() {
    if (overview) {
      const tile = dialogRef.current?.querySelector<HTMLButtonElement>(
        `:is(.journey-story__media-grid, .story-media-organizer__grid) [data-media-tile-index="${assetIndex}"]`,
      );
      if (tile) {
        selectMediaIndex(assetIndex, tile);
      } else {
        setOverview(false);
      }
      return;
    }

    const current = scopedMedia[assetIndex];
    // #204 CFAA: hidden priming/authorization media carries no shared-media id,
    // so the morph anchors on the visible settled frame instead of a zero-sized
    // node that would silently drop the shared-element transition.
    const source = dialogRef.current?.querySelector<HTMLElement>(
      ".journey-story__media [data-shared-media-id]",
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
          `:is(.journey-story__media-grid, .story-media-organizer__grid) [data-media-tile-index="${assetIndex}"]`,
        );
        return tile?.querySelector<HTMLElement>("img") ?? tile ?? null;
      },
    });
  }

  async function handleMediaReorderEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !manageMedia) return;
    const activeAsset = typeof active.id === "string" ? scopedMediaIndex.byId.get(active.id) : undefined;
    const overAsset = typeof over.id === "string" ? scopedMediaIndex.byId.get(over.id) : undefined;
    if (!activeAsset || !overAsset) return;
    if (activeAsset.routePointId !== overAsset.routePointId) {
      setOrderMessage("整段旅程按章节排列；请选择同一章节内的媒体调整顺序。");
      return;
    }

    const reorderScopeId = activeAsset.routePointId;
    const chapterMedia = scopedMedia.filter((candidate) => candidate.routePointId === reorderScopeId);
    const oldIndex = chapterMedia.findIndex((candidate) => candidate.id === active.id);
    const newIndex = chapterMedia.findIndex((candidate) => candidate.id === over.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    // Preserve a valid server-backed Undo when drag validation rejects the gesture.
    // Only a reorder that is actually going to mutate state invalidates it.
    if (!reorderInvalidatesMediaMoveUndo(scopedMedia, activeAsset.id, overAsset.id)) return;
    invalidateMoveUndo();

    // In aggregate Journey mode the grid spans multiple chapters. Reorder only
    // the active chapter, then splice it back into the canonical Story sequence
    // so a drag can never move media across route-point ownership.
    const nextChapter = arrayMove(chapterMedia, oldIndex, newIndex);
    let chapterIndex = 0;
    const nextScoped = scopedMedia.map((candidate) => (
      candidate.routePointId === reorderScopeId ? nextChapter[chapterIndex++] : candidate
    ));
    const nextVisual = applyScopeReorder(
      visualMedia,
      reorderScopeId,
      nextChapter.map((candidate) => candidate.id),
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
        await manageMedia.reorderJourneyMedia(journey.id, nextVisual.map((candidate) => candidate.id));
        const refreshedJourney = await onMediaAdded(journey.id);
        if (refreshedJourney) {
          const refreshedScoped = scopedVisualMedia(refreshedJourney);
          setAssetIndex((current) => Math.min(current, Math.max(0, refreshedScoped.length - 1)));
          setShownAssetId(null);
          setIncomingAssetId(null);
          setPendingMediaTarget(null);
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

  // #20: batch move. Toggling selection mode always resets the selection —
  // entering starts clean, and explicitly leaving should not
  // leave stale ids selected against a grid that may have just changed.
  function toggleMoveSelectMode() {
    if (mutationPending) return;
    setMoveSelectMode((value) => !value);
    setMoveSelection(new Set());
    setMoveMessage("");
    setMoveUndo(null);
  }

  function toggleMoveSelection(assetId: string) {
    setMoveSelection((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  // #20: one request moves the whole selection, landing it at the end of the
  // target route point's media (see server/routes/uploads.ts). Refreshing
  // from the server afterward lets the scope-shrink effects above settle
  // the stage if the moved media included the one currently shown.
  async function moveSelectedMediaTo(targetRoutePointId: string | null, selectedIds: readonly string[] = [...moveSelection]): Promise<boolean> {
    if (selectedIds.length === 0 || mutationPending || !manageMedia) return false;
    const assetIds = [...selectedIds];
    const undo = mediaMoveUndoForSelection(journey, assetIds, targetRoutePointId);
    if (!undo) {
      setMoveMessage("所选媒体已经变化，请重新选择。");
      return false;
    }
    const destination = targetRoutePointId === null
      ? "旅程散页"
      : journey.routePoints.find((point) => point.id === targetRoutePointId)?.label
        || "所选途径点";
    setMovePending(true);
    setMoveMessage("");
    setMoveUndo(null);
    try {
      await manageMedia.moveJourneyMedia(journey.id, assetIds, targetRoutePointId);
    } catch (error) {
      setMoveMessage(error instanceof Error ? error.message : "移动失败，请稍后重试。");
      setMovePending(false);
      return false;
    }

    setMoveUndo(undo);
    setMoveMessage(`已移动 ${assetIds.length} 个媒体到 ${destination}`);
    // Preserve any new selection made while this batch was in flight.
    setMoveSelection((current) => new Set([...current].filter((id) => !assetIds.includes(id))));
    try {
      await onMediaAdded(journey.id);
    } catch {
      setMoveMessage(`已移动 ${assetIds.length} 个媒体到 ${destination}；列表刷新失败，仍可撤销`);
    } finally {
      setMovePending(false);
    }
    return true;
  }

  async function undoLastMediaMove() {
    if (!moveUndo || mutationPending || !manageMedia) return;
    const undo = moveUndo;
    setMovePending(true);
    try {
      await manageMedia.undoJourneyMediaMove(undo);
    } catch (error) {
      const stale = mediaMoveUndoNeedsServerReconcile(error);
      if (stale) {
        // A retained retry can receive 409 after the first request actually committed
        // but its response was lost. Always reconcile from the server before retiring
        // the descriptor so the UI cannot remain on the pre-Undo state.
        setMoveUndo(null);
        try {
          const refreshedJourney = await onMediaAdded(journey.id);
          setMoveMessage(
            refreshedJourney
              ? "媒体状态已从服务器更新；该撤销操作已结束。"
              : "撤销状态已变化，但当前列表刷新失败。重新打开旅程即可看到服务器状态。",
          );
        } catch {
          setMoveMessage("撤销状态已变化，但当前列表刷新失败。重新打开旅程即可看到服务器状态。");
        }
        setMovePending(false);
        return;
      }
      setMoveMessage(error instanceof Error ? error.message : "撤销失败，请稍后重试。");
      if (!retainMediaMoveUndoAfterError(error)) setMoveUndo(null);
      setMovePending(false);
      return;
    }

    setMoveUndo(null);
    setMoveMessage("已撤销媒体移动");
    try {
      const refreshedJourney = await onMediaAdded(journey.id);
      if (!refreshedJourney) {
        setMoveMessage("媒体移动已撤销，但当前列表刷新失败。重新打开旅程即可看到服务器状态。");
      }
    } catch {
      setMoveMessage("媒体移动已撤销，但当前列表刷新失败。重新打开旅程即可看到服务器状态。");
    } finally {
      setMovePending(false);
    }
  }

  // #14: set this journey's cover media. The parent owns journey state; after
  // the API call we ask it to refresh, so the card updates immediately and a
  // failure rolls back to server truth.
  async function handleSetCover(assetId: string) {
    if (!journey || coverPending || mutationPending || !manageMedia) return;
    setCoverPending(true);
    setOrderMessage("");
    try {
      await manageMedia.setJourneyCover(journey.id, assetId);
      await onMediaAdded(journey.id);
    } catch (error) {
      setOrderMessage(error instanceof Error ? error.message : "封面设置失败，请稍后重试。");
    } finally {
      setCoverPending(false);
    }
  }

  function setPlayingFromGesture(
    willPlay: boolean,
    targetStage: "current" | "fullscreen" = "current",
    transferringVideo = false,
  ) {
    // A future video can only be authorized when its actual candidate source is
    // already attached. Starting earlier would consume the gesture on src-less
    // media, leaving the later passive play() outside the activation window.
    if (
      willPlay
      && !storyAutoplayCanStart(
        autoplayVideoCandidate,
        storyMediaAvailability(autoplayVideoCandidateRead?.status),
      )
    ) return;
    const audio = audioRef.current;
    const gestureVideo = targetStage === "fullscreen"
      ? fullscreenVideoRef.current
      : fullscreen ? fullscreenVideoRef.current : storyVideoRef.current;
    if (willPlay && gestureVideo && autoplayVideoCandidate && !transferringVideo) {
      const currentVideoIsSettled = activeAsset?.mimeType.startsWith("video/")
        && (shownAssetId ?? activeAsset.id) === activeAsset.id
        && (targetStage === "fullscreen" ? stagePlaybackReady.fullscreen : activeStagePlaybackReadyId) === activeAsset.id;
      if (currentVideoIsSettled) {
        // Keep the first video.play() inside the initiating click/tap/keyboard
        // activation. The effect remains authoritative for synchronization.
        void gestureVideo.play().catch(() => undefined);
      } else {
        // The stable stage video is mounted for the first future video before
        // autoplay starts; its signed read is prefetched independently. Touch
        // the same element inside this gesture, then pause before media can
        // advance audibly behind the current image. Safari-style per-element
        // authorization is retained because later video steps reuse this node.
        void gestureVideo.play().catch(() => undefined);
        gestureVideo.pause();
        try { gestureVideo.currentTime = 0; } catch { /* metadata may not be ready yet */ }
      }
    }
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
    if (!manageMedia || !removeMedia) return;
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

    invalidateMoveUndo();
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
      upload: manageMedia.uploadJourneyMedia,
      refresh: onMediaAdded,
      remove: removeMedia,
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
    if (!soundtrack || mutationPending || !removeMedia) return;
    invalidateMoveUndo();
    setSoundtrackRemovePending(true);
    setSoundtrackNotice("");
    setPlaying(false);
    audioSamplerRef.current.setPlaying(false);
    resetAudioAtmosphereEnergy();
    try {
      await removeMedia(soundtrack.id);
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

  const mobileStoryPlayControlVisible = showMobileStoryPlayControl({
    mobileLayout,
    overview,
    mobileManageMode,
    scopedMediaCount: scopedMedia.length,
  });
  const mobileStoryImmersiveKeepsPlaying = storyImmersiveEntryKeepsPlaying(
    playing,
    autoplayVideoCandidate,
    storyMediaAvailability(autoplayVideoCandidateRead?.status),
  );

  function openJourneyComposer() {
    if (notesPreventAction("正在保存感想，完成后才能编辑旅程。")) return;
    onEdit?.(journey.id);
  }

  function openJourneyShare() {
    if (notesPreventAction("正在保存感想，完成后才能分享旅程。")) return;
    onShare?.(journey.id);
  }

  function toggleDesktopEditing() {
    if (mutationPending || placementAnalyzing) return;
    if (desktopEditing && notesDirty) {
      notifyNotesGuard("还有未保存的感想，请先保存或放弃更改。");
      return;
    }
    cancelPendingMediaDragSettle(true);
    setPlaying(false);
    setOverview(!desktopEditing && scopedMedia.length > 0);
    setDesktopEditing((value) => !value);
    if (desktopEditing) setMobileManageMode(false);
    setMoveSelectMode(false);
    setMoveSelection(new Set());
    setPlacementReview(null);
    setMediaDeleteState("idle");
    setMediaDeleteMessage("");
    setDeleteState("idle");
    setDeleteMessage("");
  }

  const hasStoryMedia = scopedMedia.length > 0;
  const canEditStory = Boolean(manageMedia || updateJourneyNotes || canEditJourney || canShareJourney || onDelete);
  const showSoundtrack = Boolean(soundtrack || (manageMedia && mediaEditing));

  const content = (
    <div
      className={`journey-story-backdrop${mobileLayout ? " is-mobile-context" : ""}${mobileLayout && mobileStoryExpanded ? " is-story-expanded" : ""}`}
      role="presentation"
      onClick={closeFromBackdrop}
    >
      <article
        ref={dialogRef}
        tabIndex={-1}
        className={`journey-story motion-staged${mobileLayout && mobileManageMode ? " is-mobile-manage" : ""}`}
        data-story-layout={mobileLayout ? "mobile" : "desktop"}
        data-story-editing={mediaEditing ? "true" : undefined}
        data-has-media={hasStoryMedia ? "true" : "false"}
        data-mobile-mode={mobileLayout ? (mobileManageMode ? "manage" : "viewer") : undefined}
        data-mobile-presentation={mobileLayout ? (mobileStoryExpanded ? "expanded" : "in-context") : undefined}
        role="dialog"
        aria-modal={storyModal ? "true" : undefined}
        aria-labelledby="journey-story-title"
        onWheel={scrollCopyFromMedia}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.propertyName === "height" || event.propertyName === "max-height") {
            setMobileStoryCoverTransitionActive(false);
          }
        }}
      >
        {mobileLayout ? (
          <button
            type="button"
            className="journey-story__sheet-handle"
            aria-label={mobileStoryExpanded ? "收起旅程故事" : "展开旅程故事"}
            aria-expanded={mobileStoryExpanded}
            onClick={toggleMobileStoryPresentation}
            onPointerDown={handleStorySheetPointerDown}
            onPointerUp={handleStorySheetPointerUp}
            onPointerCancel={handleStorySheetPointerCancel}
          >
            <span aria-hidden="true" />
            {mobileStoryExpanded
              ? <IconChevronDown size={17} stroke={1.5} aria-hidden="true" />
              : <IconChevronUp size={17} stroke={1.5} aria-hidden="true" />}
          </button>
        ) : null}
        <header>
          {mobileLayout ? <div>
            <p>PRIVATE JOURNEY · {journeyRange(journey)}</p>
            <h2 id="journey-story-title">{journey.title}</h2>
          </div> : canEditStory ? <button
            className="journey-story__edit-toggle"
            type="button"
            aria-label={desktopEditing ? "完成编辑故事" : "编辑故事"}
            aria-pressed={desktopEditing}
            disabled={mutationPending || placementAnalyzing}
            onClick={toggleDesktopEditing}
          >{desktopEditing ? "完成" : "编辑"}</button> : null}
          {/* An upload in flight keeps this button clickable so pressing it
              explains the wait instead of silently doing nothing. */}
          <button
            className={`journey-story__close${deleteState === "pending" || uploading || notesSaveState === "saving" ? " is-status" : ""}`}
            type="button"
            disabled={mutationPending && !uploading}
            onClick={requestClose}
            aria-label="退出旅程故事"
          >
            {deleteState === "pending" || uploading || notesSaveState === "saving" ? (
              <span>{deleteState === "pending" ? "删除中" : notesSaveState === "saving" ? "保存中" : "上传中"}</span>
            ) : null}
            <IconX size={19} stroke={1.35} aria-hidden="true" />
          </button>
        </header>

        {closeBlocked && (uploading || notesSaveState === "saving") ? (
          <p className="journey-story__close-blocked" role="status">
            {notesSaveState === "saving" ? "正在保存感想，完成后即可安全退出。" : "正在完成分块上传，完成后即可安全退出。"}
          </p>
        ) : null}

        <div className="journey-story__layout">
          {hasStoryMedia ? <section
            className={`journey-story__media${overview && manageMedia ? " is-organizing" : ""}`}
            aria-label="旅程媒体"
            data-mobile-layout={mobileLayout ? "true" : undefined}
            data-media-requested={/* #489: the media the viewer last asked for,
              cold targets included. Without it a stage that has silently
              dropped a navigation looks identical to one nobody navigated. */
              pendingMediaId ?? incomingAssetId ?? undefined}
          >
            {scopedMedia.length > 0 && !mobileLayout && desktopEditing ? (
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
            {overview && mobileLayout ? (
              <button
                type="button"
                className="journey-story__mobile-sort-done"
                onClick={() => { setOverview(false); setMoveSelectMode(false); setMoveSelection(new Set()); }}
              >
                完成
              </button>
            ) : null}
            {manageMedia && overview && orderedScopedMedia.length > 0 ? (
              <button
                type="button"
                className={`journey-story__media-select-toggle${moveSelectMode ? " is-active" : ""}`}
                ref={mobileLayout ? mobileMoveSelectToggleRef : undefined}
                aria-pressed={moveSelectMode}
                disabled={mutationPending}
                onClick={toggleMoveSelectMode}
              >
                {moveSelectMode ? "取消选择" : "选择"}
              </button>
            ) : null}
            {overview && manageMedia ? (
              <StoryMediaOrganizer
                media={orderedScopedMedia}
                allMedia={visualMedia}
                routePoints={journey.routePoints}
                reads={mediaReads}
                currentId={shownAsset?.id ?? null}
                coverId={cover?.id ?? null}
                selectedIds={moveSelection}
                selecting={moveSelectMode}
                disabled={mutationPending}
                onToggleSelect={toggleMoveSelection}
                onSelect={selectMediaIndex}
                onRequestRead={loadMediaRead}
                onSetCover={handleSetCover}
                onReorder={(event) => void handleMediaReorderEnd(event)}
                onMove={(ids, target) => moveSelectedMediaTo(target, ids)}
              />
            ) : overview ? (
              <ul className="journey-story__media-grid" aria-label={`全部媒体，共 ${orderedScopedMedia.length} 个`}>
                {orderedScopedMedia.map((tile, index) => (
                  <li key={tile.id}>
                    <StoryMediaTile
                      asset={tile} index={index} isCurrent={index === assetIndex}
                      isCover={cover?.id === tile.id} read={mediaReads[tile.id]}
                      disabled={mutationPending} onRequestRead={loadMediaRead}
                      onSelect={selectMediaIndex}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {overview && moveMessage ? (
              <p className="journey-story__order-message" role="status">
                <StartripsJourneyCue
                  state={movePending ? "travel" : moveUndo ? "arrived" : "rest"}
                  size={28}
                  className="starlight-media-state__inline-cue"
                />
                <span>{moveMessage}</span>
                {moveUndo ? (
                  <button
                    className="journey-story__move-undo"
                    type="button"
                    disabled={movePending}
                    onClick={() => void undoLastMediaMove()}
                  >
                    撤销
                  </button>
                ) : null}
              </p>
            ) : null}
            {!overview && !fullscreen ? mediaStageStatus : null}
            {!overview ? <StoryMediaPages
              ref={inlineStageRef}
              scopeKey={`${journeyId}:${selectedRoutePointId ?? ""}`}
              active={!fullscreen}
              gestureEnabled={!mutationPending && !videoHandoffRef.current}
              mobileLayout={mobileLayout}
              media={scopedMedia}
              currentId={shownAsset?.id ?? null}
              coverId={cover?.id ?? null}
              incomingId={incoming?.id ?? null}
              direction={mediaNavigationDirection.current}
              reads={mediaReads}
              wrap={selectedRoutePointId !== null}
              videoAssetId={storyStageVideoAsset?.id ?? null}
              onSettled={settleIncoming}
              onMediaError={reportStageMediaError}
              onPlaybackReady={inlinePlaybackReady}
              onGestureClaim={claimStoryMediaGesture}
              onGestureHoldingChange={setMediaGestureHolding}
              onGestureConsumed={(consumed) => { storyMediaGestureConsumedRef.current = consumed; }}
              onGestureCommit={commitStoryMediaGesture}
              onGesturePrepare={prepareStoryMediaGestureTarget}
              onGestureTapAfterSettle={openFullscreenAfterStoryGesture}
              onImageClick={mobileLayout ? openImageFullscreenAfterTap : undefined}
              onNavigate={!mobileLayout ? navigateFromPicture : undefined}
              canNavigatePrevious={canStepPrevious}
              canNavigateNext={canStepNext}
              onBackdropClick={!mobileLayout ? () => {
                if (!storyMediaGestureConsumedRef.current && !videoHandoffRef.current) requestClose();
              } : undefined}
              video={renderStageVideo(false)}
            /> : null}
            {!mobileLayout && !overview && asset ? (
              <div className="journey-story__media-controls">
                <nav className="journey-story__media-nav" aria-label="媒体导航">
                <IconActionButton
                  type="button"
                  className="journey-story__fullscreen-entry"
                  label="全屏查看媒体"
                  disabled={mutationPending || Boolean(shownAsset?.mimeType.startsWith("video/")
                    && stagePlaybackReady.inline !== shownAsset.id)}
                  onClick={() => enterFullscreen(mobileStoryImmersiveKeepsPlaying)}
                ><IconMaximize size={19} stroke={1.35} aria-hidden="true" /></IconActionButton>
                {videoNavigationVisible ? <button type="button" data-video-step="previous"
                  disabled={!canStepPrevious} {...videoStepButtonInput(-1)}
                  aria-label="上一个媒体"><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" /></button> : null}
                <button
                  type="button"
                  className={playing ? "is-active" : ""}
                  disabled={
                    mutationPending
                    || (scopedMedia.length < 2 && !asset.mimeType.startsWith("video/"))
                    || (!playing && !storyAutoplayCanStart(
                      autoplayVideoCandidate,
                      storyMediaAvailability(autoplayVideoCandidateRead?.status),
                    ))
                  }
                  onClick={togglePlaying}
                  aria-label={playing ? "暂停自动播放" : "自动播放媒体"}
                  aria-pressed={playing}
                >
                  {playing
                    ? <IconPlayerPause size={17} stroke={1.35} aria-hidden="true" />
                    : <IconPlayerPlay size={17} stroke={1.35} aria-hidden="true" />}
                </button>
                {videoNavigationVisible ? <button type="button" data-video-step="next"
                  disabled={!canStepNext} {...videoStepButtonInput(1)}
                  aria-label="下一个媒体"><IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button> : null}
                </nav>
              </div>
            ) : null}
            {orderMessage ? <p className="journey-story__order-message" role="status">{orderMessage}</p> : null}
            {mobileLayout && !overview && asset ? (
              <div className="journey-story__mobile-media-actions">
                {videoNavigationVisible && !mobileManageMode && mediaDeleteState === "idle" ? <nav className="journey-story__mobile-video-nav" aria-label="视频媒体导航">
                  <button type="button" data-video-step="previous" disabled={!canStepPrevious}
                    {...videoStepButtonInput(-1)} aria-label="上一个媒体">
                    <IconArrowLeft size={19} stroke={1.5} aria-hidden="true" />
                  </button>
                  <button type="button" data-video-step="next" disabled={!canStepNext}
                    {...videoStepButtonInput(1)} aria-label="下一个媒体">
                    <IconArrowRight size={19} stroke={1.5} aria-hidden="true" />
                  </button>
                </nav> : null}
                {showMobileStoryFullscreenControl({
                  mobileLayout,
                  overview,
                  mobileManageMode,
                  hasAsset: Boolean(asset),
                }) ? (
                  /* `is-compact` closes the row when a single-asset scope
                     renders no play control. The entry is playback-transparent:
                     it hands the current sequence state to the fullscreen stage
                     instead of starting it, and spends the same gesture
                     authorizing the fullscreen video element. */
                  <IconActionButton
                    type="button"
                    className={`journey-story__mobile-media-fullscreen${mobileStoryPlayControlVisible ? "" : " is-compact"}`}
                    label="沉浸查看媒体"
                    disabled={mutationPending || Boolean(shownAsset?.mimeType.startsWith("video/")
                      && stagePlaybackReady.inline !== shownAsset.id)}
                    {...mediaButtonInput("fullscreen", () => enterFullscreen(mobileStoryImmersiveKeepsPlaying))}
                  >
                    <IconMaximize size={19} stroke={1.5} aria-hidden="true" />
                  </IconActionButton>
                ) : null}
                {mobileStoryPlayControlVisible ? (
                  <IconActionButton
                    type="button"
                    className={`journey-story__mobile-media-play${playing ? " is-active" : ""}`}
                    label={playing ? "暂停自动播放" : "自动播放媒体"}
                    aria-pressed={playing}
                    disabled={
                      mutationPending
                      || (!playing && !storyAutoplayCanStart(
                      autoplayVideoCandidate,
                      storyMediaAvailability(autoplayVideoCandidateRead?.status),
                    ))
                    }
                    {...mediaButtonInput("play", togglePlaying)}
                  >
                    {playing
                      ? <IconPlayerPause size={19} stroke={1.5} aria-hidden="true" />
                      : <IconPlayerPlay size={19} stroke={1.5} aria-hidden="true" />}
                  </IconActionButton>
                ) : null}
                {manageMedia ? <IconActionButton
                  type="button"
                  className="journey-story__mobile-media-menu-trigger"
                  buttonRef={mobileManageViewerTriggerRef}
                  label={mobileManageMode ? "管理当前媒体" : "管理旅程"}
                  tooltip={mobileManageMode ? "管理媒体" : "管理旅程"}
                  aria-expanded={mobileManageMode ? mobileMediaMenuOpen : undefined}
                  aria-hidden={mediaDeleteState !== "idle"}
                  tabIndex={mediaDeleteState === "idle" ? 0 : -1}
                  style={mediaDeleteState === "idle" ? undefined : { visibility: "hidden", pointerEvents: "none" }}
                  disabled={mutationPending}
                  onClick={() => {
                    if (!mobileManageMode) {
                      enterMobileManageMode();
                      return;
                    }
                    setMobileMediaMenuOpen((open) => !open);
                  }}
                >
                  <IconDots size={19} stroke={1.5} aria-hidden="true" />
                </IconActionButton> : null}
                {mobileManageMode && mobileMediaMenuOpen && mediaDeleteState === "idle" ? (
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
                      {scopedMedia.length > 0 ? (
                        <>
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
                          <button
                            type="button"
                            disabled={mutationPending}
                            onClick={enterMobileMoveSelectMode}
                          >
                            <IconArrowRight size={18} stroke={1.35} aria-hidden="true" />
                            移动媒体 / 重新归类
                          </button>
                        </>
                      ) : null}
                      {/* #199: immersive playback and immersive viewing both
                          left this sheet for the Viewer action cluster. Manage
                          keeps cover, ordering, reclassification and deletion. */}
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
            {manageMedia && desktopEditing && !mobileLayout && !overview && asset ? (
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
          </section> : null}

          <section ref={copyRef} className="journey-story__copy">
            {!mobileLayout ? <div className="journey-story__heading">
              <p>{journeyRange(journey)}</p>
              <h2 id="journey-story-title">{journey.title}</h2>
            </div> : null}
            {mobileLayout && !overview && !asset && !mobileManageMode ? (
              <div className="journey-story__mobile-media-actions">
                {manageMedia ? <IconActionButton
                  type="button"
                  className="journey-story__mobile-media-menu-trigger"
                  buttonRef={mobileManageViewerTriggerRef}
                  label="管理旅程"
                  tooltip="管理旅程"
                  disabled={mutationPending}
                  onClick={enterMobileManageMode}
                >
                  <IconDots size={19} stroke={1.5} aria-hidden="true" />
                </IconActionButton> : null}
              </div>
            ) : null}
            <nav className="journey-story__route-points" aria-label="选择旅程途径点">
              <button
                type="button"
                disabled={mutationPending}
                className={selectedRoutePointId === null ? "is-active" : ""}
                aria-pressed={selectedRoutePointId === null}
                onClick={() => selectMediaScope(null)}
              >
                {mobileLayout ? <span>00</span> : null}
                <strong>{mobileLayout ? "整段旅程" : "全部"}</strong>
                {mobileLayout ? <small>{visualMedia.length}</small> : null}
              </button>
              {journey.routePoints.map((point, index) => (
                <button
                  key={point.id}
                  type="button"
                  disabled={mutationPending}
                  className={[
                    selectedRoutePointId === point.id ? "is-active" : "",
                    selectedRoutePointId === null && activeChapterRoutePointId === point.id ? "is-chapter-active" : "",
                  ].filter(Boolean).join(" ")}
                  aria-pressed={selectedRoutePointId === point.id}
                  aria-current={selectedRoutePointId === null && activeChapterRoutePointId === point.id ? "step" : undefined}
                  data-route-point-id={point.id}
                  onClick={() => selectMediaScope(point.id)}
                >
                  {mobileLayout ? <span>{String(index + 1).padStart(2, "0")}</span> : null}
                  <strong>{point.label || `途径点 ${index + 1}`}</strong>
                  {mobileLayout ? <small>{visualMediaCount(point.id)}</small> : null}
                </button>
              ))}
            </nav>
            {mobileLayout && !overview ? <StoryMediaRail
              media={scopedMedia}
              currentId={shownAsset?.id ?? null}
              requestedId={pendingMediaId ?? incomingAssetId}
              reads={mediaReads}
              disabled={mutationPending}
              onSelect={navigateToMedia}
              onOrganize={manageMedia ? () => {
                if (mobileLayout) enterMobileManageMode();
                setPlaying(false);
                setOverview(true);
              } : undefined}
            /> : null}
            {mobileLayout ? <dl>
              <div><dt>ROUTE POINTS</dt><dd>{journey.routePoints.length}</dd></div>
              <div><dt>STOPS</dt><dd>{namedStops.length}</dd></div>
            </dl> : null}
            {mobileLayout && namedStops.length > 0 ? <p className="journey-story__stops">{namedStops.map((stop) => stop.label).join(" · ")}</p> : null}
            {/* #10: a selected route point shows its own note near the place
                name — distinct from system metadata. Journey-scoped view never
                fabricates a note. */}
            {mediaEditing && capabilities.canEditJourney && mutations?.enqueueCoverReveal && cover ? (
              <CoverRevealRequest
                key={`${journey.id}:${cover.id}:${cover.contentHash ?? ""}`}
                journeyId={journey.id}
                cover={cover}
                enqueue={mutations.enqueueCoverReveal}
                disabled={mutationPending || deleteState !== "idle"}
              />
            ) : null}
            {notesEditing && updateJourneyNotes ? (
              <StoryNotesEditor
                journeyNote={journeyNoteDraft ?? journey.note ?? ""}
                selectedRoutePoint={notesRoutePoint}
                selectedRoutePointNote={notesRoutePointNote}
                removedRoutePointDrafts={removedRoutePointDrafts}
                saving={mutationPending}
                saveState={notesSaveState}
                message={notesMessage}
                dirty={notesDirty}
                onJourneyNoteChange={setStoryJourneyNote}
                onRoutePointNoteChange={setStoryRoutePointNote}
                onSave={() => void saveStoryNotes()}
                onDiscard={discardStoryNotes}
                onDiscardRoutePointDraft={discardRemovedRoutePointDraft}
              />
            ) : (
              <>
                {(!desktopEditing || mobileLayout) && activeChapterRoutePoint && activeChapterRoutePoint.note ? (
                  <blockquote className="journey-story__point-note">{activeChapterRoutePoint.note}</blockquote>
                ) : null}
                {journey.note && (!desktopEditing || mobileLayout) && (mobileLayout || (!selectedRoutePoint && !activeChapterRoutePoint?.note)) ? <p className="journey-story__note">{journey.note}</p> : null}
              </>
            )}
            {mobileLayout && mobileManageMode ? (
              <div className="journey-story__mobile-manage-bar" role="status">
                <div><small>MANAGE JOURNEY</small><strong>管理旅程</strong></div>
                <button ref={mobileManageDoneRef} type="button" disabled={mutationPending} onClick={exitMobileManageMode}>完成</button>
              </div>
            ) : null}
            {onDelete && deleteState !== "idle" ? (
              <section className="journey-story__delete-confirmation" aria-label="确认删除旅程">
                <div>
                  <p>REMOVE FROM ATLAS</p>
                  <strong>7 天内可以恢复</strong>
                  <span>{journeyDeleteDescription(journey)}</span>
                </div>
                <div>
                  <button ref={deleteCancelRef} type="button" disabled={deleteState === "pending"} onClick={closeJourneyDelete}>取消</button>
                  <button type="button" disabled={mutationPending} onClick={() => void confirmDelete()}>{deleteState === "pending" ? "正在删除…" : "确认删除"}</button>
                </div>
                {deleteMessage ? <p className="journey-story__delete-error" role="alert">{deleteMessage}</p> : null}
              </section>
            ) : null}
            {manageMedia && mediaEditing ? <div className="journey-story__media-add">
              {mobileLayout ? <div>
                <p>PRIVATE MEDIA</p>
                <strong>{selectedRoutePoint
                  ? `${scopedMedia.length} 个媒体片段 · ${selectedRoutePoint.label || `途径点 ${selectedRoutePoint.sortOrder + 1}`}`
                  : `${playbackIntroMedia(journey).length} 个媒体片段 · 旅程级媒体 / 开场章节`}</strong>
              </div> : null}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm,video/quicktime"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                disabled={mutationPending || placementAnalyzing || placementReview !== null || deleteState !== "idle"}
                onChange={selectFiles}
              />
              <button
                type="button"
                disabled={mutationPending || placementAnalyzing || placementReview !== null || deleteState !== "idle"}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconUpload size={17} stroke={1.35} aria-hidden="true" />
                {uploadState.status === "uploading"
                  ? `正在上传 ${uploadPercent}%`
                  : placementAnalyzing
                    ? "正在读取拍摄信息…"
                    : "添加照片或视频"}
              </button>
              {placementReview ? (() => {
                const { groups, unsuggestedFileIndexes } = placementReview.batch;
                const groupedUploadPlan = completeMediaPlacementUploadPlan(
                  placementReview.batch,
                  placementReview.files.length,
                );
                const completeSingleGroup = groups.length === 1
                  && unsuggestedFileIndexes.length === 0
                  && groups[0].fileIndexes.length === placementReview.files.length;
                const singleSuggestion = completeSingleGroup ? groups[0] : null;
                const suggestedJourney = singleSuggestion
                  ? journeys.find((candidate) => candidate.id === singleSuggestion.journeyId) ?? null
                  : null;
                const suggestedPoint = singleSuggestion?.routePointId
                  ? suggestedJourney?.routePoints.find((point) => point.id === singleSuggestion.routePointId) ?? null
                  : null;
                const canApplySuggestion = Boolean(singleSuggestion && groupedUploadPlan);
                return (
                  <section className="journey-story__placement-review" aria-label={"\u5a92\u4f53\u4f4d\u7f6e\u5efa\u8bae"}>
                    <div className="journey-story__placement-review-head">
                      <p>PLACEMENT SUGGESTION</p>
                      <strong>{singleSuggestion && suggestedJourney
                        ? `\u770b\u8d77\u6765\u66f4\u50cf\u662f\uff1a${suggestedJourney.title} / ${suggestedPoint?.label || "\u6574\u6bb5\u65c5\u7a0b"}`
                        : `\u68c0\u6d4b\u5230 ${groups.length} \u7ec4\u53ef\u80fd\u7684\u4f4d\u7f6e`}</strong>
                      <span>{singleSuggestion
                        ? canApplySuggestion
                          ? "\u6839\u636e\u7167\u7247\u672c\u5730\u7684\u62cd\u6444\u4f4d\u7f6e/\u65f6\u95f4\u63a8\u6d4b\u3002\u786e\u8ba4\u540e\u624d\u4f1a\u4f7f\u7528\uff0c\u4e0d\u4f1a\u4fdd\u5b58\u539f\u59cb EXIF\u3002"
                          : "\u5efa\u8bae\u5c5e\u4e8e\u53e6\u4e00\u6bb5\u65c5\u7a0b\u3002\u5f53\u524d\u4e0d\u4f1a\u81ea\u52a8\u8de8\u65c5\u7a0b\u79fb\u52a8\uff1b\u4f60\u4ecd\u53ef\u4ee5\u9009\u62e9\u672c\u65c5\u7a0b\u7684\u4f4d\u7f6e\u3002"
                        : `${unsuggestedFileIndexes.length > 0 ? `${unsuggestedFileIndexes.length} \u4e2a\u6587\u4ef6\u4fe1\u606f\u4e0d\u8db3\uff1b` : ""}\u4e0d\u540c\u6587\u4ef6\u53ef\u80fd\u5c5e\u4e8e\u4e0d\u540c\u4f4d\u7f6e\uff0c\u4e0d\u4f1a\u5f3a\u884c\u5408\u5e76\u3002`}</span>
                    </div>
                    {!singleSuggestion ? (
                      <ul className="journey-story__placement-groups">
                        {groups.map((group) => {
                          const destinationJourney = journeys.find((candidate) => candidate.id === group.journeyId);
                          const destinationPoint = group.routePointId
                            ? destinationJourney?.routePoints.find((point) => point.id === group.routePointId)
                            : null;
                          return (
                            <li key={`${group.journeyId}:${group.routePointId ?? "journey"}`}>
                              <b>{group.fileIndexes.length} {"\u4e2a"}</b>
                              <span>{destinationJourney?.title ?? "\u5176\u4ed6\u65c5\u7a0b"} / {destinationPoint?.label || "\u6574\u6bb5\u65c5\u7a0b"}</span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    <div className="journey-story__placement-actions">
                      {canApplySuggestion && singleSuggestion ? (
                        <button type="button" onClick={confirmSuggestedPlacementGroups}>
                          {"\u4f7f\u7528\u5efa\u8bae"}
                        </button>
                      ) : null}
                      {!singleSuggestion && groupedUploadPlan ? (
                        <button type="button" onClick={confirmSuggestedPlacementGroups}>
                          {"\u6309\u5efa\u8bae\u5206\u522b\u653e\u7f6e"}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => confirmPlacementUpload(null)}>{"\u653e\u5230\u6574\u6bb5\u65c5\u7a0b"}</button>
                      {journey.routePoints.map((point) => (
                        <button key={point.id} type="button" onClick={() => confirmPlacementUpload(point.id)}>
                          {point.label || `\u9014\u5f84\u70b9 ${point.sortOrder + 1}`}
                        </button>
                      ))}
                      <button className="is-secondary" type="button" onClick={() => setPlacementReview(null)}>
                        {"\u53d6\u6d88"}
                      </button>
                    </div>
                  </section>
                );
              })() : null}
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
              {placementRetryGroups.length > 0 && uploadState.status !== "uploading" ? (
                <button className="journey-story__retry" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => void uploadPlacementGroups(placementRetryGroups)}>
                  {"\u91cd\u8bd5\u6309\u5efa\u8bae\u653e\u7f6e\u5931\u8d25\u7684"} {placementRetryGroups.reduce((sum, group) => sum + group.files.length, 0)} {"\u4e2a\u6587\u4ef6"}
                </button>
              ) : null}
              {retryFiles.length > 0 && uploadState.status !== "uploading" ? (
                <button className="journey-story__retry" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => void uploadFiles(retryFiles, retryRoutePointId)}>
                  重试失败的 {retryFiles.length} 个文件
                </button>
              ) : null}
            </div> : null}

            {showSoundtrack ? <div className={`journey-story__soundtrack${soundtrack && soundtrackRead?.status === "ready" ? " has-track" : ""}${playing ? " is-playing" : ""}`}>
              <div className="journey-story__soundtrack-head">
                {mobileLayout ? <p>JOURNEY SOUNDTRACK</p> : null}
                {soundtrack ? <strong>{stripMediaExtension(soundtrack.fileName)}</strong> : null}
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
              {manageMedia && mediaEditing ? <>
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
              </> : null}
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
            </div> : null}
          </section>
        </div>

        <footer>
          {(canEditJourney || canShareJourney || onDelete) && mediaEditing ? (
            <div className="journey-story__manage">
              {canEditJourney ? <button type="button" disabled={mutationPending || deleteState !== "idle"} onClick={openJourneyComposer}><IconEdit size={16} stroke={1.35} aria-hidden="true" />编辑旅程</button> : null}
              {canShareJourney ? <button type="button" data-share-journey-trigger="true" disabled={mutationPending || deleteState !== "idle"} onClick={openJourneyShare}><IconShare size={16} stroke={1.35} aria-hidden="true" />分享旅程</button> : null}
              {onDelete ? <button ref={journeyDeleteTriggerRef} className="is-destructive" type="button" disabled={mutationPending || deleteState !== "idle"} onClick={() => {
                if (notesPreventAction("正在保存感想，完成后才能删除旅程。")) return;
                setDeleteState("confirming");
                setDeleteMessage("");
              }}><IconTrash size={16} stroke={1.35} aria-hidden="true" />删除旅程</button> : null}
            </div>
          ) : null}
          <div className="journey-story__navigation">
            <button type="button" disabled={!previousJourney || mutationPending || deleteState !== "idle"} onClick={() => previousJourney && navigateStory(previousJourney.id)}><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" />上一段</button>
            <button type="button" disabled={!nextJourney || mutationPending || deleteState !== "idle"} onClick={() => nextJourney && navigateStory(nextJourney.id)}>下一段<IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
          </div>
        </footer>
      </article>

      {asset ? (
        <div
          ref={fullscreenRef}
          hidden={!fullscreen}
          style={!fullscreen ? { display: "none" } : undefined}
          className={`journey-story-fullscreen${fullscreenControlsHidden ? " is-controls-hidden" : ""}${playing ? " is-playing" : ""}`}
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          data-focus-trap-exempt="true"
          data-mobile-layout={mobileLayout ? "true" : undefined}
          aria-label="沉浸播放媒体"
          onClick={(event) => {
            if (storyMediaGestureConsumedRef.current) {
              storyMediaGestureConsumedRef.current = false;
              return;
            }
            if (!mobileLayout && event.target === event.currentTarget) exitFullscreen();
          }}
        >
          <button className="journey-story-fullscreen__close" type="button" onClick={() => exitFullscreen()} aria-label="退出沉浸媒体"><IconX size={22} stroke={1.35} aria-hidden="true" /></button>
          {fullscreen ? mediaStageStatus : null}
          <StoryMediaPages
            ref={fullscreenStageRef}
            scopeKey={`${journeyId}:${selectedRoutePointId ?? ""}`}
            active={fullscreen}
            gestureEnabled={!mutationPending && !videoHandoffRef.current}
            mobileLayout={mobileLayout}
            fullscreen
            media={scopedMedia}
            currentId={shownAsset?.id ?? null}
            coverId={cover?.id ?? null}
            incomingId={incoming?.id ?? null}
            direction={mediaNavigationDirection.current}
            reads={mediaReads}
            wrap={selectedRoutePointId !== null}
            videoAssetId={storyStageVideoAsset?.id ?? null}
            onSettled={settleIncoming}
            onMediaError={reportStageMediaError}
            onPlaybackReady={fullscreenPlaybackReady}
            onGestureClaim={claimStoryMediaGesture}
            onGestureHoldingChange={setMediaGestureHolding}
            onGestureConsumed={(consumed) => { storyMediaGestureConsumedRef.current = consumed; }}
            onGestureCommit={commitStoryMediaGesture}
            onGesturePrepare={prepareStoryMediaGestureTarget}
            onGestureExitFullscreen={exitFullscreen}
            onGestureRevealFullscreenControls={revealMobileFullscreenControls}
            onNavigate={!mobileLayout ? navigateFromPicture : undefined}
            canNavigatePrevious={canStepPrevious}
            canNavigateNext={canStepNext}
            onBackdropClick={!mobileLayout ? () => {
              if (!storyMediaGestureConsumedRef.current && !videoHandoffRef.current) exitFullscreen();
            } : undefined}
            video={renderStageVideo(true)}
          />
          {scopedMedia.length > 1 || !mobileLayout ? (
            <nav className="journey-story-fullscreen__nav" aria-label="全屏媒体导航">
              {mobileLayout || videoNavigationVisible ? <button
                type="button"
                data-video-step="previous"
                disabled={!canStepPrevious}
                {...videoStepButtonInput(-1)}
                aria-label="上一个媒体"
              >
                <IconArrowLeft size={22} stroke={1.35} aria-hidden="true" />
              </button> : null}
              <button
                type="button"
                className={playing ? "is-active" : ""}
                disabled={mutationPending || (scopedMedia.length < 2 && !asset.mimeType.startsWith("video/")) || (!playing && !storyAutoplayCanStart(
                  autoplayVideoCandidate,
                  storyMediaAvailability(autoplayVideoCandidateRead?.status),
                ))}
                onClick={togglePlaying}
                aria-label={playing ? "暂停自动播放" : "自动播放媒体"}
                aria-pressed={playing}
              >
                {playing
                  ? <IconPlayerPause size={22} stroke={1.35} aria-hidden="true" />
                  : <IconPlayerPlay size={22} stroke={1.35} aria-hidden="true" />}
              </button>
              {mobileLayout ? <span>{assetIndex + 1} / {scopedMedia.length}</span> : null}
              {mobileLayout || videoNavigationVisible ? <button
                type="button"
                data-video-step="next"
                disabled={!canStepNext}
                {...videoStepButtonInput(1)}
                aria-label="下一个媒体"
              >
                <IconArrowRight size={22} stroke={1.35} aria-hidden="true" />
              </button> : null}
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
