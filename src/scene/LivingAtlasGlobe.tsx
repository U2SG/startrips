import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import {
  buildDetailedEarthJourneyOverlay,
  type DetailedEarthLanguage,
  type ParticleAnchorFrame,
} from "./detailedEarthModel";
import {
  INITIAL_EARTH_DIVE_STATE,
  resolveEarthDive,
  type DetailReadiness,
  type EarthDiveOwner,
  type EarthDiveStage,
  type EarthDiveState,
  type EarthExperiencePolicy,
} from "./earthDive";
import {
  particleAnchorFrameMatchesSemanticZoom,
  resolveEarthDiveAlignment,
  type EarthDiveScreenFrame,
} from "./earthDiveAlignment";
import { resolveEarthDiveRevealGeometry } from "./earthDiveReveal";
import {
  GLOBE_GESTURE_HINT_DWELL_MS,
  globeGestureHintVisible,
  globeModeNoteVisible,
  initialGlobeGestureHintState,
  resolveGlobeGestureHint,
} from "./globeGestureHint";
import { ParticleEarthScene, type ParticleEarthBackend } from "./ParticleEarthScene";
import { GLOBE_MODE_CONFIG } from "./globeMode";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  SEMANTIC_ZOOM_RELEASE_ZOOM,
  type GlobeSemanticZoom,
  type SemanticZoomSnapshot,
} from "./semanticZoom";

const loadDetailedEarthMap = () => import("./DetailedEarthMap");
const DetailedEarthMap = lazy(loadDetailedEarthMap);

function readDetailedEarthScreenFrame(layer: HTMLElement | null): EarthDiveScreenFrame | null {
  const host = layer?.querySelector<HTMLElement>(".detailed-earth-map");
  if (!host) return null;
  const x = Number(host.dataset.handoffAnchorX);
  const y = Number(host.dataset.handoffAnchorY);
  const scale = Number(host.dataset.handoffScale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(scale > 0)) return null;
  return { screen: { x, y }, pxPerDegreeLat: scale };
}

