import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

export type DetailedEarthLanguage = "zh" | "bilingual";

export const DEFAULT_DETAILED_EARTH_STYLE_URL = "https://tiles.openfreemap.org/styles/fiord";
// Below this regional scale a flat map stops adding useful journey detail.
// Returning to the particle globe also avoids presenting a second world view.
export const DETAILED_EARTH_RETURN_ZOOM = 5.85;
export const DETAILED_EARTH_MIN_ZOOM = 5.6;
export const DETAILED_EARTH_INITIAL_ZOOM = 8;
export const DETAILED_EARTH_MAX_ZOOM = 16;
// MapLibre accepts pitches up to 85 degrees. Keep the camera out of the
// singular edge while still allowing a focused polar region to come into view.
export const DETAILED_EARTH_MAX_PITCH = 85;
export const DETAILED_EARTH_ROTATE_SPEED = 0.45;
export const DETAILED_EARTH_PITCH_SPEED = -0.32;
export const DETAILED_EARTH_BEARING_PER_PIXEL = 0.35;
export const DETAILED_EARTH_PITCH_PER_PIXEL = 0.25;
export const DETAILED_EARTH_TOUCH_ZOOM_RATE = 0.45;
export const DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD = 0.2;
export const DETAILED_EARTH_DRAG_PAN_OPTIONS = {
  linearity: 0.12,
  deceleration: 4_200,
  maxSpeed: 520,
} as const;

export function shouldReturnToParticleEarth(zoom: number) {
  return zoom <= DETAILED_EARTH_RETURN_ZOOM;
}

export function clampDetailedEarthPitch(pitch: number) {
  return Math.max(0, Math.min(DETAILED_EARTH_MAX_PITCH, pitch));
}

export function getDetailedEarthDragRotation(
  bearing: number,
  pitch: number,
  deltaX: number,
  deltaY: number,
) {
  return {
    // Bearing is intentionally not wrapped or clamped: repeated horizontal
    // drags should keep rotating the earth in the same direction.
    bearing: bearing - deltaX * DETAILED_EARTH_BEARING_PER_PIXEL,
    pitch: clampDetailedEarthPitch(
      pitch + deltaY * DETAILED_EARTH_PITCH_PER_PIXEL,
    ),
  };
}

// Set VITE_ATLAS_MAP_STYLE_URL to this sentinel to use the built-in AMap
// raster style (mainland-reachable, no key) instead of a vector style.
export const AMAP_RASTER_STYLE = "amap-raster";

export const AMAP_RASTER_STYLE_SPEC: StyleSpecification = {
  version: 8,
  sources: {
    amap: {
      type: "raster",
      tiles: [
        "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
        "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
        "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
        "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      ],
      tileSize: 256,
      maxzoom: 18,
    },
  },
  layers: [
    {
      id: "amap",
      type: "raster",
      source: "amap",
    },
  ],
};

const CHINESE_NAME: ExpressionSpecification = [
  "coalesce",
  ["get", "name:zh-Hans"],
  ["get", "name:zh"],
  ["get", "name:nonlatin"],
  ["get", "name"],
  ["get", "name:en"],
  ["get", "name_en"],
  "",
];

const ENGLISH_NAME: ExpressionSpecification = [
  "coalesce",
  ["get", "name:en"],
  ["get", "name_en"],
  ["get", "name:latin"],
  ["get", "name"],
  "",
];

export function getConfiguredStyleUrl(): string {
  return import.meta.env.VITE_ATLAS_MAP_STYLE_URL?.trim() || "";
}

export function isRasterDetailedEarth(): boolean {
  return getConfiguredStyleUrl() === AMAP_RASTER_STYLE;
}

// Every vector style can use the globe projection. The server proxy keeps the
// production style same-origin; the map's ready callback has a timeout because
// vector globe tiles may keep their source busy while the view is usable.
export function useGlobeProjection(): boolean {
  return !isRasterDetailedEarth();
}

export function getDetailedEarthStyle(): StyleSpecification | string {
  if (isRasterDetailedEarth()) return AMAP_RASTER_STYLE_SPEC;
  return getConfiguredStyleUrl() || DEFAULT_DETAILED_EARTH_STYLE_URL;
}

export function createDetailedEarthLabelExpression(
  language: DetailedEarthLanguage,
): ExpressionSpecification {
  if (language === "zh") return CHINESE_NAME;

  return [
    "format",
    CHINESE_NAME,
    {},
    [
      "case",
      [
        "all",
        ["!=", ENGLISH_NAME, ""],
        ["!=", CHINESE_NAME, ENGLISH_NAME],
      ],
      ["concat", "\n", ENGLISH_NAME],
      "",
    ],
    { "font-scale": 0.74 },
  ];
}

export function isDetailedEarthNameLabel(textField: unknown) {
  if (typeof textField === "string") return textField.includes("name");
  return JSON.stringify(textField)?.includes("\"name") ?? false;
}
