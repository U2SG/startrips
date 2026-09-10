import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconMapPin } from "@tabler/icons-react";
import type { HomeBasePeriod } from "../journey/homeBase";
import type { ResolvedHomeBasePresence } from "../journey/homeBasePresence";
import type { PlaybackTravelChoreography } from "../journey/journeyPlayback";
import { useCompactMobileLayout } from "../journey/mobileLayout";
import type { JourneyRoute } from "../journey/types";
import {
  buildHomeBasePresenceLayer,
  type HomeBasePresenceDrawable,
  type ProjectedHomeBasePresence,
} from "./homeBasePresenceLayer";
import type { DetailedEarthLanguage, ParticleAnchorFrame } from "./detailedEarthModel";
import {
  INITIAL_EARTH_DIVE_STATE,
  resolveEarthDive,
  type DetailReadiness,
  type EarthDiveOwner,
  type EarthDiveStage,
  type EarthDiveState,
} from "./earthDive";
import {
  GLOBE_GESTURE_HINT_DWELL_MS,
  globeGestureHintVisible,
  globeModeNoteVisible,
  initialGlobeGestureHintState,
  resolveGlobeGestureHint,
} from "./globeGestureHint";
import { GLOBE_MODE_CONFIG, ParticleEarthScene } from "./ParticleEarthScene";
import {
  SEMANTIC_ZOOM_RELEASE_ZOOM,
  type GlobeSemanticZoom,
  type SemanticZoomSnapshot,
} from "./semanticZoom";

const loadDetailedEarthMap = () => import("./DetailedEarthMap");
const DetailedEarthMap = lazy(loadDetailedEarthMap);

type LivingAtlasGlobeControlsProps = {
  diveStage: EarthDiveStage;
  detailLanguage: DetailedEarthLanguage;
  onDiveIntent: () => void;
  onDetailLanguageChange: (language: DetailedEarthLanguage) => void;
  onPickRequest?: () => void;
  showDiveIntent?: boolean;
  showDetailControls?: boolean;
  inert?: boolean;
};

export function LivingAtlasGlobeControls({
  diveStage,
  detailLanguage,
  onDiveIntent,
  onDetailLanguageChange,
  onPickRequest,
  showDiveIntent = true,
  showDetailControls = true,
  inert = false,
}: LivingAtlasGlobeControlsProps) {
  const detailMode = diveStage === "detail";
  const diveIntentLabel = diveStage === "particle" ? "靠近查看更多细节" : "返回远景";
  return (
    <div
      className="living-atlas-globe__controls"
      inert={inert || undefined}
      aria-hidden={inert || undefined}
    >
      {/* #308: keyboard fallback for the SAME semantic Dive. It is visually
          quiet until keyboard focus reaches it, and names the spatial intent
          rather than exposing either renderer as a product mode. */}
      {showDiveIntent ? (
        <button
          type="button"
          className="living-atlas-globe__dive-intent"
          data-earth-dive-intent="true"
          onClick={onDiveIntent}
          aria-label={diveIntentLabel}
        >
          {diveIntentLabel}
        </button>
      ) : null}

      {detailMode && showDetailControls ? (
        <div className="living-atlas-globe__language" role="group" aria-label="地图语言">
          <button
            type="button"
            className={detailLanguage === "zh" ? "is-active" : ""}
            onClick={() => onDetailLanguageChange("zh")}
            aria-pressed={detailLanguage === "zh"}
          >
            中文
          </button>
          <button
            type="button"
            className={detailLanguage === "bilingual" ? "is-active" : ""}
            onClick={() => onDetailLanguageChange("bilingual")}
            aria-pressed={detailLanguage === "bilingual"}
          >
            双语
          </button>
        </div>
      ) : null}

      {detailMode && showDetailControls && onPickRequest ? (
        <button
          type="button"
          className="living-atlas-globe__pick"
          onClick={onPickRequest}
          aria-label="在地图上取点加入旅程"
        >
          <IconMapPin size={16} stroke={1.25} aria-hidden="true" />
          <span className="living-atlas-globe__pick-label-full">在地图上取点</span>
          <span className="living-atlas-globe__pick-label-compact">取点</span>
        </button>
      ) : null}
    </div>
  );
}

