import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { StartripsJourneyCue, StartripsWordmark } from "../brand/StartripsBrandMark";
import "../styles/starlight-media.css";
import { useAtlasView } from "./atlasView";
import type { HomeNarrativeContext } from "./homeBasePrelude";
import { PlaybackMediaStage } from "./PlaybackMediaStage";
import { playbackSequenceChapterPresentation } from "./playbackSequenceChapter";
import { usePlaybackMapBridge } from "./usePlaybackMapBridge";
import { playbackReadIsReusable, type MediaReadState as MediaRead } from "./mediaReadRefresh";
import { playbackMediaGate, playbackChapterOpeningUrl, playbackHoldReason, type PlaybackHoldReason } from "./playbackMediaPresentation";
import {
  createDecodeRegistry,
  decodeImageUrl,
  mediaPrefetchUrlsForRead,
} from "./mediaPrefetch";
import {
  playbackProgressFraction,
  useJourneyPlaybackDirector,
  type PlaybackStepDurationResolver,
} from "./useJourneyPlaybackDirector";
import {
  commitPresentedPlaybackPosition,
  committedPlaybackPosition,
  playbackCameraTargetForStep,
  playbackCameraTargetKey,
  playbackMediaForPoint,
  playbackMediaForStep,
  playbackHoldTargetMedia,
  playbackStepIdentity,
  routePointChapterDensity,
  type CommittedPlaybackPosition,
  type PlaybackCameraTarget,
  type PlaybackStep,
} from "./journeyPlayback";
import { includePlaybackPrefetchHoldTarget, planPrefetchWindow, prefetchDispatchDecision, readyMsAheadForTempo } from "./playbackPrefetchPlan";
import { rewindPlaybackMediaElement, syncPlaybackMediaElement } from "./mediaPlaybackSync";
import {
  resolveVideoTrim,
  videoTrimBuffersOnStall,
  videoTrimEntryAction,
  videoTrimHoldsStep,
  videoTrimProgressAction,
  videoTrimPlayedFraction,
  videoTrimPositionKnown,
  videoTrimSeekApplies,
  videoTrimStatusAfterPauseChange,
  type VideoTrimSeekStatus,
  type VideoTrimWindow,
} from "./videoTrimPlayback";
import { remapPlaybackStepIndex } from "./quickRecapPlayback";
import type { AutoEditPlanV1, AutoEditSelectionReason } from "./autoEditPlan";
import {
  buildQuickRecapSelectionSummary,
  type QuickRecapOmissionReason,
} from "./quickRecapSelectionSummary";
import { playbackControlsMayAutoHide } from "./playbackControls";
import {
  nextMeaningfulStepIndex,
  playbackElapsedForFraction,
  playbackSegmentAtElapsed,
  type PlaybackPlan,
  type PlaybackTempo,
} from "./journeyPlaybackPlan";
import { journeySoundtrack, stripMediaExtension } from "./journeyModel";
import { compactMobileLayoutMarker, useCompactMobileLayout } from "./mobileLayout";
import { EMPTY_PLAYBACK_GLOBE_COVER, playbackGlobeCoverState, type PlaybackGlobeCoverState } from "./playbackGlobeCover";
import { createSoundtrackSampler } from "../motion/audioSampler";
import {
  resetAudioAtmosphereEnergy,
  writeAudioAtmosphereEnergy,
} from "../motion/audioAtmosphere";
import { prefersReducedMotion } from "../motion/preferences";
import type { Journey, JourneyMediaAsset } from "./types";
import type { PlaybackReturnReason } from "./playbackReturn";

const VIDEO_STALL_WATCHDOG_MS = 4_000;

type PlaybackArrivalGate = {
  journeyId: string;
  routePointId: string;
  stepIndex: number;
  intentRevision: number;
  pointIndex: number;
  minCameraRevision: number;
  reclaimFromFree: boolean;
  released: boolean;
};

function quickRecapSelectionReasonLabel(reason: AutoEditSelectionReason) {
  switch (reason) {
    case "all-media": return "完整媒体顺序";
    case "journey-cover": return "旅程封面";
    case "user-pinned": return "手动保留";
    case "route-point-representative": return "Route Point 代表媒体";
    case "visual-diversity": return "补充画面差异";
    case "duplicate-cluster-representative": return "相似画面的代表";
    case "video-highlight": return "代表视频片段";
  }
}

function quickRecapOmissionReasonLabel(reason: QuickRecapOmissionReason) {
  switch (reason) {
    case "not-selected": return "本次快速回顾未选入";
  }
}

/**
 * #19 Journey Playback overlay.
 *
 * A cinematic chapter player: intro -> travel (globe fly-to) -> stop (place +
 * note) -> memories (media slideshow) -> outro. The soundtrack plays for the
 * whole run, never resetting between chapters. The overlay translates each
 * phase into visible content; camera control is delegated to the parent via
 * camera target callback so the globe is never remounted.
 */
