import { lazy, Suspense, useEffect, useState } from "react";
import { IconMap2, IconWorld } from "@tabler/icons-react";
import type { JourneyRoute } from "../journey/types";
import type { DetailedEarthLanguage } from "./detailedEarthModel";
import { ParticleEarthScene } from "./ParticleEarthScene";

const loadDetailedEarthMap = () => import("./DetailedEarthMap");
const DetailedEarthMap = lazy(loadDetailedEarthMap);
const EARTH_CROSSFADE_MS = 900;
const EARTH_LOAD_TIMEOUT_MS = 12_000;

type EarthMode = "particle" | "detail";

type LivingAtlasGlobeProps = {
  focusPoint?: { lat: number; lon: number } | null;
  focusColor?: string;
  journeyRoutes: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  onJourneyRouteActivate: (journeyId: string) => void;
  onJourneyRoutePointActivate: (journeyId: string, routePointId: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  reduceMotion?: boolean;
};

export function LivingAtlasGlobe({
  focusPoint,
  focusColor,
  journeyRoutes,
  activeJourneyRouteId,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobePointPick,
  reduceMotion,
}: LivingAtlasGlobeProps) {
  const [earthMode, setEarthMode] = useState<EarthMode>("particle");
  const [transitionTarget, setTransitionTarget] = useState<EarthMode | null>(null);
  const [targetReady, setTargetReady] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [detailLanguage, setDetailLanguage] = useState<DetailedEarthLanguage>("zh");

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
    setTargetReady(false);
    setTransitionTarget(target);
  };

  const finishTransition = (target: EarthMode) => {
    if (transitionTarget !== target || !targetReady) return;
    setEarthMode(target);
    setTransitionTarget(null);
    setTargetReady(false);
  };

  const showParticle = earthMode === "particle" || transitionTarget === "particle";
  const showDetail = earthMode === "detail" || transitionTarget === "detail";
  const detailMode = earthMode === "detail";
  const transitionLabel = transitionTarget === "detail"
    ? "正在准备真实地图…"
    : "正在返回粒子地球…";
  const transitionClasses = transitionTarget
    ? ` is-transitioning is-to-${transitionTarget}${targetReady ? " is-target-ready" : ""}`
    : "";

  return (
    <section
      className={`living-atlas-globe${detailMode ? " is-detail" : " is-overview"}${transitionClasses}`}
      data-earth-mode={detailMode ? "detail" : "particle"}
      aria-label={detailMode ? "高精度地球地图" : "粒子艺术地球"}
    >
      {showParticle ? (
        <div
          className="living-atlas-globe__layer living-atlas-globe__particle-layer"
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "opacity") {
              finishTransition("particle");
            }
          }}
        >
          <ParticleEarthScene
            mode="focusPoint"
            quality="high"
            focusPoint={focusPoint}
            focusColor={focusColor}
            centerFocusPoint
            journeyRoutes={journeyRoutes}
            activeJourneyRouteId={activeJourneyRouteId}
            onJourneyRouteActivate={onJourneyRouteActivate}
            onJourneyRoutePointActivate={onJourneyRoutePointActivate}
            onGlobePointPick={onGlobePointPick}
            showArchiveSignals={false}
            onReady={() => {
              if (transitionTarget === "particle") setTargetReady(true);
            }}
            onDetailRequested={() => beginTransition("detail")}
            dragToRotate
            reduceMotion={reduceMotion}
          />
        </div>
      ) : null}

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
              language={detailLanguage}
              onGlobePointPick={onGlobePointPick}
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

      <div className="living-atlas-globe__controls">
        <button
          type="button"
          className="living-atlas-globe__mode"
          onClick={() => beginTransition(detailMode ? "particle" : "detail")}
          aria-pressed={detailMode}
          disabled={Boolean(transitionTarget)}
        >
          {detailMode ? <IconWorld size={16} stroke={1.25} aria-hidden="true" /> : <IconMap2 size={16} stroke={1.25} aria-hidden="true" />}
          <span>{transitionTarget ? transitionLabel : detailMode ? "返回粒子地球" : "深入真实地图"}</span>
          <small>{detailMode ? "ART GLOBE" : "ZOOM 20"}</small>
        </button>

        {detailMode && !transitionTarget ? (
          <div className="living-atlas-globe__language" role="group" aria-label="地图语言">
            <button
              type="button"
              className={detailLanguage === "zh" ? "is-active" : ""}
              onClick={() => setDetailLanguage("zh")}
              aria-pressed={detailLanguage === "zh"}
            >
              中文
            </button>
            <button
              type="button"
              className={detailLanguage === "bilingual" ? "is-active" : ""}
              onClick={() => setDetailLanguage("bilingual")}
              aria-pressed={detailLanguage === "bilingual"}
            >
              双语
            </button>
          </div>
        ) : null}
      </div>

      <div className="living-atlas-globe__mode-note" aria-hidden="true">
        {transitionTarget
          ? "VECTOR MAP PREPARING"
          : detailMode
            ? "CHINESE LABELS / VECTOR DETAIL"
            : "SCROLL TO ENTER DETAIL"}
      </div>
    </section>
  );
}
