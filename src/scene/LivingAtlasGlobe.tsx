import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { IconMap2, IconMapPin, IconWorld } from "@tabler/icons-react";
import type { PlaybackTravelChoreography } from "../journey/journeyPlayback";
import { useCompactMobileLayout } from "../journey/mobileLayout";
import type { JourneyRoute } from "../journey/types";
import type { DetailedEarthLanguage } from "./detailedEarthModel";
import { GLOBE_MODE_CONFIG, ParticleEarthScene } from "./ParticleEarthScene";

const loadDetailedEarthMap = () => import("./DetailedEarthMap");
const DetailedEarthMap = lazy(loadDetailedEarthMap);
const EARTH_CROSSFADE_MS = 900;
const EARTH_LOAD_TIMEOUT_MS = 12_000;

type EarthMode = "particle" | "detail";

type LivingAtlasGlobeControlsProps = {
  detailMode: boolean;
  transitionTarget: EarthMode | null;
  detailLanguage: DetailedEarthLanguage;
  transitionLabel: string;
  onModeToggle: () => void;
  onDetailLanguageChange: (language: DetailedEarthLanguage) => void;
  onPickRequest?: () => void;
  inert?: boolean;
};

export function LivingAtlasGlobeControls({
  detailMode,
  transitionTarget,
  detailLanguage,
  transitionLabel,
  onModeToggle,
  onDetailLanguageChange,
  onPickRequest,
  inert = false,
}: LivingAtlasGlobeControlsProps) {
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
        aria-label={transitionTarget ? transitionLabel : detailMode ? "返回粒子地球" : "深入真实地图"}
        aria-pressed={detailMode}
        disabled={Boolean(transitionTarget)}
      >
        {detailMode ? <IconWorld size={16} stroke={1.25} aria-hidden="true" /> : <IconMap2 size={16} stroke={1.25} aria-hidden="true" />}
        <span>{transitionTarget ? transitionLabel : detailMode ? "返回粒子地球" : "深入真实地图"}</span>
        <small>{detailMode ? "ART GLOBE" : "REGION MAP"}</small>
      </button>

      {detailMode && !transitionTarget ? (
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

      {detailMode && !transitionTarget && onPickRequest ? (
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
>;

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
                  showArchiveSignals={false}
                  dragToRotate={Boolean(atlas)}
                  wheelToZoom={Boolean(atlas)}
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
  const [earthMode, setEarthMode] = useState<EarthMode>("particle");
  const [transitionTarget, setTransitionTarget] = useState<EarthMode | null>(null);
  const [targetReady, setTargetReady] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [detailLanguage, setDetailLanguage] = useState<DetailedEarthLanguage>("zh");

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
      reduceMotion,
    });
  }, [
    activeJourneyRouteId,
    focusColor,
    focusPoint,
    focusRevision,
    focusFlightProfile,
    focusRoute,
    journeyRoutes,
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

  useEffect(() => {
    if (!transitionTarget || !targetReady) return;
    const finishTimer = window.setTimeout(() => {
      setEarthMode(transitionTarget);
      setTransitionTarget(null);
      setTargetReady(false);
    }, reduceMotion ? 50 : EARTH_CROSSFADE_MS + 200);
    return () => window.clearTimeout(finishTimer);
  }, [reduceMotion, targetReady, transitionTarget]);

  useEffect(() => {
    if (!transitionTarget || targetReady) return;
    const loadTimer = window.setTimeout(() => {
      setTransitionTarget(null);
      setTransitionError("地球视图加载超时，请重试");
    }, EARTH_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(loadTimer);
  }, [targetReady, transitionTarget]);

  const beginTransition = (target: EarthMode) => {
    if (transitionTarget || target === earthMode) return;
    setTransitionError(null);
    // The particle scene is persistent and already rendered behind the detail
    // map, so returning never waits for a second Three scene to mount.
    setTargetReady(target === "particle");
    setTransitionTarget(target);
  };

  const finishTransition = (target: EarthMode) => {
    if (transitionTarget !== target || !targetReady) return;
    setEarthMode(target);
    setTransitionTarget(null);
    setTargetReady(false);
  };

  const showDetail = earthMode === "detail" || transitionTarget === "detail" || transitionTarget === "particle";
  const detailMode = earthMode === "detail";
  const transitionLabel = transitionTarget === "detail"
    ? "正在准备真实地图…"
    : "正在返回粒子地球…";
  const transitionClasses = transitionTarget
    ? ` is-transitioning is-to-${transitionTarget}${targetReady ? " is-target-ready" : ""}`
    : "";

  return (
    <section
      className={`living-atlas-globe${detailMode ? " is-detail" : " is-overview"}${transitionClasses}${cinematicActive ? " is-cinematic" : ""}`}
      data-earth-mode={detailMode ? "detail" : "particle"}
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
        <div
          className="living-atlas-globe__layer living-atlas-globe__detail-layer"
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "opacity") {
              finishTransition("detail");
            }
          }}
        >
          <Suspense fallback={null}>
            <DetailedEarthMap
              focusPoint={focusPoint}
              focusRoute={focusRoute}
              focusRevision={focusRevision}
              focusFlightProfile={focusFlightProfile}
              language={detailLanguage}
              onGlobePointPick={onGlobePointPick}
              onOverviewRequest={() => beginTransition("particle")}
              onReady={() => {
                if (transitionTarget === "detail") setTargetReady(true);
              }}
            />
          </Suspense>
        </div>
      ) : null}

      {(transitionTarget && !targetReady) || transitionError ? (
        <div
          className={`living-atlas-globe__transition-status${transitionError ? " is-error" : ""}`}
          role="status"
        >
          {transitionError ?? transitionLabel}
        </div>
      ) : null}

      {showControls ? (
        <>
          <LivingAtlasGlobeControls
            detailMode={detailMode}
            transitionTarget={transitionTarget}
            detailLanguage={detailLanguage}
            transitionLabel={transitionLabel}
            onModeToggle={() => beginTransition(detailMode ? "particle" : "detail")}
            onDetailLanguageChange={setDetailLanguage}
            onPickRequest={onPickRequest}
            inert={cinematicActive}
          />

          <div className="living-atlas-globe__mode-note" aria-hidden="true">
            {transitionTarget
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
