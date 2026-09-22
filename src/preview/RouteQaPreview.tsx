import { useMemo, useState } from "react";
import { useCompactMobileLayout } from "../journey/mobileLayout";
import type { JourneyRoute } from "../journey/types";
import { ParticleEarthScene } from "../scene/ParticleEarthScene";
import { archiveRecords } from "../data/archiveRecords";
import { globeQaRoutes } from "./qaRoutes";

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

export function JourneyRoutesQaPreview() {
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
          archivePoints={archiveRecords}
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