export function JourneyPlaybackOverlay({
  journey,
  onClose,
  onCameraTargetChange,
  cameraFollowing,
  cameraFlight,
  onReturnToCurrentLocation,
  initialSoundtrackRead,
  reduceMotion,
  stepDurationResolver,
  mediaTrimResolver,
  onTempoChange,
  onGlobeCoverChange,
  playbackMode = "full",
  quickRecapPlan,
  quickRecapSourceJourney,
  statusMessage,
  homeNarrativeContext,
}: {
  journey: Journey | null;
  onClose: (handoff: { reason: PlaybackReturnReason; position: CommittedPlaybackPosition | null }) => void;
  onCameraTargetChange: (target: PlaybackCameraTarget, explicitlySelected: boolean) => void;
  cameraFollowing?: boolean;
  cameraFlight?: { target: PlaybackCameraTarget; revision: number; settled: boolean } | null;
  onReturnToCurrentLocation?: () => void;
  // Review P1: a prefetched soundtrack signed read, so the first play() can
  // run inside the click gesture (browser user-activation policy).
  initialSoundtrackRead?: { url: string } | null;
  reduceMotion?: boolean;
  stepDurationResolver?: PlaybackStepDurationResolver;
  // #195 Phase 2: the trim window the Edit Plan declared for a video beat. The
  // overlay owns the media element, the plan's owner owns the plan, so the
  // window arrives the same way a beat's length does. Full Playback passes
  // nothing and keeps ending its video chapters on the real `ended` event.
  mediaTrimResolver?: (journey: Journey, step: PlaybackStep) => VideoTrimWindow | null;
  // Quick Recap's target duration wins over tempo (decision D1), so the owner of
  // the Edit Plan has to rebuild it when the runtime tempo changes. Tempo state
  // stays here in the director; this only reports a change upwards.
  onTempoChange?: (tempo: PlaybackTempo) => boolean | void;
  onGlobeCoverChange?: (state: PlaybackGlobeCoverState) => void;
  playbackMode?: "full" | "quick-recap";
  quickRecapPlan?: AutoEditPlanV1 | null;
  quickRecapSourceJourney?: Journey | null;
  statusMessage?: string | null;
  homeNarrativeContext?: HomeNarrativeContext | null;
}) {
  // #194: the one product-level compact-mobile answer, published as an
  // attribute so journey-playback.css never states a breakpoint of its own.
  const compactMobileLayout = useCompactMobileLayout();
  // #200 phase D: playback is a viewing capability, so this overlay reads the
  // product mode only for its media reader. In shared mode that is the
  // grant-scoped route; there is no write here to gate.
  const { readMedia } = useAtlasView();
  // Review P2: hold the director while a media chapter's image is not yet
  // decoded, so a slow network never flashes an empty frame — the chapter
  // waits on the decode settle instead of advancing on a fixed timer.
  const [holdReason, setHoldReason] = useState<PlaybackHoldReason>("none");
  const [presentationPending, setPresentationPending] = useState(false);
  // Narrative return position is a commit log, not a mirror of the director's
  // latest requested index. Non-media beats commit with their React render; a
  // media beat commits only after PlaybackMediaStage has actually handed the
  // visible slot over. A seek that is still decoding/transitioning therefore
  // cannot masquerade as something the viewer already reached.
  const committedPositionRef = useRef<CommittedPlaybackPosition | null>(null);
  const committedJourneyIdRef = useRef<string | null>(null);
  // Keep one director clock. Its stop budget waits for a real arrival commit,
  // just as a media beat waits for its own presentation, without a second timer.
  const [videoFallbackAssetId, setVideoFallbackAssetId] = useState<string | null>(null);
  const [arrivalGate, setArrivalGate] = useState<PlaybackArrivalGate | null>(null);
  const arrivalHolding = Boolean(playbackMode === "full" && arrivalGate && !arrivalGate.released
    && arrivalGate.journeyId === journey?.id
    && (cameraFollowing !== false || (arrivalGate.reclaimFromFree
      && (cameraFlight?.revision ?? 0) < arrivalGate.minCameraRevision))
    && !(cameraFlight?.target.kind === "point"
      && cameraFlight.target.pointIndex === arrivalGate.pointIndex
      && cameraFlight.revision >= arrivalGate.minCameraRevision
      && cameraFlight.settled));
  const hold = holdReason !== "none" || presentationPending || arrivalHolding;
  const director = useJourneyPlaybackDirector(journey, hold, stepDurationResolver, homeNarrativeContext);
  const { phase, paused, pause, resume, next, back, replay, seek, exit, steps, stepIndex, tempo, setTempo } = director;
  const mapInteractive = playbackMode === "full"
    && (director.step?.kind === "travel" || director.step?.kind === "stop");
  const mapInteractiveRef = useRef(mapInteractive);
  mapInteractiveRef.current = mapInteractive;
  const explicitCameraIntentRef = useRef<number | null>(null);
  const nextByViewer = useCallback(() => {
    setArrivalGate(null);
    explicitCameraIntentRef.current = next();
  }, [next]);
  const backByViewer = useCallback(() => {
    setArrivalGate(null);
    explicitCameraIntentRef.current = back();
  }, [back]);
  const seekByViewer = useCallback((target: number) => {
    setArrivalGate(null);
    explicitCameraIntentRef.current = seek(target);
  }, [seek]);
  const globeCoverState = playbackGlobeCoverState(director.step?.kind ?? null, presentationPending);
  useEffect(() => {
    onGlobeCoverChange?.(globeCoverState);
  }, [globeCoverState.coverTransitionActive, globeCoverState.opaqueMediaCover, onGlobeCoverChange]);
  useEffect(() => () => {
    onGlobeCoverChange?.(EMPTY_PLAYBACK_GLOBE_COVER);
  }, [onGlobeCoverChange]);
  const [suppressedPrefetchDispatchCount, setSuppressedPrefetchDispatchCount] = useState(0);
  // #126 sections 3-4: the transport reads the elapsed-time plan, so the bar is
  // time-weighted instead of step-weighted and a scrub has a time model.
  const { plan, getTimerBudget } = director;
  useLayoutEffect(() => {
    const journeyId = journey?.id ?? null;
    if (committedJourneyIdRef.current !== journeyId) {
      committedJourneyIdRef.current = journeyId;
      committedPositionRef.current = null;
    }
  }, [director.step, journey]);
  const handlePresentationPendingChange = useCallback((pending: boolean) => {
    setPresentationPending(pending);
  }, []);
  const quickRecapSelectionSummary = useMemo(() => (
    playbackMode === "quick-recap" && quickRecapPlan && quickRecapSourceJourney
      ? buildQuickRecapSelectionSummary(quickRecapPlan, quickRecapSourceJourney)
      : null
  ), [playbackMode, quickRecapPlan, quickRecapSourceJourney]);
  const progressFillRef = useRef<HTMLSpanElement | null>(null);
  // Review P2: the fill animates without re-rendering, so the range's own value
  // would stay at the beat's start all beat long and a screen reader would hear
  // a stale elapsed time. Sample the live position while the scrubber has
  // focus - the state that reads it - instead of re-rendering the whole overlay
  // once a second for everyone.
  // Which beat, if any, the media element is positioning — and where it put
  // it. A video beat holds the director, so its budget never drains and the
  // budget-driven write below would keep resetting the fill to that beat's
  // start — most visibly on a pause, which re-runs that effect while no
  // `timeupdate` is left to correct it. One owner per beat.
  //
  // The fraction lives here rather than in the element because the visible fill
  // is not its only reader: the range's own `value` and `aria-valuetext` have
  // to announce the position the fill is showing, and a screen-reader user must
  // not be told a different elapsed time from the one on screen. Keyed by step
  // for the same reason `videoTrimSeek` is (`videoTrimSeekApplies`): a
  // `timeupdate` that arrives after the beat changed belongs to the beat it was
  // raised for, and must not move the new beat's bar.
  const mediaPositionRef = useRef<{ stepIndex: number; fraction: number } | null>(null);
  const [scrubberFocused, setScrubberFocused] = useState(false);
  const [livePositionFraction, setLivePositionFraction] = useState<number | null>(null);
  // Tempo is a narrative intent and Quick Recap also rebuilds its projected
  // Journey for that same user action. Report the owner rebuild synchronously in
  // the select event, in the same React batch as the director's revision bump.
  // That prevents an intermediate commit where new tempo N+1 can dispatch from
  // the old Quick Recap projection before plan scope advances to N+2.
  const changeTempo = useCallback((nextTempo: PlaybackTempo) => {
    if (nextTempo === tempo) return;
    const rebuildPending = onTempoChange?.(nextTempo) === true;
    setTempo(nextTempo, { awaitPlanScopeCommit: rebuildPending });
  }, [onTempoChange, setTempo, tempo]);

  // A Quick Recap rebuild can add or drop beats, so a step index taken before
  // it is meaningless. Keep the same step when it survives, otherwise land on
  // the nearest surviving one (`remapPlaybackStepIndex`). Reads the live index
  // through a ref so the effect fires on a rebuilt journey only, never on an
  // ordinary step advance.
  const stepIdentitiesRef = useRef<string[]>([]);
  const stepIndexRef = useRef(stepIndex);
  stepIndexRef.current = stepIndex;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const remapJourneyIdRef = useRef<string | null>(null);
  // Scope remap is part of the same narrative-intent commit as the rebuilt
  // Quick Recap plan. Claim it in layout phase, before the later prefetch
  // dispatch layout effect queues work, so a moved beat bumps the live revision
  // first and the old-index window is suppressed rather than escaping.
  useLayoutEffect(() => {
    const nextIdentities = journey
      ? stepsRef.current.map((candidate) => playbackStepIdentity(journey, candidate))
      : [];
    const previousIdentities = stepIdentitiesRef.current;
    stepIdentitiesRef.current = nextIdentities;
    const sameJourney = remapJourneyIdRef.current === (journey?.id ?? null);
    remapJourneyIdRef.current = journey?.id ?? null;
    if (!journey || !sameJourney || previousIdentities.length === 0) return;
    if (
      previousIdentities.length === nextIdentities.length
      && previousIdentities.every((identity, index) => identity === nextIdentities[index])
    ) return;
    const target = remapPlaybackStepIndex(previousIdentities, nextIdentities, stepIndexRef.current);
    // `carryProgress`: this seek re-addresses the beat that is already playing,
    // so it resumes where it was instead of restarting the image. A beat the
    // rebuild deleted lands on its neighbour, which the director starts fresh.
    if (target !== stepIndexRef.current) seek(target, { carryProgress: true });
  }, [journey, seek]);
  // Review P2: `exit()` only resets the local director; the overlay must also
  // tell the parent to drop playbackJourneyId, or playback can never close.
  const requestClose = useCallback(() => {
    const reason: PlaybackReturnReason = director.completed ? "completed" : "exited";
    const position = committedPositionRef.current;
    exit();
    onClose({ reason, position });
  }, [director.completed, exit, onClose]);
  const [mediaReads, setMediaReads] = useState<Record<string, MediaRead>>(() => {
    if (!journey || !initialSoundtrackRead) return {};
    const soundtrack = journeySoundtrack(journey);
    if (!soundtrack) return {};
    // The prefetch cache handed this one over as fresh, and the soundtrack is
    // deliberately never re-read while it plays, so no lifetime is known here.
    return {
      [soundtrack.id]: {
        status: "ready",
        url: initialSoundtrackRead.url,
        issuedAt: Number.NEGATIVE_INFINITY,
        expiresAt: Number.POSITIVE_INFINITY,
      },
    };
  });
  const mediaReadsRef = useRef(mediaReads);
  mediaReadsRef.current = mediaReads;
  const decodeRegistryRef = useRef(createDecodeRegistry(decodeImageUrl));
  // Review P2: decode settles without React state; this revision bumps on
  // every settle so the media gate re-renders once the image is decoded.
  const [decodeSettleRevision, setDecodeSettleRevision] = useState(0);
  useEffect(() => decodeRegistryRef.current.onSettle(
    () => setDecodeSettleRevision((current) => current + 1),
  ), []);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoElementRevision, setVideoElementRevision] = useState(0);
  const bindVideoElement = useCallback((element: HTMLVideoElement | null) => {
    if (videoRef.current === element) return;
    videoRef.current?.pause();
    videoRef.current = element;
    setVideoElementRevision((revision) => revision + 1);
  }, []);
  const videoStallTimerRef = useRef<number | null>(null);
  const videoStalledAssetIdRef = useRef<string | null>(null);
  const clearVideoStallWatchdog = useCallback(() => {
    if (videoStallTimerRef.current === null) return;
    window.clearTimeout(videoStallTimerRef.current);
    videoStallTimerRef.current = null;
  }, []);
  const scheduleVideoStallWatchdog = useCallback((assetId: string) => {
    clearVideoStallWatchdog();
    videoStalledAssetIdRef.current = assetId;
    videoStallTimerRef.current = window.setTimeout(() => {
      videoStallTimerRef.current = null;
      if (videoStalledAssetIdRef.current === assetId) videoStalledAssetIdRef.current = null;
      setVideoFallbackAssetId(assetId);
      setHoldReason("none");
    }, VIDEO_STALL_WATCHDOG_MS);
  }, [clearVideoStallWatchdog]);
  // #195 Phase 2. A video beat whose plan item declares a trim is owned by the
  // segment, not by the element's `ended` event: the director's budget is
  // `outMs - inMs`, so it may only start once the element sits at the in-point.
  // `positioning` holds the budget while the seek is in flight, `playing`
  // releases it, and `unavailable` means the trim could not be applied and the
  // beat falls back to the pre-#195 `ended` ownership.
  // The step index is part of the key, not decoration: consecutive beats may
  // trim the same source, and then only the step tells a late settle from the
  // previous beat apart from one meant for the current beat.
  const [videoTrimSeek, setVideoTrimSeek] = useState<
    { assetId: string; stepIndex: number; status: VideoTrimSeekStatus } | null
  >(null);
  const videoTrimTimerRef = useRef<number | null>(null);
  const clearVideoTrimWatchdog = useCallback(() => {
    if (videoTrimTimerRef.current === null) return;
    window.clearTimeout(videoTrimTimerRef.current);
    videoTrimTimerRef.current = null;
  }, []);
  // A settle only ever updates the beat it was computed for. It never creates a
  // state: the entry effect is the single writer that opens one, so a settle
  // arriving for a beat that has no trim — an `error` on an untrimmed video —
  // has nothing to say and says nothing. The watchdog is not cleared here: the
  // updater must stay pure (React may call it twice), and the effect that owns
  // the timer re-runs on every status change and clears it in its cleanup.
  const settleVideoTrimSeek = useCallback((
    assetId: string,
    stepIndex: number,
    status: VideoTrimSeekStatus,
  ) => {
    setVideoTrimSeek((current) => (
      videoTrimSeekApplies(current, assetId, stepIndex) && current!.status !== status
        ? { ...current!, status }
        : current
    ));
  }, []);
  useEffect(() => () => clearVideoTrimWatchdog(), [clearVideoTrimWatchdog]);
  // Position the element on the in-point. A seek can be refused outright (an
  // unseekable source throws) or silently never land, so the caller's bounded
  // watchdog is what turns either into `unavailable` instead of a stall.
  const applyVideoTrimEntry = useCallback((
    element: HTMLVideoElement,
    resolved: ReturnType<typeof resolveVideoTrim>,
    assetId: string,
    stepIndex: number,
  ) => {
    if (resolved.kind !== "trimmed") {
      settleVideoTrimSeek(assetId, stepIndex, "unavailable");
      return;
    }
    const action = videoTrimEntryAction(resolved, element.currentTime);
    if (action.kind !== "seek") {
      settleVideoTrimSeek(assetId, stepIndex, "playing");
      return;
    }
    try {
      element.currentTime = action.toSeconds;
    } catch {
      settleVideoTrimSeek(assetId, stepIndex, "unavailable");
    }
  }, [settleVideoTrimSeek]);
  const recoverVideoPlayback = useCallback((assetId: string) => {
    clearVideoStallWatchdog();
    if (videoStalledAssetIdRef.current === assetId) videoStalledAssetIdRef.current = null;
    setVideoFallbackAssetId((current) => current === assetId ? null : current);
  }, [clearVideoStallWatchdog]);
  useEffect(() => () => clearVideoStallWatchdog(), [clearVideoStallWatchdog]);
  useEffect(() => {
    clearVideoStallWatchdog();
    videoStalledAssetIdRef.current = null;
    // A failed beat may fall back to its timer, but a later deliberate revisit
    // must get its own attempt instead of inheriting that beat's failure.
    setVideoFallbackAssetId(null);
  }, [clearVideoStallWatchdog, director.stepIndex]);
  useEffect(() => {
    if (paused) {
      clearVideoStallWatchdog();
      return;
    }
    const stalledAssetId = videoStalledAssetIdRef.current;
    if (stalledAssetId) scheduleVideoStallWatchdog(stalledAssetId);
  }, [clearVideoStallWatchdog, paused, scheduleVideoStallWatchdog]);
  // The trim window of the beat that is playing, recomputed every render:
  // `buildPlaybackSteps` hands out a fresh step object each time, so there is
  // nothing stable to memoise against.
  const activeVideoTrim = (() => {
    const step = director.step;
    if (!journey || !mediaTrimResolver || step?.kind !== "media") return null;
    const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
    if (!asset?.mimeType.startsWith("video/")) return null;
    const trim = mediaTrimResolver(journey, step);
    return trim ? { assetId: asset.id, trim } : null;
  })();
  const activeVideoTrimAssetId = activeVideoTrim?.assetId ?? null;
  const activeVideoTrimInMs = activeVideoTrim?.trim.inMs ?? null;
  const activeVideoTrimOutMs = activeVideoTrim?.trim.outMs ?? null;
  const activeVideoTrimKey = activeVideoTrim
    ? `${activeVideoTrim.assetId}:${director.stepIndex}:${activeVideoTrimInMs}:${activeVideoTrimOutMs}`
    : null;
  const enteredVideoTrimKeyRef = useRef<string | null>(null);
  // Entering the beat — including re-entering it with the step scrubber, which
  // hands the director a fresh full budget while the `<video>` keeps its React
  // key and therefore its `currentTime`. A remounted element has no metadata
  // yet and is positioned by `loadedmetadata`; a surviving one is repositioned
  // here, because that event will not fire a second time.
  useEffect(() => {
    clearVideoTrimWatchdog();
    enteredVideoTrimKeyRef.current = activeVideoTrimKey;
    if (!activeVideoTrimAssetId || activeVideoTrimInMs === null || activeVideoTrimOutMs === null) {
      setVideoTrimSeek(null);
      return;
    }
    const stepIndex = director.stepIndex;
    setVideoTrimSeek({ assetId: activeVideoTrimAssetId, stepIndex, status: "positioning" });
    const element = videoRef.current;
    if (!element || element.readyState < 1) return;
    applyVideoTrimEntry(
      element,
      resolveVideoTrim({ inMs: activeVideoTrimInMs, outMs: activeVideoTrimOutMs }, element.duration),
      activeVideoTrimAssetId,
      stepIndex,
    );
  }, [
    applyVideoTrimEntry,
    clearVideoTrimWatchdog,
    activeVideoTrimAssetId,
    activeVideoTrimInMs,
    activeVideoTrimOutMs,
    activeVideoTrimKey,
    director.stepIndex,
    videoElementRevision,
  ]);
  // The bounded escape acceptance 5 asks for, covering both holding states. It
  // starts only once the signed read is ready and playback is running, so a slow
  // read is never mistaken for an unseekable source. Either way the beat
  // degrades to `ended` ownership — the pre-#195 behaviour — and deliberately no
  // further: the overlay's media fallback stays owned by the existing
  // `stalled` watchdog alone, so a slow refill after a resume cannot push a beat
  // that was playing correctly out of the product's normal video path.
  const videoTrimHoldingStatus = activeVideoTrimAssetId
    && videoTrimSeekApplies(videoTrimSeek, activeVideoTrimAssetId, director.stepIndex)
    ? videoTrimSeek!.status
    : null;
  const videoTrimWaiting = videoTrimHoldingStatus === "positioning"
    || videoTrimHoldingStatus === "buffering";
  const videoTrimReadReady = activeVideoTrimAssetId
    ? mediaReads[activeVideoTrimAssetId]?.status === "ready"
    : false;
  useEffect(() => {
    if (!videoTrimWaiting || !videoTrimReadReady || paused) return;
    const assetId = activeVideoTrimAssetId;
    if (!assetId) return;
    const stepIndex = director.stepIndex;
    clearVideoTrimWatchdog();
    videoTrimTimerRef.current = window.setTimeout(() => {
      videoTrimTimerRef.current = null;
      settleVideoTrimSeek(assetId, stepIndex, "unavailable");
    }, VIDEO_STALL_WATCHDOG_MS);
    return () => clearVideoTrimWatchdog();
  }, [
    activeVideoTrimAssetId,
    clearVideoTrimWatchdog,
    director.stepIndex,
    paused,
    settleVideoTrimSeek,
    videoTrimHoldingStatus,
    videoTrimReadReady,
    videoTrimWaiting,
  ]);
  // A pause freezes the budget by itself, so a beat never carries `buffering`
  // across one: the resumed beat starts from `playing` and re-reports a stall
  // that is still real, which keeps the watchdog window measuring the resume.
  useEffect(() => {
    setVideoTrimSeek((current) => {
      if (!current) return current;
      const next = videoTrimStatusAfterPauseChange(current.status);
      return next === current.status ? current : { ...current, status: next! };
    });
  }, [paused]);
  // #20: one sampler per soundtrack element; analyser built on first play.
  const samplerRef = useRef(createSoundtrackSampler());
  const lightStripRef = useRef<HTMLDivElement>(null);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [selectionSummaryOpen, setSelectionSummaryOpen] = useState(false);
  const playbackInputModalityRef = useRef<"pointer" | "keyboard">("pointer");
  const pendingReads = useRef(new Set<string>());
  // Review P2: the playback overlay is its own focus trap (rendered outside
  // any dialog that would otherwise manage Tab focus).
  const overlayRef = useRef<HTMLDivElement>(null);

  const soundtrack = useMemo(
    () => journey ? journeySoundtrack(journey) : null,
    [journey],
  );
  const soundtrackRead = soundtrack ? mediaReads[soundtrack.id] : null;
  const soundtrackIdRef = useRef<string | null>(null);
  soundtrackIdRef.current = soundtrack?.id ?? null;
  const audioReactiveReducedMotion = reduceMotion ?? prefersReducedMotion();

  const loadMediaRead = useCallback((assetId: string) => {
    // Review P1: the soundtrack's signed read is never replaced while it is
    // ready — a new URL would reset <audio src> and restart the music
    // mid-play. Every other asset is reusable only while its own read is
    // still fresh, so a short share-scoped URL is re-signed before the
    // chapter that needs it rather than failing to load.
    const existing = mediaReadsRef.current[assetId];
    if (existing?.status === "ready" && assetId === soundtrackIdRef.current) return;
    if (playbackReadIsReusable(existing, Date.now())) return;
    if (pendingReads.current.has(assetId)) return;
    pendingReads.current.add(assetId);
    setMediaReads((current) => ({
      ...current,
      [assetId]: { status: "loading" },
    }));
    const issuedAt = Date.now();
    void readMedia(assetId).then(
      (read) => setMediaReads((current) => ({
        ...current,
        [assetId]: {
          status: "ready",
          url: read.url,
          preview: read.preview,
          issuedAt,
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
  }, [readMedia]);

  // Load the soundtrack and any media the current step needs.
  // Review P1: the soundtrack read is loaded exactly ONCE per journey — it
  // must never be re-requested on chapter changes (a new signed URL would
  // replace <audio src> and reset the music mid-playback).
  useEffect(() => {
    if (soundtrack) loadMediaRead(soundtrack.id);
  }, [loadMediaRead, soundtrack?.id]);

  // #197: the prefetch window is a time budget, not an asset count. It walks
  // the expanded steps forward from the current index, spending each step's
  // duration as resolved by the director for the active plan and tempo, so a
  // faster tempo naturally prepares more assets over roughly the same seconds
  // of prepared playback. Deriving it from `stepIndex` alone is what makes a
  // seek, next or back invalidate the old window without any cancellation.
  // Prefetch must share the director's session-frozen topology. Rebuilding from
  // live Home context here would create a second step index space when Home
  // hydration resolves after Playback has already started.
  const playbackSteps = director.steps;
  const mediaById = useMemo(() => {
    const index = new Map<string, JourneyMediaAsset>();
    for (const asset of journey?.media ?? []) index.set(asset.id, asset);
    return index;
  }, [journey]);
  const { durationForStep } = director;
  const prefetchAssetIds = useMemo(() => {
    if (!journey) return [] as string[];
    const prefetchWindow = planPrefetchWindow({
      stepCount: playbackSteps.length,
      stepIndex: director.stepIndex,
      budgetMs: readyMsAheadForTempo(director.tempo),
      durationForStep: (index) => {
        const step = playbackSteps[index];
        return step ? durationForStep(step) : 0;
      },
      assetIdsForStep: (index) => {
        const step = playbackSteps[index];
        if (step?.kind !== "media") return [];
        const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
        return asset ? [asset.id] : [];
      },
    });
    // The asset the director may hold on is prepared even when the beats
    // leading to it are longer than the whole budget — a video-first chapter
    // must never leave its first image unread while the stop phase waits.
    const holdTarget = playbackHoldTargetMedia(journey, playbackSteps[director.stepIndex]);
    return includePlaybackPrefetchHoldTarget(prefetchWindow.assetIds, holdTarget?.id ?? null);
  }, [director.stepIndex, director.tempo, durationForStep, journey, playbackSteps]);
  // The window is a plain array; the effects below key off its contents so
  // they do not churn per render.
  const prefetchKey = prefetchAssetIds.join(",");
  const plannedPrefetchRevision = director.intentRevision;
  const allowPrefetchDispatch = useCallback((plannedRevision: number) => {
    const boundary = director.getPrefetchIntentBoundary();
    const decision = prefetchDispatchDecision({
      plannedRevision,
      liveRevision: boundary.liveRevision,
      blockedThroughRevision: boundary.blockedThroughRevision,
    });
    if (decision === "suppress-stale") {
      setSuppressedPrefetchDispatchCount((current) => current + 1);
      return false;
    }
    return true;
  }, [director.getPrefetchIntentBoundary]);

  // Signed reads follow the same window, through the same single read path, so
  // a decode is never scheduled for an asset that has no URL yet. Planning is
  // committed first, then actual request dispatch yields to the microtask
  // boundary. Seek/next/back are suppressed by the director revision directly.
  // Quick Recap tempo additionally blocks through the tempo revision until the
  // parent's rebuilt plan scope commits and advances that same director revision
  // again. The newer render then dispatches its live window, so suppression can
  // never turn into a deadlock or a parallel scheduler.
  useLayoutEffect(() => {
    const assetIds = [...prefetchAssetIds];
    queueMicrotask(() => {
      if (!allowPrefetchDispatch(plannedPrefetchRevision)) return;
      for (const assetId of assetIds) {
        overlayRef.current?.setAttribute(
          "data-playback-prefetch-dispatch-intent",
          String(plannedPrefetchRevision),
        );
        loadMediaRead(assetId);
      }
    });
  }, [allowPrefetchDispatch, loadMediaRead, plannedPrefetchRevision, prefetchKey]);

  // Review P2: decode media AHEAD of display so a chapter never mounts <img>
  // with a loading gap. #264 also warms a same-asset preview for photos/videos;
  // the original image decode remains the only readiness gate.
  useEffect(() => {
    if (!allowPrefetchDispatch(plannedPrefetchRevision)) return;
    for (const assetId of prefetchAssetIds) {
      const asset = mediaById.get(assetId);
      const read = mediaReads[assetId];
      if (!asset || read?.status !== "ready") continue;
      overlayRef.current?.setAttribute(
        "data-playback-prefetch-dispatch-intent",
        String(plannedPrefetchRevision),
      );
      const layerUrls = mediaPrefetchUrlsForRead(assetId, assetId, read);
      if (read.preview) void decodeImageUrl(layerUrls[0]).catch(() => undefined);
      if (asset.mimeType.startsWith("image/")) {
        decodeRegistryRef.current.ensure(assetId, read.url);
      }
    }
  }, [
    allowPrefetchDispatch,
    decodeSettleRevision,
    mediaById,
    mediaReads,
    plannedPrefetchRevision,
    prefetchKey,
  ]);

  // Review P2: while a media chapter's image is not decoded yet, hold the
  // director so it never advances into a blank frame. Terminal read/decode
  // failures are settled too: they release the hold so playback can show an
  // explicit fallback instead of deadlocking forever.
  //
  // #197: the decision itself is `playbackHoldReason` below, so what holds
  // playback is a pure, unit-covered answer and this effect only gathers the
  // inputs — the same split `playbackMediaGate` already uses.
  useEffect(() => {
    if (!journey) return;
    const step = director.step;
    // A stop step waits on the chapter's first image; a media step waits on its
    // own asset. `playbackHoldTargetMedia` answers both, and it is the same
    // asset the prefetch window guarantees to have prepared.
    const asset = step?.kind === "stop" || step?.kind === "media"
      ? playbackHoldTargetMedia(journey, step)
      : null;
    const isImage = asset?.mimeType.startsWith("image/") ?? false;
    const gate = asset
      ? playbackMediaGate(
        mediaReads[asset.id],
        isImage ? decodeRegistryRef.current.readiness(asset.id) : undefined,
        isImage,
      )
      : "ready";
    // #195 Phase 2: a trimmed video beat is owned by its segment instead of by
    // the element's `ended` event. An `unavailable` trim is not owned by the
    // segment at all, so it falls through to the untrimmed policy.
    const trimOwnsStep = Boolean(
      asset?.mimeType.startsWith("video/")
      && videoTrimSeekApplies(videoTrimSeek, asset.id, director.stepIndex)
      && videoTrimSeek!.status !== "unavailable",
    );
    setHoldReason(playbackHoldReason({
      stepKind: step?.kind,
      asset,
      gate,
      videoPlaybackFailed: asset ? videoFallbackAssetId === asset.id : false,
      trimStatus: trimOwnsStep ? videoTrimSeek!.status : null,
    }));
  }, [
    decodeSettleRevision,
    director.step,
    director.stepIndex,
    journey,
    mediaReads,
    videoFallbackAssetId,
    videoTrimSeek,
  ]);

  // The soundtrack follows playback: play on any non-paused phase after the
  // user started playback; pause when paused; never reset between chapters.
  // Review P1: layout effect so the very first play() runs inside the click
  // gesture's transient user activation (a plain effect can be too late and
  // Chrome/Safari reject the audio).
  useLayoutEffect(() => {
    const audio = audioRef.current;
    if (!audio || !soundtrackRead || soundtrackRead.status !== "ready") return;
    if (paused || !director.isPlaying) {
      samplerRef.current.setPlaying(false);
      audio.pause();
      return;
    }
    // #20: this layout effect runs in the same committed gesture turn as the
    // initial playback entry, giving AudioContext.resume() the best chance to
    // retain user activation. Failure never blocks the real <audio> element.
    if (!audioReactiveReducedMotion) samplerRef.current.start(audio);
    samplerRef.current.setPlaying(true);
    void audio.play().catch(() => undefined);
  }, [audioReactiveReducedMotion, paused, director.isPlaying, soundtrackRead?.status === "ready"]);

  // Video chapters use the same Startrips transport as the director and
  // soundtrack. The native transport is intentionally not authoritative.
  useLayoutEffect(() => {
    const step = director.step;
    const asset = journey && step?.kind === "media"
      ? playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex]
      : null;
    return syncPlaybackMediaElement(
      videoRef.current,
      director.isPlaying && !paused && !presentationPending && videoFallbackAssetId !== asset?.id,
      asset?.mimeType.startsWith("video/")
        ? () => {
            clearVideoStallWatchdog();
            videoStalledAssetIdRef.current = null;
            setVideoFallbackAssetId(asset.id);
          }
        : undefined,
    );
  }, [clearVideoStallWatchdog, director.isPlaying, director.stepIndex, journey, mediaReads, paused, presentationPending, videoElementRevision, videoFallbackAssetId]);

  // #20: one analyser graph writes a shared mutable energy channel; the light
  // strip and Three.js scene read that channel without React per-frame state.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !soundtrackRead || soundtrackRead.status !== "ready") {
      samplerRef.current.stop();
      resetAudioAtmosphereEnergy();
      return;
    }
    if (audioReactiveReducedMotion) {
      samplerRef.current.stop();
      resetAudioAtmosphereEnergy();
      return;
    }
    const sampler = samplerRef.current;
    if (director.isPlaying && !paused) sampler.start(audio);
    sampler.setPlaying(director.isPlaying && !paused);
    const strip = lightStripRef.current;
    if (!sampler.isActive()) {
      resetAudioAtmosphereEnergy();
      return;
    }
    let frame = 0;
    const drive = () => {
      const energy = sampler.getEnergy();
      writeAudioAtmosphereEnergy(energy);
      if (strip) {
        // Keep the atmosphere restrained: at full energy visual gain <= 15%.
        strip.style.setProperty("--audio-width", String(1 + energy.mid * 0.15));
        strip.style.setProperty("--audio-brightness", String(1 + energy.overall * 0.12));
      }
      frame = window.requestAnimationFrame(drive);
    };
    frame = window.requestAnimationFrame(drive);
    return () => window.cancelAnimationFrame(frame);
  }, [audioReactiveReducedMotion, director.isPlaying, paused, soundtrackRead?.status === "ready"]);

  // Final teardown happens only when playback closes.
  useEffect(() => () => {
    samplerRef.current.stop();
    resetAudioAtmosphereEnergy();
  }, []);

  useEffect(() => () => audioRef.current?.pause(), []);

  // Playback chrome fades during uninterrupted pointer/touch viewing, but it
  // must never disappear while paused or while a keyboard user owns focus in
  // the dialog. Programmatic initial focus does not pin the chrome forever:
  // only an actual keyboard interaction switches the idle policy to keyboard.
  useEffect(() => {
    let timer = 0;
    const focusWithinOverlay = () => Boolean(
      overlayRef.current?.contains(document.activeElement),
    );
    const mayAutoHide = () => !selectionSummaryOpen && playbackControlsMayAutoHide({
      paused,
      keyboardNavigation: playbackInputModalityRef.current === "keyboard",
      focusWithinOverlay: focusWithinOverlay(),
    });
    const restartIdle = () => {
      setControlsHidden(false);
      window.clearTimeout(timer);
      if (!mayAutoHide()) return;
      timer = window.setTimeout(() => {
        if (mayAutoHide()) setControlsHidden(true);
      }, 2500);
    };
    const onPointerActivity = () => {
      playbackInputModalityRef.current = "pointer";
      restartIdle();
    };
    const onKeyboardActivity = () => {
      playbackInputModalityRef.current = "keyboard";
      restartIdle();
    };
    window.addEventListener("pointermove", onPointerActivity);
    window.addEventListener("pointerdown", onPointerActivity);
    window.addEventListener("touchstart", onPointerActivity, { passive: true });
    window.addEventListener("keydown", onKeyboardActivity);
    if (paused || !director.isPlaying) setControlsHidden(false);
    else restartIdle();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onPointerActivity);
      window.removeEventListener("pointerdown", onPointerActivity);
      window.removeEventListener("touchstart", onPointerActivity);
      window.removeEventListener("keydown", onKeyboardActivity);
    };
  }, [director.isPlaying, director.stepIndex, paused, selectionSummaryOpen]);

  // Review P2: toggle playback from the user gesture so audio.play() runs
  // inside user activation; the soundtrack effect below stays as the
  // synchronization/fallback path.
  const togglePlayback = useCallback(() => {
    if (director.completed) {
      samplerRef.current.setPlaying(false);
      rewindPlaybackMediaElement(audioRef.current);
      syncPlaybackMediaElement(videoRef.current, false);
      replay();
      return;
    }
    if (paused) {
      const audio = audioRef.current;
      if (audio && soundtrackRead?.status === "ready") {
        if (!audioReactiveReducedMotion) samplerRef.current.start(audio);
        samplerRef.current.setPlaying(true);
        void audio.play().catch(() => undefined);
      }
      // Run video.play() inside the same user gesture as the Startrips resume
      // action so browser user-activation rules do not create a second state.
      const currentAsset = journey ? playbackMediaForStep(journey, director.step) : null;
      syncPlaybackMediaElement(videoRef.current, !presentationPending && videoFallbackAssetId !== currentAsset?.id);
      resume();
    } else {
      samplerRef.current.setPlaying(false);
      syncPlaybackMediaElement(videoRef.current, false);
      pause();
    }
  }, [audioReactiveReducedMotion, director.completed, director.step, journey, paused, pause, replay, resume, presentationPending, soundtrackRead?.status === "ready", videoFallbackAssetId]);

  // Camera ownership follows playback semantics. Intro/outro frame the whole
  // Journey; travel/stop/media point at one route point. The key guard avoids
  // reissuing the same point command across automatic stop -> media chapters.
  // An explicit chapter choice may reclaim a camera the viewer released.
  const lastCameraTargetKeyRef = useRef<string | null>(null);
  const commitSpatial = useCallback((_arrivingFromTravel: boolean) => {
    const target = playbackCameraTargetForStep(director.step, journey);
    if (!target || !journey) return;
    const explicitlySelected = explicitCameraIntentRef.current === director.intentRevision;
    explicitCameraIntentRef.current = null;
    const routePointId = target.kind === "point" ? journey.routePoints[target.pointIndex]?.id ?? "" : "";
    const targetKey = `${journey.id}:${playbackCameraTargetKey(target)}:${routePointId}`;
    const matchingFlight = Boolean(target.kind === "point" && cameraFlight?.target.kind === "point"
      && cameraFlight.target.pointIndex === target.pointIndex);
    const needsCameraCommand = lastCameraTargetKeyRef.current !== targetKey
      || (explicitlySelected && cameraFollowing === false)
      || (cameraFollowing === true && director.step?.kind === "stop" && !matchingFlight);
    const currentGate = arrivalGate?.journeyId === journey.id
      && arrivalGate.stepIndex === director.stepIndex
      && (arrivalGate.intentRevision === director.intentRevision || arrivalGate.released)
      && arrivalGate.routePointId === routePointId ? arrivalGate : null;
    let deferArrival = currentGate ? arrivalHolding : false;
    if (playbackMode === "full" && cameraFollowing !== undefined
      && director.step?.kind === "stop" && routePointId
      && (cameraFollowing !== false || explicitlySelected) && !currentGate) {
      // Claim the Stop before its first position commit. A new point command is
      // issued below; an already flying command for this point keeps its revision.
      const minCameraRevision = needsCameraCommand
        ? (cameraFlight?.revision ?? 0) + 1 : cameraFlight?.revision ?? 0;
      const released = !needsCameraCommand && matchingFlight && Boolean(cameraFlight?.settled);
      const nextGate: PlaybackArrivalGate = {
        journeyId: journey.id, routePointId, stepIndex: director.stepIndex,
        intentRevision: director.intentRevision, pointIndex: director.step.pointIndex,
        minCameraRevision, reclaimFromFree: cameraFollowing === false, released,
      };
      setArrivalGate(nextGate);
      deferArrival = !released;
    }
    if (director.step && director.step.kind !== "media"
      && director.step.kind !== "travel" && !deferArrival) {
      committedPositionRef.current = committedPlaybackPosition(journey, director.step);
    }
    if (needsCameraCommand) {
      lastCameraTargetKeyRef.current = targetKey;
      onCameraTargetChange(target, explicitlySelected);
    }
  }, [arrivalGate, cameraFlight, cameraFollowing, director.intentRevision, director.step,
    director.stepIndex, journey, onCameraTargetChange, playbackMode, arrivalHolding]);
  const mapBridge = usePlaybackMapBridge({ journey, director, root: overlayRef,
    reduceMotion: audioReactiveReducedMotion, commitSpatial });
  const arrivalGateMatchesCurrent = Boolean(arrivalGate && journey && journey.id === arrivalGate.journeyId
    && director.step?.kind === "stop" && director.stepIndex === arrivalGate.stepIndex
    && (director.intentRevision === arrivalGate.intentRevision || arrivalGate.released)
    && journey.routePoints[director.step.pointIndex]?.id === arrivalGate.routePointId);
  const arrivalPresentationPending = arrivalGateMatchesCurrent && arrivalHolding;
  useLayoutEffect(() => {
    if (!arrivalGate) return;
    if (!arrivalGateMatchesCurrent) {
      // The map bridge may already have queued this Stop's replacement gate in
      // an earlier layout effect. Clear only the stale gate this render saw.
      setArrivalGate((current) => current === arrivalGate ? null : current);
      return;
    }
    if (!arrivalPresentationPending && journey && director.step?.kind === "stop") {
      committedPositionRef.current = committedPlaybackPosition(journey, director.step);
      if (!arrivalGate.released) setArrivalGate({ ...arrivalGate, released: true });
    }
  }, [arrivalGate, arrivalGateMatchesCurrent, arrivalPresentationPending, director.step, journey]);
  const handlePresentationCommit = useCallback((presentedAssetId: string) => {
    if (!journey || !mapBridge.isCurrent()) return;
    committedPositionRef.current = commitPresentedPlaybackPosition(
      committedPositionRef.current, journey, director.step, presentedAssetId,
    );
    mapBridge.recordMedia();
  }, [director.step, journey, mapBridge.isCurrent, mapBridge.recordMedia]);

  // Keyboard: arrows step, space pauses, Esc exits.
  useEffect(() => {
    if (!director.isPlaying && !paused && !director.completed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
        return;
      }
      if (event.target instanceof Element && event.target.closest(".detailed-earth-map")) return;
      if (
        event.target instanceof HTMLInputElement
        || event.target instanceof HTMLSelectElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLButtonElement
      ) return;
      if (event.key === "ArrowRight") nextByViewer();
      else if (event.key === "ArrowLeft") backByViewer();
      else if (event.key === " ") {
        event.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [director.completed, director.isPlaying, paused, togglePlayback, nextByViewer, backByViewer, requestClose]);

  // The map joins the Playback focus loop only while a visible travel or stop
  // chapter gives it pointer ownership. Its native keyboard pan/zoom remains
  // available without making the rest of the Atlas interactive.
  useEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => {
      const mapHost = mapInteractiveRef.current
        ? document.querySelector<HTMLElement>('.detailed-earth-map[data-dive-owner="detail"]')
        : null;
      return [
        ...(mapHost ? mapHost.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) : []),
        ...root.querySelectorAll<HTMLElement>(
          'summary, button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => (
        element.tabIndex >= 0
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== "hidden"
      ));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !candidates.includes(current as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !candidates.includes(current as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    const firstButton = focusable()[0];
    firstButton?.focus();
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useLayoutEffect(() => {
    if (mapInteractive) return;
    if (document.activeElement instanceof Element
      && document.activeElement.closest(".detailed-earth-map")) {
      overlayRef.current?.querySelector<HTMLButtonElement>(".journey-playback__close")?.focus();
    }
  }, [mapInteractive]);

  // Review P1: a video beat is owned by the element, not by the wall-clock
  // budget - `playbackMediaWaitPolicy` holds the director until `ended`, so the
  // budget never drains and the CSS transition below never starts. The
  // element's real position is the honest source, mapped onto the stretch of the
  // bar the plan gave that beat, and written straight to the node on the
  // `timeupdate` the trim transport already listens to.
  const advanceProgressFillFromMedia = useCallback((
    element: HTMLVideoElement,
    trim: VideoTrimWindow | null,
    stepIndex: number,
  ) => {
    // The handler closes over the beat it was rendered for. A `timeupdate` that
    // lands after the director moved on describes the previous beat's element,
    // so it says nothing about where the bar is now.
    if (stepIndex !== stepIndexRef.current) return;
    const fill = progressFillRef.current;
    if (!plan || !plan.segments[stepIndex] || plan.totalDurationMs <= 0) return;
    const resolved = resolveVideoTrim(trim, element.duration);
    // Refuse the beat rather than own it at a position that cannot move: with
    // no measurable span every answer is `0`, and claiming the beat would also
    // silence the budget-driven write that is this beat's remaining chance of
    // advancing.
    if (!videoTrimPositionKnown(resolved, element.duration)) return;
    const playedFraction = videoTrimPlayedFraction(resolved, element.currentTime, element.duration);
    // One number for both readers, through the same helper the wall-clock beats
    // use: a fully played beat has consumed its whole span, so `remainingMs` is
    // the unplayed share of a unit budget.
    const fraction = playbackProgressFraction(plan, stepIndex, 1 - playedFraction, 1);
    mediaPositionRef.current = { stepIndex, fraction };
    if (!fill) return;
    fill.style.transitionDuration = "0ms";
    fill.style.width = `${fraction * 100}%`;
  }, [plan]);

  // Hand the rest of the beat to one CSS transition instead of a per-frame
  // render: at the start of a beat the fill is placed at the live position and
  // then animated, linearly and over exactly the remaining budget, to the point
  // the beat ends at. Pausing pins it where it is. The director hook runs
  // earlier in this component, so its timer effect has already booked this
  // beat's budget by the time this one reads it.
  useEffect(() => {
    const fill = progressFillRef.current;
    if (!fill || !plan) return;
    if (mediaPositionRef.current?.stepIndex === stepIndex) {
      // The element owns this beat's position; leave the width it wrote alone
      // and only make sure nothing is still animating toward a stale target.
      fill.style.transitionDuration = "0ms";
      return;
    }
    mediaPositionRef.current = null;
    const budget = getTimerBudget();
    const fraction = playbackProgressFraction(
      plan,
      stepIndex,
      budget?.remainingMs ?? 0,
      budget?.fullDurationMs ?? 0,
    );
    fill.style.transitionDuration = "0ms";
    fill.style.width = `${fraction * 100}%`;
    // Reduced motion keeps the bar honest but still: it moves once per beat,
    // which is exactly what the step-weighted bar did before this change.
    if (!budget || paused || hold || reduceMotion) return;
    // Read back a layout value so the browser keeps the position above as the
    // transition's start instead of collapsing both writes into one frame.
    void fill.offsetWidth;
    fill.style.transitionDuration = `${Math.max(0, budget.remainingMs)}ms`;
    fill.style.width = `${playbackProgressFraction(plan, stepIndex, 0, budget.fullDurationMs) * 100}%`;
  }, [getTimerBudget, hold, paused, plan, reduceMotion, stepIndex]);

  // Review P2: the accessible value follows whatever is moving the fill, but
  // only while the scrubber is focused, and at a rate an announcement can keep
  // up with. A paused beat samples once and stays put.
  //
  // Which source that is, is the beat's own answer, not this effect's: a
  // media-owned beat reads the element's position, every other beat reads the
  // wall-clock budget. Sampling the budget unconditionally is what the first
  // fix got wrong — a `video-ended` beat pins the budget at that beat's start
  // for the video's whole runtime, so the announced elapsed time stood still
  // while the bar moved.
  useEffect(() => {
    if (!scrubberFocused || !plan) {
      setLivePositionFraction(null);
      return;
    }
    const sample = () => {
      const media = mediaPositionRef.current;
      if (media?.stepIndex === stepIndex) {
        setLivePositionFraction(media.fraction);
        return;
      }
      const budget = getTimerBudget();
      setLivePositionFraction(playbackProgressFraction(
        plan,
        stepIndex,
        budget?.remainingMs ?? 0,
        budget?.fullDurationMs ?? 0,
      ));
    };
    sample();
    // A held beat used to stop the sampler, which is exactly backwards for the
    // beat a video holds: that is the beat whose position only the element
    // knows. A held beat with no media owner re-reads a frozen budget and sets
    // the identical number, which React drops without a render.
    if (paused) return;
    const timer = window.setInterval(sample, 1_000);
    return () => window.clearInterval(timer);
  }, [getTimerBudget, paused, plan, scrubberFocused, stepIndex]);

  if (!journey) return null;

  const step: PlaybackStep | undefined = director.step;
  const activeMedia = step?.kind === "media"
    ? playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex]
    : null;
  const activeRead = activeMedia ? mediaReads[activeMedia.id] : null;
  const activeMediaGate = activeMedia
    ? playbackMediaGate(
      activeRead,
      activeMedia.mimeType.startsWith("image/")
        ? decodeRegistryRef.current.readiness(activeMedia.id)
        : undefined,
      activeMedia.mimeType.startsWith("image/"),
    )
    : null;
  const activePoint = step?.kind === "stop" || step?.kind === "media"
    ? journey.routePoints[step.pointIndex]
    : step?.kind === "travel"
      ? journey.routePoints[step.to]
      : null;
  // #456: one Route Point is one chapter. The arrival caption and the chapter's
  // media live in the SAME container across the stop -> media seam, so entering
  // the memory reflows one surface instead of swapping two full-screen ones.
  // Density decides what that container may hold: an `empty` chapter is the
  // place itself and gets no media region at all.
  const chapterPointIndex = step?.kind === "stop" || step?.kind === "media"
    ? step.pointIndex
    : null;
  const chapterDensity = chapterPointIndex === null
    ? null
    : routePointChapterDensity(journey, chapterPointIndex);
  const chapterMedia = chapterPointIndex === null
    ? []
    : playbackMediaForPoint(journey, chapterPointIndex);
  const sequencePresentation = playbackSequenceChapterPresentation(journey, step);
  const sequencePeeks = sequencePresentation
    ? sequencePresentation.peekMediaIndexes.flatMap((mediaIndex) => {
      const asset = chapterMedia[mediaIndex];
      const read = asset ? mediaReads[asset.id] : null;
      if (!asset || read?.status !== "ready") return [];
      const url = asset.mimeType.startsWith("image/") ? read.url : read.preview?.url;
      return url ? [{ asset, url }] : [];
    })
    : undefined;
  // The arrival beat already waits for this asset to decode (`playbackHoldReason`),
  // so showing it as the chapter's opening still costs no extra read and removes
  // the blank frame the media beat used to enter from. A video chapter keeps the
  // reserved frame quiet until its own stage owns the runtime.
  const chapterOpeningAsset = chapterMedia[0] ?? null;
  const chapterOpeningRead = chapterOpeningAsset ? mediaReads[chapterOpeningAsset.id] : null;
  const chapterOpeningUrl = playbackChapterOpeningUrl(
    step?.kind,
    chapterOpeningAsset,
    chapterOpeningRead,
    chapterOpeningAsset?.mimeType.startsWith("image/")
      ? decodeRegistryRef.current.readiness(chapterOpeningAsset.id)
      : undefined,
  );
  // Where the beat that is playing starts on the plan: a full remaining budget
  // means nothing of it has been consumed yet.
  const beatStartFraction = playbackProgressFraction(plan, director.stepIndex, 1, 1);
  const positionFraction = livePositionFraction ?? beatStartFraction;
  const chapterTicks = plan
    ? plan.segments
      .filter((segment) => segment.kind === "arrival")
      .map((segment) => ({
        stepIndex: segment.stepIndex,
        fraction: segment.startMs / plan.totalDurationMs,
      }))
    : [];

  return (
    <div
      ref={overlayRef}
      className={`journey-playback${paused ? " is-paused" : ""}${controlsHidden ? " is-controls-hidden" : ""}`}
      role="dialog"
      aria-modal={mapInteractive ? "false" : "true"}
      aria-label="播放旅程"
      data-map-interactive={mapInteractive ? "true" : "false"}
      data-camera-follow={cameraFollowing === false ? "free" : "follow"}
      // #194: Playback follows the one product-level compact-mobile contract
      // instead of a breakpoint of its own; journey-playback.css keys off this.
      data-mobile-v2={compactMobileLayoutMarker(compactMobileLayout)}
      data-playback-phase={step?.kind ?? "idle"}
      data-arrival-gate={arrivalPresentationPending ? "pending"
        : arrivalGateMatchesCurrent ? cameraFollowing === false ? "free" : "settled" : "none"}
      data-arrival-camera-revision={arrivalGateMatchesCurrent ? arrivalGate?.minCameraRevision : undefined}
      data-playback-mode={playbackMode}
      data-playback-step={director.stepIndex}
      data-playback-steps={director.steps.length}
      data-playback-intent={director.intentRevision}
      data-playback-prefetch-suppressed={suppressedPrefetchDispatchCount}
      data-playback-prefetch-dispatch-intent={plannedPrefetchRevision}
      // #195 Phase 2: who owns the current beat's completion. `none` is an
      // untrimmed beat, still on the pre-#195 `ended` ownership; the other
      // values are the trim transport's own states, published so the browser
      // QA lane can grade the segment handover directly instead of inferring
      // it from wall-clock timing.
      data-video-trim={videoTrimHoldingStatus ?? "none"}
      // #197: why playback is waiting, published beside the step so the
      // browser QA lane counts decode holds directly instead of inferring them
      // from wall-clock gaps. `video` and `trim` are a beat's own ownership of
      // its runtime, not a lookahead that ran out.
      data-playback-hold={holdReason}
      data-playback-presentation-hold={presentationPending ? "waiting" : "none"}
      // #456: the sparse chapter density of the Route Point on screen, so the
      // continuity lane grades 0 / 1 / 3 media directly instead of counting DOM.
      data-playback-chapter-density={chapterDensity ?? "none"}
      data-playback-map-bridge={mapBridge.boundary?.direction ?? "none"}
      data-playback-map-bridge-point={mapBridge.boundary?.pointIndex}
    >
      <audio
        ref={audioRef}
        src={soundtrackRead?.status === "ready" ? soundtrackRead.url : undefined}
        loop
        preload="metadata"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* ── Chapter content ─────────────────────────────────────────────── */}
      {statusMessage ? (
        <div className="journey-playback__status" role="status">{statusMessage}</div>
      ) : null}

      <div className="journey-playback__stage">
        {step?.kind === "intro" ? (
          <>
            <div className="journey-playback__intro-brand" aria-hidden="true">
              <StartripsWordmark size={42} intro />
            </div>
            <div className="journey-playback__intro">
              <p>{playbackMode === "quick-recap" ? "QUICK RECAP" : "JOURNEY PLAYBACK"}</p>
              <h2>{journey.title}</h2>
              <span>{journey.startedOn}{journey.endedOn ? ` — ${journey.endedOn}` : ""}</span>
            </div>
          </>
        ) : null}

        {(step?.kind === "travel" || arrivalPresentationPending) && activePoint ? (
          <div className="journey-playback__travel">
            <div className="journey-playback__travel-cue" aria-hidden="true">
              <StartripsJourneyCue state="travel" size={54} />
            </div>
            <p>正在前往</p>
            <h3>{activePoint.label || `途径点 ${step?.kind === "travel" ? step.to + 1 : (chapterPointIndex ?? 0) + 1}`}</h3>
            <div className="journey-playback__route-hint" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : null}

        {chapterPointIndex !== null && activePoint && !arrivalPresentationPending ? (
          <div
            className={`journey-playback__chapter journey-playback__chapter--${chapterDensity}`}
            data-chapter-beat={step?.kind}
            data-chapter-point={chapterPointIndex}
          >
            {/* The arrival caption is the chapter's own heading: it opens the
                chapter and STAYS while its media plays, so a populated chapter
                never reads as arrival-then-a-separate-screen. */}
            <div className={`journey-playback__stop${step?.kind === "media" ? " is-receded" : ""}`}>
              <div className="journey-playback__stop-cue" aria-hidden="true">
                <StartripsJourneyCue state="arrived" size={52} />
              </div>
              <p>STOP {chapterPointIndex + 1}</p>
              <h3>{activePoint.label || `途径点 ${chapterPointIndex + 1}`}</h3>
              {activePoint.note ? (
                <blockquote>{activePoint.note}</blockquote>
              ) : null}
            </div>

            {/* `empty` renders no media region at all — the place IS the memory. */}
            {chapterDensity === "empty" ? null : (
              <div className="journey-playback__chapter-media">
                {/* The arrival already waits for this asset to decode, so the
                    media beat enters from the frame it is about to own rather
                    than from a blank one. */}
                {step?.kind === "stop" && chapterOpeningUrl ? (
                  <img
                    className="journey-playback__chapter-opening"
                    src={chapterOpeningUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                  />
                ) : null}

        {step?.kind === "media" && activeMedia ? (
          <PlaybackMediaStage
            asset={activeMedia}
            url={activeRead?.status === "ready" ? activeRead.url : null}
            preview={activeRead?.status === "ready" ? activeRead.preview : undefined}
            intent={`${journey.id}:${playbackStepIdentity(journey, step)}:${director.stepIndex}:${director.intentRevision}:${activeVideoTrimInMs}:${activeVideoTrimOutMs}`}
            mapEntrance={mapBridge.entrance}
            isIntentCurrent={mapBridge.isCurrent}
            sequencePeeks={sequencePeeks}
            stepIndex={director.stepIndex}
            imageReady={activeMediaGate === "ready"}
            videoPositionReady={!activeVideoTrim || (enteredVideoTrimKeyRef.current === activeVideoTrimKey
              && (videoTrimHoldingStatus === "playing" || videoTrimHoldingStatus === "unavailable"))}
            failed={activeMediaGate === "error" || videoFallbackAssetId === activeMedia.id}
            buffering={videoTrimWaiting}
            paused={paused}
            reduceMotion={audioReactiveReducedMotion}
            videoWaitTimeoutMs={VIDEO_STALL_WATCHDOG_MS}
            onVideoElement={bindVideoElement}
            onPendingChange={handlePresentationPendingChange}
            onPresented={handlePresentationCommit}
            onUnavailable={() => {
              setVideoFallbackAssetId(activeMedia.id);
              settleVideoTrimSeek(activeMedia.id, director.stepIndex, "unavailable");
              setHoldReason("none");
            }}
            video={activeMedia.mimeType.startsWith("video/") && activeRead?.status === "ready" ? (
                  <video
                    key={activeMedia.id}
                    src={activeRead.url}
                    playsInline
                    onEnded={() => {
                      clearVideoStallWatchdog();
                      videoStalledAssetIdRef.current = null;
                      setHoldReason("none");
                      director.complete();
                    }}
                    onError={() => {
                      clearVideoStallWatchdog();
                      videoStalledAssetIdRef.current = null;
                      setVideoFallbackAssetId(activeMedia.id);
                      settleVideoTrimSeek(activeMedia.id, director.stepIndex, "unavailable");
                      setHoldReason("none");
                    }}
                    onLoadedMetadata={(event) => {
                      if (!activeVideoTrim || activeVideoTrim.assetId !== activeMedia.id) return;
                      // Only while the beat is still holding: once it is
                      // `playing` the segment is under way, and once it is
                      // `unavailable` the watchdog has already given up, so
                      // neither state may issue another seek. That is what
                      // bounds the retry.
                      if (!videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)) return;
                      if (!videoTrimHoldsStep(videoTrimSeek!.status)) return;
                      applyVideoTrimEntry(
                        event.currentTarget,
                        resolveVideoTrim(activeVideoTrim.trim, event.currentTarget.duration),
                        activeMedia.id,
                        director.stepIndex,
                      );
                    }}
                    onSeeked={(event) => {
                      // A seek lands on the nearest decodable frame, which can
                      // be short of the in-point. Re-run the entry rule instead
                      // of assuming the first attempt succeeded: it answers
                      // `playing` when the element really is inside the segment
                      // and re-seeks when it is not, so releasing the budget
                      // always means the segment is under way.
                      //
                      // Bounded to the holding states exactly as
                      // `loadedmetadata` is, and for the same reason: once the
                      // watchdog has settled `unavailable` that degradation is
                      // decided, and a later native scrub must not re-seek the
                      // element and hand the beat a second completion owner.
                      if (!activeVideoTrim || activeVideoTrim.assetId !== activeMedia.id) return;
                      if (!videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)) return;
                      if (!videoTrimHoldsStep(videoTrimSeek!.status)) return;
                      applyVideoTrimEntry(
                        event.currentTarget,
                        resolveVideoTrim(activeVideoTrim.trim, event.currentTarget.duration),
                        activeMedia.id,
                        director.stepIndex,
                      );
                    }}
                    onWaiting={() => {
                      // The director spends the beat's budget on the wall clock,
                      // so a segment that stops progressing has to freeze it.
                      if (!activeVideoTrim || activeVideoTrim.assetId !== activeMedia.id) return;
                      if (!videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)) return;
                      if (!videoTrimBuffersOnStall(videoTrimSeek!.status, paused)) return;
                      settleVideoTrimSeek(activeMedia.id, director.stepIndex, "buffering");
                    }}
                    onPlaying={() => {
                      recoverVideoPlayback(activeMedia.id);
                      if (!activeVideoTrim || activeVideoTrim.assetId !== activeMedia.id) return;
                      if (!videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)) return;
                      if (videoTrimSeek!.status !== "buffering") return;
                      settleVideoTrimSeek(activeMedia.id, director.stepIndex, "playing");
                    }}
                    onProgress={() => clearVideoStallWatchdog()}
                    onTimeUpdate={(event) => {
                      clearVideoStallWatchdog();
                      advanceProgressFillFromMedia(
                        event.currentTarget,
                        activeVideoTrim?.assetId === activeMedia.id ? activeVideoTrim.trim : null,
                        director.stepIndex,
                      );
                      if (
                        !activeVideoTrim
                        || activeVideoTrim.assetId !== activeMedia.id
                        || !videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)
                        || (videoTrimSeek!.status !== "playing" && videoTrimSeek!.status !== "buffering")
                      ) return;
                      // `timeupdate` is the proof a buffering segment resumed:
                      // it only fires when `currentTime` actually moved.
                      if (videoTrimSeek!.status === "buffering") {
                        settleVideoTrimSeek(activeMedia.id, director.stepIndex, "playing");
                      }
                      const element = event.currentTarget;
                      const action = videoTrimProgressAction(
                        resolveVideoTrim(activeVideoTrim.trim, element.duration),
                        element.currentTime,
                      );
                      if (action.kind === "complete") {
                        setHoldReason("none");
                        director.complete();
                        return;
                      }
                      if (action.kind === "seek") {
                        try {
                          element.currentTime = action.toSeconds;
                        } catch {
                          settleVideoTrimSeek(activeMedia.id, director.stepIndex, "unavailable");
                        }
                      }
                    }}
                    onStalled={() => {
                      // `stalled` can be transient. Keep Full Playback ownership
                      // while the browser may recover, and only fall back if no
                      // progress/timeupdate may clear only this bounded watchdog; `playing` is the proof that playback resumed and may clear a persisted play failure.
                      if (paused) videoStalledAssetIdRef.current = activeMedia.id;
                      else scheduleVideoStallWatchdog(activeMedia.id);
                      if (!activeVideoTrim || activeVideoTrim.assetId !== activeMedia.id) return;
                      if (!videoTrimSeekApplies(videoTrimSeek, activeMedia.id, director.stepIndex)) return;
                      if (!videoTrimBuffersOnStall(videoTrimSeek!.status, paused)) return;
                      settleVideoTrimSeek(activeMedia.id, director.stepIndex, "buffering");
                    }}
                  />
            ) : null}
          />
        ) : null}
              </div>
            )}
          </div>
        ) : null}

        {step?.kind === "outro" ? (
          <>
            <div className="journey-playback__outro-brand" aria-hidden="true">
              <StartripsWordmark size={42} />
            </div>
            <div className="journey-playback__outro">
              <h2>{journey.title}</h2>
              <p>{journey.routePoints.length} 个地点 · 这段路已经走完</p>
            </div>
          </>
        ) : null}
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      {playbackMode === "quick-recap" && quickRecapSelectionSummary ? (
        <details
          className="journey-playback__selection-summary"
          onToggle={(event) => setSelectionSummaryOpen(event.currentTarget.open)}
        >
          <summary>本次整理</summary>
          <div className="journey-playback__selection-summary-body">
            {quickRecapSelectionSummary.map((entry, chapterIndex) => {
              const point = entry.routePointId
                ? quickRecapSourceJourney?.routePoints.find((candidate) => candidate.id === entry.routePointId) ?? null
                : null;
              return (
                <section key={`${entry.routePointId ?? "journey"}:${chapterIndex}`}>
                  <header>
                    <span>Route Point</span>
                    <strong>{point?.label || (entry.routePointId ? `Route Point ${chapterIndex + 1}` : "旅程开场")}</strong>
                  </header>
                  <p>Route Point Media · 使用 {entry.included.length} · 省略 {entry.omitted.length}</p>
                  <ul>
                    {entry.included.map((item) => {
                      const asset = quickRecapSourceJourney?.media.find((candidate) => candidate.id === item.assetId);
                      return (
                        <li key={`included:${item.assetId}`}>
                          <span aria-hidden="true">✓</span>
                          <strong>{asset ? stripMediaExtension(asset.fileName) : item.assetId}</strong>
                          <small>{quickRecapSelectionReasonLabel(item.selectionReason)}</small>
                        </li>
                      );
                    })}
                    {entry.omitted.map((item) => {
                      const asset = quickRecapSourceJourney?.media.find((candidate) => candidate.id === item.assetId);
                      return (
                        <li key={`omitted:${item.assetId}`} className="is-omitted">
                          <span aria-hidden="true">–</span>
                          <strong>{asset ? stripMediaExtension(asset.fileName) : item.assetId}</strong>
                          <small>{quickRecapOmissionReasonLabel(item.reason)}</small>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </details>
      ) : null}

      <button className="journey-playback__close" type="button" onClick={requestClose} aria-label="退出播放">
        <IconX size={22} stroke={1.35} aria-hidden="true" />
      </button>
      {cameraFollowing === false && onReturnToCurrentLocation ? (
        <button
          className="journey-playback__return-location"
          type="button"
          onClick={onReturnToCurrentLocation}
        >
          回到当前地点
        </button>
      ) : null}
      <nav className="journey-playback__controls" aria-label="播放控制">
        <button type="button" onClick={backByViewer} aria-label="上一个章节"><IconChevronLeft size={20} stroke={1.35} aria-hidden="true" /></button>
        <button
          type="button"
          className={paused ? "is-active" : ""}
          onClick={togglePlayback}
          aria-label={director.completed ? "重新播放" : paused ? "继续播放" : "暂停播放"}
          aria-pressed={paused}
        >
          {paused || director.completed
            ? <IconPlayerPlay size={20} stroke={1.35} aria-hidden="true" />
            : <IconPlayerPause size={20} stroke={1.35} aria-hidden="true" />}
        </button>
        <button type="button" onClick={nextByViewer} aria-label="下一个章节"><IconChevronRight size={20} stroke={1.35} aria-hidden="true" /></button>
        <label className="journey-playback__tempo">
          <select
            value={tempo}
            aria-label="播放节奏"
            onChange={(event) => changeTempo(event.currentTarget.value as PlaybackTempo)}
          >
            <option value="fast">快速</option>
            <option value="standard">标准</option>
            <option value="immersive">沉浸</option>
          </select>
        </label>
        <div className="journey-playback__progress">
          <span
            ref={progressFillRef}
            className="journey-playback__progress-fill"
            // The width the beat starts at. The effect above hands the rest of
            // the beat to one CSS transition, so the fill keeps moving inside a
            // beat without a per-frame render.
            style={{
              width: `${beatStartFraction * 100}%`,
              transitionProperty: "width",
              transitionTimingFunction: "linear",
              transitionDuration: "0ms",
            }}
          />
          <div className="journey-playback__progress-chapters" aria-hidden="true">
            {chapterTicks.map((tick) => (
              <i key={tick.stepIndex} style={{ left: `${tick.fraction * 100}%` }} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={PROGRESS_SCRUB_STEPS}
            step={1}
            value={Math.round(positionFraction * PROGRESS_SCRUB_STEPS)}
            aria-label="播放进度"
            aria-valuetext={playbackElapsedLabel(plan, positionFraction)}
            onFocus={() => setScrubberFocused(true)}
            onBlur={() => setScrubberFocused(false)}
            // Arrows stay chapter-sized. The bar is time-scaled now, so a
            // native arrow step would move a thousandth of the run and usually
            // land back on the same beat; the overlay's global arrow handler
            // deliberately ignores a focused input, so the keys are wired here.
            // Review P2: scrubber arrows seek the plan's explicit target beat
            // rather than re-deriving elapsed-time navigation here. The reducer
            // preserves pause ownership for that seek just as it does for next/back.
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowDown"
                  ? -1
                  : 0;
              if (direction === 0 || !plan) return;
              event.preventDefault();
              seekByViewer(nextMeaningfulStepIndex(plan, director.stepIndex, direction));
            }}
            onChange={(event) => {
              if (!plan) return;
              const elapsedMs = playbackElapsedForFraction(
                plan,
                Number(event.currentTarget.value) / PROGRESS_SCRUB_STEPS,
              );
              const segment = playbackSegmentAtElapsed(plan, elapsedMs);
              if (segment) seekByViewer(segment.stepIndex);
            }}
          />
        </div>
      </nav>

      {/* ── Soundtrack light strip (hidden engine; follows playing) ─────── */}
      {soundtrack && soundtrackRead?.status === "ready" ? (
        <div className={`journey-playback__soundtrack${director.isPlaying ? " is-playing" : ""}`} aria-hidden="true">
          <div ref={lightStripRef} className="journey-playback__soundtrack-light"><span /><span /><span /></div>
          <small>{stripMediaExtension(soundtrack.fileName)}</small>
        </div>
      ) : null}
    </div>
  );
}

/** The scrub range is time-scaled, so it needs its own resolution: one step per
 * thousandth of the plan, fine enough that dragging never skips a short beat. */
const PROGRESS_SCRUB_STEPS = 1000;

function playbackElapsedLabel(plan: PlaybackPlan | null, positionFraction: number) {
  if (!plan) return "0:00 / 0:00";
  const elapsedMs = playbackElapsedForFraction(plan, positionFraction);
  return `${formatPlaybackClock(elapsedMs)} / ${formatPlaybackClock(plan.totalDurationMs)}`;
}

function formatPlaybackClock(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${`${totalSeconds % 60}`.padStart(2, "0")}`;
}