type LivingAtlasGlobeControlsProps = {
  diveStage: EarthDiveStage;
  detailLanguage: DetailedEarthLanguage;
  onDiveIntent: () => void;
  onDetailLanguageChange: (language: DetailedEarthLanguage) => void;
  onPickRequest?: () => void;
  showDiveIntent?: boolean;
  showDetailControls?: boolean;
  diveIntentLabel?: string;
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
  diveIntentLabel: requestedDiveIntentLabel,
  inert = false,
}: LivingAtlasGlobeControlsProps) {
  const detailMode = diveStage === "detail";
  const diveIntentLabel = requestedDiveIntentLabel
    ?? (diveStage === "particle" ? "靠近查看更多细节" : "返回远景");
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
  /** Whether a chapter target currently owns the camera. */
  focusEnabled?: boolean;
  /** An unfinished Playback focus may continue after Detail takes ownership. */
  focusFlightPending?: boolean;
  focusFlightProfile?: PlaybackTravelChoreography;
  focusColor?: string;
  journeyRoutes: readonly JourneyRoute[];
  /** Marker disclosure only; route geometry always uses all Journey Route Points. */
  visibleRoutePointIds?: ReadonlySet<string>;
  activeJourneyRouteId?: string | null;
  selectedJourneyRoutePoint?: {
    journeyId: string;
    routePointId?: string | null;
    pointIndex?: number | null;
  } | null;
  narrativeJourneyRoutePoint?: {
    journeyId: string;
    routePointId?: string | null;
    pointIndex?: number | null;
  } | null;
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  };
  homeBasePresence?: {
    resolved: readonly ResolvedHomeBasePresence[];
    periods: readonly HomeBasePeriod[];
    effectiveDate: string;
  };
  activeHomeBaseContextPeriodId?: string | null;
  onHomeBaseActivate?: (periodId: string) => void;
  onSemanticZoomChange?: (level: GlobeSemanticZoom) => void;
  onManualCameraInteraction?: () => void;
  onFocusSettled?: (revision: number) => void;
  onJourneyRouteActivate: (journeyId: string) => void;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  onGlobeBlankActivate?: () => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onPickRequest?: () => void;
  showControls?: boolean;
  /** #331: hard renderer-availability policy; product UI/persistence is out of scope. */
  earthExperiencePolicy?: EarthExperiencePolicy;
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
  | "focusEnabled"
  | "focusFlightPending"
  | "focusFlightProfile"
  | "focusColor"
  | "journeyRoutes"
  | "visibleRoutePointIds"
  | "activeJourneyRouteId"
  | "selectedJourneyRoutePoint"
  | "narrativeJourneyRoutePoint"
  | "temporalReveal"
  | "onJourneyRouteActivate"
  | "onJourneyRoutePointActivate"
  | "onGlobeBlankActivate"
  | "onHomeBaseActivate"
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
  onFocusSettled?: (revision: number) => void;
  zoomIntent?: {
    zoom: number;
    revision: number;
    /** Optional geographic center for a renderer-to-particle ownership handback. */
    center?: { lat: number; lon: number };
  };
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
  const [particleEarthBackend, setParticleEarthBackend] = useState<ParticleEarthBackend | "pending">("pending");
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
          data-particle-earth-backend={particleEarthBackend}
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
                  focusEnabled={atlas?.focusEnabled}
                  focusFlightProfile={atlas?.focusFlightProfile}
                  focusColor={atlas?.focusColor}
                  centerFocusPoint={Boolean(atlas)}
                  journeyRoutes={atlas?.journeyRoutes ?? []}
                  visibleRoutePointIds={atlas?.visibleRoutePointIds}
                  activeJourneyRouteId={atlas?.activeJourneyRouteId}
                  selectedJourneyRoutePoint={atlas?.selectedJourneyRoutePoint}
                  narrativeJourneyRoutePoint={atlas?.narrativeJourneyRoutePoint}
                  temporalReveal={atlas?.temporalReveal}
                  onJourneyRouteActivate={atlas?.onJourneyRouteActivate}
                  onJourneyRoutePointActivate={atlas?.onJourneyRoutePointActivate}
                  onBackendChange={setParticleEarthBackend}
                  onGlobeBlankActivate={atlas?.onGlobeBlankActivate}
                  onHomeBaseActivate={atlas?.onHomeBaseActivate}
                  onGlobePointPick={atlas?.onGlobePointPick}
                  onSemanticZoomSnapshot={atlas?.onSemanticZoomSnapshot}
                  onParticleAnchorFrame={atlas?.onParticleAnchorFrame}
                  homeBasePresence={atlas?.homeBasePresence ?? []}
                  onHomeBasePresenceFrame={atlas?.onHomeBasePresenceFrame}
                  onManualCameraInteraction={atlas?.onManualCameraInteraction}
                  onFocusSettled={atlas?.onFocusSettled}
                  zoomIntent={atlas?.zoomIntent}
                  showArchiveSignals={false}
                  // #252: exactly one subsystem owns the camera on any frame.
                  // While the detail surface owns it the particle globe answers
                  // neither the wheel nor the drag, and opacity has no say.
                  dragToRotate={Boolean(atlas) && atlas?.inputOwner !== "detail"}
                  wheelToZoom={Boolean(atlas) && atlas?.inputOwner !== "detail"}
                  cameraHold={Boolean(atlas) && atlas?.inputOwner === "detail"}
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
  focusEnabled = true,
  focusFlightPending = false,
  focusFlightProfile,
  focusColor,
  journeyRoutes,
  visibleRoutePointIds,
  activeJourneyRouteId,
  selectedJourneyRoutePoint,
  narrativeJourneyRoutePoint,
  temporalReveal,
  homeBasePresence,
  activeHomeBaseContextPeriodId,
  onHomeBaseActivate,
  onSemanticZoomChange,
  onManualCameraInteraction,
  onFocusSettled,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobeBlankActivate,
  onGlobePointPick,
  onPickRequest,
  showControls = true,
  earthExperiencePolicy = "default",
  globeFocusMode = false,
  reduceMotion,
  cinematicActive = false,
  mediaCoverHint,
}: LivingAtlasGlobeProps) {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const debugWindow = window as Window & {
      __detailedEarthMapConstructionCount?: number;
      __detailedEarthMapRemovalCount?: number;
    };
    debugWindow.__detailedEarthMapConstructionCount ??= 0;
    debugWindow.__detailedEarthMapRemovalCount ??= 0;
  }
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
  const detailedEarthRoute = useMemo(() => (
    journeyRoutes.find((route) => route.id === activeJourneyRouteId)
      ?? focusRoute
      ?? null
  ), [activeJourneyRouteId, focusRoute, journeyRoutes]);
  const detailedEarthJourneyOverlay = useMemo(() => buildDetailedEarthJourneyOverlay({
    route: detailedEarthRoute,
    selection: selectedJourneyRoutePoint,
    narrativeSelection: narrativeJourneyRoutePoint,
    temporalReveal,
    visibleRoutePointIds,
  }), [
    detailedEarthRoute,
    narrativeJourneyRoutePoint,
    selectedJourneyRoutePoint,
    temporalReveal,
    visibleRoutePointIds,
  ]);
  const homeBaseElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const homeBaseFramesRef = useRef(new Map<string, ProjectedHomeBasePresence>());
  const applyHomeBaseFrame = useCallback((
    element: HTMLButtonElement,
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
  const bindHomeBaseElement = useCallback((periodId: string, element: HTMLButtonElement | null) => {
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
  // from four inputs: the zoom authority's snapshot, how far the
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
  const [particleOnlyZoomedIn, setParticleOnlyZoomedIn] = useState(false);
  const [zoomIntent, setZoomIntent] = useState<{
    zoom: number;
    revision: number;
    center?: { lat: number; lon: number };
  } | null>(null);
  const diveRef = useRef<EarthDiveState>(INITIAL_EARTH_DIVE_STATE);
  const scheduleDiveTickRef = useRef<(() => void) | null>(null);
  const scheduleDiveTick = useCallback(() => scheduleDiveTickRef.current?.(), []);
  // The resolver mirror follows the last COMMITTED presentation state. If the
  // rAF loop advances this ref before React commits, concurrent batching can
  // skip a semantic handoff stage in the DOM (notably reverse prewarm). Holding
  // the mirror here keeps the one-step resolver and rendered lifecycle aligned
  // without a timer or second transition authority.
  useEffect(() => {
    diveRef.current = dive;
    // Advance another stage only after this one reached React's commit.
    scheduleDiveTick();
  }, [dive, scheduleDiveTick]);
  const detailLayerRef = useRef<HTMLDivElement>(null);
  const detailCalibrationRef = useRef<((
    frame: ParticleAnchorFrame,
    mode?: "sync" | "retry",
  ) => void) | null>(null);
  const particleFrameRef = useRef<ParticleAnchorFrame | null>(null);
  const snapshotRef = useRef<SemanticZoomSnapshot>({ level: "planet", zoom: 1, localProgress: 0 });
  const readinessRef = useRef<DetailReadiness>("unavailable");
  const reduceMotionRef = useRef(Boolean(reduceMotion));
  const commandRequestedRef = useRef(false);
  const releaseRequestedRef = useRef(false);
  const earthExperiencePolicyRef = useRef<EarthExperiencePolicy>(earthExperiencePolicy);
  const policyEntryArmedRef = useRef(earthExperiencePolicy === "default");
  const policyFocusRevisionRef = useRef(focusRevision ?? 0);
  const pendingPolicyHandbackRef = useRef(false);
  const pendingPolicyHandbackCenterRef = useRef<{ lat: number; lon: number } | null>(null);
  const latestDetailObservationRef = useRef<{ lat: number; lon: number } | null>(null);
  // #253: committed composition inputs wake the same resolver as camera input.
  const suspendedRef = useRef(globeFocusMode);
  const focusRevisionRef = useRef(focusRevision ?? 0);
  const handoffRevisionRef = useRef(focusRevision ?? 0);

  useLayoutEffect(() => {
    suspendedRef.current = globeFocusMode;
    reduceMotionRef.current = Boolean(reduceMotion);
    scheduleDiveTick();
  }, [globeFocusMode, reduceMotion, scheduleDiveTick]);

  // Policy/focus refs are live inputs to the persistent rAF resolver, so they
  // must mirror COMMITTED React state. Mutating them during render lets an
  // abandoned concurrent render alter the already-running camera/resource
  // lifecycle. Apply the hard edge in layout commit, before the next paint/rAF,
  // and only arm detail again from a focus revision that actually committed.
  useLayoutEffect(() => {
    const nextFocusRevision = focusRevision ?? 0;
    focusRevisionRef.current = nextFocusRevision;
    scheduleDiveTick();
    const previousPolicy = earthExperiencePolicyRef.current;
    if (previousPolicy !== earthExperiencePolicy) {
      earthExperiencePolicyRef.current = earthExperiencePolicy;
      // A hard policy edge invalidates every old Dive request. Returning to
      // default is intentionally NOT a request to re-enter; a later zoom/focus
      // command must prove fresh intent before the existing local snapshot can
      // authorize detail again.
      policyEntryArmedRef.current = false;
      policyFocusRevisionRef.current = nextFocusRevision;
      const detailOwnedBeforePolicy = earthExperiencePolicy === "particle-only"
        && diveRef.current.owner === "detail";
      pendingPolicyHandbackRef.current = detailOwnedBeforePolicy;
      pendingPolicyHandbackCenterRef.current = detailOwnedBeforePolicy
        ? latestDetailObservationRef.current
        : null;
      commandRequestedRef.current = false;
      releaseRequestedRef.current = false;
      readinessRef.current = "unavailable";
      detailCalibrationRef.current = null;
      return;
    }
    if (
      earthExperiencePolicy === "default"
      && nextFocusRevision !== policyFocusRevisionRef.current
    ) {
      policyEntryArmedRef.current = true;
      policyFocusRevisionRef.current = nextFocusRevision;
    }
  }, [earthExperiencePolicy, focusRevision, scheduleDiveTick]);

  const syncDetailSpatialReveal = useCallback((
    stage = diveRef.current.stage,
    snapshot = snapshotRef.current,
    frame = particleFrameRef.current,
  ) => {
    const layer = detailLayerRef.current;
    if (!layer) return;
    const mapHost = layer.querySelector<HTMLElement>(".detailed-earth-map");
    if (stage === "blending" && mapHost?.dataset.mapRevealStage !== "blending") {
      // #355: style load and even correct canvas dimensions do not prove that
      // the hidden/prewarmed MapLibre surface committed a frame for its current
      // visible geometry. Hold the existing reveal boundary until the map says
      // the current blending revision rendered after geometry sync/repaint.
      layer.dataset.earthDiveSpatialReveal = "holding";
      layer.dataset.earthDiveRevealSync = mapHost?.dataset.mapRevealSync ?? "pending";
      delete layer.dataset.earthDiveAlignment;
      delete layer.dataset.earthDiveAnchorDelta;
      delete layer.dataset.earthDiveScaleError;
      layer.style.removeProperty("--earth-dive-reveal-progress");
      return;
    }
    delete layer.dataset.earthDiveRevealSync;
    if (reduceMotionRef.current || stage !== "blending") {
      layer.dataset.earthDiveSpatialReveal = "off";
      delete layer.dataset.earthDiveAlignment;
      delete layer.dataset.earthDiveAnchorDelta;
      delete layer.dataset.earthDiveScaleError;
      layer.style.removeProperty("--earth-dive-reveal-progress");
      return;
    }

    if (snapshot.level !== "local") {
      // Accessibility/keyboard Dive has no local-band spatial trajectory, and
      // the detail renderer cannot reproduce a planet-scale particle view at
      // its minimum zoom anyway. Preserve the pre-existing full-frame opacity
      // blend/readiness gate; local wheel/pinch remains strictly calibrated.
      layer.dataset.earthDiveSpatialReveal = "fallback";
      delete layer.dataset.earthDiveAlignment;
      delete layer.dataset.earthDiveAnchorDelta;
      delete layer.dataset.earthDiveScaleError;
      layer.style.removeProperty("--earth-dive-reveal-progress");
      return;
    }

    const detailFrame = readDetailedEarthScreenFrame(layer);
    const frameMatchesZoom = particleAnchorFrameMatchesSemanticZoom(frame, snapshot);
    const alignment = frameMatchesZoom ? resolveEarthDiveAlignment(frame, detailFrame) : null;
    if (frame) {
      if (!frameMatchesZoom) {
        layer.dataset.earthDiveAlignment = "stale-frame";
        layer.dataset.earthDiveSpatialReveal = "holding";
        delete layer.dataset.earthDiveAnchorDelta;
        delete layer.dataset.earthDiveScaleError;
        layer.style.removeProperty("--earth-dive-reveal-progress");
        return;
      }
      if (alignment) {
        layer.dataset.earthDiveAlignment = alignment.aligned ? "aligned" : "pending";
        layer.dataset.earthDiveAnchorDelta = alignment.anchorDeltaPx.toFixed(3);
        layer.dataset.earthDiveScaleError = alignment.localScaleError.toFixed(5);
      } else {
        layer.dataset.earthDiveAlignment = "pending";
        delete layer.dataset.earthDiveAnchorDelta;
        delete layer.dataset.earthDiveScaleError;
      }
      if (!alignment?.aligned) {
        // Never expose a second renderer while it is still visibly correcting
        // towards the particle camera. The existing opacity transition begins
        // only after both renderers agree.
        layer.dataset.earthDiveSpatialReveal = "holding";
        layer.style.removeProperty("--earth-dive-reveal-progress");
        return;
      }
    } else {
      // An unfocused fallback has no shared screen-space anchor to grade. Keep
      // the old full-frame blend rather than blocking semantic navigation.
      layer.dataset.earthDiveSpatialReveal = "fallback";
      delete layer.dataset.earthDiveAlignment;
      layer.style.removeProperty("--earth-dive-reveal-progress");
      return;
    }

    const rect = layer.getBoundingClientRect();
    const geometry = resolveEarthDiveRevealGeometry(
      frame,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      stage,
      snapshot,
    );
    if (!geometry) {
      layer.dataset.earthDiveSpatialReveal = "fallback";
      layer.style.removeProperty("--earth-dive-reveal-progress");
      return;
    }
    layer.dataset.earthDiveSpatialReveal = "on";
    layer.style.setProperty("--earth-dive-reveal-x", `${geometry.anchorX.toFixed(2)}px`);
    layer.style.setProperty("--earth-dive-reveal-y", `${geometry.anchorY.toFixed(2)}px`);
    layer.style.setProperty("--earth-dive-reveal-core-radius", `${geometry.coreRadius.toFixed(2)}px`);
    layer.style.setProperty("--earth-dive-reveal-edge-radius", `${geometry.edgeRadius.toFixed(2)}px`);
    layer.style.setProperty("--earth-dive-reveal-progress", geometry.progress.toFixed(3));
  }, []);

  const bindDetailLayer = useCallback((element: HTMLDivElement | null) => {
    detailLayerRef.current = element;
    if (element) syncDetailSpatialReveal();
    scheduleDiveTick();
  }, [scheduleDiveTick, syncDetailSpatialReveal]);

  // Stable identity: this callback travels through the persistent scene's
  // presentation, which is itself an effect dependency.
  const handleSemanticZoomSnapshot = useCallback((snapshot: SemanticZoomSnapshot) => {
    snapshotRef.current = snapshot;
    scheduleDiveTick();
    const policy = earthExperiencePolicyRef.current;
    if (policy === "particle-only") {
      setParticleOnlyZoomedIn(snapshot.level === "local");
    }
    syncDetailSpatialReveal(diveRef.current.stage, snapshot, particleFrameRef.current);
    onSemanticZoomChange?.(snapshot.level);
    if (policy === "particle-only" || diveRef.current.stage === "particle") return;
    setHandoffSnapshot((previous) => (
      previous
        && previous.level === snapshot.level
        && Math.abs(previous.localProgress - snapshot.localProgress) < 0.01
        ? previous
        : snapshot
    ));
  }, [onSemanticZoomChange, scheduleDiveTick, syncDetailSpatialReveal]);

  const handleParticleAnchorFrame = useCallback((frame: ParticleAnchorFrame | null) => {
    particleFrameRef.current = frame;
    // Once Detailed Earth owns the camera, Particle Earth is no longer a
    // handoff input. Keep the last frame for a later release, but do not let
    // background particle frames wake the otherwise-idle Dive scheduler or
    // push stale particle geometry back into the detail renderer.
    if (diveRef.current.owner === "detail") return;
    scheduleDiveTick();
    if (frame && diveRef.current.owner === "particle") {
      // Keep the hidden/blending detail camera on the exact frame that was
      // just published, rather than waiting one React render/effect behind.
      detailCalibrationRef.current?.(frame, "sync");
    }
    syncDetailSpatialReveal(diveRef.current.stage, snapshotRef.current, frame);
    if (diveRef.current.stage === "particle") return;
    setParticleFrame(frame);
  }, [scheduleDiveTick, syncDetailSpatialReveal]);

  const handleHomeBasePresenceFrame = useCallback((frame: readonly ProjectedHomeBasePresence[]) => {
    const nextFrames = new Map(frame.map((entry) => [entry.periodId, entry]));
    homeBaseFramesRef.current = nextFrames;
    for (const [periodId, element] of homeBaseElementsRef.current) {
      applyHomeBaseFrame(element, nextFrames.get(periodId));
    }
  }, [applyHomeBaseFrame]);

  const handleManualCameraInteraction = useCallback(() => {
    if (earthExperiencePolicyRef.current === "default") policyEntryArmedRef.current = true;
    scheduleDiveTick();
    onManualCameraInteraction?.();
  }, [onManualCameraInteraction, scheduleDiveTick]);
  const handleParticleFocusSettled = useCallback((revision: number) => {
    if (diveRef.current.owner === "particle") onFocusSettled?.(revision);
  }, [onFocusSettled]);
  const handleDetailFocusSettled = useCallback((revision: number) => {
    // Detail only emits after its own rendered owner prop is `detail`. This
    // also covers a synchronous Reduced Motion settlement before the parent's
    // passive dive mirror has observed that ownership commit.
    onFocusSettled?.(revision);
  }, [onFocusSettled]);

  const handleDetailReadiness = useCallback((readiness: DetailReadiness) => {
    if (earthExperiencePolicyRef.current === "particle-only") return;
    // MapLibre can repeat the settled notification after ownership commits.
    // An unchanged input must not restart the stable detail resolver.
    if (diveRef.current.stage === "detail" && readinessRef.current === readiness) return;
    readinessRef.current = readiness;
    scheduleDiveTick();
  }, [scheduleDiveTick]);

  const handleDetailCameraObservation = useCallback((point: { latitude: number; longitude: number }) => {
    if (
      earthExperiencePolicyRef.current !== "default"
      || diveRef.current.owner !== "detail"
    ) return;
    latestDetailObservationRef.current = { lat: point.latitude, lon: point.longitude };
  }, []);

  useEffect(() => {
    if (earthExperiencePolicy !== "particle-only") return;
    const shouldHandBackDetailCamera = pendingPolicyHandbackRef.current;
    pendingPolicyHandbackRef.current = false;
    const center = pendingPolicyHandbackCenterRef.current ?? undefined;
    pendingPolicyHandbackCenterRef.current = null;
    if (shouldHandBackDetailCamera) {
      setZoomIntent((previous) => ({
        zoom: snapshotRef.current.zoom,
        revision: (previous?.revision ?? 0) + 1,
        center,
      }));
    }
    setParticleOnlyZoomedIn(snapshotRef.current.level === "local");
    setDive({ ...INITIAL_EARTH_DIVE_STATE, blendMs: diveRef.current.blendMs });
    readinessRef.current = "unavailable";
    commandRequestedRef.current = false;
    releaseRequestedRef.current = false;
    setHandoffSnapshot(null);
    setParticleFrame(null);
  }, [earthExperiencePolicy]);

  // Handing the camera home: ownership ends and the zoom authority is set back
  // to where the band reopens, so the particle globe and the map cannot
  // disagree about where the user is. Whether the Dive ends altogether is
  // still the band's decision — `regional` holds the prewarm.
  const releaseDive = useCallback(() => {
    if (diveRef.current.stage === "particle") return;
    commandRequestedRef.current = false;
    releaseRequestedRef.current = true;
    scheduleDiveTick();
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
  }, [scheduleDiveTick]);

  // #308: wheel/pinch and the keyboard intent affordance converge here. This
  // remains one semantic navigation command rather than a renderer switch.
  // Invoked while a Dive is pending or owned by detail, it releases back to
  // the overview path; the readiness/failure semantics remain owned by #252.
  const requestDive = useCallback(() => {
    if (earthExperiencePolicyRef.current === "particle-only") {
      setZoomIntent((previous) => ({
        zoom: particleOnlyZoomedIn ? SEMANTIC_ZOOM_RELEASE_ZOOM : GLOBE_SEMANTIC_ZOOM_CEILING,
        revision: (previous?.revision ?? 0) + 1,
      }));
      setParticleOnlyZoomedIn((current) => !current);
      return;
    }
    policyEntryArmedRef.current = true;
    if (diveRef.current.stage !== "particle") {
      releaseDive();
      return;
    }
    releaseRequestedRef.current = false;
    commandRequestedRef.current = true;
    scheduleDiveTick();
  }, [particleOnlyZoomedIn, releaseDive, scheduleDiveTick]);

  useEffect(() => {
    let frame = 0;
    let tickCount = 0;
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(tick);
    };
    const tick = () => {
      frame = 0;
      if (import.meta.env.DEV) tickCount += 1;
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
      if (previous.stage === "blending" && earthExperiencePolicyRef.current === "default") {
        // Bounded to the overlap window: this rAF already exists for the Dive.
        // It keeps the reveal and the commit gate on the same latest published
        // camera frames without adding another observer or clock.
        syncDetailSpatialReveal(previous.stage, snapshotRef.current, particleFrameRef.current);
      }
      const revealMode = layer?.dataset.earthDiveSpatialReveal ?? null;
      const revealProgress = layer
        ? Number.parseFloat(layer.style.getPropertyValue("--earth-dive-reveal-progress"))
        : Number.NaN;
      const opacityPresented = previous.stage !== "blending"
        || !layer || Number(window.getComputedStyle(layer).opacity) >= 0.99;
      const spatialRevealPresented = revealMode === "on"
        ? Number.isFinite(revealProgress) && revealProgress >= 0.999
        : opacityPresented;
      const particleFrameMatchesZoom = particleAnchorFrameMatchesSemanticZoom(
        particleFrameRef.current,
        snapshotRef.current,
      );
      let alignment = previous.stage === "blending" && particleFrameMatchesZoom
        ? resolveEarthDiveAlignment(
          particleFrameRef.current,
          readDetailedEarthScreenFrame(layer),
        )
        : null;
      if (
        earthExperiencePolicyRef.current === "default"
        && previous.stage === "blending"
        && snapshotRef.current.level === "local"
        && revealMode !== "fallback"
        && readinessRef.current === "fully-settled"
        && particleFrameMatchesZoom
        && particleFrameRef.current
        && !alignment?.aligned
      ) {
        // A stable max-zoom particle frame may need another bounded projection
        // correction after MapLibre has drawn. Reuse the EXISTING Dive rAF as
        // the only retry authority and preserve the current corrected center;
        // no timer/state loop and no center reseed.
        detailCalibrationRef.current?.(particleFrameRef.current, "retry");
        syncDetailSpatialReveal(previous.stage, snapshotRef.current, particleFrameRef.current);
        alignment = resolveEarthDiveAlignment(
          particleFrameRef.current,
          readDetailedEarthScreenFrame(layer),
        );
      }
      const alignmentPresented = snapshotRef.current.level !== "local"
        || revealMode === "fallback"
        || !particleFrameRef.current
        || (particleFrameMatchesZoom && Boolean(alignment?.aligned));
      const blendPresented = spatialRevealPresented && alignmentPresented;
      const next = resolveEarthDive(previous, {
        policy: earthExperiencePolicyRef.current,
        snapshot: snapshotRef.current,
        readiness: readinessRef.current,
        handoffRevision: handoffRevisionRef.current,
        focusRevision: focusRevisionRef.current,
        commandRequested: commandRequestedRef.current,
        releaseRequested: releaseRequestedRef.current,
        blendPresented,
        suspended: suspendedRef.current,
        entryAllowed: policyEntryArmedRef.current,
        reduceMotion: reduceMotionRef.current,
      });
      if (layer && previous.owner !== "detail" && next.owner === "detail") {
        if (alignment?.aligned) {
          // Publish the exact alignment that authorized ownership transfer. QA
          // grades this edge, not later frames after the user is legitimately
          // driving the detail camera independently.
          layer.dataset.earthDiveCommitAnchorDelta = alignment.anchorDeltaPx.toFixed(3);
          layer.dataset.earthDiveCommitScaleError = alignment.localScaleError.toFixed(5);
        } else {
          delete layer.dataset.earthDiveCommitAnchorDelta;
          delete layer.dataset.earthDiveCommitScaleError;
        }
      }
      // The release is consumed only after React has committed the renderer
      // back to prewarm/particle. `next` can reach prewarm while the committed
      // mirror is still blending; clearing on that speculative step lets a
      // following rAF re-enter detail and overwrite the pending reverse handoff.
      // Keep the latch through that commit, then let the band decide from the
      // next frame onward. This still happens before the no-change exit so a
      // committed prewarm does not latch every later dive forever.
      if (
        releaseRequestedRef.current
        && (previous.stage === "prewarm" || previous.stage === "particle")
      ) {
        releaseRequestedRef.current = false;
        // The resolver just consumed the old latch; reconcile its cleared
        // value even when this tick did not need a React state change.
        schedule();
      }
      if (next.stage === previous.stage && next.owner === previous.owner && next.blendMs === previous.blendMs) {
        // CSS presentation and post-render calibration have no input callback.
        // Only their overlap window needs continuous observation.
        if (previous.stage === "blending") schedule();
        return;
      }
      if (next.stage === "particle") {
        if (layer) {
          delete layer.dataset.earthDiveCommitAnchorDelta;
          delete layer.dataset.earthDiveCommitScaleError;
        }
        // The map is torn down with the Dive, so its readiness cannot outlive it.
        readinessRef.current = "unavailable";
        commandRequestedRef.current = false;
        setHandoffSnapshot(null);
        setParticleFrame(null);
      } else if (previous.stage === "particle" && particleFrameRef.current) {
        // Reuse the most recently published particle frame immediately on
        // prewarm; do not wait for camera motion to cross the publisher's
        // sub-pixel threshold before the hidden map can align itself.
        setParticleFrame(particleFrameRef.current);
      }
      // Do not clear the blending presentation speculatively before React has
      // committed detail ownership. In particular, the keyboard fallback must
      // remain a real full-frame blend through the ownership edge; cleanup to
      // `off` happens from the committed-detail effect below.
      if (next.stage !== "detail") {
        syncDetailSpatialReveal(next.stage, snapshotRef.current, particleFrameRef.current);
      }
      setDive(next);
    };
    scheduleDiveTickRef.current = schedule;
    const readScheduler = () => ({
      tickCount,
      pending: frame !== 0,
      stage: diveRef.current.stage,
      inputs: {
        snapshot: snapshotRef.current,
        particleFrame: particleFrameRef.current,
        readiness: readinessRef.current,
        focusRevision: focusRevisionRef.current,
      },
    });
    const debugWindow = window as Window & { __earthDiveDebug?: typeof readScheduler };
    if (import.meta.env.DEV) debugWindow.__earthDiveDebug = readScheduler;
    schedule();
    return () => {
      scheduleDiveTickRef.current = null;
      window.cancelAnimationFrame(frame);
      if (import.meta.env.DEV && debugWindow.__earthDiveDebug === readScheduler) {
        delete debugWindow.__earthDiveDebug;
      }
    };
  }, [syncDetailSpatialReveal]);

  useEffect(() => {
    if (dive.stage !== "detail") return;
    // Final reveal cleanup belongs to the committed detail state, not to the
    // speculative resolver step that precedes the React ownership commit.
    syncDetailSpatialReveal("detail", snapshotRef.current, particleFrameRef.current);
  }, [dive.stage, syncDetailSpatialReveal]);

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

  const effectiveDive: EarthDiveState = earthExperiencePolicy === "particle-only"
    ? { ...INITIAL_EARTH_DIVE_STATE, blendMs: dive.blendMs }
    : dive;
  const homeBaseInteractive = effectiveDive.owner !== "detail"
    && !cinematicActive
    && !onGlobePointPick
    && Boolean(onHomeBaseActivate);

  useEffect(() => {
    persistentEarth.setAtlasPresentation({
      focusPoint,
      focusRoute,
      initialCameraAnchor,
      focusRevision,
      focusEnabled,
      focusFlightPending,
      focusFlightProfile,
      focusColor,
      journeyRoutes,
      visibleRoutePointIds,
      activeJourneyRouteId,
      selectedJourneyRoutePoint,
      narrativeJourneyRoutePoint,
      temporalReveal,
      onJourneyRouteActivate,
      onJourneyRoutePointActivate,
      onGlobeBlankActivate,
      onHomeBaseActivate: homeBaseInteractive ? onHomeBaseActivate : undefined,
      onGlobePointPick,
      onSemanticZoomSnapshot: handleSemanticZoomSnapshot,
      onParticleAnchorFrame: handleParticleAnchorFrame,
      homeBasePresence: homeBaseLayer,
      onHomeBasePresenceFrame: handleHomeBasePresenceFrame,
      onManualCameraInteraction: handleManualCameraInteraction,
      onFocusSettled: handleParticleFocusSettled,
      zoomIntent: zoomIntent ?? undefined,
      inputOwner: effectiveDive.owner,
      earthDiveOverlapActive: effectiveDive.stage === "prewarm" || effectiveDive.stage === "blending",
      mediaCoverHint: {
        opaqueMediaCover: Boolean(mediaCoverHint?.opaqueMediaCover),
        coverTransitionActive: Boolean(mediaCoverHint?.coverTransitionActive),
      },
      reduceMotion,
    });
  }, [
    activeJourneyRouteId,
    selectedJourneyRoutePoint?.journeyId,
    selectedJourneyRoutePoint?.routePointId,
    selectedJourneyRoutePoint?.pointIndex,
    narrativeJourneyRoutePoint?.journeyId,
    narrativeJourneyRoutePoint?.routePointId,
    narrativeJourneyRoutePoint?.pointIndex,
    cinematicActive,
    earthExperiencePolicy,
    dive.owner,
    dive.stage,
    focusColor,
    focusPoint,
    focusRevision,
    focusEnabled,
    focusFlightPending,
    focusFlightProfile,
    focusRoute,
    initialCameraAnchor,
    handleHomeBasePresenceFrame,
    handleParticleAnchorFrame,
    handleSemanticZoomSnapshot,
    homeBaseInteractive,
    homeBaseLayer,
    journeyRoutes,
    visibleRoutePointIds,
    zoomIntent,
    onGlobePointPick,
    handleManualCameraInteraction,
    handleParticleFocusSettled,
    onJourneyRouteActivate,
    onJourneyRoutePointActivate,
    onGlobeBlankActivate,
    onHomeBaseActivate,
    persistentEarth,
    reduceMotion,
    mediaCoverHint?.opaqueMediaCover,
    mediaCoverHint?.coverTransitionActive,
    temporalReveal,
  ]);

  useEffect(() => () => persistentEarth.setAtlasPresentation(null), [persistentEarth]);

  useEffect(() => {
    if (earthExperiencePolicy !== "default") return;
    const preloadTimer = window.setTimeout(() => void loadDetailedEarthMap(), 350);
    return () => window.clearTimeout(preloadTimer);
  }, [earthExperiencePolicy]);

  // The detail renderer is mounted from `prewarm` on, hidden, so the blend has
  // something real to reveal and nothing has to be revealed on a timer. A hard
  // particle-only policy is checked before mount so no hidden MapLibre lifetime
  // exists for CSS to conceal.
  const showDetail = earthExperiencePolicy === "default" && effectiveDive.stage !== "particle";
  const detailMode = effectiveDive.stage === "detail";
  // #308 review: compact mobile still needs a non-gesture path for external
  // keyboards and switch-control users. Keep the semantic Dive intent mounted
  // independently from the optional detail utility cluster; focus mode and
  // cinematic isolation remain intentionally control-free.
  const showDiveIntent = !globeFocusMode && !cinematicActive;

  return (
    <section
      className={`living-atlas-globe${detailMode ? " is-detail" : " is-overview"}${cinematicActive ? " is-cinematic" : ""}`}
      data-earth-mode={detailMode ? "detail" : "particle"}
      data-earth-policy={earthExperiencePolicy}
      data-earth-dive={effectiveDive.stage}
      data-earth-dive-owner={effectiveDive.owner}
      style={{ "--earth-dive-blend-ms": `${effectiveDive.blendMs}ms` } as CSSProperties}
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
        <div ref={bindDetailLayer} className="living-atlas-globe__layer living-atlas-globe__detail-layer">
          <Suspense fallback={null}>
            <DetailedEarthMap
              diveStage={effectiveDive.stage}
              diveOwner={effectiveDive.owner}
              diveSnapshot={handoffSnapshot ?? snapshotRef.current}
              particleFrame={particleFrame}
              focusPoint={focusPoint}
              focusRoute={focusRoute}
              journeyOverlay={detailedEarthJourneyOverlay}
              focusRevision={focusRevision}
              focusEnabled={focusEnabled}
              focusFlightPending={focusFlightPending}
              focusFlightProfile={focusFlightProfile}
              reduceMotion={reduceMotion}
              language={detailLanguage}
              onJourneyRoutePointActivate={onJourneyRoutePointActivate}
              onGlobeBlankActivate={onGlobeBlankActivate}
              onManualCameraInteraction={handleManualCameraInteraction}
              onFocusSettled={handleDetailFocusSettled}
              onGlobePointPick={detailMode ? onGlobePointPick : undefined}
              onOverviewRequest={releaseDive}
              onCameraObservation={handleDetailCameraObservation}
              onReadinessChange={handleDetailReadiness}
              calibrationHandleRef={detailCalibrationRef}
            />
          </Suspense>
        </div>
      ) : null}

      {homeBaseInteractive ? homeBaseLayer.map((descriptor) => (
          <button
            key={descriptor.periodId}
            ref={(element) => bindHomeBaseElement(descriptor.periodId, element)}
            type="button"
            className="living-atlas-globe__home-base"
            tabIndex={-1}
            hidden
            aria-label={descriptor.accessibleName}
            aria-expanded={activeHomeBaseContextPeriodId === descriptor.periodId}
            aria-controls={activeHomeBaseContextPeriodId === descriptor.periodId ? "home-base-context" : undefined}
            data-home-base-period-id={descriptor.periodId}
            data-home-base-presence={descriptor.presence}
            onClick={() => onHomeBaseActivate?.(descriptor.periodId)}
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
          </button>
        )) : null}

      {showControls || showDiveIntent ? (
        <LivingAtlasGlobeControls
          diveStage={effectiveDive.stage}
          detailLanguage={detailLanguage}
          onDiveIntent={requestDive}
          onDetailLanguageChange={setDetailLanguage}
          onPickRequest={onPickRequest}
          showDiveIntent={showDiveIntent}
          showDetailControls={showControls}
          diveIntentLabel={earthExperiencePolicy === "particle-only"
            ? particleOnlyZoomedIn ? "退远查看全局" : "靠近查看局部"
            : undefined}
          inert={cinematicActive}
        />
      ) : null}

      {modeNoteVisible && (
        effectiveDive.stage === "prewarm"
        || effectiveDive.stage === "blending"
        || detailMode
      ) ? (
        <div className="living-atlas-globe__mode-note" aria-hidden="true">
          {effectiveDive.stage === "prewarm" || effectiveDive.stage === "blending"
            ? "VECTOR MAP PREPARING"
            : "DRAG TO EXPLORE / ZOOM OUT TO RETURN"}
        </div>
      ) : null}
    </section>
  );
}
