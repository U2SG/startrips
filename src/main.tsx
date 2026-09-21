import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGateway } from "./auth/AuthGateway";
import { StartripsNotFound } from "./brand/StartripsNotFound";
import { StartripsRecoverySurface } from "./brand/StartripsRecoverySurface";
import type { StartripsRecoveryKind } from "./brand/startripsRecoverySurface";
import { StartripsBrandLoader } from "./brand/StartripsBrandMark";
import { LivingAtlasApp } from "./journey/LivingAtlasApp";
import { useCompactMobileLayout } from "./journey/mobileLayout";
import { JourneyComposer } from "./journey/JourneyComposer";
import { JourneyStory } from "./journey/JourneyStory";
import { JourneyPlaybackOverlay } from "./journey/JourneyPlaybackOverlay";
import {
  playbackCameraTargetKey,
  playbackMediaForPoint,
  type PlaybackCameraTarget,
  type PlaybackStep,
} from "./journey/journeyPlayback";
import { PLAYBACK_INITIAL_TEMPO } from "./journey/useJourneyPlaybackDirector";
import type { PlaybackTempo } from "./journey/journeyPlaybackPlan";
import {
  prepareQuickRecapPlayback,
  quickRecapStepDurationMs,
} from "./journey/quickRecapPlayback";
import { SharedAtlasView } from "./journey/SharedAtlasView";
import { isSharedAtlasPathname } from "./journey/sharedAtlas";
import {
  EarthExperiencePreferenceProvider,
  useEarthExperiencePreference,
} from "./journey/EarthExperienceProvider";
import { authClient } from "./auth/auth-client";
import type { Journey, JourneyRoute } from "./journey/types";
import { ParticleEarthScene } from "./scene/ParticleEarthScene";
import {
  LivingAtlasGlobe,
  LivingAtlasGlobeControls,
  PersistentEarthProvider,
  usePersistentEarth,
  type LivingAtlasGlobeProps,
} from "./scene/LivingAtlasGlobe";
import "./styles/tokens.css";
import "./app.css";
import "./styles/archive-shell.css";
import "./styles/artwork-browser.css";
import "./styles/personal-artifact.css";
import "./styles/personal-gallery.css";
import "./styles/auth-gate.css";
import "./styles/brand-mark.css";
import "./styles/living-atlas.css";
import "./styles/journey-playback.css";
import "./styles/globe-time-scrubber.css";
import "./styles/starlight-experience.css";

const qaState = new URLSearchParams(window.location.search).get("qaState");

