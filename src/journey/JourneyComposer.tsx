import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconDots,
  IconMapPin,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { IconActionButton } from "../components/IconActionButton";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import {
  uploadMediaInParts,
  type UploadedMediaAsset,
} from "../api/multipartUpload";
import {
  createJourney,
  JourneyApiError,
  listJourneys,
  reverseGeocode,
  searchLocations,
  updateJourney,
} from "./journeyApi";
import { journeyLocationSearchErrorMessage } from "./journeyLocationSearchError";
import {
  resolveJourneySaveRecovery,
  type JourneySaveCallbackScope,
} from "./journeySaveRecovery";
import {
  journeyVisualMedia,
  validateJourneyFiles,
  validateJourneyInput,
} from "./journeyModel";
import {
  appendRoutePoint,
  matchRouteDraftPoints,
  moveRoutePoint,
  removeRoutePoint,
  routeDraftToInput,
  suggestPointLabel,
  toggleRouteStop,
  updateRoutePoint,
  type RouteDraftPoint,
} from "./routeDraft";
import {
  buildDraftPlaybackPreviewSnapshot,
  type DraftPlaybackPreviewSnapshot,
} from "./draftPlaybackPreview";
import type {
  Journey,
  JourneyInput,
  JourneyRoute,
  LocationSearchResponse,
  LocationSearchResult,
} from "./types";
import {
  getLightEffectGradient,
  LIGHT_COLORS,
  LIGHT_EFFECTS,
  type LightEffectId,
} from "./lightEffects";
import { resolveModalInitialFocusTarget, useModalFocus, useNestedModalFocus } from "./useModalFocus";
import { useCompactMobileLayout } from "./mobileLayout";
import { useMobileSurfaceHistory } from "./useMobileSurfaceHistory";
import {
  composerAvailableHeight,
  composerTask,
  COMPOSER_MOBILE_TASKS,
  type ComposerMobileTaskId,
} from "./composerMobileTasks";

/** The upload allowlist the server enforces; every picker states the same one. */
const MEDIA_FILE_ACCEPT = "image/avif,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm";

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

export type PendingJourneyMedia = {
  file: File;
  routePointDraftId: string | null;
};

type JourneyMediaUploadAssignment = {
  file: File;
  routePointId?: string;
};

type JourneyMediaUploadResult = Pick<
  JourneySaveResult,
  "uploadedCount" | "mediaErrors"
> & {
  // The completed assets, in upload order. Callers need the resolved id
  // because the server deduplicates identical content inside a journey and
  // then answers with the existing asset rather than a new one.
  assets: UploadedMediaAsset[];
};

type UploadJourneyMediaOptions = {
  journeyId: string;
  routePointId?: string;
  files: readonly File[];
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
};

type PersistJourneyDraftOptions = {
  input: JourneyInput;
  mediaFiles: readonly PendingJourneyMedia[];
  routePoints: readonly RouteDraftPoint[];
  persist?: (input: JourneyInput) => Promise<Journey>;
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
};

type UploadJourneyMediaAssignmentsOptions = {
  journeyId: string;
  assignments: readonly JourneyMediaUploadAssignment[];
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
};

