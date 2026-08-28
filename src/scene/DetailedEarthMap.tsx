import { useEffect, useRef } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { JourneyRoute } from "../journey/types";
import {
  createDetailedEarthLabelExpression,
  DETAILED_EARTH_DRAG_PAN_OPTIONS,
  getDetailedEarthRouteFrame,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MAX_PITCH,
  DETAILED_EARTH_MAX_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  DETAILED_EARTH_PITCH_SPEED,
  type DetailedEarthLanguage,
  DETAILED_EARTH_ROTATE_SPEED,
  DETAILED_EARTH_TOUCH_ZOOM_RATE,
  DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD,
  getDetailedEarthStyle,
  isDetailedEarthNameLabel,
  shouldReturnToParticleEarth,
  useGlobeProjection,
} from "./detailedEarthModel";

type DetailedEarthMapProps = {
  focusPoint?: { lat: number; lon: number } | null;
  focusRoute?: JourneyRoute | null;
  focusRevision?: number;
  language: DetailedEarthLanguage;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onOverviewRequest?: () => void;
  onReady?: () => void;
};

function applyMapLanguage(map: MapLibreMap, language: DetailedEarthLanguage) {
  const textField = createDetailedEarthLabelExpression(language);
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol") continue;
    const currentTextField = layer.layout?.["text-field"];
    if (!isDetailedEarthNameLabel(currentTextField)) continue;
    map.setLayoutProperty(layer.id, "text-field", textField);
  }
}

function applyDetailedEarthFocus(
  map: MapLibreMap,
  focusPoint: { lat: number; lon: number } | null | undefined,
  focusRoute: JourneyRoute | null | undefined,
  duration: number,
) {
  const routeFrame = getDetailedEarthRouteFrame(focusRoute?.points ?? []);
  if (routeFrame && routeFrame.pointCount > 1) {
    map.fitBounds(routeFrame.bounds, {
      padding: 56,
      maxZoom: 10,
      duration,
      essential: true,
    });
    return;
  }
  const target = routeFrame?.center
    ?? (focusPoint ? [focusPoint.lon, focusPoint.lat] as [number, number] : null);
  if (!target) return;
  map.flyTo({
    center: target,
    zoom: Math.max(map.getZoom(), DETAILED_EARTH_INITIAL_ZOOM),
    duration,
    essential: true,
  });
}

export default function DetailedEarthMap({
  focusPoint,
  focusRoute,
  focusRevision = 0,
  language,
  onGlobePointPick,
  onOverviewRequest,
  onReady,
}: DetailedEarthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const languageRef = useRef(language);
  const focusPointRef = useRef(focusPoint);
  const focusRouteRef = useRef(focusRoute);
  const onPickRef = useRef(onGlobePointPick);
  const onOverviewRequestRef = useRef(onOverviewRequest);
  const onReadyRef = useRef(onReady);
  languageRef.current = language;
  focusPointRef.current = focusPoint;
  focusRouteRef.current = focusRoute;
  onPickRef.current = onGlobePointPick;
  onOverviewRequestRef.current = onOverviewRequest;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialRouteFrame = getDetailedEarthRouteFrame(focusRouteRef.current?.points ?? []);
    const initialCenter: [number, number] = initialRouteFrame?.center
      ?? (focusPointRef.current
        ? [focusPointRef.current.lon, focusPointRef.current.lat]
        : [104, 34]);
    const map = new MapLibreMap({
      container: host,
      style: getDetailedEarthStyle(),
      center: initialCenter,
      zoom: DETAILED_EARTH_INITIAL_ZOOM,
      minZoom: DETAILED_EARTH_MIN_ZOOM,
      maxZoom: DETAILED_EARTH_MAX_ZOOM,
      maxPitch: DETAILED_EARTH_MAX_PITCH,
      pitch: 0,
      bearing: 0,
      rotateSpeed: DETAILED_EARTH_ROTATE_SPEED,
      pitchSpeed: DETAILED_EARTH_PITCH_SPEED,
      renderWorldCopies: true,
      attributionControl: false,
      cooperativeGestures: false,
      fadeDuration: 650,
    });
    let initialLoadSettled = false;
    let overviewRequested = false;
    let settleTimer: number | null = null;
    mapRef.current = map;
    // Keep MapLibre's native gesture ownership: primary mouse / one-finger
    // touch pans, while right-button or Ctrl+drag rotates. This avoids the
    // previous custom primary-drag handler fighting native map navigation.
    map.dragPan.enable(DETAILED_EARTH_DRAG_PAN_OPTIONS);
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchZoomRotate.setZoomRate(DETAILED_EARTH_TOUCH_ZOOM_RATE);
    map.touchZoomRotate.setZoomThreshold(DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD);
    const canvas = map.getCanvas();
    canvas.style.touchAction = "none";

    map.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      // Raster fallback remains Mercator; vector styles use the globe so a
      // polar focus is not trapped by the flat-map viewport.
      if (useGlobeProjection()) map.setProjection({ type: "globe" });
      applyMapLanguage(map, languageRef.current);
      applyDetailedEarthFocus(map, focusPointRef.current, focusRouteRef.current, 0);
      const settle = () => {
        if (initialLoadSettled) return;
        initialLoadSettled = true;
        host.dataset.mapReady = "true";
        onReadyRef.current?.();
      };
      map.once("idle", settle);
      // Safety net: under heavy load MapLibre can keep re-fetching tiles and
      // never reach idle; enter the detail view anyway and let tiles finish
      // progressively.
      settleTimer = window.setTimeout(settle, 3000);
    });

    map.on("click", (event) => {
      if (!onPickRef.current) return;
      onPickRef.current({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
      });
    });
    map.on("zoomend", () => {
      if (
        !initialLoadSettled
        || overviewRequested
        || !shouldReturnToParticleEarth(map.getZoom())
      ) return;
      overviewRequested = true;
      onOverviewRequestRef.current?.();
    });
    map.on("error", (event) => {
      host.dataset.mapError = event.error?.message ?? "map-error";
    });

    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    applyMapLanguage(map, language);
  }, [language]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyDetailedEarthFocus(map, focusPoint, focusRoute, 900);
  }, [focusPoint, focusRevision, focusRoute]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = onGlobePointPick ? "crosshair" : "grab";
  }, [onGlobePointPick]);

  return (
    <div
      ref={hostRef}
      className="detailed-earth-map"
      data-map-provider="configurable-vector"
      data-map-language={language}
      data-point-pick={onGlobePointPick ? "true" : "false"}
      data-primary-drag="pan"
      data-alternate-drag="right-mouse-or-ctrl-rotate"
      role="application"
      aria-label="可深度缩放的真实地球地图"
    />
  );
}