const globeQaRoutes: JourneyRoute[] = [
  {
    id: "qa-route-night-train",
    color: "#77c8c2",
    lightEffect: "aurora",
    points: [
      { id: "qa-p-1", lat: 31.2304, lon: 121.4737, isStop: true, label: "Shanghai" },
      { id: "qa-p-2", lat: 34.7466, lon: 113.6254, isStop: true, label: "Zhengzhou" },
      { id: "qa-p-3", lat: 39.9042, lon: 116.4074, isStop: true, label: "Beijing" },
      { id: "qa-p-4", lat: 43.8256, lon: 87.6168, isStop: false, label: "Ürümqi" },
    ],
  },
  {
    id: "qa-route-sea-breeze",
    color: "#e8a87c",
    lightEffect: "rainbow",
    points: [
      { id: "qa-p-5", lat: 35.6762, lon: 139.6503, isStop: true, label: "Tokyo" },
      { id: "qa-p-6", lat: 34.6937, lon: 135.5023, isStop: true, label: "Osaka" },
      { id: "qa-p-7", lat: 33.5904, lon: 130.4017, isStop: true, label: "Fukuoka" },
    ],
  },
  {
    id: "qa-route-rhine",
    color: "#9fd356",
    lightEffect: "sunset",
    points: [
      { id: "qa-p-8", lat: 52.3676, lon: 4.9041, isStop: true, label: "Amsterdam" },
      { id: "qa-p-9", lat: 50.9375, lon: 6.9603, isStop: true, label: "Cologne" },
      { id: "qa-p-10", lat: 50.1109, lon: 8.6821, isStop: false, label: "Frankfurt" },
    ],
  },
  {
    id: "qa-route-southern-summer",
    color: "#b39ddb",
    lightEffect: "nebula",
    points: [
      { id: "qa-p-11", lat: -36.8509, lon: 174.7645, isStop: true, label: "Auckland" },
      { id: "qa-p-12", lat: -37.8136, lon: 144.9631, isStop: true, label: "Melbourne" },
      { id: "qa-p-13", lat: -33.8688, lon: 151.2093, isStop: false, label: "Sydney" },
    ],
  },
  {
    // #193 fixture: the reported US Southwest reproduction. Los Angeles and
    // Yosemite are the pair whose route visibly detached under wheel zoom.
    id: "qa-route-southwest",
    color: "#f4ce73",
    points: [
      { id: "qa-p-15", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
      { id: "qa-p-16", lat: 37.8651, lon: -119.5383, isStop: true, label: "Yosemite" },
      { id: "qa-p-17", lat: 36.1699, lon: -115.1398, isStop: true, label: "Las Vegas" },
      { id: "qa-p-18", lat: 35.1894, lon: -114.053, isStop: false, label: "Kingman" },
      { id: "qa-p-19", lat: 36.9147, lon: -111.4558, isStop: true, label: "Page" },
      { id: "qa-p-20", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
    ],
  },
  {
    // #242 fixture: a SYNTHETIC chain of eight evenly spaced ~0.5 degree legs,
    // generated from one origin and a constant step rather than taken from any
    // real itinerary. Short legs are where the old sqrt lift policy stood
    // tallest relative to the leg it decorated, so this is the shape that read
    // as a row of raised sawteeth when the globe rotated it toward the limb.
    id: "qa-route-short-legs",
    color: "#8fd0c4",
    points: Array.from({ length: 8 }, (_, index) => ({
      id: `qa-p-3${index}`,
      lat: 12 + (index * 0.35),
      lon: 8 + (index * 0.4),
      isStop: index === 0 || index === 7,
      label: `Synthetic stop ${index + 1}`,
    })),
  },
  {
    id: "qa-route-alone-at-sea",
    color: "#ffd166",
    points: [
      { id: "qa-p-14", lat: 1.290256, lon: 103.851471, isStop: true, label: "Singapore" },
    ],
  },
];

/**
 * #374 fixture: SYNTHETIC label-competition topology, not an itinerary. It
 * carries the three shapes the collision policy has to separate - a Route Point
 * whose label repeats a real Place Label, two records at the SAME coordinates,
 * and two records that share a label at DIFFERENT coordinates - plus a
 * pass-through point and an intermediate Stop for density.
 */
const labelArbitrationQaRoute: JourneyRoute = {
  id: "qa-route-label-arbitration",
  color: "#f4ce73",
  points: [
    { id: "qa-label-1", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
    { id: "qa-label-2", lat: 34.0522, lon: -118.2437, isStop: true, label: "Los Angeles" },
    { id: "qa-label-3", lat: 34.4208, lon: -117.3089, isStop: false, label: "Transit sample" },
    { id: "qa-label-4", lat: 34.8697, lon: -116.9797, isStop: true, label: "Sample Stop" },
    { id: "qa-label-5", lat: 35.3733, lon: -116.0553, isStop: true, label: "Los Angeles" },
    // Antipodal to the focus, i.e. always behind the globe's limb: a Route
    // Point that is not visible must not contribute a label.
    { id: "qa-label-6", lat: -28.0522, lon: 61.7563, isStop: true, label: "Horizon sample" },
  ],
};

function JourneyRoutesQaPreview() {
  const qaParams = new URLSearchParams(window.location.search);
  const routeOpticsQa = qaParams.get("qaRouteOptics") === "1";
  const labelArbitrationQa = qaParams.get("qaLabelArbitration") === "1";
  const [qaRouteDataUpdated, setQaRouteDataUpdated] = useState(false);
  // Match the product owner: selection changes keep the route data reference.
  const previewRoutes = useMemo(() => {
    const routes = labelArbitrationQa
      ? [...globeQaRoutes, labelArbitrationQaRoute]
      : globeQaRoutes;
    if (!qaRouteDataUpdated) return routes;
    return routes.map((route) => {
      if (route.id !== "qa-route-southwest") return route;
      const points = [...route.points];
      [points[1], points[2]] = [points[2], points[1]];
      points[0] = { ...points[0], lat: points[0].lat + 1, lon: points[0].lon + 0.5 };
      return { ...route, color: "#e486b4", points };
    });
  }, [labelArbitrationQa, qaRouteDataUpdated]);
  const [labelArbitrationStage, setLabelArbitrationStage] = useState<"browse" | "current" | "rewound">("browse");
  // #194: the preview is a second owner of the scene, so it supplies the same
  // compact flag the product owner does - otherwise the QA lane that measures
  // the contract would always see the desktop default.
  const compactMobileLayout = useCompactMobileLayout();
  const [activeRouteId, setActiveRouteId] = useState<string | null>(
    labelArbitrationQa
      ? labelArbitrationQaRoute.id
      : routeOpticsQa ? "qa-route-southwest" : null,
  );
  const [focusRevision, setFocusRevision] = useState(0);
  const [routeOpticsStage, setRouteOpticsStage] = useState<"browse" | "playing" | "rewound">("browse");
  // #196: a place label claims a geographic point, and clicking it must focus
  // that point. The preview owns the pick the product owns so the QA lane can
  // measure the claim against where the globe actually lands.
  const [pickedPoint, setPickedPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [qaVisibilityHint, setQaVisibilityHint] = useState({ opaqueMediaCover: false, coverTransitionActive: false });
  const activeRoute = previewRoutes.find((route) => route.id === activeRouteId) ?? null;
  const requestedLatRaw = qaParams.get("qaFocusLat");
  const requestedLonRaw = qaParams.get("qaFocusLon");
  const requestedLat = requestedLatRaw === null ? Number.NaN : Number(requestedLatRaw);
  const requestedLon = requestedLonRaw === null ? Number.NaN : Number(requestedLonRaw);
  const qaFocusPoint = pickedPoint ?? {
    lat: Number.isFinite(requestedLat) ? requestedLat : 30,
    lon: Number.isFinite(requestedLon) ? requestedLon : 110,
  };
  const [qaQuality, setQaQuality] = useState<"low" | "high">(
    qaParams.get("qaQuality") === "high" ? "high" : "low",
  );
  const renderBudgetQa = qaParams.get("qaRenderBudget") === "1";
  const imprintQa = qaParams.get("qaImprint") === "1";
  const imprintStage = qaParams.get("qaImprintStage") ?? "now";
  const qaTemporalReveal = useMemo(() => {
    if (!imprintQa && !routeOpticsQa && !labelArbitrationQa) return undefined;
    const journeys = new Map<string, number>();
    const points = new Map<string, number>();
    if (labelArbitrationQa) {
      // #374: Rewind is its own input. Browsing and the current narrative point
      // leave the whole route visible; the rewound stage stops before the last
      // two records, whose labels must therefore stay unrevealed.
      const rewound = labelArbitrationStage === "rewound";
      journeys.set(labelArbitrationQaRoute.id, rewound ? 0.4 : 1);
      labelArbitrationQaRoute.points.forEach((_point, pointIndex) => {
        points.set(
          `${labelArbitrationQaRoute.id}:${pointIndex}`,
          rewound && pointIndex >= 3 ? 0 : 1,
        );
      });
      return { journeys, points };
    }
    if (routeOpticsQa) {
      globeQaRoutes.forEach((route) => {
        const isTarget = route.id === "qa-route-southwest";
        const isOverlap = route.id === "qa-route-rhine";
        const progress = isTarget
          ? (routeOpticsStage === "browse" ? 1 : routeOpticsStage === "playing" ? 0.55 : 0.22)
          : isOverlap && routeOpticsStage !== "browse"
            ? (routeOpticsStage === "playing" ? 0.4 : 0.2)
            : 0;
        journeys.set(route.id, progress);
        route.points.forEach((_point, pointIndex) => {
          const pointProgress = isTarget
            ? routeOpticsStage === "browse"
              ? 1
              : routeOpticsStage === "playing"
                ? (pointIndex < 2 ? 1 : pointIndex === 2 ? 0.5 : 0)
                : (pointIndex === 0 ? 1 : pointIndex === 1 ? 0.35 : 0)
            : isOverlap && routeOpticsStage !== "browse"
              ? (pointIndex === 0 ? 1 : pointIndex === 1 ? 0.3 : 0)
              : 0;
          points.set(`${route.id}:${pointIndex}`, pointProgress);
        });
      });
      return { journeys, points };
    }
    globeQaRoutes.forEach((route, routeIndex) => {
      const progress = imprintStage === "first"
        ? (routeIndex === 0 ? 1 : 0)
        : imprintStage === "mid"
          ? (routeIndex < 3 ? 1 : routeIndex === 3 ? 0.5 : 0)
          : 1;
      journeys.set(route.id, progress);
      route.points.forEach((_point, pointIndex) => {
        points.set(`${route.id}:${pointIndex}`, progress);
      });
    });
    return { journeys, points };
  }, [imprintQa, imprintStage, labelArbitrationQa, labelArbitrationStage, routeOpticsQa, routeOpticsStage]);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe">
        <ParticleEarthScene
          mode="focusPoint"
          quality={qaQuality}
          journeyRoutes={previewRoutes}
          temporalReveal={qaTemporalReveal}
          activeJourneyRouteId={activeRouteId}
          selectedJourneyRoutePoint={labelArbitrationQa ? {
            // The chosen record is the SECOND of the two same-coordinate
            // records, so the arbitration has to prefer it over its twin.
            journeyId: labelArbitrationQaRoute.id,
            routePointId: "qa-label-2",
            pointIndex: 1,
          } : routeOpticsQa ? {
            journeyId: "qa-route-southwest",
            routePointId: "qa-p-18",
            pointIndex: 3,
          } : null}
          narrativeJourneyRoutePoint={labelArbitrationQa ? (
            labelArbitrationStage === "current"
              ? {
                journeyId: labelArbitrationQaRoute.id,
                routePointId: "qa-label-3",
                pointIndex: 2,
              }
              : null
          ) : routeOpticsQa && routeOpticsStage !== "browse" ? {
            journeyId: "qa-route-southwest",
            routePointId: routeOpticsStage === "playing" ? "qa-p-17" : "qa-p-16",
            pointIndex: routeOpticsStage === "playing" ? 2 : 1,
          } : null}
          focusRoute={activeRoute}
          focusRevision={focusRevision}
          onJourneyRouteActivate={(routeId) => {
            setActiveRouteId(routeId);
            setFocusRevision((revision) => revision + 1);
          }}
          onJourneyRoutePointActivate={() => undefined}
          onGlobePointPick={(point) => {
            setPickedPoint({ lat: point.latitude, lon: point.longitude });
            setFocusRevision((revision) => revision + 1);
          }}
          focusPoint={qaFocusPoint}
          focusColor="#77c8c2"
          centerFocusPoint
          dragToRotate
          wheelToZoom
          reduceMotion={new URLSearchParams(window.location.search).get("qaMotion") !== "animate"}
          compactMobileLayout={compactMobileLayout}
          visibilityHint={qaVisibilityHint}
        />
      </div>
      <div
        style={{
          position: "absolute",
          zIndex: 60,
          bottom: 14,
          left: 14,
          display: "flex",
          gap: 6,
        }}
      >
        {routeOpticsQa ? (
          <>
            <button type="button" data-qa-route-optics-stage="browse" onClick={() => setRouteOpticsStage("browse")}>optics browse</button>
            <button type="button" data-qa-route-optics-stage="playing" onClick={() => setRouteOpticsStage("playing")}>optics playing</button>
            <button type="button" data-qa-route-optics-stage="rewound" onClick={() => setRouteOpticsStage("rewound")}>optics rewound</button>
          </>
        ) : null}
        {labelArbitrationQa ? (
          <>
            <button type="button" data-qa-label-stage="browse" onClick={() => setLabelArbitrationStage("browse")}>label browse</button>
            <button type="button" data-qa-label-stage="current" onClick={() => setLabelArbitrationStage("current")}>label current</button>
            <button type="button" data-qa-label-stage="rewound" onClick={() => setLabelArbitrationStage("rewound")}>label rewound</button>
          </>
        ) : null}
        {renderBudgetQa ? (
          <>
            <button type="button" data-qa-render-visibility="partial" onClick={() => setQaVisibilityHint({ opaqueMediaCover: false, coverTransitionActive: false })}>partial</button>
            <button type="button" data-qa-render-visibility="transition" onClick={() => setQaVisibilityHint({ opaqueMediaCover: true, coverTransitionActive: true })}>transition</button>
            <button type="button" data-qa-render-visibility="covered" onClick={() => setQaVisibilityHint({ opaqueMediaCover: true, coverTransitionActive: false })}>covered</button>
            <button type="button" data-qa-render-visibility="reveal" onClick={() => setQaVisibilityHint({ opaqueMediaCover: false, coverTransitionActive: false })}>reveal</button>
            <button type="button" data-qa-render-quality="low" onClick={() => setQaQuality("low")}>low quality</button>
            <button type="button" data-qa-render-quality="high" onClick={() => setQaQuality("high")}>high quality</button>
            <button type="button" data-qa-route-clear onClick={() => {
              setActiveRouteId(null);
              setFocusRevision((revision) => revision + 1);
            }}>clear route</button>
            <button type="button" data-qa-route-data="updated" onClick={() => setQaRouteDataUpdated(true)}>update route data</button>
            <button type="button" data-qa-route-data="original" onClick={() => setQaRouteDataUpdated(false)}>restore route data</button>
          </>
        ) : null}
        {previewRoutes.map((route) => (
          <button
            key={route.id}
            type="button"
            data-qa-route={route.id}
            style={{
              padding: "6px 10px",
              border: activeRouteId === route.id
                ? "1px solid rgba(200,255,61,0.55)"
                : "1px solid rgba(118,198,188,0.28)",
              background: activeRouteId === route.id
                ? "rgba(200,255,61,0.1)"
                : "rgba(2,11,12,0.82)",
              color: route.color,
              cursor: "pointer",
              font: "500 9px/1 ui-monospace, monospace",
            }}
            onClick={() => {
              setActiveRouteId(route.id);
              setFocusRevision((revision) => revision + 1);
            }}
          >
            {route.id.replace("qa-route-", "")}
          </button>
        ))}
      </div>
    </main>
  );
}

const appQaPickPoints = [
  { latitude: 37.76942, longitude: -122.48621 },
  { latitude: 34.01129, longitude: -118.49231 },
  { latitude: 47.60621, longitude: -122.33207 },
];

function LivingAtlasQaGlobe({
  onGlobePointPick,
  onJourneyRoutePointActivate,
  journeyRoutes,
  activeJourneyRouteId,
  focusPoint,
  focusRoute,
  focusRevision,
  focusColor,
}: LivingAtlasGlobeProps) {
  const [pickIndex, setPickIndex] = useState(0);
  const draftRoute = journeyRoutes.find((route) => route.id === "draft-route-preview") ?? null;
  const qaParams = new URLSearchParams(window.location.search);
  const routePointContextQa = qaParams.get("qaRoutePointContext") === "1";
  const spatialHandoffQa = qaParams.get("qaSpatialHandoff") === "1";
  return (
    <div className="living-atlas__qa-globe">
      {onGlobePointPick ? (
        <button
          type="button"
          data-qa-app-globe-point-pick
          onClick={() => {
            const point = appQaPickPoints[pickIndex % appQaPickPoints.length];
            setPickIndex((current) => current + 1);
            onGlobePointPick(point);
          }}
          style={{ position: "fixed", zIndex: 230, left: 12, bottom: 12 }}
        >QA 地球点击</button>
      ) : null}
      {routePointContextQa ? journeyRoutes.flatMap((route) => route.points.flatMap((point, index) => (
        point.id ? (
          <button
            key={`${route.id}:${point.id}`}
            type="button"
            data-qa-route-point-context-activate={point.id}
            data-qa-route-point-index={index}
            onClick={() => onJourneyRoutePointActivate(route.id, point.id!)}
            style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
          >{point.label ?? point.id}</button>
        ) : []
      ))) : null}
      {spatialHandoffQa ? (
        <svg
          data-qa-spatial-route-points
          viewBox="0 0 620 360"
          aria-hidden="true"
          style={{ position: "fixed", left: 90, top: 90, width: 620, height: 360, pointerEvents: "none", zIndex: 2 }}
        >
          {journeyRoutes.flatMap((route, routeIndex) => route.points.flatMap((point, pointIndex) => {
            if (!point.id) return [];
            // Keep the deterministic spatial seam honest for ST-081: distinct
            // Route Point records at the exact same canonical coordinates share
            // one geographic marker anchor while retaining distinct record IDs.
            const firstCoordinateIndex = route.points.findIndex((candidate) => (
              candidate.lat === point.lat && candidate.lon === point.lon
            ));
            return [
              <circle
                key={`spatial:${route.id}:${point.id}`}
                className="particle-earth-route__point"
                data-journey-route={route.id}
                data-route-point-id={point.id}
                cx={150 + (firstCoordinateIndex >= 0 ? firstCoordinateIndex : pointIndex) * 115 + routeIndex * 12}
                cy={150 + routeIndex * 54}
                r={7}
              />,
            ];
          }))}
        </svg>
      ) : null}
      <output
        data-qa-app-route-preview
        data-route-points={JSON.stringify(draftRoute?.points ?? [])}
        data-focus-color={focusColor ?? ""}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
      >{draftRoute?.points.length ?? 0}</output>
      {routePointContextQa ? (
        <output
          data-qa-route-point-context-focus
          data-focus-revision={focusRevision ?? 0}
          data-focus-point={focusPoint ? `${focusPoint.lat},${focusPoint.lon}` : ""}
          data-focus-route={focusRoute?.id ?? ""}
          data-active-route={activeJourneyRouteId ?? ""}
          style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
        />
      ) : null}
    </div>
  );
}

/**
 * #252: the Semantic Earth Dive lane needs the REAL `LivingAtlasGlobe` on the
 * real persistent particle scene, because what it grades is the zoom-driven
 * handoff between them. The other globe fixtures either stub the globe
 * (`?qaState=living-atlas`) or mount the bare scene without the Atlas section
 * that publishes `data-earth-dive` (`?qaState=journey-routes`), so this is a
 * sibling fixture rather than a change to either.
 */
function EarthDiveQaPreview() {
  const persistentEarth = usePersistentEarth();
  const qaParams = new URLSearchParams(window.location.search);
  const [focusRevision, setFocusRevision] = useState(0);
  const [earthExperiencePolicy, setEarthExperiencePolicy] = useState<"default" | "particle-only">(
    qaParams.get("qaPolicy") === "particle-only" ? "particle-only" : "default",
  );
  const [qaReduceMotion, setQaReduceMotion] = useState(qaParams.get("qaMotion") !== "animate");
  useEffect(() => {
    persistentEarth.setStage("atlas");
    return () => persistentEarth.setStage("idle");
  }, [persistentEarth]);
  // The two focus shapes the product actually hands the globe, because the Dive
  // has to hold its anchor in both: a focused Route Point publishes a focus
  // point, while a focused Journey is owned by route fitting and publishes no
  // point at all - the branch whose anchor comes from the route frame.
  const focusRoute = globeQaRoutes[0];
  const routePoint = focusRoute.points[1];
  const routeFocus = qaParams.get("qaFocus") === "route";
  const requestedLat = Number(qaParams.get("qaFocusLat") ?? Number.NaN);
  const requestedLon = Number(qaParams.get("qaFocusLon") ?? Number.NaN);
  const focusPoint = routeFocus
    ? null
    : {
      lat: Number.isFinite(requestedLat) ? requestedLat : routePoint.lat,
      lon: Number.isFinite(requestedLon) ? requestedLon : routePoint.lon,
    };
  return (
    <main className="living-atlas" data-qa-earth-dive-focus={routeFocus ? "route" : "route-point"}>
      <div className="living-atlas__globe">
        <LivingAtlasGlobe
          focusPoint={focusPoint}
          focusRoute={routeFocus ? focusRoute : null}
          focusRevision={focusRevision}
          journeyRoutes={globeQaRoutes}
          activeJourneyRouteId={focusRoute.id}
          onJourneyRouteActivate={() => undefined}
          onJourneyRoutePointActivate={() => undefined}
          earthExperiencePolicy={earthExperiencePolicy}
          reduceMotion={qaReduceMotion}
        />
      </div>
      <output
        data-qa-earth-dive-route-point
        data-route-point-id={routePoint.id}
        data-route-point-lat={routePoint.lat}
        data-route-point-lon={routePoint.lon}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
      >{routePoint.label}</output>
      <button
        type="button"
        data-qa-earth-dive-refocus
        onClick={() => setFocusRevision((revision) => revision + 1)}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 14 }}
      >QA 重新对焦</button>
      <button
        type="button"
        data-qa-earth-policy="particle-only"
        onClick={() => setEarthExperiencePolicy("particle-only")}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 140 }}
      >QA 粒子地球</button>
      <button
        type="button"
        data-qa-earth-policy="default"
        onClick={() => setEarthExperiencePolicy("default")}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 250 }}
      >QA 默认地球</button>
      <button
        type="button"
        data-qa-earth-motion-toggle
        onClick={() => setQaReduceMotion((current) => !current)}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 360 }}
      >QA 动效切换</button>
      <button
        type="button"
        data-qa-earth-quality="low"
        onClick={() => persistentEarth.setStage("handoff")}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 470 }}
      >QA 低质量</button>
      <button
        type="button"
        data-qa-earth-quality="high"
        onClick={() => persistentEarth.setStage("atlas")}
        style={{ position: "absolute", zIndex: 60, bottom: 14, left: 570 }}
      >QA 高质量</button>
    </main>
  );
}

