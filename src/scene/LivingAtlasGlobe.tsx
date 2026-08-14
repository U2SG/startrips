import { lazy, Suspense, useState } from "react";
import { IconMap2, IconWorld } from "@tabler/icons-react";
import type { JourneyRoute } from "../journey/types";
import { ParticleEarthScene } from "./ParticleEarthScene";

const DetailedEarthMap = lazy(() => import("./DetailedEarthMap"));

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
  const [detailMode, setDetailMode] = useState(false);

  return (
    <section
      className={`living-atlas-globe${detailMode ? " is-detail" : " is-overview"}`}
      data-earth-mode={detailMode ? "detail" : "particle"}
      aria-label={detailMode ? "高精度地球地图" : "粒子艺术地球"}
    >
      {detailMode ? (
        <Suspense fallback={<div className="living-atlas-globe__loading">正在展开真实地球…</div>}>
          <DetailedEarthMap
            routes={journeyRoutes}
            activeJourneyRouteId={activeJourneyRouteId}
            focusPoint={focusPoint}
            onJourneyRouteActivate={onJourneyRouteActivate}
            onJourneyRoutePointActivate={onJourneyRoutePointActivate}
            onGlobePointPick={onGlobePointPick}
          />
        </Suspense>
      ) : (
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
          onDetailRequested={() => setDetailMode(true)}
          dragToRotate
          reduceMotion={reduceMotion}
        />
      )}

      <button
        type="button"
        className="living-atlas-globe__mode"
        onClick={() => setDetailMode((current) => !current)}
        aria-pressed={detailMode}
      >
        {detailMode ? <IconWorld size={16} stroke={1.25} aria-hidden="true" /> : <IconMap2 size={16} stroke={1.25} aria-hidden="true" />}
        <span>{detailMode ? "返回粒子地球" : "深入真实地图"}</span>
        <small>{detailMode ? "ART GLOBE" : "ZOOM 18"}</small>
      </button>

      <div className="living-atlas-globe__mode-note" aria-hidden="true">
        {detailMode ? "SATELLITE / STREET DETAIL" : "SCROLL TO ENTER DETAIL"}
      </div>
    </section>
  );
}
