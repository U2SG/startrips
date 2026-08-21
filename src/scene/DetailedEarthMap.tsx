import { useEffect, useRef } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  createDetailedEarthLabelExpression,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  type DetailedEarthLanguage,
  getDetailedEarthStyle,
  isDetailedEarthNameLabel,
  shouldReturnToParticleEarth,
  useGlobeProjection,
} from "./detailedEarthModel";

type DetailedEarthMapProps = {
  focusPoint?: { lat: number; lon: number } | null;
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

export default function DetailedEarthMap({
  focusPoint,
  language,
  onGlobePointPick,
  onOverviewRequest,
  onReady,
}: DetailedEarthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const languageRef = useRef(language);
  const onPickRef = useRef(onGlobePointPick);
  const onOverviewRequestRef = useRef(onOverviewRequest);
  const onReadyRef = useRef(onReady);
  languageRef.current = language;
  onPickRef.current = onGlobePointPick;
  onOverviewRequestRef.current = onOverviewRequest;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialCenter: [number, number] = focusPoint
      ? [focusPoint.lon, focusPoint.lat]
      : [104, 34];
    const map = new MapLibreMap({
      container: host,
      style: getDetailedEarthStyle(),
      center: initialCenter,
      zoom: DETAILED_EARTH_INITIAL_ZOOM,
      minZoom: DETAILED_EARTH_MIN_ZOOM,
      maxZoom: 16,
      maxPitch: 0,
      pitch: 0,
      bearing: 0,
      renderWorldCopies: false,
      attributionControl: false,
      cooperativeGestures: false,
      fadeDuration: 650,
    });
    let initialLoadSettled = false;
    let overviewRequested = false;
    mapRef.current = map;
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      // Globe projection only supports vector sources and can keep the source
      // busy forever with proxied tiles; keep it for the direct provider only.
      if (useGlobeProjection()) map.setProjection({ type: "globe" });
      applyMapLanguage(map, languageRef.current);
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
      window.setTimeout(settle, 3000);
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
    if (!map || !focusPoint) return;
    map.flyTo({
      center: [focusPoint.lon, focusPoint.lat],
      zoom: Math.max(map.getZoom(), DETAILED_EARTH_INITIAL_ZOOM),
      duration: 900,
      essential: true,
    });
  }, [focusPoint]);

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
      role="application"
      aria-label="可深度缩放的真实地球地图"
    />
  );
}