function LivingAtlasGlobeChromeQa(props: LivingAtlasGlobeProps) {
  const qaRoundTrip = new URLSearchParams(window.location.search).get("qaMode") === "globe-chrome";
  return (
    <>
      <LivingAtlasGlobe {...props} />
      {qaRoundTrip ? props.journeyRoutes.flatMap((route) => route.points.flatMap((point) => (
        point.id ? (
          <button
            key={`globe-chrome:${route.id}:${point.id}`}
            type="button"
            data-qa-globe-route-point-activate={point.id}
            data-qa-globe-route-id={route.id}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => props.onJourneyRoutePointActivate(route.id, point.id!)}
            style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0, pointerEvents: "none" }}
          >{point.label ?? point.id}</button>
        ) : []
      ))) : null}
    </>
  );
}

function LivingAtlasQaPreview() {
  // #253: the globe-focus chrome lane needs the real `LivingAtlasGlobe`, since
  // `.living-atlas-globe__controls` and the transient gesture hint live there.
  // #291's dedicated lane adds qaRoutePointContext=1 and intentionally keeps
  // the deterministic QA globe: it grades the product callback/identity/context
  // contract, while scene boot/raycast timing is already owned by scene lanes.
  const params = new URLSearchParams(window.location.search);
  const globeChrome = params.get("qaMode") === "globe-chrome";
  const routePointContextQa = params.get("qaRoutePointContext") === "1";
  if (globeChrome && !routePointContextQa) return <LivingAtlasApp GlobeComponent={LivingAtlasGlobeChromeQa} />;
  return <LivingAtlasApp GlobeComponent={LivingAtlasQaGlobe} />;
}

