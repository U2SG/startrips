import {
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
  IconDots,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { IconActionButton } from "../components/IconActionButton";
import {
  uploadMediaInParts,
  type UploadedMediaAsset,
} from "../api/multipartUpload";
import {
  createJourney,
  reverseGeocode,
  searchLocations,
  updateJourney,
} from "./journeyApi";
import {
  journeyVisualMedia,
  validateJourneyFiles,
  validateJourneyInput,
} from "./journeyModel";
import {
  appendRoutePoint,
  moveRoutePoint,
  removeRoutePoint,
  routeDraftToInput,
  suggestPointLabel,
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
import {
  getLightEffectGradient,
  LIGHT_COLORS,
  LIGHT_EFFECTS,
  type LightEffectId,
} from "./lightEffects";
import { useModalFocus, useNestedModalFocus } from "./useModalFocus";
import { useCompactMobileLayout } from "./mobileLayout";

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

export async function persistJourneyDraft({
  input,
  mediaFiles,
  routePoints,
  persist = createJourney,
  upload = uploadMediaInParts,
  onProgress,
}: PersistJourneyDraftOptions): Promise<JourneySaveResult> {
  const journey = await persist(input);
  const mediaResult = await uploadJourneyMediaAssignments({
    journeyId: journey.id,
    assignments: resolvePendingMediaUploads(mediaFiles, routePoints, journey),
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
  const [reverseAttribution, setReverseAttribution] = useState<
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
  const [lightEffect, setLightEffect] = useState<LightEffectId | null>(journey?.lightEffect ?? null);
  const [mediaFiles, setMediaFiles] = useState<PendingJourneyMedia[]>([]);
  const mobileLayout = useCompactMobileLayout();
  const [mobileMediaMenuIndex, setMobileMediaMenuIndex] = useState<number | null>(null);
  const [mobileMediaAssignmentIndex, setMobileMediaAssignmentIndex] = useState<number | null>(null);
  const [mobileMediaDeleteIndex, setMobileMediaDeleteIndex] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [savedResult, setSavedResult] = useState<JourneySaveResult | null>(null);
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
  const reverseGeocodeRevisionRef = useRef(0);
  const activeReverseGeocodeDraftIdRef = useRef<string | null>(null);
  const composerMountedRef = useRef(true);
  const routePointsRef = useRef(routePoints);
  routePointsRef.current = routePoints;
  const dialogRef = useModalFocus<HTMLElement>(() => {
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
  }, true, globePicking);
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
  }, [mobileLayout]);

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

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      reverseGeocodeRevisionRef.current += 1;
    };
  }, []);

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
    const requestRevision = ++globePickRequestRevisionRef.current;
    reverseGeocodeRevisionRef.current += 1;
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

  function closeComposer() {
    globePickRequestRevisionRef.current += 1;
    reverseGeocodeRevisionRef.current += 1;
    activeReverseGeocodeDraftIdRef.current = null;
    if (globePicking) onGlobePickCancel?.();
    onRoutePreviewChange?.(null);
    onClose();
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.currentTarget.files ?? [])];
    const next = [
      ...mediaFiles,
      ...selected.map((file) => ({ file, routePointDraftId: null })),
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

  async function save() {
    const validation = validateJourneyInput(input);
    const mediaValidation = validateJourneyFiles(mediaFiles.map((media) => media.file));
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
        mediaFiles,
        routePoints,
        persist: journey
          ? (nextInput) => updateJourney(journey.id, nextInput)
          : createJourney,
        onProgress: setProgress,
      });
      const resolvedAssignments = resolvePendingMediaUploads(
        mediaFiles,
        routePoints,
        result.journey,
      );
      setSavedResult(result);
      setRetryAssignments(
        result.mediaErrors.map((error) => resolvedAssignments[error.fileIndex]),
      );
      await onSaved(result);
      if (result.mediaErrors.length === 0) closeComposer();
    } catch (errorValue) {
      setMessage(errorValue instanceof Error ? errorValue.message : "旅程保存失败");
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
  const mobileMenuMedia = mobileMediaMenuIndex === null ? null : mediaFiles[mobileMediaMenuIndex] ?? null;
  const mobileAssignmentMedia = mobileMediaAssignmentIndex === null ? null : mediaFiles[mobileMediaAssignmentIndex] ?? null;
  const mobileDeleteMedia = mobileMediaDeleteIndex === null ? null : mediaFiles[mobileMediaDeleteIndex] ?? null;

  return (
    <div className={`journey-composer-backdrop${globePicking ? " is-globe-picking" : ""}`} role="presentation">
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
        inert={globePicking || undefined}
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
                  <strong>{existingVisualMediaCount ? `${existingVisualMediaCount} 个已有媒体 · 可继续添加` : "支持照片与视频，可持续添加"}</strong>
                  <input type="file" accept="image/avif,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple onChange={selectFiles} />
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
                            <strong>{result.label}</strong>
                            {[result.labelLocal, result.labelEnglish]
                              .filter((label, index, labels) => Boolean(label) && label !== result.label && labels.indexOf(label) === index)
                              .map((label) => <small key={label}>{label}</small>)}
                            <span>{[result.context, result.countryCode].filter(Boolean).join(" · ")}</span>
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
                {onGlobePickRequest ? <button ref={globePickTriggerRef} className="journey-globe-pick-button" type="button" onClick={requestGlobePoint}><IconMapPin size={17} stroke={1.35} aria-hidden="true" /><span><strong>直接在地球上取点</strong><small>适合在路上、海上或没有准确名称的位置</small></span></button> : null}
                {reverseAttribution ? (
                  <a className="journey-location-attribution" href={reverseAttribution.url} target="_blank" rel="noreferrer">
                    地点数据 {reverseAttribution.label}
                  </a>
                ) : null}
              </div>

              <ol className="journey-route-draft" aria-label="已添加的地点">
                {routePoints.length === 0 ? <li className="is-empty"><IconMapPin size={22} stroke={1.15} aria-hidden="true" /><span>还没有地点</span><small>先搜索一个地点，或直接在地球上取点。</small></li> : null}
                {routePoints.map((point, index) => (
                  <li key={point.draftId}>
                    <span className="journey-route-draft__index">{String(index + 1).padStart(2, "0")}</span>
                    <div className="journey-route-draft__main">
                      <input
                        aria-label={`地点 ${index + 1} 名称`}
                        maxLength={120}
                        placeholder="地点名称（可精确到建筑或景点）"
                        value={point.label}
                        onChange={(event) => setRoutePoints((current) => updateRoutePoint(current, point.draftId, { label: event.target.value }))}
                      />
                      <small>{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</small>
                      {/* #10: a short personal note for this route point. */}
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
                    </div>
                    <label className="journey-checkbox"><input type="checkbox" checked={point.isStop} onChange={() => setRoutePoints((current) => toggleRouteStop(current, point.draftId))} />停靠</label>
                    <div className="journey-route-draft__actions">
                      {isEditing ? (
                        <>
                          <IconActionButton type="button" disabled={index === 0} onClick={() => setRoutePoints((current) => moveRoutePoint(current, point.draftId, -1))} label="向前移动地点" tooltip="上移地点"><IconArrowUp size={15} stroke={1.4} aria-hidden="true" /></IconActionButton>
                          <IconActionButton type="button" disabled={index === routePoints.length - 1} onClick={() => setRoutePoints((current) => moveRoutePoint(current, point.draftId, 1))} label="向后移动地点" tooltip="下移地点"><IconArrowDown size={15} stroke={1.4} aria-hidden="true" /></IconActionButton>
                        </>
                      ) : null}
                      <IconActionButton type="button" className="is-destructive-secondary" onClick={() => removeDraftPoint(point.draftId)} label="删除地点" tooltip="删除地点"><IconTrash size={15} stroke={1.4} aria-hidden="true" /></IconActionButton>
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
            {savedResult && savedResult.mediaErrors.length === 0 && mediaFiles.length > 0 ? (
              <div className="journey-save-complete" role="status">媒体已经全部上传完成，可以返回地球查看这段旅程。</div>
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
          {savedResult ? <button type="button" onClick={closeComposer}><IconCheck size={18} stroke={1.4} aria-hidden="true" />完成</button> : <button type="button" onClick={save} disabled={saving}><IconCheck size={18} stroke={1.4} aria-hidden="true" />{saving ? "正在保存…" : isEditing ? "保存修改" : "保存到星球"}</button>}
        </footer>
      </section>
    </div>
  );
}
