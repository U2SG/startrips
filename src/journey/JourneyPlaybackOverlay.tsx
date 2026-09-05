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
import { useAtlasView } from "./atlasView";
import { mediaReadIsFresh } from "./mediaReadRefresh";
import {
  createDecodeRegistry,
  decodeImageUrl,
  type DecodedReadiness,
} from "./mediaPrefetch";
import { useJourneyPlaybackDirector, type PlaybackStepDurationResolver } from "./useJourneyPlaybackDirector";
import {
  buildPlaybackSteps,
  playbackCameraTargetForStep,
  playbackCameraTargetKey,
  playbackMediaForPoint,
  playbackMediaWaitPolicy,
  playbackStepIdentity,
  type PlaybackCameraTarget,
  type PlaybackStep,
} from "./journeyPlayback";
import { planPrefetchWindow, readyMsAheadForTempo } from "./playbackPrefetchPlan";
import { syncPlaybackMediaElement } from "./mediaPlaybackSync";
import {
  resolveVideoTrim,
  videoTrimBuffersOnStall,
  videoTrimEntryAction,
  videoTrimHoldsStep,
  videoTrimProgressAction,
  videoTrimSeekApplies,
  videoTrimStatusAfterPauseChange,
  type VideoTrimSeekStatus,
  type VideoTrimWindow,
} from "./videoTrimPlayback";
import { remapPlaybackStepIndex } from "./quickRecapPlayback";
import { playbackControlsMayAutoHide } from "./playbackControls";
import type { PlaybackTempo } from "./journeyPlaybackPlan";
import { journeySoundtrack, stripMediaExtension } from "./journeyModel";
import { compactMobileLayoutMarker, useCompactMobileLayout } from "./mobileLayout";
import { createSoundtrackSampler } from "../motion/audioSampler";
import {
  resetAudioAtmosphereEnergy,
  writeAudioAtmosphereEnergy,
} from "../motion/audioAtmosphere";
import { prefersReducedMotion } from "../motion/preferences";
import type { Journey, JourneyMediaAsset } from "./types";

type MediaRead =
  | { status: "loading" }
  | { status: "ready"; url: string; issuedAt: number; expiresAt: number }
  | { status: "error"; message: string };

/**
 * Whether a cached read may still be reused instead of re-signed.
 *
 * The overlay used to reuse a ready read forever, which was safe while every
 * signed URL lived 900 s: a whole playback ran well inside one lifetime. A
 * share-scoped read is capped at 90 s by default and again by the remaining
 * grant, so a URL prefetched at the head of the window can expire before the
 * chapter that needs it. Reuse is now a lifetime question.
 */
export function playbackReadIsReusable(
  read: MediaRead | undefined,
  now: number,
): boolean {
  return read?.status === "ready"
    && mediaReadIsFresh(read.issuedAt, read.expiresAt, now);
}

export type PlaybackMediaGate = "waiting" | "ready" | "error";

const VIDEO_STALL_WATCHDOG_MS = 4_000;