function LivingAtlasGlobeControlsQaPreview() {
  const [language, setLanguage] = useState<"zh" | "bilingual">("zh");
  const detailMode = new URLSearchParams(window.location.search).get("qaMode") !== "overview";
  return (
    <main className="living-atlas">
      <section
        className={`living-atlas-globe ${detailMode ? "is-detail" : "is-overview"} living-atlas-globe--controls-qa`}
        data-earth-mode={detailMode ? "detail" : "particle"}
        aria-label={detailMode ? "高精度地球地图控制 QA" : "粒子地球控制 QA"}
      >
        <LivingAtlasGlobeControls
          diveStage={detailMode ? "detail" : "particle"}
          detailLanguage={language}
          onDiveIntent={() => undefined}
          onDetailLanguageChange={setLanguage}
          onPickRequest={() => undefined}
        />
      </section>
    </main>
  );
}

function JourneyComposerQaPreview() {
  const qaMode = new URLSearchParams(window.location.search).get("qaMode");
  const journey = qaMode === "route-points"
    ? composerRoutePointsQaJourney
    : qaMode === "edit"
      ? storyQaJourney
      : undefined;
  const [open, setOpen] = useState(true);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-composer-reopen onClick={() => setOpen(true)}>重新打开编辑器</button>
      {open ? (
        <JourneyComposer
          open
          journey={journey}
          onClose={() => setOpen(false)}
          onSaved={() => undefined}
          onGlobePickRequest={() => undefined}
        />
      ) : null}
    </main>
  );
}

