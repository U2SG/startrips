import { useEffect, useRef } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  createDetailedEarthLabelExpression,
  getDetailedEarthDragRotation,
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
    let customPointerId: number | null = null;
    let customPointerX = 0;
    let customPointerY = 0;
    let customPointerDragged = false;
    let suppressNextMapClick = false;
    mapRef.current = map;
    map.dragRotate.enable();
    // A normal primary-button drag rotates the earth. MapLibre's built-in
    // dragRotate intentionally reserves that gesture for right-button/Ctrl
    // dragging, so leave it enabled for those gestures and own the primary
    // pointer path here.
    map.dragPan.disable();
    map.touchZoomRotate.enableRotation();
    map.touchZoomRotate.setZoomRate(DETAILED_EARTH_TOUCH_ZOOM_RATE);
    map.touchZoomRotate.setZoomThreshold(DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD);
    const canvas = map.getCanvas();
    canvas.style.touchAction = "none";

    const releaseCustomPointer = () => {
      if (
        customPointerId !== null
        && canvas.hasPointerCapture?.(customPointerId)
      ) {
        canvas.releasePointerCapture?.(customPointerId);
      }
      customPointerId = null;
      customPointerDragged = false;
      delete host.dataset.dragging;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // A second touch belongs to MapLibre's native pinch/rotation handler.
      // Stop the one-finger rotation before handing the gesture over.
      if (customPointerId !== null) {
        releaseCustomPointer();
        return;
      }
      if (!event.isPrimary) return;
      customPointerId = event.pointerId;
      customPointerX = event.clientX;
      customPointerY = event.clientY;
      customPointerDragged = false;
      map.stop();
      canvas.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== customPointerId) return;
      const deltaX = event.clientX - customPointerX;
      const deltaY = event.clientY - customPointerY;
      customPointerX = event.clientX;
      customPointerY = event.clientY;
      if (deltaX === 0 && deltaY === 0) return;
      event.preventDefault();
      customPointerDragged = true;
      suppressNextMapClick = true;
      host.dataset.dragging = "true";
      map.stop();
      const rotation = getDetailedEarthDragRotation(
        map.getBearing(),
        map.getPitch(),
        deltaX,
        deltaY,
      );
      map.setBearing(rotation.bearing);
      map.setPitch(rotation.pitch);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== customPointerId) return;
      const wasDragged = customPointerDragged;
      releaseCustomPointer();
      if (suppressNextMapClick && wasDragged) {
        window.setTimeout(() => {
          suppressNextMapClick = false;
        }, 0);
      }
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === customPointerId) releaseCustomPointer();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    map.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      // Raster fallback remains Mercator; vector styles use the globe so a
      // polar focus is not trapped by the flat-map viewport.
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
      settleTimer = window.setTimeout(settle, 3000);
    });

    map.on("click", (event) => {
      if (suppressNextMapClick) {
        suppressNextMapClick = false;
        return;
      }
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
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      releaseCustomPointer();
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
