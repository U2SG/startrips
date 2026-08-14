import type { StyleSpecification } from "maplibre-gl";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { JourneyRoute } from "../journey/types";

export const DEFAULT_DETAIL_TILE_URL = "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png";
export const DEFAULT_BLUE_MARBLE_TILE_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";

export function buildDetailedEarthData(routes: readonly JourneyRoute[]) {
  const routeLines: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: routes.flatMap((route) => route.points.length < 2 ? [] : [{
      type: "Feature" as const,
      properties: { journeyId: route.id, color: route.color },
      geometry: {
        type: "LineString" as const,
        coordinates: route.points.map((point) => [point.lon, point.lat]),
      },
    }]),
  };
  const routePoints: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: routes.flatMap((route) => route.points.map((point, index) => ({
      type: "Feature" as const,
      properties: {
        journeyId: route.id,
        routePointId: point.id ?? "",
        color: route.color,
        isStop: point.isStop ? 1 : 0,
        label: point.label ?? "",
        pointIndex: index,
      },
      geometry: {
        type: "Point" as const,
        coordinates: [point.lon, point.lat],
      },
    }))),
  };
  return { routeLines, routePoints };
}

export function createDetailedEarthStyle(): StyleSpecification {
  const detailTileUrl = import.meta.env.VITE_ATLAS_DETAIL_TILE_URL?.trim()
    || DEFAULT_DETAIL_TILE_URL;
  const detailAttribution = import.meta.env.VITE_ATLAS_DETAIL_TILE_ATTRIBUTION?.trim()
    || "© OpenStreetMap contributors © CARTO";
  const blueMarbleTileUrl = import.meta.env.VITE_ATLAS_OVERVIEW_TILE_URL?.trim()
    || DEFAULT_BLUE_MARBLE_TILE_URL;

  return {
    version: 8,
    projection: { type: "globe" },
    sources: {
      "blue-marble": {
        type: "raster",
        tiles: [blueMarbleTileUrl],
        tileSize: 256,
        maxzoom: 8,
        attribution: "NASA Earth Observatory / GIBS",
      },
      "detail-map": {
        type: "raster",
        tiles: [detailTileUrl],
        tileSize: 256,
        maxzoom: 19,
        attribution: detailAttribution,
      },
    },
    layers: [
      {
        id: "space",
        type: "background",
        paint: { "background-color": "#010506" },
      },
      {
        id: "blue-marble",
        type: "raster",
        source: "blue-marble",
        maxzoom: 7.4,
        paint: {
          "raster-opacity": 0.78,
          "raster-saturation": -0.24,
          "raster-contrast": 0.14,
          "raster-brightness-max": 0.72,
        },
      },
      {
        id: "detail-map",
        type: "raster",
        source: "detail-map",
        minzoom: 4.5,
        paint: {
          "raster-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4.5,
            0,
            7,
            0.92,
          ],
          "raster-saturation": -0.72,
          "raster-contrast": 0.22,
          "raster-brightness-min": 0.06,
          "raster-brightness-max": 0.7,
        },
      },
    ],
  };
}