const storyQaJourney: Journey = {
  id: "00000000-0000-4000-8000-000000000001",
  atlasId: "00000000-0000-4000-8000-000000000002",
  title: "穿过夜色的归途",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "灯光沿着海岸慢慢退远，路途本身成为这一晚的记忆。",
  lightColor: "#77c8c2",
  revision: 1,
  createdByUserId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [{
    id: "00000000-0000-4000-8000-000000000004",
    journeyId: "00000000-0000-4000-8000-000000000001",
    sortOrder: 0,
    latitude: 1.290256,
    longitude: 103.851471,
    label: "National Gallery Singapore",
    isStop: true,
    occurredAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }],
  // Seeded so the deterministic QA can exercise the overview grid with
  // non-adjacent selection instead of only sequential navigation.
  media: [0, 1, 2].map((index) => ({
    id: `00000000-0000-4000-8000-00000000010${index}`,
    journeyId: "00000000-0000-4000-8000-000000000001",
    routePointId: null,
    storageDriver: "qa",
    storageKey: `qa/story-seed-${index}`,
    fileName: `seed-${index}.png`,
    mimeType: "image/png",
    bytes: 68,
    sortOrder: index,
    uploadedByUserId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-08-11T00:00:00.000Z",
  })),
};

const composerRoutePointsQaJourney: Journey = {
  ...storyQaJourney,
  title: "Composer Route Point QA",
  routePoints: Array.from({ length: 12 }, (_, index) => ({
    ...storyQaJourney.routePoints[0],
    id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
    sortOrder: index,
    latitude: index === 1 || index === 6 ? 22.543096 : 21.9 + index * 0.07,
    longitude: index === 1 || index === 6 ? 114.057865 : 113.8 + index * 0.08,
    label: index === 0 || index === 11
      ? "Shared label"
      : index === 1 || index === 6
        ? "Las Vegas"
        : index === 2
          ? "Record 03"
          : `Record ${String(index + 1).padStart(2, "0")}`,
    isStop: index % 3 === 0,
    note: index === 1
      ? "Record 02 local search note."
      : index === 6
        ? "Record 07 local search note."
        : index === 2
          ? "Record 03 keeps its note while moving."
          : null,
  })),
  media: storyQaJourney.media.map((media, index) => ({
    ...media,
    routePointId: index === 0
      ? "00000000-0000-4000-8000-000000000022"
      : index === 1
        ? "00000000-0000-4000-8000-000000000021"
        : index === 2
          ? "00000000-0000-4000-8000-000000000026"
          : null,
  })),
};

const storyQaRouteBoundaryJourney: Journey = {
  ...storyQaJourney,
  routePoints: [
    storyQaJourney.routePoints[0],
    {
      ...storyQaJourney.routePoints[0],
      id: "00000000-0000-4000-8000-000000000005",
      sortOrder: 1,
      latitude: 1.3008,
      longitude: 103.8394,
      label: "Fort Canning Park",
    },
  ],
  media: [
    { ...storyQaJourney.media[0], routePointId: storyQaJourney.routePoints[0].id },
    { ...storyQaJourney.media[1], routePointId: storyQaJourney.routePoints[0].id },
    {
      ...storyQaJourney.media[2],
      routePointId: "00000000-0000-4000-8000-000000000005",
    },
    {
      ...storyQaJourney.media[2],
      id: "00000000-0000-4000-8000-000000000103",
      storageKey: "qa/story-seed-3",
      fileName: "seed-3.png",
      sortOrder: 3,
      routePointId: "00000000-0000-4000-8000-000000000005",
    },
  ],
};

const STORY_QA_MIXED_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000152";
const storyQaMixedJourney: Journey = {
  ...storyQaJourney,
  media: storyQaJourney.media.map((asset, index) => index === 1 ? {
    ...asset,
    id: STORY_QA_MIXED_VIDEO_ASSET_ID,
    storageKey: "qa/story-mixed-video",
    fileName: "mixed-video.mp4",
    mimeType: "video/mp4",
  } : asset),
};

const QA_SOUNDTRACK_ASSET_ID = "00000000-0000-4000-8000-000000000900";

