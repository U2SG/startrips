import { BOOK_PAGE_RATIO } from "./journeyBookLayout";
import type { RoutePoint } from "./types";

/**
 * Journey Book front cover: the Journey's Route blind-debossed into the cloth.
 *
 * Both renderers (the 2D book and the 3D book's canvas painter) draw the same
 * geometry: the ordered Route Points projected equirectangularly (longitude
 * scaled by the cosine of the mean latitude, so the shape keeps its aspect),
 * unwrapped across the antimeridian, fitted into the cover's route band and
 * smoothed into cubic Bézier segments. Pure; no DOM.
 */

/** The route band on the cover, as fractions of the cover width and height. */
export const COVER_ROUTE_BAND = { left: 0.08, top: 0.3, width: 0.84, height: 0.42 } as const;

/** Band width / band height on a page of `BOOK_PAGE_RATIO`. */
export const COVER_ROUTE_ASPECT = (COVER_ROUTE_BAND.width * BOOK_PAGE_RATIO) / COVER_ROUTE_BAND.height;

/** Stroke and marker sizes, as fractions of the cover width (reference: 3 px, 1 px, 6 px, 8 px on 504 px). */
export const COVER_ROUTE_STROKE = {
  deboss: 3 / 504,
  highlight: 1 / 504,
  highlightOffset: 1 / 504,
  start: 6 / 504,
  end: 8 / 504,
} as const;

/** Longer routes are thinned to this many points; the cover is a sketch, not the saved Route. */
export const COVER_ROUTE_MAX_POINTS = 64;

/** Inset of the anchors inside the band, as a fraction of the band height on every side. */
const PADDING = 0.08;

export type CoverRouteVec = { x: number; y: number };
export type CoverRouteCurve = { c1: CoverRouteVec; c2: CoverRouteVec; to: CoverRouteVec };

/**
 * Normalized to the band: x and y run 0..1 across the band's width and
 * height, so a renderer maps them with `left + x * width`, `top + y * height`.
 * The band's aspect is `COVER_ROUTE_ASPECT`, so that mapping is uniform.
 */
export type CoverRouteGeometry =
  | { kind: "none" }
  | { kind: "point"; end: CoverRouteVec }
  | { kind: "path"; start: CoverRouteVec; end: CoverRouteVec; curves: CoverRouteCurve[] };

type Coordinate = Pick<RoutePoint, "latitude" | "longitude">;

function finite(point: Coordinate): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

/** Consecutive identical coordinates collapse to one. */
function dedupe(points: readonly Coordinate[]): Coordinate[] {
  const kept: Coordinate[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && last.latitude === point.latitude && last.longitude === point.longitude) continue;
    kept.push(point);
  }
  return kept;
}

/** Each longitude moves by the shorter way round from the previous one. */
function unwrap(points: readonly Coordinate[]): Coordinate[] {
  const result: Coordinate[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(point);
      continue;
    }
    let delta = (point.longitude - previous.longitude) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    result.push({ latitude: point.latitude, longitude: previous.longitude + delta });
  }
  return result;
}

/** Evenly thinned, keeping the first and the last point. */
function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  return Array.from({ length: max }, (_, index) => points[Math.round((index * (points.length - 1)) / (max - 1))]);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function coverRouteGeometry(
  routePoints: readonly Coordinate[],
  aspect: number = COVER_ROUTE_ASPECT,
): CoverRouteGeometry {
  const points = thin(unwrap(dedupe(routePoints.filter(finite))), COVER_ROUTE_MAX_POINTS);
  if (points.length === 0) return { kind: "none" };
  const center = { x: 0.5, y: 0.5 };
  if (points.length === 1) return { kind: "point", end: center };

  const meanLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
  const xScale = Math.max(0.05, Math.cos((meanLatitude * Math.PI) / 180));
  // North up: y grows southward, as on the page.
  const projected = points.map((point) => ({ x: point.longitude * xScale, y: -point.latitude }));
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  if (spanX === 0 && spanY === 0) return { kind: "point", end: center };

  // Fit in band units (width = aspect, height = 1) with one uniform scale.
  const roomX = aspect - 2 * PADDING;
  const roomY = 1 - 2 * PADDING;
  const scale = Math.min(spanX > 0 ? roomX / spanX : Infinity, spanY > 0 ? roomY / spanY : Infinity);
  const offsetX = (aspect - spanX * scale) / 2;
  const offsetY = (1 - spanY * scale) / 2;
  const anchors = projected.map((point) => ({
    x: (offsetX + (point.x - minX) * scale) / aspect,
    y: offsetY + (point.y - minY) * scale,
  }));

  // Catmull-Rom through the anchors as cubic Béziers. Control points are kept
  // inside the band, so the curve (inside their hull) never leaves it.
  const at = (index: number) => anchors[Math.min(anchors.length - 1, Math.max(0, index))];
  const curves: CoverRouteCurve[] = [];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const before = at(index - 1);
    const from = at(index);
    const to = at(index + 1);
    const after = at(index + 2);
    curves.push({
      c1: { x: clamp01(from.x + (to.x - before.x) / 6), y: clamp01(from.y + (to.y - before.y) / 6) },
      c2: { x: clamp01(to.x - (after.x - from.x) / 6), y: clamp01(to.y - (after.y - from.y) / 6) },
      to,
    });
  }
  return { kind: "path", start: anchors[0], end: anchors[anchors.length - 1], curves };
}

/** SVG path data for a band drawn `width` × `height` units. */
export function coverRouteSvgPath(geometry: CoverRouteGeometry, width: number, height: number): string {
  if (geometry.kind !== "path") return "";
  const point = (vec: CoverRouteVec) => `${round(vec.x * width)} ${round(vec.y * height)}`;
  return [
    `M${point(geometry.start)}`,
    ...geometry.curves.map((curve) => `C${point(curve.c1)} ${point(curve.c2)} ${point(curve.to)}`),
  ].join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The cover's line under the title: dates, then the Route Point count when there is one. */
/** The Route Point count after the dates, or "" when there is none. */
export function coverDateCount(routePointCount: number): string {
  return routePointCount > 0 ? ` · ${routePointCount} 个地点` : "";
}

export function coverDateLine(dates: string, routePointCount: number): string {
  return dates + coverDateCount(routePointCount);
}

/**
 * The cover's date line stays on one line in both renderers: when the full
 * line does not fit, the count is dropped and only the dates remain.
 */
export function fitCoverDateLine(dates: string, routePointCount: number, fits: (line: string) => boolean): string {
  const full = coverDateLine(dates, routePointCount);
  return fits(full) ? full : dates;
}
