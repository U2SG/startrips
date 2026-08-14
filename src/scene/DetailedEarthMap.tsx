import { useEffect, useRef } from "react";
import {
  AttributionControl,
  type FilterSpecification,
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { JourneyRoute } from "../journey/types";
import {
  buildDetailedEarthData,
  createDetailedEarthStyle,
} from "./detailedEarthModel";

type DetailedEarthMapProps = {
  routes: readonly JourneyRoute[];
  activeJourneyRouteId?: string | null;
  focusPoint?: { lat: number; lon: number } | null;
  onJourneyRouteActivate?: (journeyId: string) => void;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
};

const ROUTE_SOURCE_ID = "journey-routes";
const POINT_SOURCE_ID = "journey-points";

function activeFilter(id?: string | null) {
  return ["==", ["get", "journeyId"], id ?? ""] as FilterSpecification;
}

export default function DetailedEarthMap({
  routes,
  activeJourneyRouteId,
  focusPoint,
  onJourneyRouteActivate,
  onJourneyRoutePointActivate,
  onGlobePointPick,
}: DetailedEarthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const routesRef = useRef(routes);
  const activeJourneyRef = useRef(activeJourneyRouteId);
  const onJourneyRef = useRef(onJourneyRouteActivate);
  const onPointRef = useRef(onJourneyRoutePointActivate);
  const onPickRef = useRef(onGlobePointPick);
  routesRef.current = routes;
  activeJourneyRef.current = activeJourneyRouteId;
  onJourneyRef.current = onJourneyRouteActivate;
  onPointRef.current = onJourneyRoutePointActivate;
  onPickRef.current = onGlobePointPick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialCenter: [number, number] = focusPoint
      ? [focusPoint.lon, focusPoint.lat]
      : [104, 34];
    const map = new MapLibreMap({
      container: host,
      style: createDetailedEarthStyle(),
      center: initialCenter,
      zoom: focusPoint ? 6.2 : 3.2,
      minZoom: 1.5,
      maxZoom: 19,
      maxPitch: 58,
      pitch: 20,
      bearing: 0,
      renderWorldCopies: false,
      attributionControl: false,
      cooperativeGestures: false,
      fadeDuration: 220,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      const data = buildDetailedEarthData(routesRef.current);
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: data.routeLines,
      });
      map.addSource(POINT_SOURCE_ID, {
        type: "geojson",
        data: data.routePoints,
      });
      map.addLayer({
        id: "journey-route-glow",
        type: "line",
        source: ROUTE_SOURCE_ID,
        paint: {
          "line-color": ["get", "color"],
          "line-opacity": 0.2,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 14, 12],
          "line-blur": 3,
        },
      });
      map.addLayer({
        id: "journey-route-core",
        type: "line",
        source: ROUTE_SOURCE_ID,
        paint: {
          "line-color": ["get", "color"],
          "line-opacity": 0.92,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 4],
        },
      });
      map.addLayer({
        id: "journey-route-active",
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: activeFilter(activeJourneyRef.current),
        paint: {
          "line-color": ["get", "color"],
          "line-opacity": 0.42,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 7, 14, 16],
          "line-blur": 5,
        },
      });
      map.addLayer({
        id: "journey-point-halo",
        type: "circle",
        source: POINT_SOURCE_ID,
        filter: activeFilter(activeJourneyRef.current),
        paint: {
          "circle-color": ["get", "color"],
          "circle-opacity": 0.18,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 11, 14, 24],
          "circle-blur": 0.55,
        },
      });
      map.addLayer({
        id: "journey-points",
        type: "circle",
        source: POINT_SOURCE_ID,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            ["case", ["==", ["get", "isStop"], 1], 5, 3.5],
            14,
            ["case", ["==", ["get", "isStop"], 1], 10, 7],
          ],
          "circle-stroke-color": "rgba(244, 255, 251, 0.9)",
          "circle-stroke-width": 1.2,
          "circle-opacity": 0.96,
        },
      });

      map.on("click", "journey-points", (event) => {
        if (onPickRef.current) return;
        const properties = event.features?.[0]?.properties;
        const journeyId = typeof properties?.journeyId === "string"
          ? properties.journeyId
          : "";
        const routePointId = typeof properties?.routePointId === "string"
          ? properties.routePointId
          : "";
        if (journeyId && routePointId) {
          onPointRef.current?.(journeyId, routePointId);
        } else if (journeyId) {
          onJourneyRef.current?.(journeyId);
        }
      });
      map.on("click", "journey-route-core", (event) => {
        if (onPickRef.current) return;
        const journeyId = event.features?.[0]?.properties?.journeyId;
        if (typeof journeyId === "string") onJourneyRef.current?.(journeyId);
      });
      for (const layer of ["journey-points", "journey-route-core"]) {
        map.on("mouseenter", layer, () => {
          if (!onPickRef.current) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = onPickRef.current ? "crosshair" : "grab";
        });
      }
      host.dataset.mapReady = "true";
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
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const data = buildDetailedEarthData(routes);
    (map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(data.routeLines);
    (map.getSource(POINT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(data.routePoints);
  }, [routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("journey-route-active")) return;
    map.setFilter("journey-route-active", activeFilter(activeJourneyRouteId));
    map.setFilter("journey-point-halo", activeFilter(activeJourneyRouteId));
  }, [activeJourneyRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPoint) return;
    map.flyTo({
      center: [focusPoint.lon, focusPoint.lat],
      zoom: Math.max(map.getZoom(), 6.2),
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
      data-map-provider="configurable-raster"
      data-point-pick={onGlobePointPick ? "true" : "false"}
      role="application"
      aria-label="可深度缩放的真实地球与旅程地图"
    />
  );
}
