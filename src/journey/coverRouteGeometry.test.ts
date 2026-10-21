import { describe, expect, it } from "vitest";
import { BOOK_PAGE_RATIO } from "./journeyBookLayout";
import {
  COVER_ROUTE_ASPECT,
  COVER_ROUTE_BAND,
  COVER_ROUTE_MAX_DOTS,
  COVER_ROUTE_MAX_POINTS,
  COVER_ROUTE_PADDING,
  COVER_ROUTE_STROKE,
  coverRouteDots,
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
    const padX = COVER_ROUTE_PADDING / COVER_ROUTE_ASPECT;
    for (const vec of anchors(geometry)) {
      expect(vec.x).toBeGreaterThanOrEqual(padX - 1e-9);
      expect(vec.x).toBeLessThanOrEqual(1 - padX + 1e-9);
      expect(vec.y).toBeGreaterThanOrEqual(COVER_ROUTE_PADDING - 1e-9);
      expect(vec.y).toBeLessThanOrEqual(1 - COVER_ROUTE_PADDING + 1e-9);
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
    expect(Math.max(size.width / (COVER_ROUTE_ASPECT - 2 * COVER_ROUTE_PADDING), size.height / (1 - 2 * COVER_ROUTE_PADDING))).toBeCloseTo(1, 6);
  });

  it("thins very long routes and keeps both ends", () => {
    const long = Array.from({ length: 500 }, (_, index) => point(Math.sin(index / 20) * 5, index / 10));
    const geometry = coverRouteGeometry(long);
    const list = anchors(geometry);
    expect(list).toHaveLength(COVER_ROUTE_MAX_POINTS);
    if (geometry.kind !== "path") throw new Error("expected a path");
    expect(geometry.start.x).toBeCloseTo(COVER_ROUTE_PADDING / COVER_ROUTE_ASPECT, 6);
    expect(geometry.end.x).toBeCloseTo(1 - COVER_ROUTE_PADDING / COVER_ROUTE_ASPECT, 6);
  });

  it("enlarges the band without reaching the cover title or the photo plate", () => {
    // Layout constants of the cover (journey-book.css and the 3D painter's COVER).
    const widthPerHeight = BOOK_PAGE_RATIO;
    const titleTop = 0.087;
    const twoTitleLines = 2 * 0.067 * 1.2 * widthPerHeight;
    const datesLine = (0.028 + 0.022 * 1.3) * widthPerHeight;
    const headBottom = titleTop + twoTitleLines + datesLine;
    const plateTop = 1 - 0.073 - 0.187;
    const plateLeft = 1 - 0.095 - 0.3;
    // Half the deboss stroke, which a curve bulging to the band edge can carry past it.
    const halfStroke = (COVER_ROUTE_STROKE.deboss / 2) * widthPerHeight;

    expect(COVER_ROUTE_BAND.top - halfStroke).toBeGreaterThan(headBottom);
    // The band is a full-width rectangle, so it must clear the plate's top edge.
    expect(COVER_ROUTE_BAND.left + COVER_ROUTE_BAND.width).toBeGreaterThan(plateLeft);
    expect(COVER_ROUTE_BAND.top + COVER_ROUTE_BAND.height + halfStroke).toBeLessThan(plateTop);
    // Larger than the previous 0.84 x 0.42 band with 8% padding.
    expect(COVER_ROUTE_BAND.width).toBeGreaterThan(0.84);
    expect(COVER_ROUTE_BAND.height * (1 - 2 * COVER_ROUTE_PADDING)).toBeGreaterThan(0.42 * 0.84);
    // The padding still holds the largest marker inside the band.
    const bandHeightInWidths = COVER_ROUTE_BAND.height / widthPerHeight;
    expect(COVER_ROUTE_PADDING * bandHeightInWidths).toBeGreaterThanOrEqual(COVER_ROUTE_STROKE.end / 2);
    expect(COVER_ROUTE_PADDING * bandHeightInWidths).toBeGreaterThanOrEqual(COVER_ROUTE_STROKE.dot / 2);
  });

  it("draws the route darker and thicker than the original 3 px sketch", () => {
    expect(COVER_ROUTE_STROKE.deboss).toBeGreaterThanOrEqual(6 / 504);
    expect(COVER_ROUTE_STROKE.dot).toBeGreaterThan(COVER_ROUTE_STROKE.deboss);
    expect(COVER_ROUTE_STROKE.start).toBeGreaterThan(COVER_ROUTE_STROKE.dot);
  });

  it("dots each interior Route Point unless there are too many to read", () => {
    const geometry = coverRouteGeometry([point(0, 0), point(0, 10), point(10, 10), point(10, 20)]);
    if (geometry.kind !== "path") throw new Error("expected a path");
    expect(coverRouteDots(geometry)).toEqual([geometry.curves[0].to, geometry.curves[1].to]);
    expect(coverRouteDots(coverRouteGeometry([point(0, 0), point(0, 10)]))).toEqual([]);
    expect(coverRouteDots({ kind: "point", end: { x: 0.5, y: 0.5 } })).toEqual([]);
    const dense = Array.from({ length: COVER_ROUTE_MAX_DOTS + 3 }, (_, index) => point(index % 2, index));
    expect(coverRouteDots(coverRouteGeometry(dense))).toEqual([]);
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
    expect(coverDateLine("2026-10-12 — 2026-10-14", 7)).toBe("2026-10-12 — 2026-10-14 · 7 个地点");
    expect(coverDateLine("2026-10-12", 0)).toBe("2026-10-12");
  });

  it("keeps one line by dropping the count when the full line does not fit", () => {
    const fitsUpTo = (max: number) => (line: string) => line.length <= max;
    expect(fitCoverDateLine("2026-10-12", 7, fitsUpTo(40))).toBe("2026-10-12 · 7 个地点");
    expect(fitCoverDateLine("2026-10-12", 7, fitsUpTo(12))).toBe("2026-10-12");
    expect(fitCoverDateLine("2026-10-12", 0, fitsUpTo(4))).toBe("2026-10-12");
    expect(coverDateLine("2026-10-12", 7)).toBe("2026-10-12" + coverDateCount(7));
    expect(coverDateCount(0)).toBe("");
  });
});
