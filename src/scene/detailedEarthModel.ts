import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import type { EarthDiveStage } from "./earthDive";
import type { SemanticZoomSnapshot } from "./semanticZoom";

export type DetailedEarthLanguage = "zh" | "bilingual";

export const DEFAULT_DETAILED_EARTH_STYLE_URL = "/api/mapstyle?path=styles%2Ffiord";
// #252: the scale at which the Semantic Earth Dive hands over is not a chosen
// number - it is whatever MapLibre zoom reproduces the particle Earth's own
// local scale at the focused place, solved by measurement in
// `solveDetailedEarthHandoffZoom`. At the particle camera's deepest zoom that
// lands a little above MapLibre zoom 5, so the two constants below had to come
// down with it: a return threshold ABOVE the calibrated handoff would make a
// freshly handed-over map ask to go home on its first frame, and a floor above
// it would clamp the calibration into a visible scale jump. They keep their
// original meaning - the scale at which a flat map stops adding useful journey
// detail - now expressed on the same scale as the handoff instead of beside it.
export const DETAILED_EARTH_RETURN_ZOOM = 4.5;
export const DETAILED_EARTH_MIN_ZOOM = 4.2;

export type DetailedEarthFocusFlightProfile = "nearby" | "regional" | "long-haul";

export function getDetailedEarthFocusDuration(
  profile: DetailedEarthFocusFlightProfile | undefined,
) {
  if (profile === "nearby") return 520;
  if (profile === "long-haul") return 1_350;
  return 900;
}

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


export type DetailedEarthRouteFrame = {
  bounds: [[number, number], [number, number]];
  center: [number, number];
  pointCount: number;
};

function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * Build one continuous longitude interval for route framing. Each longitude is
 * unwrapped relative to the previous point, so a route such as 179E -> 179W
 * stays a narrow two-degree frame instead of spanning almost the whole world.
 */
export function getDetailedEarthRouteFrame(
  points: readonly { lat: number; lon: number }[],
): DetailedEarthRouteFrame | null {
  const valid = points.filter((point) => (
    Number.isFinite(point.lat) && Number.isFinite(point.lon)
  ));
  if (valid.length === 0) return null;

  let previousLongitude = normalizeLongitude(valid[0].lon);
  let west = previousLongitude;
  let east = previousLongitude;
  let south = valid[0].lat;
  let north = valid[0].lat;

  for (let index = 1; index < valid.length; index += 1) {
    const point = valid[index];
    let longitude = normalizeLongitude(point.lon);
    while (longitude - previousLongitude > 180) longitude -= 360;
    while (longitude - previousLongitude < -180) longitude += 360;
    previousLongitude = longitude;
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }

  return {
    bounds: [[west, south], [east, north]],
    center: [(west + east) / 2, (south + north) / 2],
    pointCount: valid.length,
  };
}

export function shouldReturnToParticleEarth(zoom: number) {
  return zoom <= DETAILED_EARTH_RETURN_ZOOM;
}

// #252: where the calibration STARTS, and nothing else. The solved zoom comes
// from measuring the hidden map against the particle Earth, so this value only
// decides which side of the answer the first measurement is taken from; the
// browser lane compares the two renderers, so a poor seed cannot pass as a
// calibration. It deliberately is not a scale the product promises, and the
// technical report's seed values are not used here at all.
export const DETAILED_EARTH_HANDOFF_SEED_ZOOM = 5;
// A seed that also tracks the zoom authority converges in fewer measurements
// than a constant one, so the seed leans by this much across the `local` band.
export const DETAILED_EARTH_HANDOFF_SEED_SPAN = 0.5;
// Where a map with no focus at all looks: the geographic centre the product has
// always fallen back to.
export const DETAILED_EARTH_FALLBACK_CENTER: [number, number] = [104, 34];

/**
 * What the particle Earth is showing, in screen space, at the focused place.
 * #252 section 2: the handoff is correct when the same geographic anchor and
 * the same local scale agree in screen space between the two renderers, so
 * these are the quantities the particle side publishes and the map side solves
 * to. Both are CSS pixels in the viewport.
 */
export type ParticleAnchorFrame = {
  anchor: { lat: number; lon: number };
  screen: { x: number; y: number };
  pxPerDegreeLat: number;
};