export type LivingAtlasGlobeProps = {
  focusPoint?: { lat: number; lon: number } | null;
  focusRoute?: JourneyRoute | null;
  /** One-shot camera orientation seed; never a semantic focus object. */
  initialCameraAnchor?: { lat: number; lon: number } | null;
  focusRevision?: number;
  focusFlightProfile?: PlaybackTravelChoreography;
  focusColor?: string;
  journeyRoutes: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  };
  homeBasePresence?: {
    resolved: readonly ResolvedHomeBasePresence[];
    periods: readonly HomeBasePeriod[];
    effectiveDate: string;
  };
  onSemanticZoomChange?: (level: GlobeSemanticZoom) => void;
  onManualCameraInteraction?: () => void;
  onJourneyRouteActivate: (journeyId: string) => void;
  onJourneyRoutePointActivate: (journeyId: string, routePointId: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onPickRequest?: () => void;
  showControls?: boolean;
  /**
   * #253: globe focus mode owns the whole viewport. It arms the transient
   * zoom/drag guidance once per visit, and it SUSPENDS the Semantic Earth Dive
   * — the detail surface is not part of this composition.
   */
  globeFocusMode?: boolean;
  reduceMotion?: boolean;
  cinematicActive?: boolean;
  mediaCoverHint?: { opaqueMediaCover: boolean; coverTransitionActive: boolean };
};

export function resolveLivingAtlasHomeBaseLayer(
  homeBasePresence: LivingAtlasGlobeProps["homeBasePresence"],
): HomeBasePresenceDrawable[] {
  return homeBasePresence
    ? buildHomeBasePresenceLayer({
      presence: homeBasePresence.resolved,
      periods: homeBasePresence.periods,
      effectiveDate: homeBasePresence.effectiveDate,
    })
    : [];
}

type PersistentEarthStage = "idle" | "login" | "handoff" | "atlas";

type LoginEarthPresentation = {
  mode: "archiveBurst" | "particleSphere";
  reduceMotion: boolean;
};

type AtlasEarthPresentation = Pick<
  LivingAtlasGlobeProps,
  | "focusPoint"
  | "focusRoute"
  | "initialCameraAnchor"
  | "focusRevision"
  | "focusFlightProfile"
  | "focusColor"
  | "journeyRoutes"
  | "activeJourneyRouteId"
  | "temporalReveal"
  | "onJourneyRouteActivate"
  | "onJourneyRoutePointActivate"
  | "onGlobePointPick"
  | "reduceMotion"
  | "mediaCoverHint"
> & {
  /**
   * #252: the Dive controller lives with the Atlas globe, but the camera lives
   * in the persistent scene. These are the only two channels between them, and
   * both are the zoom authority's own currency: the snapshot it publishes, and
   * a hand-back of the camera to the zoom at which the band reopens.
   */
  onSemanticZoomSnapshot?: (snapshot: SemanticZoomSnapshot) => void;
  onParticleAnchorFrame?: (frame: ParticleAnchorFrame | null) => void;
  homeBasePresence?: readonly HomeBasePresenceDrawable[];
  onHomeBasePresenceFrame?: (frame: readonly ProjectedHomeBasePresence[]) => void;
  onManualCameraInteraction?: () => void;
  zoomIntent?: { zoom: number; revision: number };
  /** Who owns camera and gesture input on this frame. */
  inputOwner?: EarthDiveOwner;
  earthDiveOverlapActive?: boolean;
};

type PersistentEarthContextValue = {
  setStage: (stage: PersistentEarthStage) => void;
  setLoginPresentation: (presentation: LoginEarthPresentation) => void;
  setAtlasPresentation: (presentation: AtlasEarthPresentation | null) => void;
};

const PersistentEarthContext = createContext<PersistentEarthContextValue | null>(null);

export function usePersistentEarth() {
  const value = useContext(PersistentEarthContext);
  if (!value) throw new Error("PersistentEarthProvider is required");
  return value;
}

