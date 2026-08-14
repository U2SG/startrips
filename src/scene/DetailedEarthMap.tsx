import { useEffect, useRef } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  createDetailedEarthLabelExpression,
  type DetailedEarthLanguage,
  getDetailedEarthStyleUrl,
  isDetailedEarthNameLabel,
} from "./detailedEarthModel";

type DetailedEarthMapProps = {
  focusPoint?: { lat: number; lon: number } | null;
  language: DetailedEarthLanguage;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onReady?: () => void;
  onError?: () => void;
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
  onReady,
  onError,
}: DetailedEarthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const languageRef = useRef(language);
  const onPickRef = useRef(onGlobePointPick);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  languageRef.current = language;
  onPickRef.current = onGlobePointPick;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialCenter: [number, number] = focusPoint
      ? [focusPoint.lon, focusPoint.lat]
      : [104, 34];
    const map = new MapLibreMap({
      container: host,
      style: getDetailedEarthStyleUrl(),
      center: initialCenter,
      zoom: focusPoint ? 6.6 : 3.2,
      minZoom: 1.5,
      maxZoom: 20,
      maxPitch: 58,
      pitch: 20,
      bearing: 0,
      renderWorldCopies: false,
      attributionControl: false,
      cooperativeGestures: false,
      fadeDuration: 650,
    });
    let initialLoadSettled = false;
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      map.setProjection({ type: "globe" });
      applyMapLanguage(map, languageRef.current);
      map.once("idle", () => {
        if (initialLoadSettled) return;
        initialLoadSettled = true;
        host.dataset.mapReady = "true";
        onReadyRef.current?.();
      });
    });

    map.on("click", (event) => {
      if (!onPickRef.current) return;
      onPickRef.current({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
      });
    });
    map.on("error", (event) => {
      host.dataset.mapError = event.error?.message ?? "map-error";
      if (initialLoadSettled) return;
      initialLoadSettled = true;
      onErrorRef.current?.();
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
      zoom: Math.max(map.getZoom(), 6.6),
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
