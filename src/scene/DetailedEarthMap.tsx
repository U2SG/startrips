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
    let primaryDragActive = false;
    let primaryDragX = 0;
    let primaryDragY = 0;
    let primaryDragDragged = false;
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

    const finishPrimaryDrag = () => {
      const wasDragged = primaryDragDragged;
      primaryDragActive = false;
      primaryDragDragged = false;
      delete host.dataset.dragging;
      if (wasDragged) {
        // MapLibre emits its click after the matching mouseup/touchend. Keep
        // the next click suppressed long enough for that event to arrive.
        window.setTimeout(() => {
          suppressNextMapClick = false;
        }, 0);
      }
    };

    const beginPrimaryDrag = (x: number, y: number) => {
      primaryDragActive = true;
      primaryDragX = x;
      primaryDragY = y;
      primaryDragDragged = false;
      map.stop();
    };

    const updatePrimaryDrag = (
      x: number,
      y: number,
      event: { preventDefault: () => void },
    ) => {
      if (!primaryDragActive) return;
      const deltaX = x - primaryDragX;
      const deltaY = y - primaryDragY;
      primaryDragX = x;
      primaryDragY = y;
      if (deltaX === 0 && deltaY === 0) return;
      event.preventDefault();
      primaryDragDragged = true;
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

    const onMouseDown = (event: MouseEvent) => {
      // Ctrl+primary is MapLibre's own dragRotate gesture, which stays enabled
      // below. Claiming it here too would apply both rotations to one drag.
      if (event.button !== 0 || event.ctrlKey) return;
      beginPrimaryDrag(event.clientX, event.clientY);
    };

    const onMouseMove = (event: MouseEvent) => {
      updatePrimaryDrag(event.clientX, event.clientY, event);
    };

    const onMouseUp = () => {
      if (primaryDragActive) finishPrimaryDrag();
    };

    const onTouchStart = (event: TouchEvent) => {
      // Hand two-finger gestures back to MapLibre's native zoom/rotate/pitch
      // handler instead of trying to turn them into a one-finger rotation.
      if (event.touches.length !== 1) {
        finishPrimaryDrag();
        return;
      }
      const touch = event.touches[0];
      beginPrimaryDrag(touch.clientX, touch.clientY);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        finishPrimaryDrag();
        return;
      }
      const touch = event.touches[0];
      updatePrimaryDrag(touch.clientX, touch.clientY, event);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length === 0 || event.touches.length > 1) {
        finishPrimaryDrag();
      }
    };

    const onTouchCancel = () => finishPrimaryDrag();

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchCancel);
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
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchCancel);
      finishPrimaryDrag();
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
