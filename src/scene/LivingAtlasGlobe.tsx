import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconMap2, IconMapPin, IconWorld } from "@tabler/icons-react";
import type { PlaybackTravelChoreography } from "../journey/journeyPlayback";
import { useCompactMobileLayout } from "../journey/mobileLayout";
import type { JourneyRoute } from "../journey/types";
import type { DetailedEarthLanguage } from "./detailedEarthModel";
import {
  INITIAL_EARTH_DIVE_STATE,
  resolveEarthDive,
  type DetailReadiness,
  type EarthDiveOwner,
  type EarthDiveStage,
  type EarthDiveState,
} from "./earthDive";
import { GLOBE_MODE_CONFIG, ParticleEarthScene } from "./ParticleEarthScene";
import {
  SEMANTIC_ZOOM_RELEASE_ZOOM,
  type SemanticZoomSnapshot,
} from "./semanticZoom";

const loadDetailedEarthMap = () => import("./DetailedEarthMap");
const DetailedEarthMap = lazy(loadDetailedEarthMap);

// #252: the control is the fallback COMMAND for the same Semantic Earth Dive,
// not a second product mode. Its label reports where the zoom-driven
// controller stands.
const DIVE_PENDING_LABEL = "正在深入真实地图…";

type LivingAtlasGlobeControlsProps = {
  diveStage: EarthDiveStage;
  detailLanguage: DetailedEarthLanguage;
  onModeToggle: () => void;
  onDetailLanguageChange: (language: DetailedEarthLanguage) => void;
  onPickRequest?: () => void;
  inert?: boolean;
};

