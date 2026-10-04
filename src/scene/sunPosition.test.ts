import { describe, expect, it } from "vitest";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS } from "./earthDive";
import { latLonToVector3 } from "./geo";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  GLOBE_SEMANTIC_ZOOM_FLOOR,
  LOCAL_BAND_ENTRY_ZOOM,
  resolveGlobeSemanticZoom,
} from "./semanticZoom";
import {
  DAY_NIGHT_DIVE_RELEASE_PROGRESS,
  DAY_NIGHT_NIGHT_BRIGHTNESS,
  dayNightBrightness,
  dayNightDiveFactor,
  dayNightModeWeight,
  parseSunTimeOverride,
  subsolarPoint,
  sunDirectionAt,
} from "./sunPosition";

const at = (iso: string) => subsolarPoint(new Date(iso));

describe("subsolar point", () => {
  it("sits on the equator near Greenwich at the March equinox noon", () => {
    // 2026-03-20 14:46 UTC equinox. Noon UTC is 0.11 days earlier, and the
    // equation of time (about -7.5 min) puts the sun ~1.9° east of Greenwich.
    const point = at("2026-03-20T12:00:00Z");
    expect(Math.abs(point.lat)).toBeLessThan(1);
    expect(point.lon).toBeGreaterThan(1);
    expect(point.lon).toBeLessThan(3);
  });

  it.each([
    "2026-04-15T12:00:00Z",
    "2026-06-13T12:00:00Z",
    "2026-09-01T12:00:00Z",
    "2026-12-25T12:00:00Z",
  ])("is over Greenwich at noon UTC when the equation of time is near zero (%s)", (iso) => {
    expect(Math.abs(at(iso).lon)).toBeLessThan(1);
  });

  it("reaches the tropics at the solstices", () => {
    expect(at("2026-06-21T08:24:00Z").lat).toBeCloseTo(23.44, 1);
    expect(at("2026-12-21T20:50:00Z").lat).toBeCloseTo(-23.44, 1);
  });

  it("moves west 15° per hour", () => {
    const noon = at("2026-06-21T12:00:00Z").lon;
    const later = at("2026-06-21T18:00:00Z").lon;
    expect(noon - later).toBeCloseTo(90, 0);
  });

  it("returns a unit direction through the canonical projection", () => {
    const date = new Date("2026-06-21T12:00:00Z");
    const { lat, lon } = subsolarPoint(date);
    const direction = sunDirectionAt(date);
    expect(direction.length()).toBeCloseTo(1, 10);
    expect(direction.distanceTo(latLonToVector3(lat, lon, 1))).toBeLessThan(1e-12);
  });
});

describe("day/night controls", () => {
  it("pins the clock only for a valid sunTime", () => {
    expect(parseSunTimeOverride("?dayNight=1&sunTime=2026-06-21T12:00:00Z")?.toISOString())
      .toBe("2026-06-21T12:00:00.000Z");
    expect(parseSunTimeOverride("?dayNight=1&sunTime=not-a-date")).toBeNull();
    expect(parseSunTimeOverride("?dayNight=1")).toBeNull();
  });

  it("is active on the particle globe modes and off on Surface Earth", () => {
    expect(dayNightModeWeight("particleSphere")).toBe(1);
    expect(dayNightModeWeight("focusPoint")).toBe(1);
    expect(dayNightModeWeight("archiveBurst")).toBe(1);
    expect(dayNightModeWeight("surfaceEarth")).toBe(0);
  });

  it("ramps continuously across the local band entry", () => {
    const epsilon = 1e-4;
    // The geometric edge and the hysteresis edge where the band really opens.
    for (const edge of [LOCAL_BAND_ENTRY_ZOOM, LOCAL_BAND_ENTRY_ZOOM + 0.08]) {
      expect(Math.abs(dayNightDiveFactor(edge - epsilon) - dayNightDiveFactor(edge + epsilon)))
        .toBeLessThan(0.01);
    }
    expect(dayNightDiveFactor(GLOBE_SEMANTIC_ZOOM_FLOOR)).toBe(1);
    expect(dayNightDiveFactor(LOCAL_BAND_ENTRY_ZOOM)).toBe(1);
    // Regression: the first `local` frame (zoom 2.63, localProgress ~0.178)
    // used to jump from 1 to ~0.51; it is now reached gradually from 2.55.
    const opened = resolveGlobeSemanticZoom({ zoom: 2.63, previous: "regional" }).snapshot;
    expect(opened.level).toBe("local");
    expect(dayNightDiveFactor(opened.zoom)).toBeGreaterThan(0.5);
    expect(dayNightDiveFactor(2.629)).toBeCloseTo(dayNightDiveFactor(opened.zoom), 2);
  });

  it("is fully released at and after the Dive blend threshold", () => {
    expect(DAY_NIGHT_DIVE_RELEASE_PROGRESS).toBeLessThan(EARTH_DIVE_BLEND_ENTER_PROGRESS);
    for (let zoom = GLOBE_SEMANTIC_ZOOM_FLOOR; zoom <= GLOBE_SEMANTIC_ZOOM_CEILING; zoom += 0.005) {
      const snapshot = resolveGlobeSemanticZoom({ zoom, previous: "local" }).snapshot;
      if (snapshot.localProgress >= DAY_NIGHT_DIVE_RELEASE_PROGRESS) {
        expect(dayNightDiveFactor(snapshot.zoom)).toBe(0);
      }
    }
    const blendZoom = LOCAL_BAND_ENTRY_ZOOM
      + EARTH_DIVE_BLEND_ENTER_PROGRESS * (GLOBE_SEMANTIC_ZOOM_CEILING - LOCAL_BAND_ENTRY_ZOOM);
    expect(dayNightDiveFactor(blendZoom)).toBe(0);
    expect(dayNightDiveFactor(GLOBE_SEMANTIC_ZOOM_CEILING)).toBe(0);
  });

  it("only darkens: day is exactly 1 and night never falls below the floor", () => {
    expect(dayNightBrightness(1, 1)).toBe(1);
    expect(dayNightBrightness(0.2, 1)).toBe(1);
    expect(dayNightBrightness(-1, 1)).toBeCloseTo(DAY_NIGHT_NIGHT_BRIGHTNESS, 10);
    expect(dayNightBrightness(-1, 0)).toBe(1);
    for (let dot = -1; dot <= 1; dot += 0.05) {
      const value = dayNightBrightness(dot, 1);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(DAY_NIGHT_NIGHT_BRIGHTNESS);
    }
  });
});