export function PersistentEarthProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<PersistentEarthStage>("idle");
  // #194: the scene owner reads the one shared compact-mobile contract and
  // hands the answer down, so the globe overlays can never disagree with the
  // Atlas shell about whether the viewport is in compact mobile mode.
  const compactMobileLayout = useCompactMobileLayout();
  const [loginPresentation, setLoginPresentation] = useState<LoginEarthPresentation>(() => {
    const reduceMotion = typeof window !== "undefined"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return {
      // The login Earth is already visible while the session request is pending.
      // Seed the same one-way intro mode that LoginV3Scene will own after the
      // request settles, so first paint never bounces particle → burst → particle.
      mode: reduceMotion ? "particleSphere" : "archiveBurst",
      reduceMotion,
    };
  });
  const [atlasPresentation, setAtlasPresentation] = useState<AtlasEarthPresentation | null>(null);
  const lightweight = import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("qaLite") === "1";
  const value = useMemo<PersistentEarthContextValue>(() => ({
    setStage,
    setLoginPresentation,
    setAtlasPresentation,
  }), []);
  const atlasOwnsScene = stage === "handoff" || stage === "atlas";
  const atlas = atlasOwnsScene ? atlasPresentation : null;
  const active = stage !== "idle";
  const interactive = stage === "atlas" && Boolean(atlas);

  return (
    <PersistentEarthContext.Provider value={value}>
      <div className="persistent-earth-shell" data-persistent-earth-stage={stage}>
        <div
          className="persistent-earth-host"
          data-persistent-earth-host="true"
          data-stage={stage}
          data-interactive={interactive ? "true" : "false"}
          aria-hidden="true"
        >
          <div className="persistent-earth-host__viewport">
            {active ? (
              lightweight ? (
                <div className="persistent-earth-host__qa-earth" data-three-scene="particle-earth" />
              ) : (
                <ParticleEarthScene
                  mode={atlas ? "focusPoint" : loginPresentation.mode}
                  quality={stage === "atlas" ? "high" : "low"}
                  focusPoint={atlas?.focusPoint}
                  focusRoute={atlas?.focusRoute}
                  initialCameraAnchor={atlas?.initialCameraAnchor}
                  focusRevision={atlas?.focusRevision}
                  focusFlightProfile={atlas?.focusFlightProfile}
                  focusColor={atlas?.focusColor}
                  centerFocusPoint={Boolean(atlas)}
                  journeyRoutes={atlas?.journeyRoutes ?? []}
                  activeJourneyRouteId={atlas?.activeJourneyRouteId}
                  temporalReveal={atlas?.temporalReveal}
                  onJourneyRouteActivate={atlas?.onJourneyRouteActivate}
                  onJourneyRoutePointActivate={atlas?.onJourneyRoutePointActivate}
                  onGlobePointPick={atlas?.onGlobePointPick}
                  onSemanticZoomSnapshot={atlas?.onSemanticZoomSnapshot}
                  onParticleAnchorFrame={atlas?.onParticleAnchorFrame}
                  homeBasePresence={atlas?.homeBasePresence ?? []}
                  onHomeBasePresenceFrame={atlas?.onHomeBasePresenceFrame}
                  onManualCameraInteraction={atlas?.onManualCameraInteraction}
                  zoomIntent={atlas?.zoomIntent}
                  showArchiveSignals={false}
                  // #252: exactly one subsystem owns the camera on any frame.
                  // While the detail surface owns it the particle globe answers
                  // neither the wheel nor the drag, and opacity has no say.
                  dragToRotate={Boolean(atlas) && atlas?.inputOwner !== "detail"}
                  wheelToZoom={Boolean(atlas) && atlas?.inputOwner !== "detail"}
                  reduceMotion={atlas?.reduceMotion ?? loginPresentation.reduceMotion}
                  rotationYOverride={atlas ? undefined : GLOBE_MODE_CONFIG.particleSphere.rotationY}
                  compactMobileLayout={compactMobileLayout}
                  visibilityHint={{
                    opaqueMediaCover: atlas?.mediaCoverHint?.opaqueMediaCover ?? false,
                    coverTransitionActive: atlas?.mediaCoverHint?.coverTransitionActive ?? false,
                    earthDiveOverlapActive: atlas?.earthDiveOverlapActive ?? false,
                  }}
                />
              )
            ) : null}
          </div>
        </div>
        <div className="persistent-earth-content">{children}</div>
      </div>
    </PersistentEarthContext.Provider>
  );
}