export function LivingAtlasGlobeControls({
  diveStage,
  detailLanguage,
  onModeToggle,
  onDetailLanguageChange,
  onPickRequest,
  inert = false,
}: LivingAtlasGlobeControlsProps) {
  const detailMode = diveStage === "detail";
  const pending = diveStage === "prewarm" || diveStage === "blending";
  return (
    <div
      className="living-atlas-globe__controls"
      inert={inert || undefined}
      aria-hidden={inert || undefined}
    >
      <button
        type="button"
        className="living-atlas-globe__mode"
        onClick={onModeToggle}
        aria-label={detailMode ? "返回粒子地球" : "深入真实地图"}
        aria-pressed={detailMode}
      >
        {detailMode ? <IconWorld size={16} stroke={1.25} aria-hidden="true" /> : <IconMap2 size={16} stroke={1.25} aria-hidden="true" />}
        <span>{pending ? DIVE_PENDING_LABEL : detailMode ? "返回粒子地球" : "深入真实地图"}</span>
        <small>{detailMode ? "ART GLOBE" : "REGION MAP"}</small>
      </button>

      {detailMode ? (
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

      {detailMode && onPickRequest ? (
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
  focusRevision?: number;
  focusFlightProfile?: PlaybackTravelChoreography;
  focusColor?: string;
  journeyRoutes: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  temporalReveal?: {
    journeys: ReadonlyMap<string, number>;
    points: ReadonlyMap<string, number>;
  };
  onJourneyRouteActivate: (journeyId: string) => void;
  onJourneyRoutePointActivate: (journeyId: string, routePointId: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onPickRequest?: () => void;
  showControls?: boolean;
  reduceMotion?: boolean;
  cinematicActive?: boolean;
};

type PersistentEarthStage = "idle" | "login" | "handoff" | "atlas";

type LoginEarthPresentation = {
  mode: "archiveBurst" | "particleSphere";
  reduceMotion: boolean;
};

type AtlasEarthPresentation = Pick<
  LivingAtlasGlobeProps,
  | "focusPoint"
  | "focusRoute"
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
> & {
  /**
   * #252: the Dive controller lives with the Atlas globe, but the camera lives
   * in the persistent scene. These are the only two channels between them, and
   * both are the zoom authority's own currency: the snapshot it publishes, and
   * a hand-back of the camera to the zoom at which the band reopens.
   */
  onSemanticZoomSnapshot?: (snapshot: SemanticZoomSnapshot) => void;
  zoomIntent?: { zoom: number; revision: number };
  /** Who owns camera and gesture input on this frame. */
  inputOwner?: EarthDiveOwner;
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
  focusRevision,
  focusFlightProfile,
  focusColor,
  journeyRoutes,
  activeJourneyRouteId,
  temporalReveal,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobePointPick,
  onPickRequest,
  showControls = true,
  reduceMotion,
  cinematicActive = false,
}: LivingAtlasGlobeProps) {
  const persistentEarth = usePersistentEarth();
  const [detailLanguage, setDetailLanguage] = useState<DetailedEarthLanguage>("zh");

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
  const [zoomIntent, setZoomIntent] = useState<{ zoom: number; revision: number } | null>(null);
  const diveRef = useRef<EarthDiveState>(INITIAL_EARTH_DIVE_STATE);
  const snapshotRef = useRef<SemanticZoomSnapshot>({ level: "planet", zoom: 1, localProgress: 0 });
  const readinessRef = useRef<DetailReadiness>("unavailable");
  const commandRequestedRef = useRef(false);
  const releaseRequestedRef = useRef(false);
  const focusRevisionRef = useRef(focusRevision ?? 0);
  const handoffRevisionRef = useRef(focusRevision ?? 0);
  focusRevisionRef.current = focusRevision ?? 0;

  // Stable identity: this callback travels through the persistent scene's
  // presentation, which is itself an effect dependency.
  const handleSemanticZoomSnapshot = useCallback((snapshot: SemanticZoomSnapshot) => {
    snapshotRef.current = snapshot;
    if (diveRef.current.stage === "particle") return;
    setHandoffSnapshot((previous) => (
      previous
        && previous.level === snapshot.level
        && Math.abs(previous.localProgress - snapshot.localProgress) < 0.01
        ? previous
        : snapshot
    ));
  }, []);

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

  const requestDive = useCallback(() => {
    if (diveRef.current.stage === "detail") {
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
      const next = resolveEarthDive(previous, {
        snapshot: snapshotRef.current,
        readiness: readinessRef.current,
        handoffRevision: handoffRevisionRef.current,
        focusRevision: focusRevisionRef.current,
        commandRequested: commandRequestedRef.current,
        releaseRequested: releaseRequestedRef.current,
        reduceMotion: Boolean(reduceMotion),
      });
      if (next.stage === previous.stage && next.owner === previous.owner && next.blendMs === previous.blendMs) return;
      // The release is consumed once ownership is home and the renderer is
      // back to warming: from there the band alone decides.
      if (next.stage === "prewarm" || next.stage === "particle") releaseRequestedRef.current = false;
      if (next.stage === "particle") {
        // The map is torn down with the Dive, so its readiness cannot outlive it.
        readinessRef.current = "unavailable";
        commandRequestedRef.current = false;
        setHandoffSnapshot(null);
      }
      diveRef.current = next;
      setDive(next);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [reduceMotion]);

  useEffect(() => {
    persistentEarth.setAtlasPresentation({
      focusPoint,
      focusRoute,
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
      zoomIntent: zoomIntent ?? undefined,
      inputOwner: dive.owner,
      reduceMotion,
    });
  }, [
    activeJourneyRouteId,
    dive.owner,
    focusColor,
    focusPoint,
    focusRevision,
    focusFlightProfile,
    focusRoute,
    handleSemanticZoomSnapshot,
    journeyRoutes,
    zoomIntent,
    onGlobePointPick,
    onJourneyRouteActivate,
    onJourneyRoutePointActivate,
    persistentEarth,
    reduceMotion,
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
        <div className="living-atlas-globe__layer living-atlas-globe__detail-layer">
          <Suspense fallback={null}>
            <DetailedEarthMap
              diveStage={dive.stage}
              diveOwner={dive.owner}
              diveSnapshot={handoffSnapshot ?? snapshotRef.current}
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

      {showControls ? (
        <>
          <LivingAtlasGlobeControls
            diveStage={dive.stage}
            detailLanguage={detailLanguage}
            onModeToggle={requestDive}
            onDetailLanguageChange={setDetailLanguage}
            onPickRequest={onPickRequest}
            inert={cinematicActive}
          />

          <div className="living-atlas-globe__mode-note" aria-hidden="true">
            {dive.stage === "prewarm" || dive.stage === "blending"
              ? "VECTOR MAP PREPARING"
              : detailMode
                ? "DRAG TO EXPLORE / ZOOM OUT TO RETURN"
                : "SCROLL TO ZOOM / DRAG TO ROTATE"}
          </div>
        </>
      ) : null}
    </section>
  );
}
