import { describe, expect, it } from "vitest";
import {
  COVER_ROUTE_ASPECT,
  COVER_ROUTE_MAX_POINTS,
  coverDateCount,
  coverDateLine,
  fitCoverDateLine,
  coverRouteGeometry,
  coverRouteSvgPath,
  type CoverRouteGeometry,
} from "./coverRouteGeometry";

const point = (latitude: number, longitude: number) => ({ latitude, longitude });

function anchors(geometry: CoverRouteGeometry) {
  if (geometry.kind !== "path") throw new Error(`expected a path, got ${geometry.kind}`);
  return [geometry.start, ...geometry.curves.map((curve) => curve.to)];
}

/** Extent of the anchors in band units (width = aspect, height = 1). */
function extent(geometry: CoverRouteGeometry, aspect = COVER_ROUTE_ASPECT) {
  const list = anchors(geometry);
  const xs = list.map((vec) => vec.x * aspect);
  const ys = list.map((vec) => vec.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe("coverRouteGeometry", () => {
  it("draws nothing without Route Points", () => {
    expect(coverRouteGeometry([])).toEqual({ kind: "none" });
    expect(coverRouteGeometry([point(Number.NaN, 10)])).toEqual({ kind: "none" });
  });

  it("puts a single Route Point at the centre of the band", () => {
    expect(coverRouteGeometry([point(35, 135.7)])).toEqual({ kind: "point", end: { x: 0.5, y: 0.5 } });
  });

  it("collapses consecutive identical Route Points", () => {
    expect(coverRouteGeometry([point(35, 135.7), point(35, 135.7)])).toEqual({ kind: "point", end: { x: 0.5, y: 0.5 } });
    const geometry = coverRouteGeometry([point(0, 0), point(0, 0), point(0, 10), point(0, 10), point(10, 10)]);
    expect(anchors(geometry)).toHaveLength(3);
  });

  it("keeps the order: the start and the end are the first and last Route Points", () => {
    const geometry = coverRouteGeometry([point(0, 0), point(0, 10), point(10, 10)]);
    if (geometry.kind !== "path") throw new Error("expected a path");
    // West to east, then north (up on the page).
    expect(geometry.start.x).toBeLessThan(geometry.end.x);
    expect(geometry.end.y).toBeLessThan(geometry.start.y);
  });

  it("preserves the aspect of the route with a cos(mean latitude) longitude scale", () => {
    // Along the equator: 10° of longitude and 5° of latitude keep 2:1.
    const equator = extent(coverRouteGeometry([point(-2.5, 0), point(2.5, 10)]));
    expect(equator.width / equator.height).toBeCloseTo(2, 6);
    // At 60° north a degree of longitude is half as wide.
    const north = extent(coverRouteGeometry([point(57.5, 0), point(62.5, 20)]));
    const cos = Math.cos((60 * Math.PI) / 180);
    expect(north.width / north.height).toBeCloseTo((20 * cos) / 5, 6);
  });

  it("unwraps longitudes across the antimeridian instead of crossing the whole map", () => {
    const crossing = extent(coverRouteGeometry([point(0, 179), point(1, -179)]));
    const near = extent(coverRouteGeometry([point(0, -1), point(1, 1)]));
    expect(crossing.width / crossing.height).toBeCloseTo(near.width / near.height, 6);
    const geometry = coverRouteGeometry([point(0, 179), point(1, -179)]);
    if (geometry.kind !== "path") throw new Error("expected a path");
    expect(geometry.start.x).toBeLessThan(geometry.end.x);
  });

  it("keeps anchors inside the padding and every control point inside the band", () => {
    const zigzag = Array.from({ length: 12 }, (_, index) => point(index % 2 ? 40 : -10, index * 15 - 80));
    const geometry = coverRouteGeometry(zigzag);
    if (geometry.kind !== "path") throw new Error("expected a path");
    const padX = 0.08 / COVER_ROUTE_ASPECT;
    for (const vec of anchors(geometry)) {
      expect(vec.x).toBeGreaterThanOrEqual(padX - 1e-9);
      expect(vec.x).toBeLessThanOrEqual(1 - padX + 1e-9);
      expect(vec.y).toBeGreaterThanOrEqual(0.08 - 1e-9);
      expect(vec.y).toBeLessThanOrEqual(0.92 + 1e-9);
    }
    for (const curve of geometry.curves) {
      for (const vec of [curve.c1, curve.c2]) {
        expect(vec.x).toBeGreaterThanOrEqual(0);
        expect(vec.x).toBeLessThanOrEqual(1);
        expect(vec.y).toBeGreaterThanOrEqual(0);
        expect(vec.y).toBeLessThanOrEqual(1);
      }
    }
    // The fit fills the band on the limiting axis.
    const size = extent(geometry);
    expect(Math.max(size.width / (COVER_ROUTE_ASPECT - 0.16), size.height / 0.84)).toBeCloseTo(1, 6);
  });

  it("thins very long routes and keeps both ends", () => {
    const long = Array.from({ length: 500 }, (_, index) => point(Math.sin(index / 20) * 5, index / 10));
    const geometry = coverRouteGeometry(long);
    const list = anchors(geometry);
    expect(list).toHaveLength(COVER_ROUTE_MAX_POINTS);
    if (geometry.kind !== "path") throw new Error("expected a path");
    expect(geometry.start.x).toBeCloseTo(0.08 / COVER_ROUTE_ASPECT, 6);
    expect(geometry.end.x).toBeCloseTo(1 - 0.08 / COVER_ROUTE_ASPECT, 6);
  });

  it("writes SVG path data with one cubic per segment", () => {
    const d = coverRouteSvgPath(coverRouteGeometry([point(0, 0), point(0, 10), point(10, 10)]), 160, 100);
    expect(d.startsWith("M")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(coverRouteSvgPath({ kind: "point", end: { x: 0.5, y: 0.5 } }, 160, 100)).toBe("");
  });
});

describe("coverDateLine", () => {
  it("adds the Route Point count only when there is one", () => {
    expect(coverDateLine("2026-10-12 — 2026-10-14", 7)).toBe("2026-10-12 — 2026-10-14 · 7 个路线点");
    expect(coverDateLine("2026-10-12", 0)).toBe("2026-10-12");
  });

  it("keeps one line by dropping the count when the full line does not fit", () => {
    const fitsUpTo = (max: number) => (line: string) => line.length <= max;
    expect(fitCoverDateLine("2026-10-12", 7, fitsUpTo(40))).toBe("2026-10-12 · 7 个路线点");
    expect(fitCoverDateLine("2026-10-12", 7, fitsUpTo(12))).toBe("2026-10-12");
    expect(fitCoverDateLine("2026-10-12", 0, fitsUpTo(4))).toBe("2026-10-12");
    expect(coverDateLine("2026-10-12", 7)).toBe("2026-10-12" + coverDateCount(7));
    expect(coverDateCount(0)).toBe("");
  });
});