async function uploadJourneyMediaAssignments({
  journeyId,
  assignments,
  upload = uploadMediaInParts,
  onProgress,
}: UploadJourneyMediaAssignmentsOptions): Promise<JourneyMediaUploadResult> {
  const totalBytes = assignments.reduce((sum, assignment) => sum + assignment.file.size, 0);
  const mediaErrors: JourneySaveResult["mediaErrors"] = [];
  const assets: UploadedMediaAsset[] = [];
  let uploadedCount = 0;
  let completedBytes = 0;

  for (let fileIndex = 0; fileIndex < assignments.length; fileIndex += 1) {
    const { file, routePointId } = assignments[fileIndex];
    try {
      const asset = await upload({
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
      if (asset) assets.push(asset);
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

  return { uploadedCount, mediaErrors, assets };
}

export async function uploadJourneyMedia({
  journeyId,
  routePointId,
  files,
  upload = uploadMediaInParts,
  onProgress,
}: UploadJourneyMediaOptions): Promise<JourneyMediaUploadResult> {
  return uploadJourneyMediaAssignments({
    journeyId,
    assignments: files.map((file) => ({ file, routePointId })),
    upload,
    onProgress,
  });
}

export function resolvePendingMediaUploads(
  mediaFiles: readonly PendingJourneyMedia[],
  routePoints: readonly RouteDraftPoint[],
  journey: Journey,
): JourneyMediaUploadAssignment[] {
  return mediaFiles.map(({ file, routePointDraftId }) => {
    if (!routePointDraftId) return { file };
    const draftIndex = routePoints.findIndex((point) => point.draftId === routePointDraftId);
    const draftPoint = routePoints[draftIndex];
    const persistedPoint = draftPoint?.id
      ? journey.routePoints.find((point) => point.id === draftPoint.id)
      : journey.routePoints.find((point) => point.sortOrder === draftIndex);
    if (!persistedPoint) {
      throw new Error("旅程已保存，但媒体归属无法确认；请重新打开旅程后添加媒体。");
    }
    return { file, routePointId: persistedPoint.id };
  });
}

export function clearRemovedMediaTarget(
  mediaFiles: readonly PendingJourneyMedia[],
  routePointDraftId: string,
): PendingJourneyMedia[] {
  return mediaFiles.map((media) => (
    media.routePointDraftId === routePointDraftId
      ? { ...media, routePointDraftId: null }
      : media
  ));
}

export function routePointFocusAfterRemoval(
  routePoints: readonly RouteDraftPoint[],
  routePointDraftId: string,
): string | null {
  const index = routePoints.findIndex((point) => point.draftId === routePointDraftId);
  if (index < 0) return null;
  return routePoints[index + 1]?.draftId ?? routePoints[index - 1]?.draftId ?? null;
}

export class JourneyMediaContinuationError extends Error {
  readonly journey: Journey;

  constructor(journey: Journey, cause: unknown) {
    super(cause instanceof Error ? cause.message : "媒体继续处理失败");
    this.name = "JourneyMediaContinuationError";
    this.journey = journey;
  }
}

export async function persistJourneyDraft({
  input,
  mediaFiles,
  routePoints,
  persist = createJourney,
  upload = uploadMediaInParts,
  onProgress,
}: PersistJourneyDraftOptions): Promise<JourneySaveResult> {
  const journey = await persist(input);
  try {
    const mediaResult = await uploadJourneyMediaAssignments({
      journeyId: journey.id,
      assignments: resolvePendingMediaUploads(mediaFiles, routePoints, journey),
      upload,
      onProgress,
    });
    return { journey, ...mediaResult };
  } catch (error) {
    throw new JourneyMediaContinuationError(journey, error);
  }
}

export async function reconcileUnknownJourneyCreate(
  submittedDraft: JourneyInput,
  readJourneys: () => Promise<Journey[]> = listJourneys,
  knownJourneyIdsBeforeCreate: ReadonlySet<string> = new Set(),
) {
  return resolveJourneySaveRecovery(
    submittedDraft,
    await readJourneys(),
    { knownJourneyIdsBeforeCreate },
  );
}

export type GlobePointPick = {
  latitude: number;
  longitude: number;
};

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

function confirmationRequiredUnknownCreateMessage(hasPendingMedia: boolean) {
  const pendingMediaNotice = hasPendingMedia
    ? "当前会话仍会保留尚未上传的本地媒体和路线点归属；请不要刷新整个页面。"
    : "";
  return `检测到一条与本次提交内容完全相同、且在本次尝试后出现的 Journey，但当前系统没有能证明它属于这次保存请求的服务端尝试标识。为避免把其他会话创建的 Journey 当成本次结果，当前不会自动采用它、上传媒体或触发抵达焦点，也不会再次创建。请先关闭创建器，在 Atlas 中核对这条 Journey。${pendingMediaNotice}`;
}

function ambiguousUnknownCreateMessage(hasPendingMedia: boolean) {
  const refreshWarning = hasPendingMedia
    ? "如果你选择刷新整个页面，尚未上传的本地媒体和路线点归属会丢失，需要重新选择。"
    : "";
  return `检测到多条与本次提交完全相同的新 Journey，无法安全判断哪一条属于这次保存。为避免重复创建，当前不会再次提交；请关闭创建器后在 Atlas 中核对这些 Journey。${refreshWarning}`;
}

type JourneyComposerProps = {
  open: boolean;
  journey?: Journey | null;
  initialUnknownCreateAttempt?: UnknownJourneyCreateAttempt | null;
  onClose: (unknownCreateAttempt?: UnknownJourneyCreateAttempt | null) => void;
  onSaved: (
    result: JourneySaveResult,
    callbackScope: JourneySaveCallbackScope,
  ) => void | Promise<void>;
  onGlobePickRequest?: (accept: (point: GlobePointPick) => void) => void;
  onGlobePickCancel?: () => void;
  onRoutePreviewChange?: (route: JourneyRoute | null) => void;
  onPlaybackPreview?: (snapshot: DraftPlaybackPreviewSnapshot) => void;
  playbackPreviewActive?: boolean;
  playbackPreviewPreparing?: boolean;
};

type PlaybackPreviewReturnFocusKind = "editor" | "route-point" | "none";

/**
 * Why the dialog does or does not hold focus once the Playback Preview
 * suspension is released. `trap` is the contract: the trap's own activation
 * focus landed. `repaired` means it landed only after the layer settled, and
 * `blocked` names the element that still refuses focus, so a failure says
 * whether focus was rejected or taken away again rather than reporting an
 * anonymous `body`.
 */
function describeReturnFocusOutcome(root: HTMLElement | null) {
  if (!root) return "detached";
  if (root.contains(document.activeElement)) return "trap";
  const inertOwner = root.closest<HTMLElement>("[inert]");
  if (inertOwner) return `blocked:inert:${inertOwner.className || inertOwner.tagName.toLowerCase()}`;
  if (getComputedStyle(root).visibility === "hidden") return "blocked:hidden";
  return "outside";
}

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
    // #10: echo the existing note back so a whole-list replace never clears
    // it; absent notes stay absent.
    note: point.note ?? null,
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
  initialUnknownCreateAttempt = null,
  onClose,
  onSaved,
  onGlobePickRequest,
  onGlobePickCancel,
  onRoutePreviewChange,
  onPlaybackPreview,
  playbackPreviewActive = false,
  playbackPreviewPreparing = false,
}: JourneyComposerProps) {
  const recoveryInput = !journey ? initialUnknownCreateAttempt?.input : undefined;
  const recoveryRoutePoints = !journey ? initialUnknownCreateAttempt?.routePoints : undefined;
  const [routePoints, setRoutePoints] = useState<RouteDraftPoint[]>(
    () => journey
      ? journeyToDraftPoints(journey)
      : recoveryRoutePoints?.map((point) => ({ ...point }))
        ?? (recoveryInput?.routePoints ?? []).map((point) => ({
          draftId: draftId(),
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
          label: point.label,
          isStop: point.isStop,
          occurredAt: point.occurredAt ?? null,
          note: point.note ?? null,
        })),
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
  const [reverseAttribution, setReverseAttribution] = useState<
    LocationSearchResponse["attribution"]
  >(null);
  const [searchPending, setSearchPending] = useState(false);
  const [title, setTitle] = useState(journey?.title ?? recoveryInput?.title ?? "");
  const [startedOn, setStartedOn] = useState(
    () => journey?.startedOn ?? recoveryInput?.startedOn ?? new Date().toISOString().slice(0, 10),
  );
  const [endedOn, setEndedOn] = useState(journey?.endedOn ?? recoveryInput?.endedOn ?? "");
  const [note, setNote] = useState(journey?.note ?? recoveryInput?.note ?? "");
  const [lightColor, setLightColor] = useState(journey?.lightColor ?? recoveryInput?.lightColor ?? LIGHT_COLORS[0]);
  const [lightEffect, setLightEffect] = useState<LightEffectId | null>(journey?.lightEffect ?? recoveryInput?.lightEffect ?? null);
  const [mediaFiles, setMediaFiles] = useState<PendingJourneyMedia[]>(
    () => journey
      ? []
      : (initialUnknownCreateAttempt?.mediaFiles ?? []).map((media) => ({ ...media })),
  );
  const mobileLayout = useCompactMobileLayout();
  // #375: which Composer task the compact-mobile surface is showing. Desktop
  // renders the same information architecture inline and stays on "primary".
  const [mobileTask, setMobileTask] = useState<ComposerMobileTaskId>("primary");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const activeMobileTask: ComposerMobileTaskId = mobileLayout ? mobileTask : "primary";
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskEntryRefs = useRef(new Map<ComposerMobileTaskId | "more", HTMLButtonElement>());
  const taskReturnFocusRef = useRef<ComposerMobileTaskId | null>(null);
  const [mobileMediaMenuIndex, setMobileMediaMenuIndex] = useState<number | null>(null);
  const [mobileMediaAssignmentIndex, setMobileMediaAssignmentIndex] = useState<number | null>(null);
  const [mobileMediaDeleteIndex, setMobileMediaDeleteIndex] = useState<number | null>(null);
  const [expandedRoutePointDraftId, setExpandedRoutePointDraftId] = useState<string | null>(null);
  const [routePointMenuDraftId, setRoutePointMenuDraftId] = useState<string | null>(null);
  const routePointTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const routePointMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const routePointRowRefs = useRef(new Map<string, HTMLLIElement>());
  const narrativeScrollRef = useRef<HTMLElement>(null);
  const routeScrollRef = useRef<HTMLElement>(null);
  const playbackPreviewRevisionRef = useRef(0);
  const playbackPreviewWasActiveRef = useRef(false);
  const lastEditorFocusRef = useRef<HTMLElement | null>(null);
  const playbackPreviewReturnFocusKindRef = useRef<PlaybackPreviewReturnFocusKind | null>(null);
  const [playbackPreviewReturnFocusKind, setPlaybackPreviewReturnFocusKind] = useState<PlaybackPreviewReturnFocusKind | null>(null);
  const [playbackPreviewReturnFocusOutcome, setPlaybackPreviewReturnFocusOutcome] = useState<string | null>(null);
  const playbackPreviewReturnContextRef = useRef<{
    selectedDraftId: string | null;
    expandedDraftId: string | null;
    focusTarget: HTMLElement | null;
    narrativeScrollTop: number;
    routeScrollTop: number;
    mobileTask: ComposerMobileTaskId;
  } | null>(null);
  const pendingRoutePointFocusDraftIdRef = useRef<string | null>(null);
  const pendingRoutePointMenuFocusDraftIdRef = useRef<string | null>(null);
  const pendingRoutePointScrollDraftIdRef = useRef<string | null>(null);
  const [message, setMessage] = useState(() => {
    if (journey || !initialUnknownCreateAttempt) return "";
    const hasPendingMedia = (initialUnknownCreateAttempt.mediaFiles?.length ?? 0) > 0;
    if (initialUnknownCreateAttempt.mode === "confirmation-required") {
      return confirmationRequiredUnknownCreateMessage(hasPendingMedia);
    }
    if (initialUnknownCreateAttempt.mode === "ambiguous") {
      return ambiguousUnknownCreateMessage(hasPendingMedia);
    }
    return unknownCreateRecheckMessage(hasPendingMedia);
  });
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [savedResult, setSavedResult] = useState<JourneySaveResult | null>(null);
  const [unknownCreateAttempt, setUnknownCreateAttempt] = useState<UnknownJourneyCreateAttempt | null>(
    () => journey ? null : initialUnknownCreateAttempt,
  );
  const [retryAssignments, setRetryAssignments] = useState<JourneyMediaUploadAssignment[]>([]);
  const [globePicking, setGlobePicking] = useState(false);
  const activeLightEffect = LIGHT_EFFECTS.find((effect) => effect.id === lightEffect) ?? null;
  // The composer edits photos and videos; a journey soundtrack is managed in
  // the story dialog and is not counted here.
  const existingVisualMediaCount = journey ? journeyVisualMedia(journey).length : 0;
  const safeLightColor = /^#[0-9a-fA-F]{6}$/.test(lightColor) ? lightColor : LIGHT_COLORS[0];
  const activeLightGradient = activeLightEffect
    ? getLightEffectGradient(activeLightEffect.id, safeLightColor)
    : `linear-gradient(135deg, ${safeLightColor}, ${safeLightColor})`;
  const globePickTriggerRef = useRef<HTMLButtonElement>(null);
  const globePickCancelRef = useRef<HTMLButtonElement>(null);
  const globePickFocusRestorePendingRef = useRef(false);
  // Each globe-pick handoff is single-use. A cancelled/closed pick can leave
  // an accept callback alive in an event queue, so gate it by a monotonically
  // increasing revision instead of trusting the caller to forget it in time.
  const globePickRequestRevisionRef = useRef(0);
  const searchRevisionRef = useRef(0);
  const reverseGeocodeRevisionRef = useRef(0);
  const activeReverseGeocodeDraftIdRef = useRef<string | null>(null);
  const composerMountedRef = useRef(true);
  const routePointsRef = useRef(routePoints);
  routePointsRef.current = routePoints;
  const existingSearchMatches = useMemo(
    () => matchRouteDraftPoints(routePoints, searchQuery),
    [routePoints, searchQuery],
  );
  /**
   * #245 established that a modal focus trap owns initial focus for its whole
   * activation: a restore written in a later passive effect races the trap's own
   * `resolveModalInitialFocusTarget` instead of replacing it. Releasing the
   * Playback Preview suspension re-activates this trap, so the preserved return
   * target is handed to the trap as its initial focus rather than re-applied
   * afterwards. `resolveModalInitialFocusTarget` already rejects an inert,
   * zero-rect or hidden candidate and falls back to the dialog root.
   */
  const resolvePlaybackPreviewReturnFocus = useCallback((root: HTMLElement) => {
    const context = playbackPreviewReturnContextRef.current;
    if (!context) {
      playbackPreviewReturnFocusKindRef.current = null;
      return null;
    }
    if (context.focusTarget?.isConnected && root.contains(context.focusTarget)) {
      playbackPreviewReturnFocusKindRef.current = "editor";
      return context.focusTarget;
    }
    const candidate = context.selectedDraftId
      ? routePointTriggerRefs.current.get(context.selectedDraftId) ?? null
      : null;
    // A Route Point deleted or replaced while the preview ran must not be
    // revived through a stale trigger ref, so survival is read from the live
    // dialog subtree rather than from the captured selection alone.
    const trigger = candidate?.isConnected && root.contains(candidate) ? candidate : null;
    playbackPreviewReturnFocusKindRef.current = trigger ? "route-point" : "none";
    return trigger;
  }, []);

  const dialogRef = useModalFocus<HTMLElement>(() => {
    if (moreMenuOpen) {
      setMoreMenuOpen(false);
      return;
    }
    if (mobileLayout && mobileTask !== "primary") {
      exitMobileTask();
      return;
    }
    if (mobileMediaDeleteIndex !== null) {
      setMobileMediaDeleteIndex(null);
      return;
    }
    if (mobileMediaAssignmentIndex !== null) {
      setMobileMediaAssignmentIndex(null);
      return;
    }
    if (mobileMediaMenuIndex !== null) {
      setMobileMediaMenuIndex(null);
      return;
    }
    if (!saving) closeComposer();
  }, true, globePicking || playbackPreviewActive, resolvePlaybackPreviewReturnFocus);
  const mobileMediaSheetRef = useNestedModalFocus<HTMLElement>(
    mobileLayout && (
      mobileMediaMenuIndex !== null
      || mobileMediaAssignmentIndex !== null
      || mobileMediaDeleteIndex !== null
    ),
    mobileMediaMenuIndex !== null
      ? `manage:${mobileMediaMenuIndex}`
      : mobileMediaAssignmentIndex !== null
        ? `assignment:${mobileMediaAssignmentIndex}`
        : mobileMediaDeleteIndex !== null
          ? `delete:${mobileMediaDeleteIndex}`
          : null,
  );

  useEffect(() => {
    if (mobileLayout) return;
    setMobileMediaMenuIndex(null);
    setMobileMediaAssignmentIndex(null);
    setMobileMediaDeleteIndex(null);
    // Desktop shows the whole architecture inline, so a task left open on a
    // rotated phone must not survive as a state nobody can see or leave.
    setMobileTask("primary");
    setMoreMenuOpen(false);
    taskReturnFocusRef.current = null;
  }, [mobileLayout]);

  /**
   * #375: entering a task moves focus to its heading, and leaving it restores
   * focus to the control that opened it. The task panels are views inside the
   * Composer dialog, not nested modals, so this deliberately adds no second
   * focus trap on top of the one `useModalFocus` already owns.
   */
  useEffect(() => {
    if (!mobileLayout) return;
    if (mobileTask !== "primary") {
      taskHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    const returning = taskReturnFocusRef.current;
    taskReturnFocusRef.current = null;
    if (!returning) return;
    // A More-path entry is unmounted with its menu, so the control the person
    // actually came through - and the one still on screen - is More itself.
    const target = composerTask(returning).behindMore ? "more" : returning;
    taskEntryRefs.current.get(target)?.focus({ preventScroll: true });
  }, [mobileLayout, mobileTask]);

  /**
   * #375: a soft keyboard shrinks the visual viewport and leaves the layout
   * viewport alone, so a dialog sized to the layout viewport hides its own
   * sticky save behind the keyboard. Publish the measured available height and
   * keep the focused field in view when it changes.
   */
  useEffect(() => {
    if (!mobileLayout) return;
    const visual = globalThis.visualViewport;
    if (!visual) return;
    const apply = (keepFocusVisible: boolean) => {
      const root = dialogRef.current;
      if (!root) return;
      const height = composerAvailableHeight(globalThis.innerHeight, visual.height, visual.offsetTop);
      if (height === null) root.style.removeProperty("--composer-available-height");
      else root.style.setProperty("--composer-available-height", `${height}px`);
      if (!keepFocusVisible) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active)) {
        active.scrollIntoView({ block: "nearest" });
      }
    };
    const onResize = () => apply(true);
    const onScroll = () => apply(false);
    apply(false);
    visual.addEventListener("resize", onResize);
    visual.addEventListener("scroll", onScroll);
    return () => {
      visual.removeEventListener("resize", onResize);
      visual.removeEventListener("scroll", onScroll);
      dialogRef.current?.style.removeProperty("--composer-available-height");
    };
  }, [mobileLayout, dialogRef]);

  useMobileSurfaceHistory(
    mobileLayout && mobileTask !== "primary",
    "composer-task",
    () => exitMobileTask(),
  );

  useEffect(() => {
    if (expandedRoutePointDraftId && !routePoints.some((point) => point.draftId === expandedRoutePointDraftId)) {
      setExpandedRoutePointDraftId(null);
    }
    if (routePointMenuDraftId && !routePoints.some((point) => point.draftId === routePointMenuDraftId)) {
      setRoutePointMenuDraftId(null);
    }
  }, [expandedRoutePointDraftId, routePointMenuDraftId, routePoints]);

  useEffect(() => {
    if (!routePointMenuDraftId) return;
    const openDraftId = routePointMenuDraftId;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      pendingRoutePointMenuFocusDraftIdRef.current = openDraftId;
      setRoutePointMenuDraftId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [routePointMenuDraftId]);

  useEffect(() => {
    const focusDraftId = pendingRoutePointFocusDraftIdRef.current;
    if (focusDraftId) {
      const trigger = routePointTriggerRefs.current.get(focusDraftId);
      if (trigger) {
        trigger.focus({ preventScroll: true });
        pendingRoutePointFocusDraftIdRef.current = null;
      }
    }

    const menuFocusDraftId = pendingRoutePointMenuFocusDraftIdRef.current;
    if (menuFocusDraftId) {
      const trigger = routePointMenuTriggerRefs.current.get(menuFocusDraftId);
      if (trigger) {
        trigger.focus({ preventScroll: true });
        pendingRoutePointMenuFocusDraftIdRef.current = null;
      }
    }

    const scrollDraftId = pendingRoutePointScrollDraftIdRef.current;
    if (scrollDraftId) {
      const row = routePointRowRefs.current.get(scrollDraftId);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        pendingRoutePointScrollDraftIdRef.current = null;
      }
    }
  }, [expandedRoutePointDraftId, routePointMenuDraftId, routePoints]);

  const input = useMemo<JourneyInput>(() => ({
    title: title.trim(),
    startedOn,
    endedOn: endedOn || null,
    note: note.trim(),
    lightColor,
    lightEffect,
    revision: journey?.revision,
    routePoints: routeDraftToInput(routePoints),
  }), [endedOn, journey?.revision, lightColor, lightEffect, note, routePoints, startedOn, title]);

  function requestPlaybackPreview() {
    if (!onPlaybackPreview || saving || routePoints.length === 0 || playbackPreviewActive) return;
    setPlaybackPreviewReturnFocusOutcome(null);
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = lastEditorFocusRef.current?.isConnected ? lastEditorFocusRef.current : activeElement;
    const selectedDraftId = focusTarget
      ?.closest<HTMLElement>("[data-route-point-draft-id]")
      ?.dataset.routePointDraftId
      ?? expandedRoutePointDraftId;
    playbackPreviewReturnContextRef.current = {
      selectedDraftId,
      expandedDraftId: expandedRoutePointDraftId,
      focusTarget,
      narrativeScrollTop: narrativeScrollRef.current?.scrollTop ?? 0,
      routeScrollTop: routeScrollRef.current?.scrollTop ?? 0,
      mobileTask,
    };
    playbackPreviewRevisionRef.current += 1;
    onPlaybackPreview(buildDraftPlaybackPreviewSnapshot({
      sourceJourney: journey ?? null,
      input,
      routePoints,
      snapshotRevision: playbackPreviewRevisionRef.current,
      excludedPendingMediaCount: mediaFiles.length,
    }));
  }

  useEffect(() => {
    const wasActive = playbackPreviewWasActiveRef.current;
    playbackPreviewWasActiveRef.current = playbackPreviewActive;
    if (!wasActive || playbackPreviewActive) return;
    const context = playbackPreviewReturnContextRef.current;
    if (!context) return;
    const expandedSurvives = context.expandedDraftId
      ? routePoints.some((point) => point.draftId === context.expandedDraftId)
      : false;
    setExpandedRoutePointDraftId(expandedSurvives ? context.expandedDraftId : null);
    // The preview suspends the Composer rather than replacing it, so it returns
    // to the same task the person left, not to the primary surface.
    setMobileTask(context.mobileTask);
    setPlaybackPreviewReturnFocusKind(playbackPreviewReturnFocusKindRef.current);
    // The trap owns the restore, but Chromium rejects focus while the suspended
    // Composer still inherits `visibility: hidden` from the Playback Preview
    // backdrop. Wait on that actual lifecycle condition instead of guessing a
    // timeout, then restore the exact resolved target once it is focusable.
    const immediate = describeReturnFocusOutcome(dialogRef.current);
    setPlaybackPreviewReturnFocusOutcome(immediate);
    const restoreWhenVisible = () => {
      if (playbackPreviewReturnContextRef.current !== context) return;
      const root = dialogRef.current;
      if (!root) {
        playbackPreviewReturnContextRef.current = null;
        return;
      }
      if (getComputedStyle(root).visibility === "hidden" || root.closest("[inert]")) {
        window.requestAnimationFrame(restoreWhenVisible);
        return;
      }
      if (narrativeScrollRef.current) narrativeScrollRef.current.scrollTop = context.narrativeScrollTop;
      if (routeScrollRef.current) routeScrollRef.current.scrollTop = context.routeScrollTop;
      const returnTarget = resolveModalInitialFocusTarget(root, resolvePlaybackPreviewReturnFocus);
      const needsRepair = document.activeElement !== returnTarget;
      if (needsRepair) returnTarget.focus({ preventScroll: true });
      setPlaybackPreviewReturnFocusOutcome(
        document.activeElement === returnTarget
          ? (needsRepair ? `repaired:${immediate}` : "trap")
          : describeReturnFocusOutcome(root),
      );
      playbackPreviewReturnContextRef.current = null;
    };
    window.requestAnimationFrame(restoreWhenVisible);
  }, [playbackPreviewActive, resolvePlaybackPreviewReturnFocus, routePoints]);

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      searchRevisionRef.current += 1;
      reverseGeocodeRevisionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    searchRevisionRef.current += 1;
    setSearchResults([]);
    setSearchAttribution(null);
    setSearchPending(false);
  }, [journey?.id]);

  useEffect(() => {
    onRoutePreviewChange?.(routePoints.length === 0 ? null : {
      id: journey?.id ?? "draft-route-preview",
      color: lightColor,
      lightEffect,
      points: routePoints.map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
        isStop: point.isStop,
        label: point.label,
      })),
    });
  }, [journey?.id, lightColor, lightEffect, onRoutePreviewChange, routePoints]);

  useEffect(() => {
    if (!globePicking) return;
    globePickCancelRef.current?.focus({ preventScroll: true });
  }, [globePicking]);

  function restoreGlobePickTriggerFocus() {
    // The modal focus trap resumes when globePicking becomes false and focuses
    // the dialog root first. Queue trigger restoration for the post-resume
    // effect below so the trap cannot steal focus back from the trigger.
    globePickFocusRestorePendingRef.current = true;
  }

  useEffect(() => {
    if (globePicking || !globePickFocusRestorePendingRef.current) return;
    globePickFocusRestorePendingRef.current = false;
    const deadline = performance.now() + 1_000;
    const keepFocusOwned = () => {
      const trigger = globePickTriggerRef.current;
      if (!trigger?.isConnected || performance.now() >= deadline) return;
      const visible = !trigger.closest("[inert]")
        && trigger.getClientRects().length > 0
        && getComputedStyle(trigger).visibility !== "hidden";
      if (!visible) {
        window.requestAnimationFrame(keepFocusOwned);
        return;
      }
      const active = document.activeElement;
      if (active === document.body || active === dialogRef.current || active === null) {
        trigger.focus({ preventScroll: true });
      } else if (active !== trigger) {
        // A real user move owns focus from here; never steal it back.
        return;
      }
      window.requestAnimationFrame(keepFocusOwned);
    };
    window.requestAnimationFrame(keepFocusOwned);
  }, [globePicking]);

  useEffect(() => {
    if (!globePicking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      globePickRequestRevisionRef.current += 1;
      setGlobePicking(false);
      setMessage("");
      onGlobePickCancel?.();
      restoreGlobePickTriggerFocus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [globePicking, onGlobePickCancel]);

  if (!open) return null;

  function addPoint(point: RouteDraftPoint) {
    setRoutePoints((current) => {
      const next = appendRoutePoint(current, point);
      // Keep async globe-pick work aligned even when a mocked/fast reverse
      // lookup settles before React commits the next render.
      routePointsRef.current = next;
      return next;
    });
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

  function changeSearchQuery(value: string) {
    searchRevisionRef.current += 1;
    setSearchQuery(value);
    setSearchResults([]);
    setSearchAttribution(null);
    setSearchPending(false);
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) {
      searchRevisionRef.current += 1;
      setSearchResults([]);
      setSearchAttribution(null);
      setSearchPending(false);
      setMessage("至少输入两个字符再搜索。");
      return;
    }

    const revision = ++searchRevisionRef.current;
    setSearchPending(true);
    setMessage("");
    try {
      const response = await searchLocations(query);
      if (!composerMountedRef.current || searchRevisionRef.current !== revision) return;
      setSearchResults(response.results);
      setSearchAttribution(response.attribution);
    } catch (error) {
      if (!composerMountedRef.current || searchRevisionRef.current !== revision) return;
      setSearchResults([]);
      setSearchAttribution(null);
      setMessage(journeyLocationSearchErrorMessage(error));
    } finally {
      if (composerMountedRef.current && searchRevisionRef.current === revision) {
        setSearchPending(false);
      }
    }
  }

  function locateExistingRoutePoint(routePointDraftId: string) {
    if (!routePointsRef.current.some((point) => point.draftId === routePointDraftId)) return;
    setRoutePointMenuDraftId(null);
    pendingRoutePointFocusDraftIdRef.current = routePointDraftId;
    pendingRoutePointScrollDraftIdRef.current = routePointDraftId;
    setExpandedRoutePointDraftId(routePointDraftId);
    routePointTriggerRefs.current.get(routePointDraftId)?.focus({ preventScroll: true });
    routePointRowRefs.current.get(routePointDraftId)?.scrollIntoView({ block: "nearest" });
    setMessage("");
  }

  function addSearchResult(result: LocationSearchResult) {
    searchRevisionRef.current += 1;
    addPoint(toDraftPoint(
      result.latitude,
      result.longitude,
      result.label,
      true,
    ));
    setSearchResults([]);
    setSearchAttribution(null);
    setSearchPending(false);
    setSearchQuery("");
  }
  function requestGlobePoint() {
    if (!onGlobePickRequest) return;
    const requestRevision = ++globePickRequestRevisionRef.current;
    reverseGeocodeRevisionRef.current += 1;
    setRoutePointMenuDraftId(null);
    setGlobePicking(true);
    setReverseAttribution(null);
    setMessage("请在地球上点击一个位置。");
    onGlobePickRequest((point) => {
      // Consume exactly this handoff once. This also rejects callbacks from a
      // cancelled/closed pick and a second delivery from the globe surface.
      if (globePickRequestRevisionRef.current !== requestRevision) return;
      globePickRequestRevisionRef.current += 1;

      setGlobePicking(false);
      restoreGlobePickTriggerFocus();
      const draftPoint = toDraftPoint(
        point.latitude,
        point.longitude,
        "",
        routePointsRef.current.length === 0,
      );
      addPoint(draftPoint);
      const geocodeRevision = ++reverseGeocodeRevisionRef.current;
      activeReverseGeocodeDraftIdRef.current = draftPoint.draftId;
      setMessage("已从地球添加地点；正在识别坐标对应的名称…");
      void suggestPlaceName(draftPoint, geocodeRevision);
    });
  }

  async function suggestPlaceName(point: RouteDraftPoint, revision: number) {
    try {
      const response = await reverseGeocode(point.latitude, point.longitude);
      if (!composerMountedRef.current) return;
      // The point may have been removed while the lookup was in flight. Never
      // resurrect it or show a result for an interaction that no longer exists.
      if (!routePointsRef.current.some((candidate) => candidate.draftId === point.draftId)) return;

      const label = response.result?.label;
      if (label) {
        setRoutePoints((current) => suggestPointLabel(current, point.draftId, label));
      }

      // A newer globe pick owns the shared message/attribution surface. An old
      // lookup may still fill its own blank point label, but must never replace
      // the current pick's user-visible status or provider attribution.
      if (reverseGeocodeRevisionRef.current !== revision) return;
      activeReverseGeocodeDraftIdRef.current = null;
      if (label) {
        setMessage(`已根据坐标识别为「${label}」，可继续修改。`);
      } else {
        setMessage("已从地球添加地点，未识别到对应名称；可手动补充。");
      }
      setReverseAttribution(response.attribution ?? null);
    } catch {
      if (!composerMountedRef.current) return;
      if (!routePointsRef.current.some((candidate) => candidate.draftId === point.draftId)) return;
      if (reverseGeocodeRevisionRef.current !== revision) return;
      activeReverseGeocodeDraftIdRef.current = null;
      // Reverse lookup is optional (including timeout); the picked point stays
      // editable and route preview remains driven by the local draft.
      setReverseAttribution(null);
      setMessage("已从地球添加地点；坐标识别暂不可用，可手动补充名称。");
    }
  }

  function cancelGlobePoint() {
    globePickRequestRevisionRef.current += 1;
    setGlobePicking(false);
    setMessage("");
    onGlobePickCancel?.();
    restoreGlobePickTriggerFocus();
  }

  function closeComposerWithUnknownCreateAttempt(
    preservedUnknownCreateAttempt: UnknownJourneyCreateAttempt | null,
  ) {
    globePickRequestRevisionRef.current += 1;
    searchRevisionRef.current += 1;
    reverseGeocodeRevisionRef.current += 1;
    activeReverseGeocodeDraftIdRef.current = null;
    if (globePicking) onGlobePickCancel?.();
    onRoutePreviewChange?.(null);
    onClose(preservedUnknownCreateAttempt);
  }

  function closeComposer() {
    closeComposerWithUnknownCreateAttempt(unknownCreateAttempt);
  }

  function enterMobileTask(task: ComposerMobileTaskId) {
    setMoreMenuOpen(false);
    if (task === "primary") {
      exitMobileTask();
      return;
    }
    setMobileTask(task);
  }

  function exitMobileTask() {
    setMoreMenuOpen(false);
    setMobileTask((current) => {
      if (current === "primary") return current;
      taskReturnFocusRef.current = current;
      return "primary";
    });
  }

  /** What a task entry says it holds, so nothing is entered blind. */
  function composerTaskSummary(task: ComposerMobileTaskId) {
    if (task === "journey-info") {
      return note.trim() ? `${startedOn || "未设置日期"} · 已写下故事` : startedOn || "未设置日期";
    }
    if (task === "media") {
      if (mediaFiles.length > 0) return `${mediaFiles.length} 个待上传`;
      return existingVisualMediaCount ? `${existingVisualMediaCount} 个已有媒体` : "还没有媒体";
    }
    if (task === "appearance") {
      return activeLightEffect?.label ?? "单色";
    }
    return "经纬度与地球取点";
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>, routePointDraftId: string | null = null) {
    const selected = [...(event.currentTarget.files ?? [])];
    const next = [
      ...mediaFiles,
      ...selected.map((file) => ({ file, routePointDraftId })),
    ];
    const validation = validateJourneyFiles(next.map((media) => media.file));
    if (!validation.accepted) {
      setMessage(validation.errors[0]);
    } else {
      setMediaFiles(next);
      setMessage("");
    }
    event.currentTarget.value = "";
  }

  function mediaAssignmentLabel(media: PendingJourneyMedia) {
    if (!media.routePointDraftId) return "整段旅程";
    const pointIndex = routePoints.findIndex((point) => point.draftId === media.routePointDraftId);
    const point = routePoints[pointIndex];
    return point
      ? `${String(pointIndex + 1).padStart(2, "0")} · ${point.label || `途径点 ${pointIndex + 1}`}`
      : "整段旅程";
  }

  function assignPendingMedia(index: number, routePointDraftId: string | null) {
    setMediaFiles((current) => current.map((candidate, candidateIndex) => (
      candidateIndex === index ? { ...candidate, routePointDraftId } : candidate
    )));
    setMobileMediaAssignmentIndex(null);
    setMobileMediaMenuIndex(null);
  }

  function movePendingMedia(index: number, direction: -1 | 1) {
    setMediaFiles((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setMobileMediaMenuIndex(null);
  }

  function removePendingMedia(index: number) {
    setMediaFiles((current) => current.filter((_, candidate) => candidate !== index));
    setMobileMediaDeleteIndex(null);
    setMobileMediaMenuIndex(null);
    setMobileMediaAssignmentIndex(null);
  }

  function removeDraftPoint(draftPointId: string) {
    const resetsMediaScope = mediaFiles.some(
      (media) => media.routePointDraftId === draftPointId,
    );
    const removesActiveReverseLookup = activeReverseGeocodeDraftIdRef.current === draftPointId;
    if (removesActiveReverseLookup) {
      // The shared geocode status belongs to this point. Invalidate the pending
      // lookup before removing the draft so a late response cannot restore its
      // message/attribution, and never leave the Composer stuck on "正在识别…".
      reverseGeocodeRevisionRef.current += 1;
      activeReverseGeocodeDraftIdRef.current = null;
      setReverseAttribution(null);
    }
    setRoutePoints((current) => {
      const next = removeRoutePoint(current, draftPointId);
      routePointsRef.current = next;
      return next;
    });
    setMediaFiles((current) => clearRemovedMediaTarget(current, draftPointId));
    if (resetsMediaScope) {
      setMessage("已删除该途径点；关联媒体已改为整段旅程。");
    } else if (removesActiveReverseLookup) {
      setMessage("");
    }
  }

  function toggleRoutePointExpanded(draftPointId: string) {
    setRoutePointMenuDraftId(null);
    setExpandedRoutePointDraftId((current) => {
      const next = current === draftPointId ? null : draftPointId;
      if (next) pendingRoutePointScrollDraftIdRef.current = next;
      return next;
    });
  }

  function moveDraftPointRow(draftPointId: string, direction: -1 | 1) {
    pendingRoutePointFocusDraftIdRef.current = draftPointId;
    pendingRoutePointScrollDraftIdRef.current = draftPointId;
    setRoutePointMenuDraftId(null);
    setRoutePoints((current) => {
      const next = moveRoutePoint(current, draftPointId, direction);
      routePointsRef.current = next;
      return next;
    });
  }

  function closeRoutePointMenu(draftPointId: string) {
    pendingRoutePointMenuFocusDraftIdRef.current = draftPointId;
    setRoutePointMenuDraftId(null);
  }

  function removeDraftPointFromMenu(draftPointId: string) {
    const focusTarget = routePointFocusAfterRemoval(routePointsRef.current, draftPointId);
    setRoutePointMenuDraftId(null);
    setExpandedRoutePointDraftId((current) => current === draftPointId ? focusTarget : current);
    if (focusTarget) {
      pendingRoutePointFocusDraftIdRef.current = focusTarget;
      pendingRoutePointScrollDraftIdRef.current = focusTarget;
    }
    removeDraftPoint(draftPointId);
  }

  function routePointMediaAssociation(point: RouteDraftPoint) {
    const pending = mediaFiles.filter((media) => media.routePointDraftId === point.draftId);
    const persisted = point.id && journey
      ? journeyVisualMedia(journey).filter((media) => media.routePointId === point.id)
      : [];
    const names = [
      ...persisted.map((media) => media.fileName),
      ...pending.map((media) => media.file.name),
    ];
    if (names.length === 0) {
      return { count: 0, label: "暂无媒体归属此地点" };
    }
    const preview = names.slice(0, 2).join("、");
    const remainder = names.length > 2 ? ` 等 ${names.length} 个` : "";
    return { count: names.length, label: `${preview}${remainder}` };
  }

  async function applySavedResult(
    result: JourneySaveResult,
    callbackScope: JourneySaveCallbackScope,
    options: { resolveRetryAssignments?: boolean } = {},
  ) {
    const shouldResolveRetryAssignments = options.resolveRetryAssignments ?? true;
    const resolvedAssignments = shouldResolveRetryAssignments
      ? resolvePendingMediaUploads(mediaFiles, routePoints, result.journey)
      : [];
    setUnknownCreateAttempt(null);
    setSavedResult(result);
    setRetryAssignments(shouldResolveRetryAssignments
      ? result.mediaErrors.map((error) => resolvedAssignments[error.fileIndex])
      : []);
    try {
      await onSaved(result, callbackScope);
    } catch {
      setMessage("旅程已经保存，但 Atlas 暂时没有刷新成功；重新打开后会从服务器恢复。");
      return;
    }
    if (result.mediaErrors.length === 0) closeComposerWithUnknownCreateAttempt(null);
  }

  async function applyPersistedMediaContinuationFailure(
    error: JourneyMediaContinuationError,
    callbackScope: JourneySaveCallbackScope,
  ) {
    const result: JourneySaveResult = {
      journey: error.journey,
      uploadedCount: 0,
      mediaErrors: mediaFiles.map((media, fileIndex) => ({
        fileIndex,
        fileName: media.file.name,
        message: error.message,
      })),
    };
    await applySavedResult(result, callbackScope, { resolveRetryAssignments: false });
    setMessage("Journey 已保存，但媒体归属暂时无法安全确认。请完成后重新打开这段 Journey，再添加这些媒体；不会再次创建 Journey。");
  }

  async function recoverUnknownCreate(
    submittedDraft: JourneyInput,
    knownJourneyIdsBeforeCreate: readonly string[],
  ) {
    let recovery;
    try {
      recovery = await reconcileUnknownJourneyCreate(
        submittedDraft,
        listJourneys,
        new Set(knownJourneyIdsBeforeCreate),
      );
    } catch {
      setUnknownCreateAttempt({
        input: submittedDraft,
        knownJourneyIdsBeforeCreate: [...knownJourneyIdsBeforeCreate],
        mode: "recheck",
        routePoints: routePoints.map((point) => ({ ...point })),
        mediaFiles: mediaFiles.map((media) => ({ ...media })),
      });
      setMessage(unknownCreateRecheckMessage(mediaFiles.length > 0));
      return;
    }

    if (recovery.status === "not-persisted") {
      setUnknownCreateAttempt(null);
      setMessage("已确认这段旅程没有保存到 Atlas；你可以重新提交一次。");
      return;
    }

    if (recovery.status === "confirmation-required") {
      setUnknownCreateAttempt({
        input: submittedDraft,
        knownJourneyIdsBeforeCreate: [...knownJourneyIdsBeforeCreate],
        mode: "confirmation-required",
        routePoints: routePoints.map((point) => ({ ...point })),
        mediaFiles: mediaFiles.map((media) => ({ ...media })),
      });
      setMessage(confirmationRequiredUnknownCreateMessage(mediaFiles.length > 0));
      return;
    }

    setUnknownCreateAttempt({
      input: submittedDraft,
      knownJourneyIdsBeforeCreate: [...knownJourneyIdsBeforeCreate],
      mode: "ambiguous",
      routePoints: routePoints.map((point) => ({ ...point })),
      mediaFiles: mediaFiles.map((media) => ({ ...media })),
    });
    setMessage(ambiguousUnknownCreateMessage(mediaFiles.length > 0));
  }

  async function save() {
    const submittedInput = unknownCreateAttempt?.input ?? input;
    const validation = validateJourneyInput(submittedInput);
    const mediaValidation = validateJourneyFiles(mediaFiles.map((media) => media.file));
    const error = validation.errors[0] ?? mediaValidation.errors[0];
    if (error) {
      setMessage(error);
      return;
    }

    let knownJourneyIdsBeforeCreate = unknownCreateAttempt?.knownJourneyIdsBeforeCreate ?? [];
    setSaving(true);
    setMessage("");
    setProgress(null);
    try {
      if (!journey && unknownCreateAttempt) {
        if (unknownCreateAttempt.mode === "ambiguous") {
          setMessage(ambiguousUnknownCreateMessage(mediaFiles.length > 0));
          return;
        }
        if (unknownCreateAttempt.mode === "confirmation-required") {
          setMessage(confirmationRequiredUnknownCreateMessage(mediaFiles.length > 0));
          return;
        }
        await recoverUnknownCreate(
          unknownCreateAttempt.input,
          unknownCreateAttempt.knownJourneyIdsBeforeCreate,
        );
        return;
      }

      if (!journey) {
        try {
          knownJourneyIdsBeforeCreate = (await listJourneys()).map((candidate) => candidate.id);
        } catch {
          setMessage("暂时无法核对 Atlas 中已有的 Journey，因此这次没有提交。请稍后再试。");
          return;
        }
      }

      const result = await persistJourneyDraft({
        input: submittedInput,
        mediaFiles,
        routePoints,
        persist: journey
          ? (nextInput) => updateJourney(journey.id, nextInput)
          : createJourney,
        onProgress: setProgress,
      });
      await applySavedResult(result, "initial-save");
    } catch (errorValue) {
      if (errorValue instanceof JourneyMediaContinuationError) {
        await applyPersistedMediaContinuationFailure(errorValue, "initial-save");
      } else {
        const createOutcomeMayBeUnknown = !journey && (
          !(errorValue instanceof JourneyApiError)
          || errorValue.status >= 500
        );
        if (createOutcomeMayBeUnknown) {
          await recoverUnknownCreate(submittedInput, knownJourneyIdsBeforeCreate);
        } else {
          setMessage(errorValue instanceof Error ? errorValue.message : "旅程保存失败");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryFailedMedia() {
    if (!savedResult || retryAssignments.length === 0) return;
    setSaving(true);
    setMessage("");
    setProgress(null);
    try {
      const retried = await uploadJourneyMediaAssignments({
        journeyId: savedResult.journey.id,
        assignments: retryAssignments,
        onProgress: setProgress,
      });
      const nextResult: JourneySaveResult = {
        journey: savedResult.journey,
        uploadedCount: savedResult.uploadedCount + retried.uploadedCount,
        mediaErrors: retried.mediaErrors,
      };
      setSavedResult(nextResult);
      setRetryAssignments(
        retried.mediaErrors.map((error) => retryAssignments[error.fileIndex]),
      );
      await onSaved(nextResult, "media-retry");
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
  const editorLocked = saving || savedResult !== null || unknownCreateAttempt !== null;
  const mobileMenuMedia = mobileMediaMenuIndex === null ? null : mediaFiles[mobileMediaMenuIndex] ?? null;
  const mobileAssignmentMedia = mobileMediaAssignmentIndex === null ? null : mediaFiles[mobileMediaAssignmentIndex] ?? null;
  const mobileDeleteMedia = mobileMediaDeleteIndex === null ? null : mediaFiles[mobileMediaDeleteIndex] ?? null;


  const mediaHeadingFragment = (
              <div className="journey-composer__section-heading">
                <p>01 · MEMORY</p>
                <h3>照片与影像</h3>
                <span>可选，旅程会先保存，媒体按文件分块上传。</span>
              </div>
  );
  const mediaFieldsFragment = (
              <div className="journey-media-fields">
                <label className="journey-media-picker">
                  <IconUpload size={26} stroke={1.2} aria-hidden="true" />
                  <span>添加照片或视频</span>
                  <strong>{existingVisualMediaCount ? `${existingVisualMediaCount} 个已有媒体 · 可继续添加` : "支持照片与视频，可持续添加"}</strong>
                  <input type="file" accept={MEDIA_FILE_ACCEPT} multiple onChange={(event) => selectFiles(event)} />
                </label>
                {!mobileLayout ? (
                  <ul>
                    {mediaFiles.map((media, index) => (
                      <li key={`${media.file.name}-${media.file.lastModified}-${index}`}>
                        <span>{media.file.name}<small>{formatBytes(media.file.size)}</small></span>
                        <select
                          aria-label={`${media.file.name} 的媒体归属`}
                          value={media.routePointDraftId ?? ""}
                          onChange={(event) => assignPendingMedia(index, event.target.value || null)}
                        >
                          <option value="">整段旅程</option>
                          {routePoints.map((point, pointIndex) => (
                            <option key={point.draftId} value={point.draftId}>
                              {String(pointIndex + 1).padStart(2, "0")} · {point.label || `途径点 ${pointIndex + 1}`}
                            </option>
                          ))}
                        </select>
                        <div className="journey-media-fields__actions">
                          <IconActionButton
                            type="button"
                            label={`移除媒体 ${media.file.name}`}
                            tooltip="移除媒体"
                            className="is-destructive-secondary"
                            onClick={() => removePendingMedia(index)}
                          >
                            <IconTrash size={16} stroke={1.4} aria-hidden="true" />
                          </IconActionButton>
                          {isEditing ? (
                            <>
                              <IconActionButton
                                type="button"
                                label={`向前调整 ${media.file.name} 的排序`}
                                tooltip="上移媒体"
                                disabled={index === 0}
                                onClick={() => movePendingMedia(index, -1)}
                              >
                                <IconArrowUp size={16} stroke={1.4} aria-hidden="true" />
                              </IconActionButton>
                              <IconActionButton
                                type="button"
                                label={`向后调整 ${media.file.name} 的排序`}
                                tooltip="下移媒体"
                                disabled={index === mediaFiles.length - 1}
                                onClick={() => movePendingMedia(index, 1)}
                              >
                                <IconArrowDown size={16} stroke={1.4} aria-hidden="true" />
                              </IconActionButton>
                            </>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="journey-media-fields__mobile-list">
                    {mediaFiles.map((media, index) => (
                      <li className="journey-media-mobile-card" key={`${media.file.name}-${media.file.lastModified}-${index}`}>
                        <span className="journey-media-mobile-card__file">
                          {media.file.name}
                          <small>{formatBytes(media.file.size)}</small>
                        </span>
                        <button
                          type="button"
                          className="journey-media-mobile-card__assignment"
                          aria-label={`${media.file.name} 的媒体归属：${mediaAssignmentLabel(media)}`}
                          onClick={() => {
                            setMobileMediaMenuIndex(null);
                            setMobileMediaAssignmentIndex(index);
                          }}
                        >
                          <IconMapPin size={14} stroke={1.35} aria-hidden="true" />
                          <span>{mediaAssignmentLabel(media)}</span>
                        </button>
                        <IconActionButton
                          type="button"
                          className="journey-media-mobile-card__menu"
                          label={`管理媒体 ${media.file.name}`}
                          tooltip="管理媒体"
                          aria-expanded={mobileMediaMenuIndex === index}
                          onClick={() => {
                            setMobileMediaAssignmentIndex(null);
                            setMobileMediaDeleteIndex(null);
                            setMobileMediaMenuIndex((current) => current === index ? null : index);
                          }}
                        >
                          <IconDots size={19} stroke={1.45} aria-hidden="true" />
                        </IconActionButton>
                      </li>
                    ))}
                  </ul>
                )}
                {mobileLayout && mobileMenuMedia && mobileMediaMenuIndex !== null ? (
                  <div className="journey-media-mobile-sheet-layer">
                    <button type="button" className="journey-media-mobile-sheet__backdrop" aria-label="关闭媒体管理" onClick={() => setMobileMediaMenuIndex(null)} />
                    <section ref={mobileMediaSheetRef} tabIndex={-1} data-focus-trap-exempt="true" className="journey-media-mobile-sheet" role="dialog" aria-modal="true" aria-label={`管理媒体 ${mobileMenuMedia.file.name}`}>
                      <div className="journey-media-mobile-sheet__heading">
                        <small>媒体管理</small>
                        <strong>{mobileMenuMedia.file.name}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMediaAssignmentIndex(mobileMediaMenuIndex);
                          setMobileMediaMenuIndex(null);
                        }}
                      >
                        <IconMapPin size={18} stroke={1.35} aria-hidden="true" />
                        调整归属
                      </button>
                      {isEditing && mediaFiles.length > 1 ? (
                        <div className="journey-media-mobile-sheet__order" role="group" aria-label="调整待上传媒体顺序">
                          <button type="button" disabled={mobileMediaMenuIndex === 0} onClick={() => movePendingMedia(mobileMediaMenuIndex, -1)}>
                            <IconArrowUp size={18} stroke={1.35} aria-hidden="true" />
                            前移一位
                          </button>
                          <button type="button" disabled={mobileMediaMenuIndex === mediaFiles.length - 1} onClick={() => movePendingMedia(mobileMediaMenuIndex, 1)}>
                            <IconArrowDown size={18} stroke={1.35} aria-hidden="true" />
                            后移一位
                          </button>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="is-destructive"
                        onClick={() => {
                          setMobileMediaDeleteIndex(mobileMediaMenuIndex);
                          setMobileMediaMenuIndex(null);
                        }}
                      >
                        <IconTrash size={18} stroke={1.35} aria-hidden="true" />
                        移除媒体
                      </button>
                    </section>
                  </div>
                ) : null}
                {mobileLayout && mobileAssignmentMedia && mobileMediaAssignmentIndex !== null ? (
                  <div className="journey-media-mobile-sheet-layer">
                    <button type="button" className="journey-media-mobile-sheet__backdrop" aria-label="关闭媒体归属选择" onClick={() => setMobileMediaAssignmentIndex(null)} />
                    <section ref={mobileMediaSheetRef} tabIndex={-1} data-focus-trap-exempt="true" className="journey-media-mobile-sheet is-assignment" role="dialog" aria-modal="true" aria-label={`${mobileAssignmentMedia.file.name} 的媒体归属`}>
                      <div className="journey-media-mobile-sheet__heading">
                        <small>媒体归属</small>
                        <strong>{mobileAssignmentMedia.file.name}</strong>
                      </div>
                      <button
                        type="button"
                        className={!mobileAssignmentMedia.routePointDraftId ? "is-current" : ""}
                        aria-pressed={!mobileAssignmentMedia.routePointDraftId}
                        onClick={() => assignPendingMedia(mobileMediaAssignmentIndex, null)}
                      >
                        <IconMapPin size={18} stroke={1.35} aria-hidden="true" />
                        整段旅程
                      </button>
                      {routePoints.map((point, pointIndex) => (
                        <button
                          type="button"
                          key={point.draftId}
                          className={mobileAssignmentMedia.routePointDraftId === point.draftId ? "is-current" : ""}
                          aria-pressed={mobileAssignmentMedia.routePointDraftId === point.draftId}
                          onClick={() => assignPendingMedia(mobileMediaAssignmentIndex, point.draftId)}
                        >
                          <IconMapPin size={18} stroke={1.35} aria-hidden="true" />
                          {String(pointIndex + 1).padStart(2, "0")} · {point.label || `途径点 ${pointIndex + 1}`}
                        </button>
                      ))}
                    </section>
                  </div>
                ) : null}
                {mobileLayout && mobileDeleteMedia && mobileMediaDeleteIndex !== null ? (
                  <div className="journey-media-mobile-sheet-layer">
                    <button type="button" className="journey-media-mobile-sheet__backdrop" aria-label="取消移除媒体" onClick={() => setMobileMediaDeleteIndex(null)} />
                    <section ref={mobileMediaSheetRef} tabIndex={-1} data-focus-trap-exempt="true" className="journey-media-mobile-sheet is-confirming" role="alertdialog" aria-modal="true" aria-label={`确认移除媒体 ${mobileDeleteMedia.file.name}`}>
                      <div className="journey-media-mobile-sheet__heading">
                        <small>移除媒体</small>
                        <strong>确定移除 {mobileDeleteMedia.file.name}？</strong>
                      </div>
                      <p>它只会从这次待上传列表中移除，不会由滑动手势直接触发。</p>
                      <div className="journey-media-mobile-sheet__confirm-actions">
                        <button type="button" onClick={() => setMobileMediaDeleteIndex(null)}>取消</button>
                        <button type="button" className="is-destructive" onClick={() => removePendingMedia(mobileMediaDeleteIndex)}>确认移除</button>
                      </div>
                    </section>
                  </div>
                ) : null}
                {mediaFiles.length > 0 ? (
                  <p>{mobileLayout ? "点按归属标签可调整；其他操作收在媒体管理中。" : "每个文件都可以归到整段旅程，或一个具体途径点。"}</p>
                ) : null}
              </div>
  );
  const journeyHeadingFragment = (
              <div className="journey-composer__section-heading journey-composer__story-heading">
                {mobileLayout ? null : <p>02 · JOURNEY</p>}
                <h3 id="journey-story-heading">这段旅程</h3>
              </div>
  );
  const journeyTitleFragment = (
                <label className="journey-title-field"><span>旅程标题</span><input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="穿过北方的夜车" /></label>
  );
  const journeyMetaFragment = (
    <>
                <div className="journey-story-fields__dates">
                  <label><span>开始日期</span><input type="date" required value={startedOn} onChange={(event) => setStartedOn(event.target.value)} /></label>
                  <label><span>结束日期 <small>可选</small></span><input type="date" min={startedOn} value={endedOn} onChange={(event) => setEndedOn(event.target.value)} /></label>
                </div>
                <label><span>旅程故事 <small>可选</small></span><textarea rows={5} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记下沿途发生了什么，也可以留白。" /></label>
    </>
  );
  const appearanceFragment = (
    <>
                <fieldset className="journey-light-colors">
                  <legend>这段旅程的光 · 单色基调</legend>
                  <div className="journey-light-color-list">
                    {LIGHT_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={lightColor === color ? "is-selected" : ""}
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          setLightColor(color);
                          setLightEffect(null);
                        }}
                        aria-label={`选择单色 ${color}`}
                        aria-pressed={lightColor === color}
                      />
                    ))}
                  </div>
                </fieldset>
                <fieldset className="journey-light-effects">
                  <legend>多色特效</legend>
                  <div
                    className="journey-light-effect-preview"
                    style={{
                      "--journey-light-gradient": activeLightGradient,
                      "--journey-light-color": safeLightColor,
                    } as CSSProperties}
                  >
                    <span className="journey-light-effect-preview__orb" aria-hidden="true" />
                    <span className="journey-light-effect-preview__copy">
                      <strong>{activeLightEffect?.label ?? "单色"}</strong>
                    </span>
                    <span className="journey-light-effect-preview__caption">旅程的光</span>
                  </div>
                  <div className="journey-light-effect-list" role="group" aria-label="选择多色特效">
                    {LIGHT_EFFECTS.map((effect) => (
                      <button
                        key={effect.id}
                        type="button"
                        className={lightEffect === effect.id ? "is-selected" : ""}
                        style={{
                          "--journey-light-gradient": getLightEffectGradient(effect.id, safeLightColor),
                          "--journey-light-color": safeLightColor,
                        } as CSSProperties}
                        onClick={() => {
                          setLightEffect(effect.id);
                        }}
                        aria-label={`选择${effect.label}特效`}
                        aria-pressed={lightEffect === effect.id}
                      >
                        <span className="journey-light-effect__orb" aria-hidden="true" />
                        <span className="journey-light-effect__copy">
                          <strong>{effect.label}</strong>
                        </span>
                      </button>
                    ))}
                  </div>
                </fieldset>
    </>
  );
  const routeHeadingFragment = (
              <div className="journey-composer__section-heading">
                {mobileLayout ? null : <p>03 · TRACE</p>}
                <h3 id="journey-route-heading">在地图上留下它</h3>
                {mobileLayout ? null : <span>一个地点就是一次停留；继续添加会自然连成路径。</span>}
              </div>
  );
  const routeSearchFragment = (
    <>
                <form onSubmit={runSearch} className="journey-location-search">
                  <label>
                    <span>搜索本旅程或外部地点</span>
                    <input
                      value={searchQuery}
                      onChange={(event) => changeSearchQuery(event.target.value)}
                      maxLength={120}
                      placeholder="建筑、景点、街道、街区或城市"
                    />
                  </label>
                  <button type="submit" disabled={searchPending}>
                    <IconSearch size={16} stroke={1.4} aria-hidden="true" />
                    {searchPending ? "搜索中…" : "搜索"}
                  </button>
                </form>
                {existingSearchMatches.length > 0 ? (
                  <section className="journey-location-result-group" data-qa-composer-existing-results aria-label="本旅程已有地点">
                    <div className="journey-location-result-group__heading">
                      <strong>本旅程已有地点</strong>
                      <small>定位，不会新增</small>
                    </div>
                    <ul className="journey-location-results">
                      {existingSearchMatches.map(({ point, routeIndex }) => {
                        const displayLabel = point.label.trim() || `途径点 ${routeIndex + 1}`;
                        const mediaAssociation = routePointMediaAssociation(point);
                        return (
                          <li key={point.draftId} data-existing-route-point-draft-id={point.draftId}>
                            <button
                              type="button"
                              aria-label={`定位 ${String(routeIndex + 1).padStart(2, "0")} · ${displayLabel}`}
                              onClick={() => locateExistingRoutePoint(point.draftId)}
                            >
                              <span className="journey-location-result-copy">
                                <strong>{displayLabel}</strong>
                                <small>{String(routeIndex + 1).padStart(2, "0")} · {point.isStop ? "停靠" : "途径"} · {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</small>
                                <span>{point.note?.trim() || mediaAssociation.label}</span>
                              </span>
                              <span className="journey-location-result-action">定位</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
                {searchResults.length > 0 ? (
                  <section className="journey-location-result-group" data-qa-composer-external-results aria-label="外部地点">
                    <div className="journey-location-result-group__heading">
                      <strong>外部地点</strong>
                      <small>添加为新的 Route Point</small>
                    </div>
                    <ul className="journey-location-results">
                      {searchResults.map((result) => (
                        <li key={result.id} data-location-result-id={result.id}>
                          <button
                            type="button"
                            aria-label={`添加 ${result.label}${[result.context, result.countryCode].filter(Boolean).length ? ` · ${[result.context, result.countryCode].filter(Boolean).join(" · ")}` : ""}`}
                            onClick={() => addSearchResult(result)}
                          >
                            <span className="journey-location-result-copy">
                              <strong>{result.label}</strong>
                              {[result.labelLocal, result.labelEnglish]
                                .filter((label, index, labels) => Boolean(label) && label !== result.label && labels.indexOf(label) === index)
                                .map((label) => <small key={label}>{label}</small>)}
                              <span>{[result.context, result.countryCode].filter(Boolean).join(" · ")}</span>
                            </span>
                            <span className="journey-location-result-action">添加</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {searchAttribution ? (
                      <a className="journey-location-attribution" href={searchAttribution.url} target="_blank" rel="noreferrer">
                        地点数据 {searchAttribution.label}
                      </a>
                    ) : null}
                  </section>
                ) : null}
    </>
  );
  const globePickFragment = (
    <>
                {onGlobePickRequest ? <button ref={globePickTriggerRef} className="journey-globe-pick-button" type="button" onClick={requestGlobePoint}><IconMapPin size={17} stroke={1.35} aria-hidden="true" /><span><strong>直接在地球上取点</strong><small>适合在路上、海上或没有准确名称的位置</small></span></button> : null}
    </>
  );
  const reverseAttributionFragment = (
    <>
                {reverseAttribution ? (
                  <a className="journey-location-attribution" href={reverseAttribution.url} target="_blank" rel="noreferrer">
                    地点数据 {reverseAttribution.label}
                  </a>
                ) : null}
    </>
  );
  const routeListFragment = (
              <ol className="journey-route-draft" aria-label="已添加的地点">
                {routePoints.length === 0 ? <li className="is-empty"><IconMapPin size={22} stroke={1.15} aria-hidden="true" /><span>还没有地点</span><small>先搜索一个地点，或直接在地球上取点。</small></li> : null}
                {routePoints.map((point, index) => {
                  const expanded = expandedRoutePointDraftId === point.draftId;
                  const menuOpen = routePointMenuDraftId === point.draftId;
                  const displayLabel = point.label.trim() || `途径点 ${index + 1}`;
                  const mediaAssociation = routePointMediaAssociation(point);
                  const editorId = `journey-route-point-${point.draftId}-editor`;
                  const menuId = `journey-route-point-${point.draftId}-menu`;
                  return (
                    <li
                      key={point.draftId}
                      ref={(node) => {
                        if (node) routePointRowRefs.current.set(point.draftId, node);
                        else routePointRowRefs.current.delete(point.draftId);
                      }}
                      className={expanded ? "is-expanded" : undefined}
                      data-route-point-draft-id={point.draftId}
                      data-route-point-position={index + 1}
                      data-route-point-latitude={point.latitude}
                      data-route-point-longitude={point.longitude}
                      data-route-point-expanded={expanded ? "true" : "false"}
                    >
                      <span className="journey-route-draft__index">{String(index + 1).padStart(2, "0")}</span>
                      <button
                        type="button"
                        className="journey-route-draft__summary"
                        ref={(node) => {
                          if (node) routePointTriggerRefs.current.set(point.draftId, node);
                          else routePointTriggerRefs.current.delete(point.draftId);
                        }}
                        aria-expanded={expanded}
                        aria-controls={editorId}
                        onClick={() => toggleRoutePointExpanded(point.draftId)}
                      >
                        <span>
                          <strong>{displayLabel}</strong>
                          <small>{point.isStop ? "停靠" : "途径"} · {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</small>
                        </span>
                        <IconChevronDown className="journey-route-draft__summary-chevron" size={17} stroke={1.35} aria-hidden="true" />
                      </button>
                      <div className="journey-route-draft__actions" role="group" aria-label={`${displayLabel} 排序和更多操作`}>
                        <IconActionButton type="button" disabled={index === 0} onClick={() => moveDraftPointRow(point.draftId, -1)} label={`向前移动 ${displayLabel}`} tooltip="上移地点"><IconArrowUp size={16} stroke={1.4} aria-hidden="true" /></IconActionButton>
                        <IconActionButton type="button" disabled={index === routePoints.length - 1} onClick={() => moveDraftPointRow(point.draftId, 1)} label={`向后移动 ${displayLabel}`} tooltip="下移地点"><IconArrowDown size={16} stroke={1.4} aria-hidden="true" /></IconActionButton>
                        <IconActionButton
                          type="button"
                          buttonRef={(node) => {
                            if (node) routePointMenuTriggerRefs.current.set(point.draftId, node);
                            else routePointMenuTriggerRefs.current.delete(point.draftId);
                          }}
                          label={`更多操作 ${displayLabel}`}
                          tooltip="更多操作"
                          aria-expanded={menuOpen}
                          aria-controls={menuId}
                          onClick={() => setRoutePointMenuDraftId((current) => current === point.draftId ? null : point.draftId)}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape" || !menuOpen) return;
                            event.preventDefault();
                            closeRoutePointMenu(point.draftId);
                          }}
                        >
                          <IconDots size={18} stroke={1.45} aria-hidden="true" />
                        </IconActionButton>
                      </div>
                      {menuOpen ? (
                        <div
                          id={menuId}
                          className="journey-route-draft__menu"
                          role="menu"
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            event.preventDefault();
                            closeRoutePointMenu(point.draftId);
                          }}
                        >
                          <button type="button" role="menuitem" className="is-destructive-secondary" onClick={() => removeDraftPointFromMenu(point.draftId)}>
                            <IconTrash size={16} stroke={1.4} aria-hidden="true" />
                            删除地点
                          </button>
                        </div>
                      ) : null}
                      {expanded ? (
                        <div id={editorId} className="journey-route-draft__expanded">
                          <label>
                            <span>地点名称</span>
                            <input
                              aria-label={`${displayLabel} 名称`}
                              maxLength={120}
                              placeholder="地点名称（可精确到建筑或景点）"
                              value={point.label}
                              onChange={(event) => setRoutePoints((current) => updateRoutePoint(current, point.draftId, { label: event.target.value }))}
                            />
                          </label>
                          <div className="journey-route-draft__coordinates" aria-label={`${displayLabel} 规范坐标`}>
                            <span>规范坐标</span>
                            <code>{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</code>
                          </div>
                          <label className="journey-route-draft__note">
                            <span>这一站想记住什么？<small>可选</small></span>
                            <textarea
                              rows={2}
                              maxLength={500}
                              value={point.note ?? ""}
                              placeholder="写下一句当时的心情、发生的小事，或以后看到这里时想起的话…"
                              onChange={(event) => setRoutePoints((current) => updateRoutePoint(current, point.draftId, { note: event.target.value }))}
                            />
                          </label>
                          <label className="journey-checkbox"><input type="checkbox" checked={point.isStop} onChange={() => setRoutePoints((current) => toggleRouteStop(current, point.draftId))} />停靠</label>
                          <div className="journey-route-draft__media-association" data-route-point-media-count={mediaAssociation.count}>
                            <span>媒体归属</span>
                            <small>{mediaAssociation.label}</small>
                          </div>
                          {mobileLayout ? (
                            <label className="journey-route-draft__media-upload">
                              <IconUpload size={17} stroke={1.35} aria-hidden="true" />
                              <span>为这一站添加照片或视频</span>
                              <input
                                type="file"
                                aria-label={`为 ${displayLabel} 添加照片或视频`}
                                accept={MEDIA_FILE_ACCEPT}
                                multiple
                                onChange={(event) => selectFiles(event, point.draftId)}
                              />
                            </label>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
  );
  const preciseLocationFragment = (
              <details className="journey-precise-location" open={mobileLayout || undefined}>
                <summary><span><IconMapPin size={17} stroke={1.35} aria-hidden="true" />精确位置</span><small>手动输入经纬度</small><IconChevronDown className="journey-precise-location__chevron" size={17} stroke={1.35} aria-hidden="true" /></summary>
                <div className="journey-coordinate-fields">
                  <label className="journey-coordinate-fields__label"><span>地点名称</span><input maxLength={120} value={pointLabel} onChange={(event) => setPointLabel(event.target.value)} placeholder="可精确到建筑、景点或沿途位置" /></label>
                  <label><span>纬度</span><input inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="31.2304" /></label>
                  <label><span>经度</span><input inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="121.4737" /></label>
                  <label className="journey-checkbox"><input type="checkbox" checked={pointIsStop} onChange={(event) => setPointIsStop(event.target.checked)} />这是一个停留地点</label>
                  <button type="button" onClick={addManualPoint}><IconPlus size={16} stroke={1.4} aria-hidden="true" />添加精确位置</button>
                </div>
              </details>
  );
  return (
    <div className={`journey-composer-backdrop${globePicking ? " is-globe-picking" : ""}${playbackPreviewActive ? " is-playback-previewing" : ""}`} role="presentation">
      {globePicking ? (
        <aside className="journey-globe-pick-hint" role="status">
          <IconMapPin size={18} stroke={1.4} aria-hidden="true" />
          <div><strong>在地球上选择路线点</strong><span>点击球面；路线会按添加顺序连接。</span></div>
          <button ref={globePickCancelRef} type="button" onClick={cancelGlobePoint}><IconX size={18} stroke={1.4} aria-hidden="true" /><span>取消</span></button>
        </aside>
      ) : null}
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="journey-composer motion-staged"
        data-mobile-layout={mobileLayout ? "true" : undefined}
        data-playback-preview-active={playbackPreviewActive ? "true" : undefined}
        data-playback-preview-return-focus={playbackPreviewReturnFocusKind ?? undefined}
        data-playback-preview-return-focus-outcome={playbackPreviewReturnFocusOutcome ?? undefined}
        inert={globePicking || playbackPreviewActive || undefined}
        role="dialog"
        aria-hidden={playbackPreviewActive || undefined}
        aria-modal={playbackPreviewActive ? undefined : true}
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
            data-composer-scroll-owner={mobileLayout ? "editor" : undefined}
            aria-disabled={editorLocked}
            inert={editorLocked}
            onFocusCapture={(event) => {
              if (event.target instanceof HTMLElement) lastEditorFocusRef.current = event.target;
            }}
          >
            {mobileLayout ? (
              /*
               * #375: on compact mobile the Composer is one task at a time. The
               * primary task carries the Journey title, the Route Point list,
               * add/search and the sticky save; everything else is entered from
               * here and returns here. `composerMobileTasks.ts` is the map, and
               * its test is what keeps a capability from being merely hidden.
               */
              activeMobileTask === "primary" ? (
                <section
                  className="journey-composer__task"
                  data-composer-task="primary"
                  aria-labelledby="journey-story-heading"
                >
                  {journeyHeadingFragment}
                  <div className="journey-story-fields">
                    {journeyTitleFragment}
                  </div>
                  <nav className="journey-composer__task-entries" aria-label="旅程编辑任务">
                    {COMPOSER_MOBILE_TASKS.filter((task) => task.id !== "primary" && !task.behindMore).map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        data-composer-task-entry={task.id}
                        ref={(node) => {
                          if (node) taskEntryRefs.current.set(task.id, node);
                          else taskEntryRefs.current.delete(task.id);
                        }}
                        onClick={() => enterMobileTask(task.id)}
                      >
                        <span>{task.entryLabel}</span>
                        <small>{composerTaskSummary(task.id)}</small>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="journey-composer__task-more"
                      data-composer-task-entry="more"
                      ref={(node) => {
                        if (node) taskEntryRefs.current.set("more", node);
                        else taskEntryRefs.current.delete("more");
                      }}
                      aria-expanded={moreMenuOpen}
                      aria-controls="journey-composer-more-menu"
                      onClick={() => setMoreMenuOpen((current) => !current)}
                    >
                      <IconDots size={18} stroke={1.45} aria-hidden="true" />
                      <span>更多</span>
                    </button>
                    {moreMenuOpen ? (
                      <div id="journey-composer-more-menu" className="journey-composer__more-menu" role="menu">
                        {COMPOSER_MOBILE_TASKS.filter((task) => task.behindMore).map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            role="menuitem"
                            data-composer-task-entry={task.id}
                            ref={(node) => {
                              if (node) taskEntryRefs.current.set(task.id, node);
                              else taskEntryRefs.current.delete(task.id);
                            }}
                            onClick={() => enterMobileTask(task.id)}
                          >
                            <span>{task.entryLabel}</span>
                            <small>{composerTaskSummary(task.id)}</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </nav>
                  {routeHeadingFragment}
                  <div className="journey-composer__route-tools">
                    {routeSearchFragment}
                    {reverseAttributionFragment}
                  </div>
                  {routeListFragment}
                </section>
              ) : (
                <section
                  className="journey-composer__task"
                  data-composer-task={activeMobileTask}
                  aria-labelledby={`journey-composer-task-${activeMobileTask}`}
                >
                  <div className="journey-composer__task-header">
                    <button
                      type="button"
                      className="journey-composer__task-back"
                      data-composer-task-back={activeMobileTask}
                      onClick={exitMobileTask}
                    >
                      <IconChevronLeft size={18} stroke={1.4} aria-hidden="true" />
                      <span>{composerTask("primary").entryLabel}</span>
                    </button>
                    <h3 id={`journey-composer-task-${activeMobileTask}`} ref={taskHeadingRef} tabIndex={-1}>
                      {composerTask(activeMobileTask).heading}
                    </h3>
                  </div>
                  {activeMobileTask === "journey-info" ? (
                    <div className="journey-story-fields">{journeyMetaFragment}</div>
                  ) : null}
                  {activeMobileTask === "media" ? mediaFieldsFragment : null}
                  {activeMobileTask === "appearance" ? (
                    <div className="journey-story-fields">{appearanceFragment}</div>
                  ) : null}
                  {activeMobileTask === "location" ? (
                    <div className="journey-composer__route-tools">
                      {globePickFragment}
                      {preciseLocationFragment}
                    </div>
                  ) : null}
                </section>
              )
            ) : (
              <>
                <section ref={narrativeScrollRef} className="journey-composer__narrative" aria-labelledby="journey-story-heading">
                  {mediaHeadingFragment}
                  {mediaFieldsFragment}
                  {journeyHeadingFragment}
                  <div className="journey-story-fields">
                    {journeyTitleFragment}
                    {journeyMetaFragment}
                    {appearanceFragment}
                  </div>
                </section>

                <section ref={routeScrollRef} className="journey-composer__route" aria-labelledby="journey-route-heading">
                  {routeHeadingFragment}
                  <div className="journey-composer__route-tools">
                    {routeSearchFragment}
                    {globePickFragment}
                    {reverseAttributionFragment}
                  </div>
                  {routeListFragment}
                  {preciseLocationFragment}
                </section>
              </>
            )}
          </div>
        </div>

        {progress || savedResult ? (
          <div className="journey-composer__save-status">
            {progress ? <div className="journey-upload-progress" aria-live="polite"><span>{progress.fileName}</span><progress max={100} value={progressPercent} /> <strong>{progressPercent}%</strong></div> : null}
            {savedResult?.mediaErrors.length ? (
              <div className="journey-save-partial" role="status">
                <div className="journey-save-partial__heading"><StartripsJourneyCue state="rest" size={40} /><h4>旅程已保存，部分媒体没有上传成功</h4></div>
                <p>成功 {savedResult.uploadedCount} 个，失败 {savedResult.mediaErrors.length} 个。路线和故事不会丢失。</p>
                <ul>{savedResult.mediaErrors.map((error) => <li key={`${error.fileIndex}-${error.fileName}`}><strong>{error.fileName}</strong>：{error.message}</li>)}</ul>
                {retryAssignments.length > 0 ? (
                  <button type="button" onClick={retryFailedMedia} disabled={saving}>{saving ? "正在重试…" : "重试失败媒体"}</button>
                ) : (
                  <p>这些媒体暂时无法安全重试；请完成后重新打开这段 Journey，再添加这些媒体。</p>
                )}
              </div>
            ) : null}
            {savedResult && savedResult.mediaErrors.length === 0 && mediaFiles.length > 0 ? (
              <div className="journey-save-complete" role="status"><StartripsJourneyCue state="arrived" size={48} /><span>媒体已经全部上传完成，可以返回地球查看这段旅程。</span></div>
            ) : null}
          </div>
        ) : null}
        {message ? <p className="journey-composer__message" role="alert">{message}</p> : null}
        <footer className="journey-composer__footer">
          <div className="journey-composer__summary" aria-live="polite">
            <strong>{routePoints.length === 0 ? "还没有地点" : routePoints.length === 1 ? "1 个地点" : `${routePoints.length} 个地点 · 一段路径`}</strong>
            <span>{mediaFiles.length > 0
              ? `${mediaFiles.length} 个新媒体文件`
              : existingVisualMediaCount
                ? `${existingVisualMediaCount} 个已有媒体`
                : "媒体可以稍后补充"}</span>
          </div>
          <div className="journey-composer__footer-actions">
            {onPlaybackPreview && !savedResult ? (
              <button
                type="button"
                className="journey-composer__preview-playback"
                onClick={requestPlaybackPreview}
                disabled={saving || routePoints.length === 0 || playbackPreviewActive || playbackPreviewPreparing}
                data-playback-preview-trigger
              >
                <IconPlayerPlay size={18} stroke={1.4} aria-hidden="true" />
                {playbackPreviewPreparing ? "正在准备预览…" : "预览播放"}
              </button>
            ) : null}
            {savedResult ? <button type="button" onClick={closeComposer}><IconCheck size={18} stroke={1.4} aria-hidden="true" />完成</button> : <button type="button" onClick={save} disabled={saving || unknownCreateAttempt?.mode === "ambiguous" || unknownCreateAttempt?.mode === "confirmation-required"}>{saving ? <StartripsJourneyCue state="waiting" size={32} /> : <IconCheck size={18} stroke={1.4} aria-hidden="true" />}{saving ? "正在保存…" : unknownCreateAttempt?.mode === "ambiguous" || unknownCreateAttempt?.mode === "confirmation-required" ? "请关闭后核对 Atlas" : unknownCreateAttempt ? "重新确认保存结果" : isEditing ? "保存修改" : "保存到星球"}</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