function JourneyStoryQaPreview() {
  const qaMode = new URLSearchParams(window.location.search).get("qaMode");
  const mixedMediaMode = qaMode === "mixed-media";
  const manyMediaMode = qaMode === "many-media";
  const routeBoundaryMode = qaMode === "route-boundary";
  const initialJourney = mixedMediaMode
    ? storyQaMixedJourney
    : routeBoundaryMode
      ? storyQaRouteBoundaryJourney
      : manyMediaMode ? {
    ...storyQaJourney,
    media: Array.from({ length: 8 }, (_, index) => ({
      ...storyQaJourney.media[0],
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      storageKey: `qa/story-seed-${index}`, fileName: `seed-${index}.jpg`, sortOrder: index,
    })),
  } : storyQaJourney;
  const [open, setOpen] = useState(true);
  const [journeys, setJourneys] = useState<Journey[]>([initialJourney]);
  // The preview synthesizes the asset a real API would return, so it needs to
  // be told which kind the next completed upload represents.
  const [nextMediaIsSoundtrack, setNextMediaIsSoundtrack] = useState(false);

  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-story-reopen onClick={() => setOpen(true)}>重新打开旅程</button>
      <button type="button" data-qa-story-next-audio onClick={() => setNextMediaIsSoundtrack(true)}>下一个上传是配乐</button>
      {open ? (
        <JourneyStory
          journeys={journeys}
          journeyId={initialJourney.id}
          onClose={() => setOpen(false)}
          onNavigate={() => undefined}
          onEdit={() => undefined}
          onDelete={() => {
            setJourneys([]);
            setOpen(false);
          }}
          onMediaAdded={() => {
            const currentJourney = journeys[0];
            const index = currentJourney.media.length;
            // The API deduplicates identical content inside a journey and
            // answers with the asset that already exists, so re-uploading the
            // same soundtrack must not add a second row here either.
            if (
              nextMediaIsSoundtrack
              && currentJourney.media.some((asset) => asset.id === QA_SOUNDTRACK_ASSET_ID)
            ) {
              setNextMediaIsSoundtrack(false);
              return currentJourney;
            }
            const nextJourney: Journey = {
              ...currentJourney,
              media: [...currentJourney.media, {
                id: nextMediaIsSoundtrack
                  ? QA_SOUNDTRACK_ASSET_ID
                  : `00000000-0000-4000-8000-00000000020${index}`,
                journeyId: storyQaJourney.id,
                routePointId: null,
                storageDriver: "qa",
                storageKey: `qa/story-media-${index}`,
                fileName: nextMediaIsSoundtrack ? "night-theme.mp3" : "night-route.png",
                mimeType: nextMediaIsSoundtrack ? "audio/mpeg" : "image/png",
                bytes: 68,
                sortOrder: index,
                uploadedByUserId: storyQaJourney.createdByUserId,
                createdAt: "2026-08-11T00:00:00.000Z",
              }],
            };
            setJourneys([nextJourney]);
            setNextMediaIsSoundtrack(false);
            return nextJourney;
          }}
          onMediaDelete={(assetId) => {
            const currentJourney = journeys[0];
            const nextJourney: Journey = {
              ...currentJourney,
              media: currentJourney.media.filter((asset) => asset.id !== assetId),
            };
            setJourneys([nextJourney]);
          }}
          onMediaReorder={(_journeyId, assetIds) => {
            const currentJourney = journeys[0];
            const media = assetIds
              .map((id, index) => {
                const asset = currentJourney.media.find((candidate) => candidate.id === id);
                return asset ? { ...asset, sortOrder: index } : null;
              })
              .filter((asset): asset is NonNullable<typeof asset> => asset !== null);
            const nextJourney: Journey = { ...currentJourney, media };
            setJourneys([nextJourney]);
            return nextJourney;
          }}
        />
      ) : null}
    </main>
  );
}

const playbackQaJourneyId = "00000000-0000-4000-8000-000000000011";
const playbackQaJourney: Journey = {
  ...storyQaJourney,
  id: playbackQaJourneyId,
  title: "QA · MEDIA PLAYBACK",
  routePoints: storyQaJourney.routePoints.map((point) => ({
    ...point,
    journeyId: playbackQaJourneyId,
  })),
  media: [{
    ...storyQaJourney.media[0],
    id: "00000000-0000-4000-8000-000000000111",
    journeyId: playbackQaJourneyId,
    routePointId: storyQaJourney.routePoints[0].id,
    storageKey: "qa/playback-video",
    fileName: "playback-video.mp4",
    mimeType: "video/mp4",
    sortOrder: 0,
  }],
};

// #195 Phase 2: the trimmed variant. A second asset follows the video on the
// same route point, because "the segment ended the beat" is only distinguishable
// from "playback ended" if there is a next beat to advance into.
const PLAYBACK_QA_TRIM_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000111";
const playbackQaTrimJourney: Journey = {
  ...playbackQaJourney,
  media: [
    playbackQaJourney.media[0],
    {
      ...playbackQaJourney.media[0],
      id: "00000000-0000-4000-8000-000000000112",
      storageKey: "qa/playback-after-trim",
      fileName: "playback-after-trim.png",
      mimeType: "image/png",
      sortOrder: 1,
    },
  ],
};

function JourneyPlaybackQaPreview() {
  // A trim is declared by the Edit Plan, so the preview supplies it the way
  // Quick Recap does: the resolver answers the window, and the beat's booked
  // length is the same `outMs - inMs` the plan would have booked. Without the
  // trim mode this stays the untrimmed preview the other lanes already drive.
  const qaParams = new URLSearchParams(window.location.search);
  const trimMode = qaParams.get("qaMode") === "trim";
  const trimInMs = Number(qaParams.get("qaTrimIn") ?? 1_200);
  const trimOutMs = Number(qaParams.get("qaTrimOut") ?? 4_700);
  const trim = Number.isFinite(trimInMs) && Number.isFinite(trimOutMs)
    ? { inMs: trimInMs, outMs: trimOutMs }
    : { inMs: 1_200, outMs: 4_700 };
  const journey = trimMode ? playbackQaTrimJourney : playbackQaJourney;
  const trimmedAsset = (targetJourney: Journey, step: PlaybackStep) => (
    step.kind === "media"
    && playbackMediaForPoint(targetJourney, step.pointIndex)[step.mediaIndex]?.id
      === PLAYBACK_QA_TRIM_VIDEO_ASSET_ID
  );
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={journey}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        mediaTrimResolver={trimMode
          ? (targetJourney, step) => trimmedAsset(targetJourney, step) ? trim : null
          : undefined}
        stepDurationResolver={trimMode
          ? (targetJourney, step) => (
            trimmedAsset(targetJourney, step) ? trim.outMs - trim.inMs : undefined
          )
          : undefined}
        playbackMode={trimMode ? "quick-recap" : "full"}
        reduceMotion
      />
    </main>
  );
}

// #197: the image-heavy Playback fixtures the prefetch capture needs. A
// time-budget lookahead only differs from the old fixed `current + next` when
// there are many assets to prepare, and the tempo difference only shows on
// image beats. These live in this dev-only preview alone: `LivingAtlasApp`
// builds its journeys from the API, and the default `?qaState=journey-playback`
// preview above is untouched because `qa:media-controls` and
// `qa:final-acceptance` still grade it.
const PREFETCH_QA_SINGLE_POINT_IMAGES = 20;
const PREFETCH_QA_MULTI_POINTS = 5;
const PREFETCH_QA_MULTI_POINT_IMAGES = 12;