export type EarthDiveHandoffFrame = {
  center: [number, number];
  zoom: number;
  /** Where the anchor must land, when the particle side has published it. */
  screen: { x: number; y: number } | null;
};

/**
 * The MapLibre frame that corresponds to a particle focus at one Dive stage.
 *
 * The centre is geographic and the zoom is a SEED: the real zoom is solved from
 * a measurement of the mounted map against `ParticleAnchorFrame` (see
 * `solveDetailedEarthHandoffZoom`), because a linear map from particle zoom to
 * MapLibre zoom is not a calibration - it is a guess that happens to be
 * monotonic. What this function guarantees, and what
 * `detailedEarthModel.test.ts` asserts, is that nothing here varies with the
 * stage: the framing cannot change as the surface becomes visible and then
 * takes ownership. The stage only says whether a frame exists at all - at
 * `particle` there is no map to frame.
 */
export function getEarthDiveHandoffFrame({
  stage,
  snapshot,
  focusPoint,
  routePoints,
  particleFrame,
}: {
  stage: EarthDiveStage;
  snapshot: SemanticZoomSnapshot;
  focusPoint?: { lat: number; lon: number } | null;
  routePoints?: readonly { lat: number; lon: number }[];
  particleFrame?: ParticleAnchorFrame | null;
}): EarthDiveHandoffFrame | null {
  if (stage === "particle") return null;
  const routeFrame = getDetailedEarthRouteFrame(routePoints ?? []);
  // The particle globe anchors a focused Journey on its route frame centre and
  // falls back to the focused point, so the map must read the same order or the
  // two surfaces would be centred on different places. A published particle
  // frame outranks both: it names the place the particle Earth is actually
  // holding on screen.
  const center: [number, number] = particleFrame
    ? [particleFrame.anchor.lon, particleFrame.anchor.lat]
    : routeFrame?.center
      ?? (focusPoint && Number.isFinite(focusPoint.lat) && Number.isFinite(focusPoint.lon)
        ? [focusPoint.lon, focusPoint.lat]
        : DETAILED_EARTH_FALLBACK_CENTER);
  const progress = Math.min(1, Math.max(0, snapshot.localProgress));
  return {
    center,
    zoom: DETAILED_EARTH_HANDOFF_SEED_ZOOM + progress * DETAILED_EARTH_HANDOFF_SEED_SPAN,
    screen: particleFrame ? { ...particleFrame.screen } : null,
  };
}

/**
 * The MapLibre zoom at which the map's local scale equals the particle Earth's.
 *
 * MapLibre's scale is exponential in zoom, so one measured pair - the zoom the
 * map is standing at and the pixels per degree it produces there - fixes the
 * answer in one step, whatever projection the installed version is using and
 * without this module restating a formula for it. The caller measures with
 * `project`, applies the answer with a non-animated camera update, and may
 * measure again: an exact solver run twice is a fixed point, which is what
 * makes the loop safe to bound.
 */
export function solveDetailedEarthHandoffZoom({
  measuredZoom,
  measuredPxPerDegreeLat,
  targetPxPerDegreeLat,
}: {
  measuredZoom: number;
  measuredPxPerDegreeLat: number;
  targetPxPerDegreeLat: number;
}): number {
  if (
    !Number.isFinite(measuredZoom)
    || !(measuredPxPerDegreeLat > 0)
    || !(targetPxPerDegreeLat > 0)
  ) return clampDetailedEarthZoom(measuredZoom);
  const correction = Math.log2(targetPxPerDegreeLat / measuredPxPerDegreeLat);
  return clampDetailedEarthZoom(measuredZoom + correction);
}

export function clampDetailedEarthZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return DETAILED_EARTH_HANDOFF_SEED_ZOOM;
  return Math.max(DETAILED_EARTH_MIN_ZOOM, Math.min(DETAILED_EARTH_MAX_ZOOM, zoom));
}

/**
 * The screen-space correction that puts a projected anchor onto the point the
 * particle Earth is holding it at. Applied to the map CENTRE in pixel space and
 * unprojected by the caller, so the same projection answers both questions.
 */
export function detailedEarthAnchorCorrection(
  projected: { x: number; y: number },
  target: { x: number; y: number },
) {
  return { x: projected.x - target.x, y: projected.y - target.y };
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