export function LivingAtlasGlobe({
  focusPoint,
  focusRoute,
  initialCameraAnchor,
  focusRevision,
  focusFlightProfile,
  focusColor,
  journeyRoutes,
  activeJourneyRouteId,
  temporalReveal,
  homeBasePresence,
  onSemanticZoomChange,
  onManualCameraInteraction,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobePointPick,
  onPickRequest,
  showControls = true,
  globeFocusMode = false,
  reduceMotion,
  cinematicActive = false,
  mediaCoverHint,
}: LivingAtlasGlobeProps) {
  const persistentEarth = usePersistentEarth();
  const compactMobileLayout = useCompactMobileLayout();
  const [detailLanguage, setDetailLanguage] = useState<DetailedEarthLanguage>("zh");
  const [gestureHint, signalGestureHint] = useReducer(
    resolveGlobeGestureHint,
    initialGlobeGestureHintState,
  );
  const gestureHintVisible = globeGestureHintVisible(gestureHint);
  const modeNoteVisible = globeModeNoteVisible(gestureHint, { globeFocusMode, compactMobileLayout });
  const homeBaseLayer = useMemo(() => resolveLivingAtlasHomeBaseLayer(homeBasePresence), [homeBasePresence]);
  const homeBaseElementsRef = useRef(new Map<string, HTMLDivElement>());
  const homeBaseFramesRef = useRef(new Map<string, ProjectedHomeBasePresence>());
  const applyHomeBaseFrame = useCallback((
    element: HTMLDivElement,
    frame: ProjectedHomeBasePresence | undefined,
  ) => {
    const visible = Boolean(frame?.visible);
    element.hidden = !visible;
    element.style.display = visible ? "" : "none";
    element.tabIndex = visible ? 0 : -1;
    if (!frame || !visible) return;
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
  }, []);
  const bindHomeBaseElement = useCallback((periodId: string, element: HTMLDivElement | null) => {
    if (!element) {
      homeBaseElementsRef.current.delete(periodId);
      return;
    }
    homeBaseElementsRef.current.set(periodId, element);
    applyHomeBaseFrame(element, homeBaseFramesRef.current.get(periodId));
  }, [applyHomeBaseFrame]);

  // #252: there is exactly one piece of Dive state and `earthDive.ts` decides
  // it. What used to be an `earthMode` / `transitionTarget` / `targetReady`
  // triple driven by a crossfade timer and a 12 s load timeout is now resolved
  // every frame from four inputs: the zoom authority's snapshot, how far the
  // detail renderer has come, the focus intent the handoff was armed against,
  // and the fallback command.
  const [dive, setDive] = useState<EarthDiveState>(INITIAL_EARTH_DIVE_STATE);
  // The frame the map is handed off across is a function of the snapshot, so
  // the snapshot has to reach React — but only while a map exists, and only on
  // a move large enough to matter.
  const [handoffSnapshot, setHandoffSnapshot] = useState<SemanticZoomSnapshot | null>(null);
  // What the particle Earth is showing at the focused place. The detail surface
  // solves its own camera to this, so it only has to reach React while a map
  // exists and only when it has moved enough to change that solution.
  const [particleFrame, setParticleFrame] = useState<ParticleAnchorFrame | null>(null);
  const [zoomIntent, setZoomIntent] = useState<{ zoom: number; revision: number } | null>(null);
  const diveRef = useRef<EarthDiveState>(INITIAL_EARTH_DIVE_STATE);
  const detailLayerRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<SemanticZoomSnapshot>({ level: "planet", zoom: 1, localProgress: 0 });
  const readinessRef = useRef<DetailReadiness>("unavailable");
  const commandRequestedRef = useRef(false);
  // #253: the Dive resolves on a rAF loop, so the mode's own suspension has to
  // reach it as a ref like every other per-frame input rather than as an
  // effect dependency that would restart the loop.
  const suspendedRef = useRef(globeFocusMode);
  suspendedRef.current = globeFocusMode;
  const releaseRequestedRef = useRef(false);
  const focusRevisionRef = useRef(focusRevision ?? 0);
  const handoffRevisionRef = useRef(focusRevision ?? 0);
  focusRevisionRef.current = focusRevision ?? 0;

  // Stable identity: this callback travels through the persistent scene's
  // presentation, which is itself an effect dependency.
  const handleSemanticZoomSnapshot = useCallback((snapshot: SemanticZoomSnapshot) => {
    snapshotRef.current = snapshot;
    onSemanticZoomChange?.(snapshot.level);
    if (diveRef.current.stage === "particle") return;
    setHandoffSnapshot((previous) => (
      previous
        && previous.level === snapshot.level
        && Math.abs(previous.localProgress - snapshot.localProgress) < 0.01
        ? previous
        : snapshot
    ));
  }, [onSemanticZoomChange]);

  const handleParticleAnchorFrame = useCallback((frame: ParticleAnchorFrame | null) => {
    if (diveRef.current.stage === "particle") return;
    setParticleFrame(frame);
  }, []);

  const handleHomeBasePresenceFrame = useCallback((frame: readonly ProjectedHomeBasePresence[]) => {
    const nextFrames = new Map(frame.map((entry) => [entry.periodId, entry]));
    homeBaseFramesRef.current = nextFrames;
    for (const [periodId, element] of homeBaseElementsRef.current) {
      applyHomeBaseFrame(element, nextFrames.get(periodId));
    }
  }, [applyHomeBaseFrame]);

  const handleDetailReadiness = useCallback((readiness: DetailReadiness) => {
    readinessRef.current = readiness;
  }, []);

  // Handing the camera home: ownership ends and the zoom authority is set back
  // to where the band reopens, so the particle globe and the map cannot
  // disagree about where the user is. Whether the Dive ends altogether is
  // still the band's decision — `regional` holds the prewarm.
  const releaseDive = useCallback(() => {
    if (diveRef.current.stage === "particle") return;
    commandRequestedRef.current = false;
    releaseRequestedRef.current = true;
    // Only a dive the camera actually travelled into needs the camera moved
    // back: a dive the fallback command opened from a far band left the
    // particle zoom where it was, and writing it would zoom the globe IN on
    // the way out.
    if (snapshotRef.current.level === "local") {
      setZoomIntent((previous) => ({
        zoom: SEMANTIC_ZOOM_RELEASE_ZOOM,
        revision: (previous?.revision ?? 0) + 1,
      }));
    }
  }, []);

  // #308: wheel/pinch and the keyboard intent affordance converge here. This
  // remains one semantic navigation command rather than a renderer switch.
  // Invoked while a Dive is pending or owned by detail, it releases back to
  // the overview path; the readiness/failure semantics remain owned by #252.
  const requestDive = useCallback(() => {
    if (diveRef.current.stage !== "particle") {
      releaseDive();
      return;
    }
    releaseRequestedRef.current = false;
    commandRequestedRef.current = true;
  }, [releaseDive]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const previous = diveRef.current;
      // A handoff is armed against the focus intent that was current when it
      // left the ground. While the Dive has not opened a blend yet it keeps
      // re-arming, so only a focus change during a pending handoff is stale.
      if (previous.stage === "particle" || previous.stage === "prewarm") {
        handoffRevisionRef.current = focusRevisionRef.current;
      }
      // The blend is presented by CSS over `blendMs`, so ownership must not
      // transfer until the surface is actually on screen. That is measured
      // from the layer itself rather than timed: no clock reaches the resolver.
      const layer = detailLayerRef.current;
      const blendPresented = !layer || Number(window.getComputedStyle(layer).opacity) >= 0.99;
      const next = resolveEarthDive(previous, {
        snapshot: snapshotRef.current,
        readiness: readinessRef.current,
        handoffRevision: handoffRevisionRef.current,
        focusRevision: focusRevisionRef.current,
        commandRequested: commandRequestedRef.current,
        releaseRequested: releaseRequestedRef.current,
        blendPresented,
        suspended: suspendedRef.current,
        reduceMotion: Boolean(reduceMotion),
      });
      // The release is consumed as soon as ownership is home and the renderer
      // is back to warming: from there the band alone decides. This happens
      // before the no-change exit on purpose — a cancel that resolves to the
      // stage the band already wanted would otherwise latch forever and block
      // every later dive.
      if (next.stage === "prewarm" || next.stage === "particle") releaseRequestedRef.current = false;
      if (next.stage === previous.stage && next.owner === previous.owner && next.blendMs === previous.blendMs) return;
      if (next.stage === "particle") {
        // The map is torn down with the Dive, so its readiness cannot outlive it.
        readinessRef.current = "unavailable";
        commandRequestedRef.current = false;
        setHandoffSnapshot(null);
        setParticleFrame(null);
      }
      diveRef.current = next;
      setDive(next);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [reduceMotion]);

  // #253: entering focus mode arms the hint, leaving retires it and bumps the
  // ordering token so this visit's dwell timer cannot speak for the next one.
  useEffect(() => {
    signalGestureHint({ kind: "focus-mode", active: globeFocusMode });
  }, [globeFocusMode]);

  // The dwell is a plain timer, not an animation or `transitionend` listener,
  // so reduced motion reaches the same end state on the same schedule.
  useEffect(() => {
    if (!gestureHintVisible) return;
    const session = gestureHint.session;
    const dwell = window.setTimeout(
      () => signalGestureHint({ kind: "dwell", session }),
      GLOBE_GESTURE_HINT_DWELL_MS,
    );
    return () => window.clearTimeout(dwell);
  }, [gestureHint.session, gestureHintVisible]);

  // The particle globe owns wheel/drag on its own canvas outside this subtree,
  // so the first gesture is observed on the window rather than on the section.
  useEffect(() => {
    if (!gestureHintVisible) return;
    const session = gestureHint.session;
    const dismiss = () => signalGestureHint({ kind: "gesture", session });
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("pointerdown", dismiss, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", dismiss, { capture: true });
      window.removeEventListener("pointerdown", dismiss, { capture: true });
    };
  }, [gestureHint.session, gestureHintVisible]);

  useEffect(() => {
    persistentEarth.setAtlasPresentation({
      focusPoint,
      focusRoute,
      initialCameraAnchor,
      focusRevision,
      focusFlightProfile,
      focusColor,
      journeyRoutes,
      activeJourneyRouteId,
      temporalReveal,
      onJourneyRouteActivate,
      onJourneyRoutePointActivate,
      onGlobePointPick,
      onSemanticZoomSnapshot: handleSemanticZoomSnapshot,
      onParticleAnchorFrame: handleParticleAnchorFrame,
      homeBasePresence: homeBaseLayer,
      onHomeBasePresenceFrame: handleHomeBasePresenceFrame,
      onManualCameraInteraction,
      zoomIntent: zoomIntent ?? undefined,
      inputOwner: dive.owner,
      earthDiveOverlapActive: dive.stage === "prewarm" || dive.stage === "blending",
      mediaCoverHint: {
        opaqueMediaCover: Boolean(mediaCoverHint?.opaqueMediaCover),
        coverTransitionActive: Boolean(mediaCoverHint?.coverTransitionActive),
      },
      reduceMotion,
    });
  }, [
    activeJourneyRouteId,
    cinematicActive,
    dive.owner,
    dive.stage,
    focusColor,
    focusPoint,
    focusRevision,
    focusFlightProfile,
    focusRoute,
    initialCameraAnchor,
    handleHomeBasePresenceFrame,
    handleParticleAnchorFrame,
    handleSemanticZoomSnapshot,
    homeBaseLayer,
    journeyRoutes,
    zoomIntent,
    onGlobePointPick,
    onManualCameraInteraction,
    onJourneyRouteActivate,
    onJourneyRoutePointActivate,
    persistentEarth,
    reduceMotion,
    mediaCoverHint?.opaqueMediaCover,
    mediaCoverHint?.coverTransitionActive,
    temporalReveal,
  ]);

  useEffect(() => () => persistentEarth.setAtlasPresentation(null), [persistentEarth]);

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => void loadDetailedEarthMap(), 350);
    return () => window.clearTimeout(preloadTimer);
  }, []);

  // The detail renderer is mounted from `prewarm` on, hidden, so the blend has
  // something real to reveal and nothing has to be revealed on a timer.
  const showDetail = dive.stage !== "particle";
  const detailMode = dive.stage === "detail";
  // #308 review: compact mobile still needs a non-gesture path for external
  // keyboards and switch-control users. Keep the semantic Dive intent mounted
  // independently from the optional detail utility cluster; focus mode and
  // cinematic isolation remain intentionally control-free.
  const showDiveIntent = !globeFocusMode && !cinematicActive;

  return (
    <section
      className={`living-atlas-globe${detailMode ? " is-detail" : " is-overview"}${cinematicActive ? " is-cinematic" : ""}`}
      data-earth-mode={detailMode ? "detail" : "particle"}
      data-earth-dive={dive.stage}
      data-earth-dive-owner={dive.owner}
      style={{ "--earth-dive-blend-ms": `${dive.blendMs}ms` } as CSSProperties}
      data-ambience="on"
      aria-label={detailMode ? "高精度地球地图" : "粒子艺术地球"}
    >
      {/* The aurora field is part of the atlas, not a user preference: it is
          always rendered and only its animation answers to reduced motion. */}
      <div className="living-atlas-ambience" aria-hidden="true">
        <span className="living-atlas-ambience__blob living-atlas-ambience__blob-a" />
        <span className="living-atlas-ambience__blob living-atlas-ambience__blob-b" />
        <span className="living-atlas-ambience__blob living-atlas-ambience__blob-c" />
      </div>
      {showDetail ? (
        <div ref={detailLayerRef} className="living-atlas-globe__layer living-atlas-globe__detail-layer">
          <Suspense fallback={null}>
            <DetailedEarthMap
              diveStage={dive.stage}
              diveOwner={dive.owner}
              diveSnapshot={handoffSnapshot ?? snapshotRef.current}
              particleFrame={particleFrame}
              focusPoint={focusPoint}
              focusRoute={focusRoute}
              focusRevision={focusRevision}
              focusFlightProfile={focusFlightProfile}
              language={detailLanguage}
              onGlobePointPick={detailMode ? onGlobePointPick : undefined}
              onOverviewRequest={releaseDive}
              onReadinessChange={handleDetailReadiness}
            />
          </Suspense>
        </div>
      ) : null}

      {dive.owner !== "detail" && !cinematicActive ? homeBaseLayer.map((descriptor) => (
          <div
            key={descriptor.periodId}
            ref={(element) => bindHomeBaseElement(descriptor.periodId, element)}
            className="living-atlas-globe__home-base"
            role="img"
            tabIndex={-1}
            hidden
            aria-label={descriptor.accessibleName}
            data-home-base-presence={descriptor.presence}
            style={{
              minWidth: descriptor.touchTargetPx,
              minHeight: descriptor.touchTargetPx,
              "--home-base-emphasis": descriptor.emphasisWeight,
            } as CSSProperties}
          >
            <span className="living-atlas-globe__home-base-core" aria-hidden="true" />
            {descriptor.label ? (
              <span className="living-atlas-globe__home-base-label" aria-hidden="true">{descriptor.label}</span>
            ) : null}
          </div>
        )) : null}

      {showControls || showDiveIntent ? (
        <LivingAtlasGlobeControls
          diveStage={dive.stage}
          detailLanguage={detailLanguage}
          onDiveIntent={requestDive}
          onDetailLanguageChange={setDetailLanguage}
          onPickRequest={onPickRequest}
          showDiveIntent={showDiveIntent}
          showDetailControls={showControls}
          inert={cinematicActive}
        />
      ) : null}

      {/* #308: one resolver owns gesture-note discoverability. Focus mode keeps
          #253's transient onboarding; ordinary desktop keeps one quiet gesture
          line even though renderer-mode chrome is gone; compact mobile stays
          uncluttered and relies on its native pinch gesture. */}
      {modeNoteVisible ? (
        <div className="living-atlas-globe__mode-note" aria-hidden="true">
          {dive.stage === "prewarm" || dive.stage === "blending"
            ? "VECTOR MAP PREPARING"
            : detailMode
              ? "DRAG TO EXPLORE / ZOOM OUT TO RETURN"
              : "SCROLL TO ZOOM / DRAG TO ROTATE"}
        </div>
      ) : null}
    </section>
  );
}