function prefetchQaJourney(pointCount: number, imagesPerPoint: number): Journey {
  const journeyId = "00000000-0000-4000-8000-000000000012";
  const routePoints = Array.from({ length: pointCount }, (_unused, pointIndex) => ({
    id: `00000000-0000-4000-8000-2${`${pointIndex}`.padStart(2, "0")}000000000`,
    journeyId,
    sortOrder: pointIndex,
    latitude: 1.290256 + pointIndex * 1.4,
    longitude: 103.851471 + pointIndex * 1.9,
    label: `QA POINT ${pointIndex}`,
    isStop: true,
    occurredAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }));
  const media = routePoints.flatMap((point, pointIndex) => (
    Array.from({ length: imagesPerPoint }, (_unused, mediaIndex) => ({
      // The id carries its own route point and media index, so the QA script
      // can map a signed read back to the beat that displays it without any
      // extra DOM contract.
      id: `00000000-0000-4000-8000-1${`${pointIndex}`.padStart(2, "0")}${`${mediaIndex}`.padStart(3, "0")}000000`,
      journeyId,
      routePointId: point.id,
      storageDriver: "qa",
      storageKey: `qa/prefetch-${pointIndex}-${mediaIndex}`,
      fileName: `prefetch-${pointIndex}-${mediaIndex}.png`,
      mimeType: "image/png",
      bytes: 68,
      sortOrder: pointIndex * 1_000 + mediaIndex,
      uploadedByUserId: storyQaJourney.createdByUserId,
      createdAt: "2026-08-11T00:00:00.000Z",
    }))
  ));
  return {
    ...storyQaJourney,
    id: journeyId,
    title: "QA · PLAYBACK PREFETCH",
    routePoints,
    media,
  };
}

const prefetchQaSingleJourney = prefetchQaJourney(1, PREFETCH_QA_SINGLE_POINT_IMAGES);
const prefetchQaMultiJourney = prefetchQaJourney(
  PREFETCH_QA_MULTI_POINTS,
  PREFETCH_QA_MULTI_POINT_IMAGES,
);

function JourneyPlaybackPrefetchQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const journey = params.get("qaFixture") === "multi"
    ? prefetchQaMultiJourney
    : prefetchQaSingleJourney;
  // Quick Recap is wired the way `LivingAtlasApp` wires it, not approximated:
  // the recap owns an Edit Plan, the plan is rebuilt at the live tempo
  // (decision D1), and the same resolver answers each beat's length — which is
  // what makes the prefetch window walk the beats the recap actually plays.
  const recap = params.get("qaRecap") === "1";
  const [tempo, setTempo] = useState<PlaybackTempo>(PLAYBACK_INITIAL_TEMPO);
  const quickRecap = useMemo(
    () => (recap
      ? prepareQuickRecapPlayback(journey, {
        generatedAt: "2026-09-05T00:00:00.000Z",
        tempo,
      })
      : null),
    [journey, recap, tempo],
  );
  const stepDurationResolver = useCallback((
    targetJourney: Journey,
    step: PlaybackStep,
    activeTempo: PlaybackTempo,
  ) => (
    quickRecap
      ? quickRecapStepDurationMs(targetJourney, step, quickRecap.plan, activeTempo)
      : undefined
  ), [quickRecap]);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={quickRecap?.journey ?? journey}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        stepDurationResolver={recap ? stepDurationResolver : undefined}
        onTempoChange={setTempo}
        playbackMode={quickRecap ? "quick-recap" : "full"}
        reduceMotion
      />
    </main>
  );
}

// #456: the sparse-chapter continuity fixture — three consecutive Route Points
// carrying 0, 1 and 3 Route Point Media, which is exactly the density grammar
// `routePointChapterDensity` classifies. The lane needs the camera commands the
// overlay issues, and this preview is the only place that owns them, so it
// records each one instead of discarding it like the other playback previews.
const CONTINUITY_QA_MEDIA_COUNTS = [0, 1, 3];

const continuityQaJourneyId = "00000000-0000-4000-8000-000000000456";
const continuityQaJourney: Journey = (() => {
  const routePoints = CONTINUITY_QA_MEDIA_COUNTS.map((_unused, pointIndex) => ({
    id: `st109-point-${pointIndex}`,
    journeyId: continuityQaJourneyId,
    sortOrder: pointIndex,
    latitude: 1.290256 + pointIndex * 2.2,
    longitude: 103.851471 + pointIndex * 2.6,
    label: `QA CHAPTER ${pointIndex}`,
    isStop: true,
    occurredAt: null,
    note: pointIndex === 0
      ? "没有照片的一站，地点本身就是完整章节。"
      : pointIndex === 1
        ? Array.from({ length: 18 }, () => "这是一段用于验证窄屏长笔记仍为媒体保留稳定画面空间的 Route Point 记录。").join("\n")
        : null,
    createdAt: "2026-09-20T00:00:00.000Z",
  }));
  const media = routePoints.flatMap((point, pointIndex) => (
    Array.from({ length: CONTINUITY_QA_MEDIA_COUNTS[pointIndex] }, (_unused, mediaIndex) => ({
      id: `st109-p${pointIndex}-m${mediaIndex}`,
      journeyId: continuityQaJourneyId,
      routePointId: point.id,
      storageDriver: "qa",
      storageKey: `qa/continuity-${pointIndex}-${mediaIndex}`,
      fileName: `continuity-${pointIndex}-${mediaIndex}.png`,
      mimeType: "image/png",
      bytes: 68,
      sortOrder: pointIndex * 10 + mediaIndex,
      uploadedByUserId: storyQaJourney.createdByUserId,
      createdAt: "2026-09-20T00:00:00.000Z",
    }))
  ));
  return {
    ...storyQaJourney,
    id: continuityQaJourneyId,
    title: "QA · PLAYBACK CONTINUITY",
    note: "",
    routePoints,
    media,
  };
})();

type ContinuityQaTrace = { cameraTargets: { key: string; at: number }[] };

function JourneyPlaybackContinuityQaPreview() {
  const params = new URLSearchParams(window.location.search);
  // Reduced Motion is a run parameter here, not a constant: acceptance 6 is
  // only observable if the SAME fixture can be played both ways.
  const reduceMotion = params.get("qaReduceMotion") !== "0";
  const recordCameraTarget = useCallback((target: PlaybackCameraTarget) => {
    const store = window as unknown as { __qaPlaybackContinuity?: ContinuityQaTrace };
    const trace = store.__qaPlaybackContinuity ?? { cameraTargets: [] };
    store.__qaPlaybackContinuity = trace;
    trace.cameraTargets.push({ key: playbackCameraTargetKey(target), at: Date.now() });
  }, []);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={continuityQaJourney}
        onClose={() => undefined}
        onCameraTargetChange={recordCameraTarget}
        playbackMode="full"
        reduceMotion={reduceMotion}
      />
    </main>
  );
}