export function playbackMediaGate(
  read: MediaRead | null | undefined,
  decodeReadiness: DecodedReadiness | undefined,
  isImage: boolean,
): PlaybackMediaGate {
  if (!read || read.status === "loading") return "waiting";
  if (read.status === "error") return "error";
  if (!isImage) return "ready";
  if (decodeReadiness?.status === "error") return "error";
  return decodeReadiness?.status === "decoded" ? "ready" : "waiting";
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
  initialSoundtrackRead,
  reduceMotion,
  stepDurationResolver,
  mediaTrimResolver,
  onTempoChange,
  playbackMode = "full",
  statusMessage,
}: {
  journey: Journey | null;
  onClose: () => void;
  onCameraTargetChange: (target: PlaybackCameraTarget) => void;
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
  onTempoChange?: (tempo: PlaybackTempo) => void;
  playbackMode?: "full" | "quick-recap";
  statusMessage?: string | null;
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
  const [hold, setHold] = useState(false);
  const [videoFallbackAssetId, setVideoFallbackAssetId] = useState<string | null>(null);
  const director = useJourneyPlaybackDirector(journey, hold, stepDurationResolver);
  const { phase, paused, pause, resume, next, back, seek, exit, steps, stepIndex, tempo, setTempo } = director;
  // Report a real tempo change only. The director resets to the initial tempo
  // whenever the journey changes, and a rebuilt plan hands us a new `journey`
  // object every time, so re-announcing the current tempo would loop.
  const notifiedTempoRef = useRef<PlaybackTempo>(tempo);
  useEffect(() => {
    if (notifiedTempoRef.current === tempo) return;
    notifiedTempoRef.current = tempo;
    onTempoChange?.(tempo);
  }, [onTempoChange, tempo]);

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
  useEffect(() => {
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
    exit();
    onClose();
  }, [exit, onClose]);
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
      setHold(false);
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
  // Entering the beat — including re-entering it with the step scrubber, which
  // hands the director a fresh full budget while the `<video>` keeps its React
  // key and therefore its `currentTime`. A remounted element has no metadata
  // yet and is positioned by `loadedmetadata`; a surviving one is repositioned
  // here, because that event will not fire a second time.
  useEffect(() => {
    clearVideoTrimWatchdog();
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
    director.stepIndex,
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
  const playbackSteps = useMemo(
    () => journey ? buildPlaybackSteps(journey) : [],
    [journey],
  );
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
    if (holdTarget && !prefetchWindow.assetIds.includes(holdTarget.id)) {
      return [holdTarget.id, ...prefetchWindow.assetIds];
    }
    return prefetchWindow.assetIds;
  }, [director.stepIndex, director.tempo, durationForStep, journey, playbackSteps]);
  // `playbackSteps` is rebuilt per journey, but the window is a plain array;
  // the effects below key off its contents so they do not churn per render.
  const prefetchKey = prefetchAssetIds.join(",");
  const prefetchAssetIdsRef = useRef(prefetchAssetIds);
  prefetchAssetIdsRef.current = prefetchAssetIds;

  // Signed reads follow the same window, through the same single read path, so
  // a decode is never scheduled for an asset that has no URL yet. This is
  // strictly fewer concurrent reads than before, when arriving at a stop
  // requested every asset of the chapter at once.
  useEffect(() => {
    for (const assetId of prefetchAssetIdsRef.current) loadMediaRead(assetId);
  }, [loadMediaRead, prefetchKey]);

  // Review P2: decode media AHEAD of display so a chapter never mounts <img>
  // with a loading gap. Videos stay at read only; images alone are decoded.
  useEffect(() => {
    for (const assetId of prefetchAssetIdsRef.current) {
      const asset = mediaById.get(assetId);
      if (!asset?.mimeType.startsWith("image/")) continue;
      const read = mediaReads[assetId];
      if (read?.status === "ready") {
        decodeRegistryRef.current.ensure(assetId, read.url);
      }
    }
  }, [decodeSettleRevision, mediaById, mediaReads, prefetchKey]);

  // Review P2: while a media chapter's image is not decoded yet, hold the
  // director so it never advances into a blank frame. Terminal read/decode
  // failures are settled too: they release the hold so playback can show an
  // explicit fallback instead of deadlocking forever.
  useEffect(() => {
    if (!journey) return;
    const step = director.step;
    if (step?.kind === "stop") {
      // Hold the STOP phase until this chapter's first image is decoded. If
      // the signed read or browser decode fails, release the hold and let the
      // media step render its recoverable error state.
      const firstImage = playbackHoldTargetMedia(journey, step);
      if (!firstImage) {
        setHold(false);
        return;
      }
      const gate = playbackMediaGate(
        mediaReads[firstImage.id],
        decodeRegistryRef.current.readiness(firstImage.id),
        true,
      );
      setHold(gate === "waiting");
      return;
    }
    if (step?.kind !== "media") {
      setHold(false);
      return;
    }
    const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
    if (!asset) {
      setHold(false);
      return;
    }
    const isImage = asset.mimeType.startsWith("image/");
    const gate = playbackMediaGate(
      mediaReads[asset.id],
      isImage ? decodeRegistryRef.current.readiness(asset.id) : undefined,
      isImage,
    );
    // Successful Full Journey video chapters are owned by the media element's
    // real `ended` event. Once this asset has recorded a media/play() failure,
    // keep the failure state stable across renders so the legacy fallback timer
    // can run instead of immediately re-acquiring the hold.
    if (asset.mimeType.startsWith("video/") && videoFallbackAssetId === asset.id) {
      setHold(false);
      return;
    }
    // #195 Phase 2: a trimmed video beat is owned by its segment instead of by
    // the element's `ended` event. Hold only while the element is being moved
    // onto the in-point, then release so the director spends exactly the
    // `outMs - inMs` the plan booked — that equality is what makes step
    // accounting and real elapsed playback agree for a non-zero in-point. An
    // `unavailable` trim falls through to the untrimmed policy below.
    if (
      asset.mimeType.startsWith("video/")
      && videoTrimSeekApplies(videoTrimSeek, asset.id, director.stepIndex)
      && videoTrimSeek!.status !== "unavailable"
    ) {
      setHold(videoTrimHoldsStep(videoTrimSeek!.status));
      return;
    }
    setHold(playbackMediaWaitPolicy(asset, gate) !== "none");
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
      director.isPlaying && !paused,
      asset?.mimeType.startsWith("video/")
        ? () => {
            clearVideoStallWatchdog();
            videoStalledAssetIdRef.current = null;
            setVideoFallbackAssetId(asset.id);
          }
        : undefined,
    );
  }, [clearVideoStallWatchdog, director.isPlaying, director.stepIndex, journey, mediaReads, paused]);

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
    const mayAutoHide = () => playbackControlsMayAutoHide({
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
  }, [director.isPlaying, director.stepIndex, paused]);

  // Review P2: toggle playback from the user gesture so audio.play() runs
  // inside user activation; the soundtrack effect below stays as the
  // synchronization/fallback path.
  const togglePlayback = useCallback(() => {
    if (paused) {
      const audio = audioRef.current;
      if (audio && soundtrackRead?.status === "ready") {
        if (!audioReactiveReducedMotion) samplerRef.current.start(audio);
        samplerRef.current.setPlaying(true);
        void audio.play().catch(() => undefined);
      }
      // Run video.play() inside the same user gesture as the Startrips resume
      // action so browser user-activation rules do not create a second state.
      syncPlaybackMediaElement(videoRef.current, true);
      resume();
    } else {
      samplerRef.current.setPlaying(false);
      syncPlaybackMediaElement(videoRef.current, false);
      pause();
    }
  }, [audioReactiveReducedMotion, paused, pause, resume, soundtrackRead?.status === "ready"]);

  // Camera ownership follows playback semantics. Intro/outro frame the whole
  // Journey; travel/stop/media point at one route point. The key guard avoids
  // reissuing the same point command across stop -> media chapters.
  const lastCameraTargetKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const target = playbackCameraTargetForStep(director.step, journey);
    if (!target || !journey) return;
    const targetKey = `${journey.id}:${playbackCameraTargetKey(target)}`;
    if (lastCameraTargetKeyRef.current === targetKey) return;
    lastCameraTargetKeyRef.current = targetKey;
    onCameraTargetChange(target);
  }, [director.step, journey, onCameraTargetChange]);

  // Keyboard: arrows step, space pauses, Esc exits.
  useEffect(() => {
    if (!director.isPlaying && !paused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
        return;
      }
      if (
        event.target instanceof HTMLInputElement
        || event.target instanceof HTMLSelectElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLButtonElement
      ) return;
      if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") back();
      else if (event.key === " ") {
        event.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [director.isPlaying, paused, togglePlayback, next, back, requestClose]);

  // Review P2: keep Tab focus inside the playback overlay.
  useEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => [...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => (
      element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden"
    ));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
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
  const progress = stepsProgress(director.stepIndex, director.steps.length);
  const chapterStepIndexes = director.steps.flatMap((candidate, index) => (
    candidate.kind === "stop" ? [index] : []
  ));

  return (
    <div
      ref={overlayRef}
      className={`journey-playback${paused ? " is-paused" : ""}${controlsHidden ? " is-controls-hidden" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="播放旅程"
      // #194: Playback follows the one product-level compact-mobile contract
      // instead of a breakpoint of its own; journey-playback.css keys off this.
      data-mobile-v2={compactMobileLayoutMarker(compactMobileLayout)}
      data-playback-phase={step?.kind ?? "idle"}
      data-playback-mode={playbackMode}
      data-playback-step={director.stepIndex}
      data-playback-steps={director.steps.length}
      // #195 Phase 2: who owns the current beat's completion. `none` is an
      // untrimmed beat, still on the pre-#195 `ended` ownership; the other
      // values are the trim transport's own states, published so the browser
      // QA lane can grade the segment handover directly instead of inferring
      // it from wall-clock timing.
      data-video-trim={videoTrimHoldingStatus ?? "none"}
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
          <div className="journey-playback__intro">
            <p>{playbackMode === "quick-recap" ? "QUICK RECAP" : "JOURNEY PLAYBACK"}</p>
            <h2>{journey.title}</h2>
            <span>{journey.startedOn}{journey.endedOn ? ` — ${journey.endedOn}` : ""}</span>
          </div>
        ) : null}

        {step?.kind === "travel" && activePoint ? (
          <div className="journey-playback__travel">
            <p>正在前往</p>
            <h3>{activePoint.label || `途径点 ${step.to + 1}`}</h3>
            <div className="journey-playback__route-hint" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : null}

        {step?.kind === "stop" && activePoint ? (
          <div className="journey-playback__stop">
            <p>STOP {step.pointIndex + 1}</p>
            <h3>{activePoint.label || `途径点 ${step.pointIndex + 1}`}</h3>
            {activePoint.note ? (
              <blockquote>{activePoint.note}</blockquote>
            ) : null}
          </div>
        ) : null}

        {step?.kind === "media" && activeMedia ? (
          <div className="journey-playback__media">
            {activeMediaGate === "error" ? (
              <div className="journey-playback__media-state is-error">媒体暂不可用，继续播放下一段</div>
            ) : activeMedia.mimeType.startsWith("video/")
              ? activeRead?.status === "ready"
                ? <video
                    ref={videoRef}
                    key={activeMedia.id}
                    src={activeRead.url}
                    autoPlay
                    playsInline
                    onEnded={() => {
                      clearVideoStallWatchdog();
                      videoStalledAssetIdRef.current = null;
                      setHold(false);
                      director.complete();
                    }}
                    onError={() => {
                      clearVideoStallWatchdog();
                      videoStalledAssetIdRef.current = null;
                      setVideoFallbackAssetId(activeMedia.id);
                      settleVideoTrimSeek(activeMedia.id, director.stepIndex, "unavailable");
                      setHold(false);
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
                        setHold(false);
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
                : <div className="journey-playback__media-state">正在打开媒体…</div>
              // Review P2: images must wait for the decode gate too — showing
              // the <img> as soon as the signed URL is ready can still flash
              // a blank frame while the browser decodes (#11 requirement).
              : activeMediaGate === "ready" && activeRead?.status === "ready"
                ? <img key={activeMedia.id} src={activeRead.url} alt={activeMedia.fileName} />
                : <div className="journey-playback__media-state">正在打开媒体…</div>}
          </div>
        ) : null}

        {step?.kind === "outro" ? (
          <div className="journey-playback__outro">
            <h2>{journey.title}</h2>
            <p>{journey.routePoints.length} 个地点 · 这段路已经走完</p>
          </div>
        ) : null}
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <button className="journey-playback__close" type="button" onClick={requestClose} aria-label="退出播放">
        <IconX size={22} stroke={1.35} aria-hidden="true" />
      </button>
      <nav className="journey-playback__controls" aria-label="播放控制">
        <button type="button" onClick={back} aria-label="上一个章节"><IconChevronLeft size={20} stroke={1.35} aria-hidden="true" /></button>
        <button
          type="button"
          className={paused ? "is-active" : ""}
          onClick={togglePlayback}
          aria-label={paused ? "继续播放" : "暂停播放"}
          aria-pressed={paused}
        >
          {paused
            ? <IconPlayerPlay size={20} stroke={1.35} aria-hidden="true" />
            : <IconPlayerPause size={20} stroke={1.35} aria-hidden="true" />}
        </button>
        <button type="button" onClick={next} aria-label="下一个章节"><IconChevronRight size={20} stroke={1.35} aria-hidden="true" /></button>
        <label className="journey-playback__tempo">
          <select
            value={tempo}
            aria-label="播放节奏"
            onChange={(event) => setTempo(event.currentTarget.value as PlaybackTempo)}
          >
            <option value="fast">快速</option>
            <option value="standard">标准</option>
            <option value="immersive">沉浸</option>
          </select>
        </label>
        <div className="journey-playback__progress">
          <span className="journey-playback__progress-fill" style={{ width: `${progress * 100}%` }} />
          <div className="journey-playback__progress-chapters" aria-hidden="true">
            {chapterStepIndexes.map((stepIndex) => (
              <i
                key={stepIndex}
                style={{ left: `${stepsProgress(stepIndex, director.steps.length) * 100}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, director.steps.length - 1)}
            step={1}
            value={director.stepIndex}
            aria-label="播放进度"
            aria-valuetext={`${director.stepIndex + 1} / ${Math.max(1, director.steps.length)}`}
            onChange={(event) => seek(Number(event.currentTarget.value))}
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

function stepsProgress(stepIndex: number, total: number) {
  if (total <= 1) return 1;
  return Math.min(1, Math.max(0, stepIndex / (total - 1)));
}

/**
 * The asset the director may hold on for a step: a media step's own asset, and
 * a stop step's first image — the frame the stop phase waits to decode.
 */
export function playbackHoldTargetMedia(
  journey: Journey,
  step: PlaybackStep | undefined,
): JourneyMediaAsset | null {
  if (step?.kind === "stop") {
    return playbackMediaForPoint(journey, step.pointIndex)
      .find((asset) => asset.mimeType.startsWith("image/")) ?? null;
  }
  return playbackMediaForStep(journey, step);
}

export function playbackMediaForStep(
  journey: Journey,
  step: PlaybackStep | undefined,
): JourneyMediaAsset | null {
  if (step?.kind !== "media") return null;
  return playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex] ?? null;
}