function BrandSignatureMotionQaPreview() {
  return (
    <main className="auth-gate auth-gate--brand-loading" data-qa-brand-signature-motion="true">
      <StartripsBrandLoader message="Loading your private atlas…" />
    </main>
  );
}

function RecoverySurfaceQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("qaMode");
  const kind: StartripsRecoveryKind = requested === "not-found" || requested === "error" ? requested : "empty";
  const [intent, setIntent] = useState("idle");
  const markIntent = (name: string) => setIntent(name);
  const rootClassName = kind === "not-found"
    ? "startrips-not-found"
    : `living-atlas${kind === "error" ? " is-error" : " is-mobile-v2"}`;
  return (
    <main
      className={`${rootClassName} recovery-surface-qa recovery-surface-qa--${kind}`}
      data-qa-recovery-surface={kind}
      data-qa-recovery-intent={intent}
    >
      <StartripsRecoverySurface
        kind={kind}
        className={kind === "empty" ? "living-atlas__empty" : undefined}
        headingLevel={kind === "empty" ? 2 : 1}
        detail={kind === "error" ? "QA recoverable service error" : undefined}
        onPrimaryAction={() => markIntent(kind === "error" ? "retry" : kind === "empty" ? "create" : "home")}
        onSecondaryAction={kind === "not-found" ? () => markIntent("back") : undefined}
      />
    </main>
  );
}

const coverRevealPreview = import.meta.env.DEV && qaState === "cover-reveal";

const Experience = import.meta.env.DEV && qaState === "journey-composer"
  ? JourneyComposerQaPreview
  : import.meta.env.DEV && qaState === "journey-story"
    ? JourneyStoryQaPreview
  : import.meta.env.DEV && qaState === "journey-playback"
    // #197: the prefetch capture needs its own image-heavy fixture, so it is a
    // sibling mode of the playback preview rather than a change to it.
    ? (new URLSearchParams(window.location.search).get("qaMode") === "prefetch"
      ? JourneyPlaybackPrefetchQaPreview
      // #456: the sparse 0/1/3-media continuity fixture is a sibling mode too,
      // so the lanes already grading the default preview keep their fixture.
      : new URLSearchParams(window.location.search).get("qaMode") === "continuity"
        ? JourneyPlaybackContinuityQaPreview
        : JourneyPlaybackQaPreview)
  : import.meta.env.DEV && qaState === "journey-routes"
    ? JourneyRoutesQaPreview
  : import.meta.env.DEV && (qaState === "globe-controls" || qaState === "globe-controls-gateway")
    ? LivingAtlasGlobeControlsQaPreview
  : import.meta.env.DEV && qaState === "earth-dive"
    ? EarthDiveQaPreview
  : import.meta.env.DEV && (qaState === "living-atlas" || qaState === "atlas-gateway")
    ? LivingAtlasQaPreview
  : import.meta.env.DEV && qaState === "brand-signature-motion"
    ? BrandSignatureMotionQaPreview
  : import.meta.env.DEV && qaState === "recovery-surfaces"
    ? RecoverySurfaceQaPreview
  // #367 slice 3: the vendored cover reveal renderer has no product surface
  // yet, so its only mount is this deterministic dev-only preview. It is lazy
  // like `ExperienceDemo` rather than statically imported, so neither the
  // product bundle nor the twenty other browser-QA lanes' page loads carry the
  // renderer and its vendored sources.
  : coverRevealPreview
    ? lazy(async () => ({ default: (await import("./reveal/CoverRevealQaPreview")).CoverRevealQaPreview }))
  : import.meta.env.DEV && qaState === "final-acceptance"
    ? LivingAtlasApp
  : import.meta.env.DEV && qaState
    ? App
    : OwnerLivingAtlasApp;

/**
 * #332: the stored Earth experience preference, bound to the real session.
 *
 * Mounted around `AuthGateway` rather than inside it, so the one read is keyed
 * by the stable user and not by the Atlas: `WorkspaceGate` remounts whenever
 * the active organization changes, and switching Atlas must not re-read or
 * reset a personal preference. `/share#<token>` is mounted outside this
 * provider entirely, so a guest tree has no reader and issues no request.
 */
function SessionEarthExperienceProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  return (
    <EarthExperiencePreferenceProvider
      accountKey={session.data?.user.id ?? null}
      sessionResolved={!session.isPending}
    >
      {children}
    </EarthExperiencePreferenceProvider>
  );
}

/**
 * #332: the product Atlas, reading the person's stored Earth experience.
 *
 * This is the only place the saved preference becomes the `#331` policy. It is
 * a wrapper rather than a prop threaded from the render root because the value
 * is resolved inside the provider mounted around `AuthGateway`, one tree above
 * the gate that decides whether an Atlas renders at all.
 */
function OwnerLivingAtlasApp() {
  const { policy } = useEarthExperiencePreference();
  return <LivingAtlasApp earthExperiencePolicy={policy} />;
}

/**
 * #200 phase D: `/share#<token>` is a read-only product mode, not a state of
 * the owner app.
 *
 * It is mounted OUTSIDE `AuthGateway` on purpose. A recipient has no account,
 * and the gateway's first act is to list the viewer's organizations and read
 * `/api/atlases/current`; running that for a guest would mean two failing
 * requests and a login gate in front of a link that is already authorized.
 * Mounting the shared view here instead means the guest tree never contains
 * an owner atlas, an owner capability provider, or an account surface.
 */
const shared = isSharedAtlasPathname(window.location.pathname);
const knownAppPath = ["/", "/reset-password", "/accept-invitation"].includes(window.location.pathname);
const localDemo = import.meta.env.DEV
  && window.location.pathname === "/"
  && new URLSearchParams(window.location.search).get("demo") === "1";
const ExperienceDemo = import.meta.env.DEV ? lazy(() => import("./preview/ExperienceDemo")) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PersistentEarthProvider>
      {localDemo && ExperienceDemo ? (
        <Suspense fallback={<main className="auth-gate auth-gate--brand-loading"><StartripsBrandLoader message="正在打开示例图谱…" /></main>}>
          <ExperienceDemo />
        </Suspense>
      ) : !shared && !knownAppPath ? <StartripsNotFound /> : shared ? (
        <SharedAtlasView
          GlobeComponent={
            import.meta.env.DEV
            && new URLSearchParams(window.location.search).get("qaRoutePointContext") === "1"
              ? LivingAtlasGlobeChromeQa
              : undefined
          }
        />
      ) : (
        <SessionEarthExperienceProvider>
          <AuthGateway>
            {coverRevealPreview ? (
              <Suspense fallback={<main className="auth-gate auth-gate--brand-loading"><StartripsBrandLoader message="Loading your private atlas…" /></main>}>
                <Experience />
              </Suspense>
            ) : (
              <Experience />
            )}
          </AuthGateway>
        </SessionEarthExperienceProvider>
      )}
    </PersistentEarthProvider>
  </StrictMode>,
);
